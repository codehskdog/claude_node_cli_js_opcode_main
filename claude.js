/**
 * Node.js 版本的 “Claude 后端命令层”。
 *
 * 背景/目标
 * - 原项目的后端命令层位于 Rust/Tauri：src-tauri/src/commands/claude.rs
 * - 该 Rust 模块对前端暴露了一组 command（Tauri invoke / Web 模式 HTTP），用于：
 *   1) 读取与管理 Claude Code 的本地数据目录：~/.claude
 *   2) 发现并启动 Claude Code CLI（claude）并以 stream-json 形式接收流式输出
 *   3) 通过事件系统把 stdout/stderr 的每一行 JSONL 推到前端
 *   4) 补充：文件列表/搜索、hooks 配置读写、checkpoint/timeline 等
 *
 * 这个文件做什么
 * - 用 Node.js 复刻 claude.rs 的 “命令层语义”：
 *   - 对齐方法名（例如 list_projects、execute_claude_code、get_project_sessions…）
 *   - 输出数据结构尽量贴近前端现有消费方式（snake_case / camelCase 的历史兼容差异见注释）
 * - 提供一个事件总线（EventEmitter），模拟 Tauri 的 event emit 行为：
 *   - 通用事件：claude-output / claude-error / claude-complete / claude-cancelled
 *   - Session 隔离事件：claude-output:{sessionId} 等
 *
 * 重要说明（与 Rust 版差异）
 * - 这是“命令层逻辑”的 Node 实现，不等同于可直接替换 Tauri invoke_handler 的完整后端。
 *   在 Tauri 桌面应用里，Rust 仍负责注册 #[tauri::command]；Node 通常作为 sidecar 被调用。
 * - checkpoint 相关功能这里提供了一个可落盘的简化实现（可用但不完全等价于 Rust checkpoint 模块）：
 *   - 支持 create/restore/list/timeline/settings/cleanup 等基本链路
 *   - diff 目前仅返回简化结构，不生成真实 unified diff
 *
 * 事件协议（前端消费关键点）
 * - stdout 每行：emit('claude-output', line)
 * - 如果已解析到 Claude init 的 session_id：
 *   - 同时 emit(`claude-output:${sessionId}`, line) 进行会话隔离
 * - stderr 同理：claude-error / claude-error:{sessionId}
 * - 进程结束：claude-complete / claude-complete:{sessionId}，payload 是 boolean success
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 返回当前 Unix 时间戳（秒）。
 * - Rust 版大量使用 `SystemTime::now().duration_since(UNIX_EPOCH).as_secs()`
 * - Node 里用 Date.now() / 1000 对齐语义即可
 */
function nowUnixSeconds() {
    return Math.floor(Date.now() / 1000);
}

/**
 * 判断路径是否存在（文件/目录都算）。
 * - 等价于 Rust 的 `Path::exists()`
 * - 通过 `fs.access` 实现；失败统一返回 false（不抛出）
 */
async function pathExists(p) {
    try {
        await fs.access(p);
        return true;
    } catch {
        return false;
    }
}

/**
 * 尝试 realpath（解析符号链接、规范化路径）。
 * - Rust 版对 ~/.claude 会做 canonicalize
 * - Node 环境中某些路径可能无权限或不存在，这里失败则回退原路径
 */
async function safeRealpath(p) {
    try {
        return await fs.realpath(p);
    } catch {
        return p;
    }
}

/**
 * 读取 JSON 文件并 parse。
 * - 任何异常（文件不存在/权限/JSON 语法错误）都返回 fallback
 * - 这是命令层常用的“宽容读取”策略，避免 UI 因单个文件损坏直接崩溃
 */
async function readJsonFile(p, fallback) {
    try {
        const content = await fs.readFile(p, 'utf8');
        return JSON.parse(content);
    } catch {
        return fallback;
    }
}

/**
 * 将对象写入 JSON 文件（pretty printed）。
 * - 自动创建父目录
 * - 统一在文件末尾追加换行，便于 diff 与命令行查看
 */
async function writeJsonFilePretty(p, value) {
    const dir = path.dirname(p);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(p, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

/**
 * 读取文本文件并按行 yield（async generator）。
 *
 * 注意：这里是“简化实现”
 * - 直接一次性读入内存再 split
 * - 对于 ~/.claude/projects/*.jsonl 这类文件一般可接受，但极大文件会占用内存
 *
 * maxLines
 * - 用于像 getProjectPathFromSessions 这种“只看前 N 行”的场景，避免无意义遍历
 */
async function* readLines(filePath, maxLines = Infinity) {
    const content = await fs.readFile(filePath, 'utf8');
    const lines = content.split(/\r?\n/);
    let count = 0;
    for (const line of lines) {
        if (count >= maxLines) return;
        if (line.length === 0) continue;
        yield line;
        count += 1;
    }
}

/**
 * 从 `claude --version` 输出中提取 semver-ish 版本号。
 * - Rust 版使用 regex 提取：(\d+\.\d+\.\d+...)
 * - 这里用同等正则
 */
function extractVersion(text) {
    const m = text.match(/(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?)/);
    return m ? m[1] : undefined;
}

/**
 * 是否为隐藏名称（以 . 开头）。
 * - 用于目录遍历时跳过隐藏目录/文件（.git 等）
 */
function isHiddenName(name) {
    return name.startsWith('.');
}

/**
 * 是否为“应跳过的常见大目录”。
 * - 用于递归搜索/扫描时避免性能灾难
 * - Rust 版同样跳过 node_modules/target/.git 等
 */
function isSkippedDirName(name) {
    return (
        name === 'node_modules' ||
        name === 'target' ||
        name === '.git' ||
        name === 'dist' ||
        name === 'build' ||
        name === '.next' ||
        name === '__pycache__'
    );
}

/**
 * 获取文件/目录时间信息（秒）。
 * - createdAt：优先用 birthtime（某些平台可能不可靠），否则回退 now
 * - modifiedAt：优先用 mtime，否则回退 createdAt
 *
 * 用途
 * - list_projects / get_project_sessions 需要 created_at / most_recent_session
 */
async function getFileStatTimesUnixSeconds(p) {
    const st = await fs.stat(p);
    const createdAt = Number.isFinite(st.birthtimeMs) && st.birthtimeMs > 0 ? Math.floor(st.birthtimeMs / 1000) : nowUnixSeconds();
    const modifiedAt = Number.isFinite(st.mtimeMs) && st.mtimeMs > 0 ? Math.floor(st.mtimeMs / 1000) : createdAt;
    return { createdAt, modifiedAt };
}

/**
 * 对字符串做 SHA-256 哈希（hex）。
 * - checkpoint 快照会把文件内容放进 content pool（用 hash 去重）
 */
async function sha256String(s) {
    return createHash('sha256').update(s, 'utf8').digest('hex');
}

/**
 * 粗略判断一个文件是否可能是“文本文件”。
 *
 * 目的
 * - checkpoint 快照不应把二进制大文件（图片、字体等）全量读入
 *
 * 策略（启发式，不保证正确）
 * - 文件必须是普通文件（isFile）
 * - 文件大小必须小于 sizeLimitBytes（默认 1MB）
 * - 内容采样片段不能包含 NUL 字节（0）
 */
async function isProbablyTextFile(p, sizeLimitBytes = 1024 * 1024) {
    try {
        const st = await fs.stat(p);
        if (!st.isFile()) return false;
        if (st.size > sizeLimitBytes) return false;
        const buf = await fs.readFile(p);
        const sample = buf.subarray(0, Math.min(buf.length, 4096));
        for (const b of sample) {
            if (b === 0) return false;
        }
        return true;
    } catch {
        return false;
    }
}

/**
 * 将绝对路径编码为 Claude Code 项目 ID。
 * - Claude Code 在 ~/.claude/projects 里用“路径替换 / 为 -”命名目录
 * - 这种编码不可逆（路径本身含 - 时存在歧义），Rust 版也标注了 DEPRECATED
 */
function encodeProjectId(projectPath) {
    return projectPath.replaceAll('/', '-');
}

/**
 * “尽力而为”的解码（仅作为 fallback）。
 * - Rust 版同样是 `encoded.replace('-', '/')`
 * - 真实路径更可靠的来源是：读取 session JSONL 中的 cwd 字段
 */
function decodeProjectPath(encoded) {
    return encoded.replaceAll('-', '/');
}

/**
 * 从某个 ~/.claude/projects/<projectId> 目录下的 session jsonl 中提取 cwd（真实项目路径）。
 *
 * 为什么需要它
 * - 目录名的编码不可逆，所以必须从 session 内容找 `cwd`
 *
 * 实现细节
 * - 找任意一个 *.jsonl
 * - 只读取前 10 行（Rust 版同样这么做），因为有些文件第一行可能 cwd 为 null
 * - 找到第一个非空 cwd 就返回
 */
async function getProjectPathFromSessions(projectDir) {
    const entries = await fs.readdir(projectDir, { withFileTypes: true });
    for (const entry of entries) {
        if (!entry.isFile()) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (ext !== '.jsonl') continue;
        const filePath = path.join(projectDir, entry.name);
        try {
            for await (const line of readLines(filePath, 10)) {
                try {
                    const json = JSON.parse(line);
                    const cwd = typeof json?.cwd === 'string' ? json.cwd : null;
                    if (cwd && cwd.length > 0) return cwd;
                } catch {
                    continue;
                }
            }
        } catch {
            continue;
        }
    }
    throw new Error('Could not determine project path from session files');
}

/**
 * 从 session JSONL 文件中提取“第一条有效 user 消息”以及其 timestamp。
 *
 * 过滤规则（与 Rust 版对齐）
 * - role 必须是 user
 * - 跳过 caveat 文本（Claude Code 会插入一段说明）
 * - 跳过以 <command-name> / <local-command-stdout> 开头的“命令回显类”消息
 */
async function extractFirstUserMessage(jsonlPath) {
    try {
        for await (const line of readLines(jsonlPath)) {
            let entry;
            try {
                entry = JSON.parse(line);
            } catch {
                continue;
            }
            const role = entry?.message?.role;
            const content = entry?.message?.content;
            if (role !== 'user') continue;
            if (typeof content !== 'string') continue;
            if (content.includes('Caveat: The messages below were generated by the user while running local commands')) continue;
            if (content.startsWith('<command-name>') || content.startsWith('<local-command-stdout>')) continue;
            return { firstMessage: content, timestamp: typeof entry?.timestamp === 'string' ? entry.timestamp : undefined };
        }
        return { firstMessage: undefined, timestamp: undefined };
    } catch {
        return { firstMessage: undefined, timestamp: undefined };
    }
}

/**
 * 找到用户的 ~/.claude 目录。
 * - 这是整个项目/会话/设置/时间线的根目录
 */
async function findClaudeDir() {
    const home = os.homedir();
    if (!home) throw new Error('Could not find home directory');
    const p = path.join(home, '.claude');
    if (!(await pathExists(p))) throw new Error('Could not find ~/.claude directory');
    return await safeRealpath(p);
}

/**
 * 发现 claude 可执行文件位置。
 *
 * 备注
 * - Rust 版 `claude_binary.rs` 做了更复杂的发现（which、版本比较、数据库偏好）
 * - 这里实现的是“够用的候选路径扫描 + 回退到 PATH”，适合做 sidecar 的逻辑演示
 *
 * 返回值
 * - 若找到某个绝对路径：返回该路径
 * - 否则返回 'claude'（依赖系统 PATH）
 */
async function findClaudeBinary() {
    const home = os.homedir();
    const candidates = [];
    if (home) {
        candidates.push(path.join(home, '.claude', 'local', 'claude'));
        candidates.push(path.join(home, '.local', 'bin', 'claude'));
        candidates.push(path.join(home, '.npm-global', 'bin', 'claude'));
        candidates.push(path.join(home, '.yarn', 'bin', 'claude'));
        candidates.push(path.join(home, '.bun', 'bin', 'claude'));
        candidates.push(path.join(home, 'bin', 'claude'));
        candidates.push(path.join(home, 'node_modules', '.bin', 'claude'));
        candidates.push(path.join(home, '.config', 'yarn', 'global', 'node_modules', '.bin', 'claude'));
        candidates.push(path.join(home, '.nvm', 'versions', 'node'));
    }
    candidates.push('/usr/local/bin/claude');
    candidates.push('/opt/homebrew/bin/claude');
    candidates.push('/usr/bin/claude');
    candidates.push('/bin/claude');

    for (const c of candidates) {
        if (c.endsWith(path.sep + 'node') || c.endsWith(path.sep + 'node' + path.sep) || c.endsWith(path.sep + 'node' + path.sep + '')) {
            continue;
        }
        if (await pathExists(c)) return c;
    }

    if (home) {
        const nvmBase = path.join(home, '.nvm', 'versions', 'node');
        if (await pathExists(nvmBase)) {
            try {
                const entries = await fs.readdir(nvmBase, { withFileTypes: true });
                for (const e of entries) {
                    if (!e.isDirectory()) continue;
                    const p = path.join(nvmBase, e.name, 'bin', 'claude');
                    if (await pathExists(p)) return p;
                }
            } catch {
                null;
            }
        }
    }

    return 'claude';
}

export class ClaudeNodeBackend extends EventEmitter {
    constructor() {
        super();
        /**
         * 当前正在运行的 claude 子进程（如果有）。
         * - Rust 版通过 ClaudeProcessState 存一个 Child
         * - 这里用 child_process.ChildProcess
         */
        this._currentProcess = null;
        /**
         * 运行中 session 的 registry（用于 list_running_claude_sessions / get_claude_session_output / cancel）。
         *
         * key: Claude Code 的 session_id（从 stream-json 的 system:init 中提取）
         * value: {
         *   run_id: number,
         *   pid: number,
         *   started_at: ISO string,
         *   project_path: string,
         *   task: string,
         *   model: string,
         *   live_output: string
         * }
         */
        this._sessions = new Map();
        /**
         * 用于生成 registry 的 run_id。
         * - Rust 版 ProcessRegistry 从 1000000 起步，避免与 AgentRun 的 id 冲突
         */
        this._runIdCounter = 1000000;
    }

    /**
     * 为“非 agent 的后台进程”生成一个唯一 run_id。
     * - 这里仅用于 ClaudeSession registry
     */
    _nextRunId() {
        const v = this._runIdCounter;
        this._runIdCounter += 1;
        return v;
    }

    /**
     * 对应 Rust command: get_home_directory
     * - UI 用于定位默认目录/路径选择器等
     */
    async get_home_directory() {
        return os.homedir() || '/';
    }

    /**
     * 对应 Rust command: list_projects
     *
     * 数据来源
     * - ~/.claude/projects 下每个目录就是一个 project（目录名是编码过的路径）
     * - sessions 是该目录下的 *.jsonl 文件（去掉扩展名）
     *
     * project.path 的确定方式
     * - 优先从 session jsonl 的 cwd 字段读取（可靠）
     * - 失败再用目录名 decode（不可靠但兜底）
     */
    async list_projects() {
        const claudeDir = await findClaudeDir();
        const projectsDir = path.join(claudeDir, 'projects');
        if (!(await pathExists(projectsDir))) return [];
        const entries = await fs.readdir(projectsDir, { withFileTypes: true });
        const projects = [];
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const dirName = entry.name;
            const dirPath = path.join(projectsDir, dirName);
            const { createdAt } = await getFileStatTimesUnixSeconds(dirPath);
            let projectPath;
            try {
                projectPath = await getProjectPathFromSessions(dirPath);
            } catch {
                projectPath = decodeProjectPath(dirName);
            }
            const sessionEntries = await fs.readdir(dirPath, { withFileTypes: true });
            const sessions = [];
            let mostRecentSession;
            for (const se of sessionEntries) {
                if (!se.isFile()) continue;
                if (path.extname(se.name).toLowerCase() !== '.jsonl') continue;
                const sid = path.basename(se.name, '.jsonl');
                sessions.push(sid);
                try {
                    const { modifiedAt } = await getFileStatTimesUnixSeconds(path.join(dirPath, se.name));
                    mostRecentSession = typeof mostRecentSession === 'number' ? Math.max(mostRecentSession, modifiedAt) : modifiedAt;
                } catch {
                    null;
                }
            }
            projects.push({
                id: dirName,
                path: projectPath,
                sessions,
                created_at: createdAt,
                most_recent_session: mostRecentSession,
            });
        }
        projects.sort((a, b) => {
            const at = typeof a.most_recent_session === 'number' ? a.most_recent_session : null;
            const bt = typeof b.most_recent_session === 'number' ? b.most_recent_session : null;
            if (at != null && bt != null) return bt - at;
            if (at != null && bt == null) return -1;
            if (at == null && bt != null) return 1;
            return (b.created_at || 0) - (a.created_at || 0);
        });
        return projects;
    }

    /**
     * 对应 Rust command: create_project
     * - 作用：确保 ~/.claude/projects/<encoded> 目录存在
     * - 注意：Claude Code 本身不一定需要这个命令，这更多是 UI 的“把某路径纳入管理”的动作
     */
    async create_project({ path: projectPath }) {
        if (typeof projectPath !== 'string' || projectPath.length === 0) throw new Error('Invalid path');
        const projectId = encodeProjectId(projectPath);
        const claudeDir = await findClaudeDir();
        const projectsDir = path.join(claudeDir, 'projects');
        await fs.mkdir(projectsDir, { recursive: true });
        const projectDir = path.join(projectsDir, projectId);
        await fs.mkdir(projectDir, { recursive: true });
        const { createdAt } = await getFileStatTimesUnixSeconds(projectDir);
        return { id: projectId, path: projectPath, sessions: [], created_at: createdAt, most_recent_session: undefined };
    }

    /**
     * 对应 Rust command: get_project_sessions
     * - 列出某 project 下所有会话（*.jsonl）
     * - 同时尝试加载 ~/.claude/todos/<sessionId>.json 作为 todo_data
     *
     * 兼容字段
     * - 前端在不同模块中既出现 snake_case 也出现 camelCase，这里沿用 rust 返回风格：
     *   - project_id / project_path / created_at / first_message / message_timestamp
     */
    async get_project_sessions({ projectId }) {
        if (typeof projectId !== 'string' || projectId.length === 0) throw new Error('Project directory not found: ' + projectId);
        const claudeDir = await findClaudeDir();
        const projectDir = path.join(claudeDir, 'projects', projectId);
        if (!(await pathExists(projectDir))) throw new Error('Project directory not found: ' + projectId);
        const todosDir = path.join(claudeDir, 'todos');
        let projectPath;
        try {
            projectPath = await getProjectPathFromSessions(projectDir);
        } catch {
            projectPath = decodeProjectPath(projectId);
        }
        const entries = await fs.readdir(projectDir, { withFileTypes: true });
        const sessions = [];
        for (const entry of entries) {
            if (!entry.isFile()) continue;
            if (path.extname(entry.name).toLowerCase() !== '.jsonl') continue;
            const sessionId = path.basename(entry.name, '.jsonl');
            const filePath = path.join(projectDir, entry.name);
            const { createdAt } = await getFileStatTimesUnixSeconds(filePath);
            const { firstMessage, timestamp } = await extractFirstUserMessage(filePath);
            const todoPath = path.join(todosDir, `${sessionId}.json`);
            const todoData = (await pathExists(todoPath)) ? await readJsonFile(todoPath, undefined) : undefined;
            sessions.push({
                id: sessionId,
                project_id: projectId,
                project_path: projectPath,
                todo_data: todoData,
                created_at: createdAt,
                first_message: firstMessage,
                message_timestamp: timestamp,
            });
        }
        sessions.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
        return sessions;
    }

    /**
     * 对应 Rust command: get_claude_settings
     * - 读取 ~/.claude/settings.json
     * - Rust 版返回 ClaudeSettings { data: Value }，前端有一段“兼容提取 data”的逻辑
     * - 这里沿用 `{ data: <json> }` 的结构，保持兼容
     */
    async get_claude_settings() {
        const claudeDir = await findClaudeDir();
        const settingsPath = path.join(claudeDir, 'settings.json');
        if (!(await pathExists(settingsPath))) return { data: {} };
        const data = await readJsonFile(settingsPath, {});
        return { data };
    }

    /**
     * 对应 Rust command: save_claude_settings
     * - 将 settings（JSON）写回 ~/.claude/settings.json
     */
    async save_claude_settings({ settings }) {
        const claudeDir = await findClaudeDir();
        const settingsPath = path.join(claudeDir, 'settings.json');
        await writeJsonFilePretty(settingsPath, settings ?? {});
        return 'Settings saved successfully';
    }

    /**
     * 对应 Rust command: get_system_prompt
     * - 读取 ~/.claude/CLAUDE.md
     * - 如果不存在则返回空字符串
     */
    async get_system_prompt() {
        const claudeDir = await findClaudeDir();
        const p = path.join(claudeDir, 'CLAUDE.md');
        if (!(await pathExists(p))) return '';
        return await fs.readFile(p, 'utf8');
    }

    /**
     * 对应 Rust command: save_system_prompt
     * - 写入 ~/.claude/CLAUDE.md
     */
    async save_system_prompt({ content }) {
        const claudeDir = await findClaudeDir();
        const p = path.join(claudeDir, 'CLAUDE.md');
        await fs.writeFile(p, String(content ?? ''), 'utf8');
        return 'System prompt saved successfully';
    }

    /**
     * 对应 Rust command: open_new_session
     *
     * 语义
     * - Rust 版在 debug 下直接 spawn claude（production 受限）
     * - 这里提供一个“启动 claude CLI（不附加参数）”的实现作为占位
     *
     * 注意
     * - 这个方法并不会接管流式输出，也不会产生 session registry
     * - 真正用于 UI 内发 prompt 并接收输出的是 execute/continue/resume
     */
    async open_new_session({ path: projectPath } = {}) {
        const claudePath = await findClaudeBinary();
        const child = spawn(claudePath, [], {
            cwd: typeof projectPath === 'string' && projectPath.length > 0 ? projectPath : undefined,
            stdio: 'ignore',
            env: process.env,
        });
        child.unref();
        return 'Claude Code session started';
    }

    /**
     * 对应 Rust command: check_claude_version
     *
     * 行为
     * - 执行 `claude --version`
     * - 解析输出并判断是否包含 “Claude Code” 关键字
     *
     * 返回结构（对齐 rust/ts）
     * - { is_installed: boolean, version?: string, output: string }
     */
    async check_claude_version() {
        const claudePath = await findClaudeBinary();
        try {
            const output = await new Promise((resolve, reject) => {
                const child = spawn(claudePath, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
                let stdout = '';
                let stderr = '';
                child.stdout.on('data', (d) => (stdout += d.toString('utf8')));
                child.stderr.on('data', (d) => (stderr += d.toString('utf8')));
                child.on('error', reject);
                child.on('close', (code) => resolve({ code, stdout, stderr }));
            });
            const full = (output.stderr ? `${output.stdout}\n${output.stderr}` : output.stdout).trim();
            const version = extractVersion(output.stdout);
            const isValid = output.stdout.includes('(Claude Code)') || output.stdout.includes('Claude Code');
            return { is_installed: Boolean(isValid && output.code === 0), version, output: full };
        } catch (e) {
            return { is_installed: false, version: undefined, output: `Command not found: ${e?.message || String(e)}` };
        }
    }

    /**
     * 对应 Rust command: find_claude_md_files
     *
     * 功能
     * - 递归扫描某项目目录，找出所有名为 CLAUDE.md（大小写不敏感）的文件
     *
     * 性能/安全策略
     * - 跳过隐藏目录
     * - 跳过常见大目录（node_modules/target/.git 等）
     */
    async find_claude_md_files({ projectPath }) {
        const root = String(projectPath ?? '');
        if (!root) throw new Error('Project path does not exist: ' + root);
        if (!(await pathExists(root))) throw new Error('Project path does not exist: ' + root);
        const files = [];
        const walk = async (current) => {
            const entries = await fs.readdir(current, { withFileTypes: true });
            for (const entry of entries) {
                const full = path.join(current, entry.name);
                if (isHiddenName(entry.name)) continue;
                if (entry.isDirectory()) {
                    if (isSkippedDirName(entry.name)) continue;
                    await walk(full);
                } else if (entry.isFile()) {
                    if (entry.name.toLowerCase() === 'claude.md') {
                        const st = await fs.stat(full);
                        const rel = path.relative(root, full);
                        files.push({
                            relative_path: rel,
                            absolute_path: full,
                            size: st.size,
                            modified: Math.floor(st.mtimeMs / 1000),
                        });
                    }
                }
            }
        };
        await walk(root);
        files.sort((a, b) => a.relative_path.localeCompare(b.relative_path));
        return files;
    }

    /**
     * 对应 Rust command: read_claude_md_file
     * - 根据绝对路径读取文件内容
     */
    async read_claude_md_file({ filePath }) {
        const p = String(filePath ?? '');
        if (!(await pathExists(p))) throw new Error('File does not exist: ' + p);
        return await fs.readFile(p, 'utf8');
    }

    /**
     * 对应 Rust command: save_claude_md_file
     * - 根据绝对路径写入文件内容，并确保父目录存在
     */
    async save_claude_md_file({ filePath, content }) {
        const p = String(filePath ?? '');
        const dir = path.dirname(p);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(p, String(content ?? ''), 'utf8');
        return 'File saved successfully';
    }

    /**
     * 对应 Rust command: load_session_history
     *
     * 数据格式
     * - Claude Code session 存储为 JSONL（每行一个 JSON 对象）
     * - 这里逐行 parse 成对象数组返回，供前端直接渲染历史
     */
    async load_session_history({ sessionId, projectId }) {
        const claudeDir = await findClaudeDir();
        const p = path.join(claudeDir, 'projects', String(projectId), `${String(sessionId)}.jsonl`);
        if (!(await pathExists(p))) throw new Error('Session file not found: ' + sessionId);
        const messages = [];
        for await (const line of readLines(p)) {
            try {
                messages.push(JSON.parse(line));
            } catch {
                null;
            }
        }
        return messages;
    }

    /**
     * 对应 Rust command: list_directory_contents
     *
     * 行为
     * - 列出某目录下第一层条目（不递归）
     * - 默认跳过隐藏文件/目录，但允许 `.claude` 以方便管理项目本地配置
     */
    async list_directory_contents({ directoryPath }) {
        const p = String(directoryPath ?? '').trim();
        if (!p) throw new Error('Directory path cannot be empty');
        if (!(await pathExists(p))) throw new Error('Path does not exist: ' + p);
        const st = await fs.stat(p);
        if (!st.isDirectory()) throw new Error('Path is not a directory: ' + p);
        const entries = await fs.readdir(p, { withFileTypes: true });
        const out = [];
        for (const entry of entries) {
            if (isHiddenName(entry.name) && entry.name !== '.claude') continue;
            const full = path.join(p, entry.name);
            const st2 = await fs.stat(full);
            out.push({
                name: entry.name,
                path: full,
                is_directory: entry.isDirectory(),
                size: st2.isFile() ? st2.size : 0,
                extension: st2.isFile() ? (path.extname(entry.name).slice(1) || undefined) : undefined,
            });
        }
        out.sort((a, b) => {
            if (a.is_directory && !b.is_directory) return -1;
            if (!a.is_directory && b.is_directory) return 1;
            return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
        });
        return out;
    }

    /**
     * 对应 Rust command: search_files
     *
     * 行为
     * - 在 basePath 下递归查找名称包含 query 的文件或目录（不做内容搜索）
     * - 限制：
     *   - 最大递归深度 5
     *   - 最多返回 50 条（与 Rust 版一致）
     */
    async search_files({ basePath, query }) {
        const base = String(basePath ?? '').trim();
        const q = String(query ?? '').trim();
        if (!base) throw new Error('Base path cannot be empty');
        if (!(await pathExists(base))) throw new Error('Path does not exist: ' + base);
        if (!q) return [];
        const queryLower = q.toLowerCase();
        const results = [];
        const walk = async (current, depth) => {
            if (depth > 5 || results.length >= 50) return;
            let entries;
            try {
                entries = await fs.readdir(current, { withFileTypes: true });
            } catch {
                return;
            }
            for (const entry of entries) {
                if (results.length >= 50) return;
                if (isHiddenName(entry.name)) continue;
                const full = path.join(current, entry.name);
                if (entry.name.toLowerCase().includes(queryLower)) {
                    const st = await fs.stat(full);
                    results.push({
                        name: entry.name,
                        path: full,
                        is_directory: st.isDirectory(),
                        size: st.isFile() ? st.size : 0,
                        extension: st.isFile() ? (path.extname(entry.name).slice(1) || undefined) : undefined,
                    });
                }
                if (entry.isDirectory()) {
                    if (isSkippedDirName(entry.name)) continue;
                    await walk(full, depth + 1);
                }
            }
        };
        await walk(base, 0);
        results.sort((a, b) => {
            const aExact = a.name.toLowerCase() === queryLower;
            const bExact = b.name.toLowerCase() === queryLower;
            if (aExact && !bExact) return -1;
            if (!aExact && bExact) return 1;
            return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
        });
        results.splice(50);
        return results;
    }

    /**
     * 对应 Rust command: get_hooks_config
     *
     * scope
     * - user: ~/.claude/settings.json
     * - project: <project>/.claude/settings.json
     * - local: <project>/.claude/settings.local.json
     *
     * 返回
     * - settings.hooks（若不存在则返回 {}）
     */
    async get_hooks_config({ scope, projectPath }) {
        const s = String(scope ?? '');
        let settingsPath;
        if (s === 'user') {
            const claudeDir = await findClaudeDir();
            settingsPath = path.join(claudeDir, 'settings.json');
        } else if (s === 'project') {
            const p = String(projectPath ?? '');
            if (!p) throw new Error('Project path required for project scope');
            settingsPath = path.join(p, '.claude', 'settings.json');
        } else if (s === 'local') {
            const p = String(projectPath ?? '');
            if (!p) throw new Error('Project path required for local scope');
            settingsPath = path.join(p, '.claude', 'settings.local.json');
        } else {
            throw new Error('Invalid scope');
        }
        if (!(await pathExists(settingsPath))) return {};
        const settings = await readJsonFile(settingsPath, {});
        const hooks = settings?.hooks;
        return typeof hooks === 'object' && hooks !== null ? hooks : {};
    }

    /**
     * 对应 Rust command: update_hooks_config
     * - 在指定 scope 的 settings 文件中写入 hooks 字段
     * - 若 scope 为 project/local，会自动创建 <project>/.claude 目录
     */
    async update_hooks_config({ scope, hooks, projectPath }) {
        const s = String(scope ?? '');
        let settingsPath;
        if (s === 'user') {
            const claudeDir = await findClaudeDir();
            settingsPath = path.join(claudeDir, 'settings.json');
        } else if (s === 'project') {
            const p = String(projectPath ?? '');
            if (!p) throw new Error('Project path required for project scope');
            const claudeDir = path.join(p, '.claude');
            await fs.mkdir(claudeDir, { recursive: true });
            settingsPath = path.join(claudeDir, 'settings.json');
        } else if (s === 'local') {
            const p = String(projectPath ?? '');
            if (!p) throw new Error('Project path required for local scope');
            const claudeDir = path.join(p, '.claude');
            await fs.mkdir(claudeDir, { recursive: true });
            settingsPath = path.join(claudeDir, 'settings.local.json');
        } else {
            throw new Error('Invalid scope');
        }
        const settings = (await pathExists(settingsPath)) ? await readJsonFile(settingsPath, {}) : {};
        settings.hooks = hooks ?? {};
        await writeJsonFilePretty(settingsPath, settings);
        return 'Hooks configuration updated successfully';
    }

    /**
     * 对应 Rust command: validate_hook_command
     *
     * 安全策略
     * - 仅做 bash 语法检查（bash -n），不会执行命令
     * - 返回 { valid: boolean, message: string } 供 UI 展示
     */
    async validate_hook_command({ command }) {
        const cmd = String(command ?? '');
        const result = await new Promise((resolve) => {
            const child = spawn('bash', ['-n', '-c', cmd], { stdio: ['ignore', 'pipe', 'pipe'] });
            let stderr = '';
            child.stderr.on('data', (d) => (stderr += d.toString('utf8')));
            child.on('close', (code) => resolve({ code, stderr }));
            child.on('error', () => resolve({ code: 1, stderr: 'Failed to validate command' }));
        });
        if (result.code === 0) return { valid: true, message: 'Command syntax is valid' };
        return { valid: false, message: `Syntax error: ${String(result.stderr || '').trim()}` };
    }

    /**
     * 对应 Rust command: execute_claude_code
     * - 启动一个全新 claude 会话（通过 `-p <prompt>`）
     */
    async execute_claude_code({ projectPath, prompt, model }) {
        return await this._spawnClaude({ projectPath, prompt, model, mode: 'execute' });
    }

    /**
     * 对应 Rust command: continue_claude_code
     * - 使用 `-c -p <prompt>` 在 Claude Code 的“继续模式”下追加对话
     */
    async continue_claude_code({ projectPath, prompt, model }) {
        return await this._spawnClaude({ projectPath, prompt, model, mode: 'continue' });
    }

    /**
     * 对应 Rust command: resume_claude_code
     * - 使用 `--resume <sessionId> -p <prompt>` 复用某个已有会话
     * - 注意：Claude Code 可能在 resume 后返回一个新的 session_id（前端有兼容逻辑）
     */
    async resume_claude_code({ projectPath, sessionId, prompt, model }) {
        return await this._spawnClaude({ projectPath, prompt, model, mode: 'resume', resumeSessionId: sessionId });
    }

    /**
     * 对应 Rust command: cancel_claude_execution
     *
     * 行为
     * - 若提供 sessionId：优先尝试按 registry 里的 pid kill
     * - 否则尝试 kill 当前进程
     * - 无论是否真的 kill 成功，都 emit cancelled/complete 事件，让 UI 状态一致
     */
    async cancel_claude_execution({ sessionId } = {}) {
        const sid = sessionId ? String(sessionId) : null;
        let killed = false;
        if (sid && this._sessions.has(sid)) {
            const s = this._sessions.get(sid);
            if (s?.pid) {
                try {
                    process.kill(s.pid, 'SIGKILL');
                    killed = true;
                } catch {
                    null;
                }
            }
        }
        if (!killed && this._currentProcess?.pid) {
            try {
                this._currentProcess.kill('SIGKILL');
                killed = true;
            } catch {
                null;
            }
        }
        if (sid) {
            this.emit(`claude-cancelled:${sid}`, true);
            this.emit(`claude-complete:${sid}`, false);
        }
        this.emit('claude-cancelled', true);
        this.emit('claude-complete', false);
        return;
    }

    /**
     * 对应 Rust command: list_running_claude_sessions
     * - 返回 registry 中记录的运行中会话列表
     */
    async list_running_claude_sessions() {
        const out = [];
        for (const [sessionId, info] of this._sessions.entries()) {
            out.push({
                run_id: info.run_id,
                process_type: { ClaudeSession: { session_id: sessionId } },
                pid: info.pid,
                started_at: info.started_at,
                project_path: info.project_path,
                task: info.task,
                model: info.model,
            });
        }
        return out;
    }

    /**
     * 对应 Rust command: get_claude_session_output
     * - 返回 registry 累积的 live_output（JSONL 原文串）
     * - 仅用于“正在跑的 session”的实时输出；历史回放仍应走 load_session_history
     */
    async get_claude_session_output({ sessionId }) {
        const sid = String(sessionId ?? '');
        const s = this._sessions.get(sid);
        return s?.live_output ?? '';
    }

    /**
     * 核心：启动 claude 子进程并转发 stream-json 输出。
     *
     * 与 Rust spawn_claude_process 的对应关系
     * - Rust：tokio spawn 进程，AsyncBufReadExt::lines 逐行读取 stdout/stderr
     * - Node：child_process.spawn，监听 'data'，手动按 \n 切分（处理 chunk 边界）
     *
     * 参数
     * - projectPath: 执行工作目录（claude 会以此为项目上下文）
     * - prompt/model: 透传给 cli
     * - mode:
     *   - execute: `-p <prompt>`
     *   - continue: `-c -p <prompt>`
     *   - resume: `--resume <id> -p <prompt>`
     */
    async _spawnClaude({ projectPath, prompt, model, mode, resumeSessionId }) {
        const project = String(projectPath ?? '');
        if (!project) throw new Error('project_path is required');
        const claudePath = await findClaudeBinary();
        const promptStr = String(prompt ?? '');
        const modelStr = String(model ?? '');
        const args = [];
        if (mode === 'continue') args.push('-c');
        if (mode === 'resume') {
            args.push('--resume');
            args.push(String(resumeSessionId ?? ''));
        }
        args.push('-p', promptStr);
        if (modelStr) args.push('--model', modelStr);
        args.push('--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions');

        // 本实现是“单实例运行”：
        // - 若已有 claude 子进程在跑，先强制 kill，避免并发导致事件串流与状态复杂化。
        if (this._currentProcess) {
            try {
                this._currentProcess.kill('SIGKILL');
            } catch {
                null;
            }
            this._currentProcess = null;
        }

        const child = spawn(claudePath, args, {
            cwd: project,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: process.env,
        });
        this._currentProcess = child;

        // Claude Code 的 session_id 会在 stdout 的 system:init 消息里出现：
        // - 在拿到它之前，我们只能向通用 channel emit（claude-output）
        // - 拿到之后再向 session 细分 channel emit（claude-output:{sessionId}）
        let sessionId = null;
        let runId = null;

        // 把每一行 JSONL 原文追加进 registry 的 live_output，便于 UI 重新拉取/重连。
        const appendLiveOutput = (line) => {
            if (!sessionId) return;
            const s = this._sessions.get(sessionId);
            if (!s) return;
            s.live_output += line + '\n';
        };

        // stdout 的每一行都会走这里：
        // 1) 尝试 parse JSON
        // 2) 如果是 init 且包含 session_id，则创建 registry 记录
        // 3) 逐行 emit 到前端
        const onStdoutLine = (line) => {
            let parsed;
            try {
                parsed = JSON.parse(line);
            } catch {
                parsed = null;
            }
            if (parsed && parsed.type === 'system' && parsed.subtype === 'init' && typeof parsed.session_id === 'string') {
                if (!sessionId) {
                    sessionId = parsed.session_id;
                    runId = this._nextRunId();
                    this._sessions.set(sessionId, {
                        run_id: runId,
                        pid: child.pid ?? 0,
                        started_at: new Date().toISOString(),
                        project_path: project,
                        task: promptStr,
                        model: modelStr,
                        live_output: '',
                    });
                }
            }
            if (sessionId) {
                appendLiveOutput(line);
                this.emit(`claude-output:${sessionId}`, line);
            }
            this.emit('claude-output', line);
        };

        // stderr 逐行透传（不尝试 JSON parse）
        const onStderrLine = (line) => {
            if (sessionId) this.emit(`claude-error:${sessionId}`, line);
            this.emit('claude-error', line);
        };

        // 由于 'data' 事件拿到的是任意大小的 chunk，可能出现：
        // - 一个 chunk 包含多行
        // - 一行被拆成多个 chunk
        // 所以要做“分段拼接 + 按换行切分 + 末尾残留缓存”的处理。
        const stdoutBuf = [];
        const stderrBuf = [];

        child.stdout.on('data', (d) => {
            stdoutBuf.push(d);
            const text = Buffer.concat(stdoutBuf).toString('utf8');
            const parts = text.split(/\r?\n/);
            stdoutBuf.length = 0;
            stdoutBuf.push(Buffer.from(parts.pop() ?? '', 'utf8'));
            for (const p of parts) {
                if (!p) continue;
                onStdoutLine(p);
            }
        });

        child.stderr.on('data', (d) => {
            stderrBuf.push(d);
            const text = Buffer.concat(stderrBuf).toString('utf8');
            const parts = text.split(/\r?\n/);
            stderrBuf.length = 0;
            stderrBuf.push(Buffer.from(parts.pop() ?? '', 'utf8'));
            for (const p of parts) {
                if (!p) continue;
                onStderrLine(p);
            }
        });

        // 进程自然退出（exit code 0 视为 success）
        // - emit complete 事件
        // - 清理 registry
        child.on('close', (code) => {
            const success = code === 0;
            if (sessionId) {
                this.emit(`claude-complete:${sessionId}`, success);
                const s = this._sessions.get(sessionId);
                if (s) this._sessions.delete(sessionId);
            }
            this.emit('claude-complete', success);
            if (this._currentProcess === child) this._currentProcess = null;
        });

        // spawn/运行期间报错（比如找不到可执行文件、无权限）
        child.on('error', (e) => {
            if (sessionId) this.emit(`claude-error:${sessionId}`, String(e?.message || e));
            this.emit('claude-error', String(e?.message || e));
            if (sessionId) this.emit(`claude-complete:${sessionId}`, false);
            this.emit('claude-complete', false);
            if (this._currentProcess === child) this._currentProcess = null;
        });

        return;
    }

    /**
     * checkpoint 存储布局（Node 简化实现）
     *
     * baseDir:
     *   ~/.claude/projects/<projectId>/.timelines/<sessionId>/
     *
     * timelineFile:
     *   timeline.json（记录 checkpoints 列表、当前 checkpoint、树形 rootNode 等）
     *
     * checkpointsDir:
     *   checkpoints/<checkpointId>/
     *     - metadata.json（Checkpoint 元数据）
     *     - messages.jsonl（该 checkpoint 截止的会话消息）
     *
     * filesDir:
     *   files/
     *     - content_pool/<sha256>（文件内容按 hash 去重存放）
     *     - refs/<checkpointId>/*.json（记录 checkpoint 中包含哪些文件以及对应 hash）
     */
    async _checkpointPaths({ projectId, sessionId }) {
        const claudeDir = await findClaudeDir();
        const baseDir = path.join(claudeDir, 'projects', String(projectId), '.timelines', String(sessionId));
        return {
            baseDir,
            timelineFile: path.join(baseDir, 'timeline.json'),
            checkpointsDir: path.join(baseDir, 'checkpoints'),
            filesDir: path.join(baseDir, 'files'),
            contentPoolDir: path.join(baseDir, 'files', 'content_pool'),
            refsDir: path.join(baseDir, 'files', 'refs'),
        };
    }

    /**
     * 读取 timeline.json（不存在则返回默认结构）。
     * - timeline 文件是 Node 版自己维护的；与 Rust 版 timeline 结构并非完全一致
     */
    async _loadTimeline(paths, sessionId) {
        const fallback = {
            sessionId,
            rootNode: null,
            currentCheckpointId: null,
            autoCheckpointEnabled: false,
            checkpointStrategy: 'smart',
            totalCheckpoints: 0,
            checkpoints: [],
        };
        const t = await readJsonFile(paths.timelineFile, fallback);
        if (!t || typeof t !== 'object') return fallback;
        if (!Array.isArray(t.checkpoints)) t.checkpoints = [];
        if (typeof t.totalCheckpoints !== 'number') t.totalCheckpoints = t.checkpoints.length;
        return t;
    }

    /**
     * 写回 timeline.json。
     */
    async _saveTimeline(paths, timeline) {
        await writeJsonFilePretty(paths.timelineFile, timeline);
    }

    /**
     * 对项目工作目录做一次“文本文件快照”。
     *
     * 输出
     * - 返回 [{ rel, hash }]：
     *   - rel：相对 projectPath 的路径
     *   - hash：文件内容的 sha256
     *
     * 落盘
     * - content_pool/<hash>：存放真实内容（第一次出现才写）
     * - refs/<checkpointId>/<safe>.json：记录 rel->hash 的引用关系
     */
    async _snapshotProjectFiles({ projectPath, checkpointId, paths }) {
        const files = [];
        const walk = async (current) => {
            const entries = await fs.readdir(current, { withFileTypes: true });
            for (const entry of entries) {
                if (isHiddenName(entry.name)) continue;
                if (entry.isDirectory()) {
                    if (isSkippedDirName(entry.name)) continue;
                    await walk(path.join(current, entry.name));
                } else if (entry.isFile()) {
                    const full = path.join(current, entry.name);
                    const rel = path.relative(projectPath, full);
                    if (!rel || rel.startsWith('..')) continue;
                    if (!(await isProbablyTextFile(full))) continue;
                    const content = await fs.readFile(full, 'utf8');
                    const hash = await sha256String(content);
                    await fs.mkdir(paths.contentPoolDir, { recursive: true });
                    const poolPath = path.join(paths.contentPoolDir, hash);
                    if (!(await pathExists(poolPath))) await fs.writeFile(poolPath, content, 'utf8');
                    files.push({ rel, hash });
                }
            }
        };
        await walk(projectPath);
        const refsDir = path.join(paths.refsDir, checkpointId);
        await fs.mkdir(refsDir, { recursive: true });
        for (const f of files) {
            const safe = f.rel.replaceAll(path.sep, '__');
            await writeJsonFilePretty(path.join(refsDir, `${safe}.json`), {
                checkpoint_id: checkpointId,
                file_path: f.rel,
                hash: f.hash,
                is_deleted: false,
            });
        }
        return files;
    }

    /**
     * 对应 Rust command: create_checkpoint
     *
     * 语义（简化）
     * - 读取当前 session jsonl（可选截断到 messageIndex）
     * - 对项目文件做一次快照（仅文本文件 + 小文件）
     * - 写入 checkpoints/<id>/{metadata.json,messages.jsonl}
     * - 更新 timeline.json（追加 checkpoint，更新 currentCheckpointId，重建树）
     */
    async create_checkpoint({ sessionId, projectId, projectPath, messageIndex, description }) {
        const sid = String(sessionId);
        const pid = String(projectId);
        const ppath = String(projectPath);
        const paths = await this._checkpointPaths({ projectId: pid, sessionId: sid });
        await fs.mkdir(paths.checkpointsDir, { recursive: true });
        const checkpointId = cryptoRandomId();
        const sessionFile = path.join(await findClaudeDir(), 'projects', pid, `${sid}.jsonl`);
        let messages = '';
        if (await pathExists(sessionFile)) {
            const content = await fs.readFile(sessionFile, 'utf8');
            if (typeof messageIndex === 'number') {
                const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
                messages = lines.slice(0, Math.max(0, messageIndex + 1)).join('\n') + (lines.length > 0 ? '\n' : '');
            } else {
                messages = content.endsWith('\n') ? content : content + '\n';
            }
        }
        const cpDir = path.join(paths.checkpointsDir, checkpointId);
        await fs.mkdir(cpDir, { recursive: true });
        const fileRefs = await this._snapshotProjectFiles({ projectPath: ppath, checkpointId, paths });
        const checkpoint = {
            id: checkpointId,
            sessionId: sid,
            projectId: pid,
            messageIndex: typeof messageIndex === 'number' ? messageIndex : Math.max(0, messages.split(/\r?\n/).filter((l) => l.trim().length > 0).length - 1),
            timestamp: new Date().toISOString(),
            description: description ? String(description) : null,
            parentCheckpointId: null,
            metadata: {
                totalTokens: 0,
                modelUsed: 'unknown',
                userPrompt: '',
                fileChanges: fileRefs.length,
                snapshotSize: 0,
            },
        };
        await writeJsonFilePretty(path.join(cpDir, 'metadata.json'), checkpoint);
        await fs.writeFile(path.join(cpDir, 'messages.jsonl'), messages, 'utf8');
        const timeline = await this._loadTimeline(paths, sid);
        timeline.checkpoints.push(checkpoint);
        timeline.totalCheckpoints = timeline.checkpoints.length;
        timeline.currentCheckpointId = checkpointId;
        timeline.rootNode = buildTimelineTree(timeline.checkpoints, checkpointId);
        await this._saveTimeline(paths, timeline);
        return { checkpoint, files_processed: fileRefs.length, warnings: [] };
    }

    /**
     * 对应 Rust command: restore_checkpoint
     *
     * 语义（简化）
     * - 用 checkpoint 的 messages.jsonl 覆盖回 session jsonl（实现“回到某个时刻的对话”）
     * - 用 refs + content_pool 恢复项目文件内容
     * - 更新 timeline.json 的 currentCheckpointId
     */
    async restore_checkpoint({ checkpointId, sessionId, projectId, projectPath }) {
        const sid = String(sessionId);
        const pid = String(projectId);
        const ppath = String(projectPath);
        const paths = await this._checkpointPaths({ projectId: pid, sessionId: sid });
        const cpDir = path.join(paths.checkpointsDir, String(checkpointId));
        if (!(await pathExists(cpDir))) throw new Error('Checkpoint not found: ' + checkpointId);
        const meta = await readJsonFile(path.join(cpDir, 'metadata.json'), null);
        if (!meta) throw new Error('Failed to load checkpoint metadata');
        const messages = await fs.readFile(path.join(cpDir, 'messages.jsonl'), 'utf8');
        const sessionFile = path.join(await findClaudeDir(), 'projects', pid, `${sid}.jsonl`);
        await fs.writeFile(sessionFile, messages, 'utf8');
        const refsDir = path.join(paths.refsDir, String(checkpointId));
        let restored = 0;
        if (await pathExists(refsDir)) {
            const refs = await fs.readdir(refsDir, { withFileTypes: true });
            for (const r of refs) {
                if (!r.isFile() || path.extname(r.name) !== '.json') continue;
                const ref = await readJsonFile(path.join(refsDir, r.name), null);
                if (!ref) continue;
                if (ref.is_deleted) {
                    const target = path.join(ppath, String(ref.file_path));
                    try {
                        await fs.rm(target, { force: true });
                    } catch {
                        null;
                    }
                    restored += 1;
                    continue;
                }
                const poolPath = path.join(paths.contentPoolDir, String(ref.hash));
                if (!(await pathExists(poolPath))) continue;
                const content = await fs.readFile(poolPath, 'utf8');
                const target = path.join(ppath, String(ref.file_path));
                await fs.mkdir(path.dirname(target), { recursive: true });
                await fs.writeFile(target, content, 'utf8');
                restored += 1;
            }
        }
        const timeline = await this._loadTimeline(paths, sid);
        timeline.currentCheckpointId = String(checkpointId);
        timeline.rootNode = buildTimelineTree(timeline.checkpoints, String(checkpointId));
        await this._saveTimeline(paths, timeline);
        return { checkpoint: meta, files_processed: restored, warnings: [] };
    }

    /**
     * 对应 Rust command: list_checkpoints
     * - 直接返回 timeline.json 中的 checkpoints 数组
     */
    async list_checkpoints({ sessionId, projectId, projectPath }) {
        const sid = String(sessionId);
        const pid = String(projectId);
        const paths = await this._checkpointPaths({ projectId: pid, sessionId: sid });
        const timeline = await this._loadTimeline(paths, sid);
        return Array.isArray(timeline.checkpoints) ? timeline.checkpoints : [];
    }

    /**
     * 对应 Rust command: fork_from_checkpoint
     *
     * 语义（简化）
     * - 复制原 session 的 jsonl 到 newSessionId
     * - 在新 session 上创建一个 checkpoint（并把 parentCheckpointId 指向源 checkpoint）
     */
    async fork_from_checkpoint({ checkpointId, sessionId, projectId, projectPath, newSessionId, description }) {
        const claudeDir = await findClaudeDir();
        const pid = String(projectId);
        const sourceSid = String(sessionId);
        const targetSid = String(newSessionId);
        const source = path.join(claudeDir, 'projects', pid, `${sourceSid}.jsonl`);
        const target = path.join(claudeDir, 'projects', pid, `${targetSid}.jsonl`);
        if (await pathExists(source)) {
            await fs.copyFile(source, target);
        }
        const result = await this.create_checkpoint({
            sessionId: targetSid,
            projectId: pid,
            projectPath: String(projectPath),
            messageIndex: undefined,
            description: description ?? null,
        });
        result.checkpoint.parentCheckpointId = String(checkpointId);
        const paths = await this._checkpointPaths({ projectId: pid, sessionId: targetSid });
        const cpDir = path.join(paths.checkpointsDir, result.checkpoint.id);
        await writeJsonFilePretty(path.join(cpDir, 'metadata.json'), result.checkpoint);
        const timeline = await this._loadTimeline(paths, targetSid);
        const idx = timeline.checkpoints.findIndex((c) => c.id === result.checkpoint.id);
        if (idx >= 0) timeline.checkpoints[idx] = result.checkpoint;
        timeline.rootNode = buildTimelineTree(timeline.checkpoints, timeline.currentCheckpointId);
        await this._saveTimeline(paths, timeline);
        return result;
    }

    /**
     * 对应 Rust command: get_session_timeline
     * - 将 timeline.json 的字段映射为前端期望的结构（snake_case）
     */
    async get_session_timeline({ sessionId, projectId, projectPath }) {
        const sid = String(sessionId);
        const pid = String(projectId);
        const paths = await this._checkpointPaths({ projectId: pid, sessionId: sid });
        const timeline = await this._loadTimeline(paths, sid);
        return {
            session_id: sid,
            root_node: timeline.rootNode,
            current_checkpoint_id: timeline.currentCheckpointId,
            auto_checkpoint_enabled: Boolean(timeline.autoCheckpointEnabled),
            checkpoint_strategy: timeline.checkpointStrategy || 'smart',
            total_checkpoints: Number(timeline.totalCheckpoints) || 0,
        };
    }

    /**
     * 对应 Rust command: update_checkpoint_settings
     * - 更新 timeline.json 的 autoCheckpointEnabled / checkpointStrategy
     */
    async update_checkpoint_settings({ sessionId, projectId, projectPath, autoCheckpointEnabled, checkpointStrategy }) {
        const sid = String(sessionId);
        const pid = String(projectId);
        const paths = await this._checkpointPaths({ projectId: pid, sessionId: sid });
        const timeline = await this._loadTimeline(paths, sid);
        const strat = String(checkpointStrategy ?? '');
        if (!['manual', 'per_prompt', 'per_tool_use', 'smart'].includes(strat)) {
            throw new Error('Invalid checkpoint strategy: ' + strat);
        }
        timeline.autoCheckpointEnabled = Boolean(autoCheckpointEnabled);
        timeline.checkpointStrategy = strat;
        await this._saveTimeline(paths, timeline);
        return;
    }

    /**
     * 对应 Rust command: get_checkpoint_diff
     *
     * 当前实现
     * - 仅加载两端 metadata.json，并返回 token_delta
     * - modified/added/deleted 文件列表留空（尚未实现真正 diff）
     */
    async get_checkpoint_diff({ fromCheckpointId, toCheckpointId, sessionId, projectId }) {
        const sid = String(sessionId);
        const pid = String(projectId);
        const claudeDir = await findClaudeDir();
        const baseDir = path.join(claudeDir, 'projects', pid, '.timelines', sid);
        const loadMeta = async (cid) => {
            const p = path.join(baseDir, 'checkpoints', cid, 'metadata.json');
            return await readJsonFile(p, null);
        };
        const fromMeta = await loadMeta(String(fromCheckpointId));
        const toMeta = await loadMeta(String(toCheckpointId));
        const tokenDelta = (toMeta?.metadata?.totalTokens ?? 0) - (fromMeta?.metadata?.totalTokens ?? 0);
        return {
            from_checkpoint_id: String(fromCheckpointId),
            to_checkpoint_id: String(toCheckpointId),
            modified_files: [],
            added_files: [],
            deleted_files: [],
            token_delta: tokenDelta,
        };
    }

    /**
     * 对应 Rust command: track_checkpoint_message
     * - Rust 版会把消息传给 checkpoint manager 用于自动策略判断等
     * - Node 简化实现暂不维护增量状态，因此这里是 no-op
     */
    async track_checkpoint_message({ sessionId, projectId, projectPath, message }) {
        return;
    }

    /**
     * 对应 Rust command: check_auto_checkpoint
     *
     * 目的
     * - 根据设置的策略判断是否应该自动创建 checkpoint
     *
     * 当前实现（启发式）
     * - manual: 永不触发
     * - per_prompt: 当消息是 user role 触发
     * - per_tool_use: 当 assistant content 中包含 tool_use 触发
     * - smart: 当 tool name 看起来是写/删/改类操作时触发（write/create/delete/edit/patch）
     *
     * 注意
     * - message 参数来自前端，可能是 JSONL 字符串（也可能不是），这里 try/catch 宽容处理
     */
    async check_auto_checkpoint({ sessionId, projectId, projectPath, message }) {
        const sid = String(sessionId);
        const pid = String(projectId);
        const paths = await this._checkpointPaths({ projectId: pid, sessionId: sid });
        const timeline = await this._loadTimeline(paths, sid);
        if (!timeline.autoCheckpointEnabled) return false;
        const strat = timeline.checkpointStrategy || 'smart';
        const msg = String(message ?? '');
        let json;
        try {
            json = JSON.parse(msg);
        } catch {
            json = null;
        }
        if (strat === 'manual') return false;
        if (strat === 'per_prompt') {
            const role = json?.message?.role;
            return role === 'user';
        }
        if (strat === 'per_tool_use') {
            const content = json?.message?.content;
            if (!Array.isArray(content)) return false;
            return content.some((c) => c?.type === 'tool_use');
        }
        const content = json?.message?.content;
        if (Array.isArray(content)) {
            for (const c of content) {
                if (c?.type === 'tool_use' && typeof c?.name === 'string') {
                    const n = c.name.toLowerCase();
                    if (n.includes('write') || n.includes('create') || n.includes('delete') || n.includes('edit') || n.includes('patch')) return true;
                }
            }
        }
        return false;
    }

    /**
     * 对应 Rust command: cleanup_old_checkpoints
     *
     * 行为
     * - 保留最近 keepCount 个 checkpoint（按 timestamp 逆序）
     * - 删除其余 checkpoints/<id> 与 refs/<id> 目录
     * - 更新 timeline.json 并返回删除数量
     */
    async cleanup_old_checkpoints({ sessionId, projectId, projectPath, keepCount }) {
        const sid = String(sessionId);
        const pid = String(projectId);
        const paths = await this._checkpointPaths({ projectId: pid, sessionId: sid });
        const timeline = await this._loadTimeline(paths, sid);
        const keep = Math.max(0, Number(keepCount ?? 0));
        if (timeline.checkpoints.length <= keep) return 0;
        const sorted = [...timeline.checkpoints].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
        const keepIds = new Set(sorted.slice(0, keep).map((c) => c.id));
        const toRemove = timeline.checkpoints.filter((c) => !keepIds.has(c.id));
        for (const c of toRemove) {
            const cpDir = path.join(paths.checkpointsDir, c.id);
            await fs.rm(cpDir, { recursive: true, force: true });
            const refsDir = path.join(paths.refsDir, c.id);
            await fs.rm(refsDir, { recursive: true, force: true });
        }
        timeline.checkpoints = timeline.checkpoints.filter((c) => keepIds.has(c.id));
        timeline.totalCheckpoints = timeline.checkpoints.length;
        if (timeline.currentCheckpointId && !keepIds.has(timeline.currentCheckpointId)) {
            timeline.currentCheckpointId = timeline.checkpoints[0]?.id ?? null;
        }
        timeline.rootNode = buildTimelineTree(timeline.checkpoints, timeline.currentCheckpointId);
        await this._saveTimeline(paths, timeline);
        return toRemove.length;
    }

    /**
     * 对应 Rust command: get_checkpoint_settings
     * - 返回 timeline 的当前设置与统计
     */
    async get_checkpoint_settings({ sessionId, projectId, projectPath }) {
        const sid = String(sessionId);
        const pid = String(projectId);
        const paths = await this._checkpointPaths({ projectId: pid, sessionId: sid });
        const timeline = await this._loadTimeline(paths, sid);
        return {
            auto_checkpoint_enabled: Boolean(timeline.autoCheckpointEnabled),
            checkpoint_strategy: timeline.checkpointStrategy || 'smart',
            total_checkpoints: timeline.totalCheckpoints || 0,
            current_checkpoint_id: timeline.currentCheckpointId ?? null,
        };
    }

    /**
     * 对应 Rust command: clear_checkpoint_manager
     * - Rust 版会释放内存中的 manager；Node 版没有长生命周期 manager，因此 no-op
     */
    async clear_checkpoint_manager({ sessionId }) {
        return;
    }

    /**
     * 对应 Rust command: get_checkpoint_state_stats
     * - Rust 版用于调试/监控 checkpoint manager 活跃数
     * - Node 版没有常驻 manager，因此返回固定值
     */
    async get_checkpoint_state_stats() {
        return { active_managers: 0, active_sessions: [] };
    }

    /**
     * 对应 Rust command: get_recently_modified_files
     *
     * 行为（简化）
     * - 递归遍历 projectPath
     * - 返回 mtime 在最近 N 分钟内的文件绝对路径列表
     */
    async get_recently_modified_files({ sessionId, projectId, projectPath, minutes }) {
        const root = String(projectPath ?? '');
        if (!root) return [];
        const sinceMs = Date.now() - Math.max(0, Number(minutes ?? 0)) * 60 * 1000;
        const out = [];
        const walk = async (current) => {
            const entries = await fs.readdir(current, { withFileTypes: true });
            for (const entry of entries) {
                if (isHiddenName(entry.name)) continue;
                const full = path.join(current, entry.name);
                if (entry.isDirectory()) {
                    if (isSkippedDirName(entry.name)) continue;
                    await walk(full);
                } else if (entry.isFile()) {
                    const st = await fs.stat(full);
                    if (st.mtimeMs >= sinceMs) out.push(full);
                }
            }
        };
        if (await pathExists(root)) await walk(root);
        return out;
    }

    /**
     * 对应 Rust command: track_session_messages
     * - Rust 版会把一批消息写入 checkpoint manager
     * - Node 版暂不维护增量状态，因此 no-op
     */
    async track_session_messages({ sessionId, projectId, projectPath, messages }) {
        return;
    }
}

/**
 * 生成一个 16 字节的随机 hex 字符串作为 checkpointId。
 *
 * 注意
 * - 这里为了避免引入额外依赖，使用 Math.random() 做伪随机
 * - 若用于安全相关 ID，应替换为 crypto.randomBytes
 */
function cryptoRandomId() {
    const bytes = new Uint8Array(16);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    return Buffer.from(bytes).toString('hex');
}

/**
 * 根据 checkpoints 的 parentCheckpointId 字段构建一棵树（timeline rootNode）。
 *
 * 说明
 * - Rust 版的 timeline 结构更丰富，这里只构建最基础的父子关系
 * - 同时兼容 parentCheckpointId（camelCase）与 parent_checkpoint_id（snake_case）
 *
 * currentCheckpointId
 * - 当前实现并未基于该参数做高亮或裁剪，仅保留以便未来扩展
 */
function buildTimelineTree(checkpoints, currentCheckpointId) {
    if (!Array.isArray(checkpoints) || checkpoints.length === 0) return null;
    const nodes = new Map();
    for (const c of checkpoints) {
        nodes.set(c.id, { checkpoint: c, children: [], file_snapshot_ids: [] });
    }
    let root = null;
    for (const c of checkpoints) {
        const node = nodes.get(c.id);
        const parentId = c.parentCheckpointId || c.parent_checkpoint_id || null;
        if (parentId && nodes.has(parentId)) {
            nodes.get(parentId).children.push(node);
        } else {
            if (!root) root = node;
        }
    }
    return root;
}

/**
 * 默认导出一个单例，方便集成方直接 import 后使用：
 * - 调用命令：await claudeNodeBackend.list_projects()
 * - 监听事件：claudeNodeBackend.on('claude-output', handler)
 */
export const claudeNodeBackend = new ClaudeNodeBackend();
