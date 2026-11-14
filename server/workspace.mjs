#!/usr/bin/env node
// Workspace helper of lmstudio-mcp: everything a local model may do to a project during a coding task, and the
// trusted steps around it. It runs on the machine that runs LM Studio (this one, or another one over SSH) and is
// driven by lmstudio-mcp.mjs. Every command prints one JSON line ({ ok, ... }) on stdout.
//
//   mirror  --name <name>                                   bare repository that receives the base commit by push
//   prepare --id <task> --repo <git dir> --branch <branch> --base <commit>   git worktree for the task
//   setup   --id <task> --command <line>                    install step before the model starts (trusted, no sandbox)
//   serve   --id <task> --commands <json>                   the model's tools as JSON lines on stdin/stdout, sandboxed
//   finish  --id <task> --message <text>                    commit the work on the task branch, report the diff, delete the worktree
//   remove  --id <task>                                     delete the worktree
//
// The sandbox: `serve` runs itself again under macOS sandbox-exec with a deny-by-default profile. The model's tools
// and every command they start can write only inside the worktree and the task's own temp and home folders, can
// read the system, the worktree and its git folder but nothing else of the home folder, and can't use the network
// at all (localhost included). Path checks in the tools come on top of that. Trusted steps never read the
// worktree's .git file: they use the git folders recorded by prepare, and git runs without hooks. Before them the
// task folder is renamed, so that a process the model left running loses its write access (the sandbox grants
// it by path), and the worktree is deleted afterwards: nothing the model touched is handed on except the commit.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

const HOME = process.env.LMSTUDIO_MCP_HOME?.trim() || join(homedir(), ".lmstudio-mcp");
const SCRIPT = fileURLToPath(import.meta.url);
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const TASK_ID = /^t_[a-z0-9]+$/;
const MAX_OUTPUT = 20_000; // characters in one tool result
const MAX_READ_BYTES = 5_000_000;
const MAX_WRITE_BYTES = 2_000_000;
const MAX_PATCH = 2_000_000;
const PRUNE_AFTER_MS = 3 * 24 * 3600_000; // worktrees of tasks that never finished
const SHELL_CHARS = "|&;<>()$`\\\n\r";

class Refusal extends Error {} // a tool call the model has to change

// ---------- helpers ----------

function fail(message) {
  throw new Refusal(message);
}

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// Head and tail of a long output: test runners print the summary at the end.
function squeeze(text, max = MAX_OUTPUT) {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.2);
  return `${text.slice(0, head)}\n… ${text.length - max} characters left out …\n${text.slice(-(max - head))}`;
}

function taskDir(id) {
  if (!TASK_ID.test(id ?? "")) fail(`Invalid task id: ${id}`);
  return join(HOME, "work", id);
}

function readTask(id) {
  try {
    return JSON.parse(readFileSync(join(taskDir(id), "task.json"), "utf8"));
  } catch {
    fail(`No worktree for task ${id} on this machine.`);
  }
}

function git(args, options = {}) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], ...options, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...options.env } });
}

function gitError(error) {
  return String(error.stderr || error.message).trim();
}

function real(path) {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

// PATH for commands in the worktree: the Node version of .nvmrc when Homebrew has it, the Node that runs this
// helper, then the usual places.
function commandPath(root) {
  const dirs = [];
  const major = /^\s*v?(\d+)/.exec(readText(join(root, ".nvmrc")) ?? "")?.[1];
  if (major) for (const base of ["/opt/homebrew/opt", "/usr/local/opt"]) dirs.push(join(base, `node@${major}`, "bin"));
  dirs.push(dirname(process.execPath), "/opt/homebrew/bin", "/usr/local/bin");
  // /usr/bin/git on macOS is a launcher that can't work in the sandbox: put the real git first.
  const xcodeGit = process.platform === "darwin" ? spawnSync("xcrun", ["--find", "git"], { encoding: "utf8" }).stdout?.trim() : undefined;
  if (xcodeGit) dirs.push(dirname(xcodeGit));
  dirs.push("/usr/bin", "/bin", "/usr/sbin", "/sbin");
  return [...new Set(dirs.filter((dir) => existsSync(dir)))].join(":");
}

// pnpm switches to the version in package.json's packageManager from its tools folder; in the sandbox it can't
// download one, so it gets to read the versions it already has.
function pnpmHome() {
  const home = process.env.PNPM_HOME || (process.platform === "darwin" ? join(homedir(), "Library", "pnpm") : join(homedir(), ".local", "share", "pnpm"));
  return existsSync(home) ? home : undefined;
}

function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

// ---------- trusted steps ----------

function requireSandbox() {
  if (process.platform !== "darwin" || !existsSync(SANDBOX_EXEC)) {
    fail(`Coding tasks need macOS on the machine that runs LM Studio: the model's tools run inside sandbox-exec, which ${process.platform} doesn't have.`);
  }
}

function mirror({ name }) {
  if (!/^[A-Za-z0-9._-]+$/.test(name ?? "")) fail(`Invalid mirror name: ${name}`);
  const path = join(HOME, "repos", `${name}.git`);
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    git(["init", "--bare", "--quiet", path]);
  }
  return { path };
}

// Which package manager the project uses and the checks the model may run by default.
function projectInfo(root) {
  let scripts;
  try {
    scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts ?? {};
  } catch {
    return {};
  }
  const has = (file) => existsSync(join(root, file));
  const pm = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("bun.lock") || has("bun.lockb") ? "bun" : "npm";
  const run = (name) => (pm === "npm" ? (name === "test" ? "npm test" : `npm run ${name}`) : pm === "bun" ? `bun run ${name}` : `${pm} ${name}`);
  const install = {
    pnpm: "pnpm install --frozen-lockfile --prefer-offline",
    yarn: has(".yarnrc.yml") ? "yarn install --immutable" : "yarn install --frozen-lockfile",
    bun: "bun install --frozen-lockfile",
    npm: has("package-lock.json") ? "npm ci" : "npm install",
  }[pm];
  return {
    package_manager: pm,
    scripts: Object.keys(scripts),
    suggested_commands: ["test", "typecheck", "lint"].filter((name) => scripts[name]).map(run),
    suggested_setup: install,
  };
}

function prepare({ id, repo, branch, base }) {
  requireSandbox();
  if (!/^[A-Za-z0-9._/-]+$/.test(branch ?? "") || branch.startsWith("-") || branch.includes("..")) fail(`Invalid branch name: ${branch}`);
  if (!/^[0-9a-f]{7,64}$/.test(base ?? "")) fail(`Invalid base commit: ${base}`);
  if (!repo || !isAbsolute(repo)) fail(`Invalid repository path: ${repo}`);
  const dir = taskDir(id);
  if (existsSync(dir)) fail(`${dir} already exists.`);
  pruneOld();
  const root = join(dir, "repo");
  for (const sub of ["tmp", "home"]) mkdirSync(join(dir, sub), { recursive: true, mode: 0o700 });
  try {
    const exists = spawnSync("git", ["-C", repo, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).status === 0;
    const add = exists ? ["worktree", "add", "--quiet", root, branch] : ["worktree", "add", "--quiet", "-b", branch, root, base];
    git(["-C", repo, "-c", "core.hooksPath=/dev/null", ...add]);
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    fail(`Could not create the worktree: ${gitError(error)}`);
  }
  const gitDir = git(["-C", root, "rev-parse", "--absolute-git-dir"]).trim();
  const commonDir = resolve(root, git(["-C", root, "rev-parse", "--git-common-dir"]).trim());
  const task = { id, repo, branch, base, root, git_dir: gitDir, common_dir: commonDir, created_at: new Date().toISOString() };
  writeFileSync(join(dir, "task.json"), `${JSON.stringify(task, null, 2)}\n`, { mode: 0o600 });
  return { root, ...projectInfo(root) };
}

// Install step chosen by the caller (e.g. pnpm install), run before the model touches anything: it may use the
// network and the user's package store.
function setup({ id, command }) {
  const task = readTask(id);
  if (!command) fail("No setup command.");
  const started = Date.now();
  const result = spawnSync("/bin/sh", ["-c", command], {
    cwd: task.root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 30 * 60_000,
    env: { ...process.env, PATH: commandPath(task.root), CI: "1" },
  });
  return {
    exit_code: result.status ?? (result.signal ? 128 : 1),
    seconds: Math.round((Date.now() - started) / 100) / 10,
    output: squeeze(`${result.stdout ?? ""}${result.stderr ?? ""}`.trim(), 4000),
  };
}

// git for the trusted steps: the recorded git folders, never the worktree's .git file, and no hooks.
function trustedGit(task) {
  const base = ["--git-dir", task.git_dir, "--work-tree", task.root, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "commit.gpgsign=false"];
  const env = { GIT_AUTHOR_NAME: "lmstudio-mcp", GIT_AUTHOR_EMAIL: "lmstudio-mcp@localhost", GIT_COMMITTER_NAME: "lmstudio-mcp", GIT_COMMITTER_EMAIL: "lmstudio-mcp@localhost" };
  const run = (args) => git([...base, ...args], { cwd: task.root, env });
  run.status = (args) => spawnSync("git", [...base, ...args], { cwd: task.root, stdio: "ignore" }).status;
  return run;
}

function finish({ id, message }) {
  const recorded = readTask(id);
  // From here on, nothing the model started can write to the worktree: its sandbox allows writes by path.
  const dir = `${taskDir(id)}.done`;
  renameSync(taskDir(id), dir);
  const task = { ...recorded, root: join(dir, "repo") };
  try {
    const run = trustedGit(task);
    // A git repository the model made inside the worktree would be committed as a submodule link: leave it out.
    const nested = run(["ls-files", "-z", "--others", "--exclude-standard", "--directory"])
      .split("\0")
      .filter((entry) => entry.endsWith("/") && existsSync(join(task.root, entry, ".git")))
      .map((entry) => entry.slice(0, -1));
    run(["add", "-A", "--", ".", ...nested.map((path) => `:(exclude)${path}`)]);
    const leftOut = [...nested];
    for (const line of run(["diff", "--cached", "--raw", "--no-renames", "HEAD"]).split("\n").filter(Boolean)) {
      const [modes, path] = line.split("\t");
      const [oldMode, newMode] = modes.slice(1).split(" ");
      if (newMode !== "160000") continue;
      run(oldMode === "160000" ? ["reset", "--quiet", "HEAD", "--", path] : ["rm", "--cached", "--quiet", "--", path]);
      leftOut.push(path);
    }
    const changed = run.status(["diff", "--cached", "--quiet"]) === 1;
    if (changed) run(["commit", "--quiet", "--no-verify", "-m", message || `Work of task ${id}`]);
    const head = run(["rev-parse", "HEAD"]).trim();
    let files = 0;
    let insertions = 0;
    let deletions = 0;
    for (const line of run(["diff", "--numstat", task.base, head]).split("\n").filter(Boolean)) {
      const [added, removed] = line.split("\t");
      files++;
      insertions += Number(added) || 0;
      deletions += Number(removed) || 0;
    }
    const patch = run(["diff", task.base, head]);
    return {
      branch: task.branch,
      base: task.base,
      commit: head === task.base ? null : head,
      files,
      insertions,
      deletions,
      diff_stat: run(["diff", "--stat=120", task.base, head]).trimEnd(),
      patch: patch.length > MAX_PATCH ? patch.slice(0, MAX_PATCH) : patch,
      patch_truncated: patch.length > MAX_PATCH || undefined,
      left_out: leftOut.length ? leftOut : undefined,
    };
  } finally {
    removeWorktree(task);
  }
}

function removeWorktree(task) {
  try {
    git(["--git-dir", task.common_dir, "worktree", "remove", "--force", task.root]);
  } catch {
    // the worktree's admin files no longer match: delete the folder and let git forget it
  }
  rmSync(dirname(task.root), { recursive: true, force: true });
  try {
    git(["--git-dir", task.common_dir, "worktree", "prune"]);
  } catch {
    // nothing to prune
  }
  return { removed: task.root };
}

// Worktrees of tasks that were cut short (the Claude Code session ended, say) go after a few days.
function pruneOld() {
  let names = [];
  try {
    names = readdirSync(join(HOME, "work"));
  } catch {
    return;
  }
  for (const name of names.filter((n) => TASK_ID.test(n.replace(/\.done$/, "")))) {
    const dir = join(HOME, "work", name);
    try {
      if (Date.now() - statSync(dir).mtimeMs < PRUNE_AFTER_MS) continue;
      const task = JSON.parse(readText(join(dir, "task.json")) ?? "null");
      if (task?.common_dir) removeWorktree({ ...task, root: join(dir, "repo") });
      else rmSync(dir, { recursive: true, force: true });
    } catch {
      // try again next time
    }
  }
}

// ---------- the sandbox ----------

function sbString(path) {
  return `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// Folders the sandbox may never read, whatever else is opened: they hold keys, tokens and credentials.
const SECRET_PLACES = [".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".config", ".netrc", ".npmrc", ".pgpass", ".git-credentials", ".claude.json", "Library/Keychains", ".lmstudio"];

// A folder to open for reading, or undefined when that would open the home folder, a folder above it, or a folder
// right below it (~/.config, ~/Library, ~/bin...): a Node installed in ~/bin must not open the whole home folder.
function narrowRead(path) {
  const resolved = real(path) ?? path;
  const home = real(homedir()) ?? homedir();
  const down = relative(home, resolved);
  if (down === "" || (!down.startsWith("..") && !isAbsolute(down))) return down.split(sep).filter(Boolean).length >= 2 ? resolved : undefined;
  const up = relative(resolved, home);
  return up === "" || (!up.startsWith("..") && !isAbsolute(up)) ? undefined : resolved;
}

function sandboxProfile(task, path) {
  const dir = dirname(task.root);
  const writable = [task.root, join(dir, "tmp"), join(dir, "home")].map(real).filter(Boolean);
  const node = real(process.execPath) ?? process.execPath;
  // Node's installation folder, else its bin folder, else only the program itself.
  const readable = [...writable, task.git_dir, task.common_dir, SCRIPT, narrowRead(dirname(dirname(node))) ?? narrowRead(dirname(node)) ?? node];
  // git and other developer tools from Xcode or the Command Line Tools (the latter live in /Library)
  const developer = spawnSync("xcode-select", ["-p"], { encoding: "utf8" }).stdout?.trim();
  if (developer) readable.push(developer.includes(".app/") ? developer.slice(0, developer.indexOf(".app/") + 4) : developer);
  if (pnpmHome()) readable.push(join(pnpmHome(), ".tools"));
  // Programs on PATH that live in the home folder (nvm, say): their installation folder.
  for (const entry of path.split(":")) if (entry.startsWith(`${homedir()}/`)) readable.push(narrowRead(dirname(entry)) ?? narrowRead(entry));
  const system = ["/usr", "/bin", "/sbin", "/System", "/Library", "/opt", "/private/etc", "/private/var/db"];
  const subpaths = (paths) => [...new Set(paths.filter(Boolean).map((p) => real(p) ?? p))].map((p) => `(subpath ${sbString(p)})`).join(" ");
  const secrets = SECRET_PLACES.map((place) => join(homedir(), place));
  return `(version 1)
(deny default)
(allow process-exec process-fork)
(allow signal (target same-sandbox))
(allow process-info* (target same-sandbox))
(allow sysctl-read)
(allow ipc-posix-sem ipc-posix-shm)
(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo") (global-name "com.apple.PowerManagement.control"))
(allow file-read-metadata)
(allow file-read* (literal "/") (literal "/etc") (literal "/var") (literal "/tmp") ${subpaths(system)})
(allow file-read* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/random") (literal "/dev/urandom") (subpath "/dev/fd"))
(allow file-read* ${subpaths(readable)})
(deny file-read* (subpath "/opt/homebrew/var") (subpath "/usr/local/var") ${subpaths(secrets)})
(allow file-write* ${subpaths(writable)} (literal "/dev/null") (literal "/dev/zero") (literal "/dev/stdout") (literal "/dev/stderr") (subpath "/dev/fd"))
(allow file-ioctl (literal "/dev/null"))
`;
}

// The model's tools run here: a trusted parent starts this script again under sandbox-exec, with a clean
// environment, and passes stdin and stdout through.
function serve({ id, commands }) {
  requireSandbox();
  const task = readTask(id);
  const allow = JSON.parse(commands ?? "[]");
  if (!Array.isArray(allow) || allow.some((c) => typeof c !== "string" || !c.trim())) fail("--commands must be a JSON array of command lines.");
  const dir = dirname(task.root);
  const path = commandPath(task.root);
  const env = {
    PATH: path,
    HOME: join(dir, "home"),
    TMPDIR: join(dir, "tmp"),
    LANG: "en_US.UTF-8",
    TERM: "dumb",
    CI: "1",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    npm_config_update_notifier: "false",
    DO_NOT_TRACK: "1",
    TURBO_TELEMETRY_DISABLED: "1",
    NEXT_TELEMETRY_DISABLED: "1",
    LMSTUDIO_WORKSPACE: JSON.stringify({ root: task.root, allow }),
  };
  if (pnpmHome()) env.PNPM_HOME = pnpmHome();
  const child = spawn(SANDBOX_EXEC, ["-p", sandboxProfile(task, path), process.execPath, SCRIPT, "tools"], { cwd: task.root, env, stdio: "inherit" });
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => child.kill(signal));
  child.on("error", (error) => {
    process.stdout.write(`${JSON.stringify({ ok: false, error: `Could not start the sandbox: ${error.message}` })}\n`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  return null; // answers come from the child
}

// ---------- the model's tools (inside the sandbox) ----------

function tools() {
  const { root, allow } = JSON.parse(process.env.LMSTUDIO_WORKSPACE ?? "{}");
  const ROOT = realpathSync(root);
  const allowed = allow.map(parseCommand);

  const within = (path) => {
    const rel = relative(ROOT, path);
    return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
  };
  const hasGit = (rel) => rel.split(sep).some((part) => part.toLowerCase() === ".git"); // APFS ignores case
  const show = (abs) => relative(ROOT, abs) || ".";

  // The absolute path for a path the model gave: inside the project root also after following symlinks, and
  // never in .git.
  function target(path, { write = false, link = false } = {}) {
    if (path === undefined || path === null || path === "") path = ".";
    if (typeof path !== "string" || path.includes("\0")) fail("path must be a string.");
    const abs = resolve(ROOT, path);
    if (!within(abs)) fail(`${path} is outside the project folder. Use paths relative to the project root.`);
    if (hasGit(relative(ROOT, abs))) fail("The .git folder is off limits.");
    if (write && abs === ROOT) fail("That is the project root itself.");
    let probe = link ? dirname(abs) : abs; // link: the path itself may be a symbolic link (to delete it)
    for (;;) {
      try {
        lstatSync(probe);
        break;
      } catch {
        probe = dirname(probe);
      }
    }
    const resolved = real(probe);
    if (!resolved || !within(resolved)) fail(`${path} leads outside the project folder through a symbolic link.`);
    if (hasGit(relative(ROOT, resolved))) fail("The .git folder is off limits.");
    return abs;
  }

  function textOf(abs, label) {
    let info;
    try {
      info = statSync(abs);
    } catch {
      fail(`${label} does not exist.`);
    }
    if (info.isDirectory()) fail(`${label} is a folder: use list_files.`);
    if (info.size > MAX_READ_BYTES) fail(`${label} is larger than 5 MB.`);
    const buffer = readFileSync(abs);
    if (buffer.subarray(0, 8000).includes(0)) fail(`${label} is a binary file (${info.size} bytes).`);
    return buffer.toString("utf8");
  }

  // Files of the project below a folder, without what .gitignore ignores.
  function projectFiles(abs) {
    const rel = relative(ROOT, abs);
    try {
      const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", rel || "."], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
      return [...new Set(out.split("\0").filter(Boolean))].filter((file) => existsSync(join(ROOT, file)));
    } catch {
      const found = [];
      const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if ([".git", "node_modules"].includes(entry.name) || found.length > 20_000) continue;
          const full = join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else found.push(relative(ROOT, full));
        }
      };
      walk(abs);
      return found;
    }
  }

  const handlers = {
    list_files({ path, recursive }) {
      const abs = target(path);
      if (!existsSync(abs) || !statSync(abs).isDirectory()) fail(`${path} is not a folder.`);
      const prefix = relative(ROOT, abs) ? `${relative(ROOT, abs)}/` : "";
      const entries = recursive
        ? projectFiles(abs).map((file) => (file.startsWith(prefix) ? file.slice(prefix.length) : file))
        : readdirSync(abs, { withFileTypes: true })
            .filter((entry) => entry.name.toLowerCase() !== ".git")
            .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.isSymbolicLink() ? `${entry.name}@` : entry.name));
      entries.sort();
      if (!entries.length) return `${show(abs)} is empty.`;
      const shown = entries.slice(0, 1000);
      return `${show(abs)}${recursive ? " (all files below it)" : ""}:\n${shown.join("\n")}${entries.length > shown.length ? `\n… and ${entries.length - shown.length} more` : ""}`;
    },

    read_file({ path, offset = 1, limit = 400 }) {
      if (!path) fail("path is required.");
      const abs = target(path);
      const lines = textOf(abs, path).split("\n");
      if (lines.at(-1) === "") lines.pop();
      const start = Math.max(1, Math.trunc(Number(offset)) || 1);
      if (lines.length && start > lines.length) fail(`${path} has only ${lines.length} lines.`);
      const count = Math.min(Math.max(1, Math.trunc(Number(limit)) || 400), 2000);
      const out = [];
      let size = 0;
      let end = start - 1;
      for (let n = start; n <= Math.min(lines.length, start + count - 1); n++) {
        const line = `${n}\t${clip(lines[n - 1], 2000)}`;
        if (size + line.length > MAX_OUTPUT && out.length) break;
        out.push(line);
        size += line.length + 1;
        end = n;
      }
      const more = end < lines.length ? ` (read on with offset ${end + 1})` : "";
      return `${show(abs)}: lines ${lines.length ? start : 0}-${end} of ${lines.length}${more}\n${out.join("\n")}`;
    },

    search({ pattern, path, glob, ignore_case }) {
      if (typeof pattern !== "string" || !pattern) fail("pattern is required.");
      let regex;
      try {
        regex = new RegExp(pattern, ignore_case ? "i" : "");
      } catch (error) {
        fail(`Invalid regular expression: ${error.message}`);
      }
      const abs = target(path);
      if (!existsSync(abs)) fail(`${path} does not exist.`);
      const files = statSync(abs).isDirectory() ? projectFiles(abs) : [relative(ROOT, abs)];
      const globRegex = glob ? globToRegex(glob) : null;
      const results = [];
      for (const file of files) {
        if (globRegex && !globRegex.test(glob.includes("/") ? file : basename(file))) continue;
        let text;
        try {
          const full = join(ROOT, file);
          if (statSync(full).size > 1_000_000) continue;
          const buffer = readFileSync(full);
          if (buffer.subarray(0, 8000).includes(0)) continue;
          text = buffer.toString("utf8");
        } catch {
          continue;
        }
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (!regex.test(lines[i])) continue;
          results.push(`${file}:${i + 1}: ${clip(lines[i].trim(), 300)}`);
          if (results.length >= 200) return `${results.join("\n")}\n… stopped at 200 matches: narrow the search with path or glob.`;
        }
      }
      return results.length ? squeeze(results.join("\n")) : "No matches.";
    },

    write_file({ path, content }) {
      if (!path) fail("path is required.");
      if (typeof content !== "string") fail("content must be a string.");
      if (Buffer.byteLength(content) > MAX_WRITE_BYTES) fail("content is larger than 2 MB.");
      const abs = target(path, { write: true });
      const existed = existsSync(abs);
      if (existed && statSync(abs).isDirectory()) fail(`${path} is a folder.`);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
      return `${existed ? "Replaced" : "Created"} ${show(abs)} (${content.split("\n").length} lines).`;
    },

    edit_file({ path, old_text, new_text, replace_all }) {
      if (!path) fail("path is required.");
      if (typeof old_text !== "string" || !old_text) fail("old_text must be the exact text to replace; to create a file use write_file.");
      if (typeof new_text !== "string") fail("new_text must be a string.");
      const abs = target(path, { write: true });
      if (!existsSync(abs)) fail(`${path} does not exist: create it with write_file.`);
      const text = textOf(abs, path);
      const positions = [];
      for (let at = text.indexOf(old_text); at !== -1; at = text.indexOf(old_text, at + old_text.length)) positions.push(at);
      if (!positions.length) {
        const loose = (s) => s.replace(/\s+/g, " ").trim();
        const hint = loose(text).includes(loose(old_text))
          ? "The text is there with different whitespace or indentation: copy it exactly from read_file, without the line numbers."
          : "Read the file again and copy the text exactly, without the line numbers.";
        fail(`old_text was not found in ${path}. ${hint}`);
      }
      const lineOf = (at) => text.slice(0, at).split("\n").length;
      if (positions.length > 1 && !replace_all) {
        fail(`old_text occurs ${positions.length} times in ${path} (lines ${positions.slice(0, 10).map(lineOf).join(", ")}). Include more surrounding text to make it unique, or pass replace_all: true.`);
      }
      const updated = replace_all ? text.split(old_text).join(new_text) : text.slice(0, positions[0]) + new_text + text.slice(positions[0] + old_text.length);
      writeFileSync(abs, updated);
      const first = lineOf(positions[0]);
      const lines = updated.split("\n");
      const from = Math.max(1, first - 2);
      const to = Math.min(lines.length, first + new_text.split("\n").length + 1);
      const excerpt = lines.slice(from - 1, to).map((line, i) => `${from + i}\t${clip(line, 300)}`).join("\n");
      return `Replaced ${replace_all ? positions.length : 1} occurrence(s) in ${show(abs)}. Now:\n${excerpt}`;
    },

    delete_file({ path }) {
      if (!path) fail("path is required.");
      const abs = target(path, { write: true, link: true });
      let info;
      try {
        info = lstatSync(abs);
      } catch {
        fail(`${path} does not exist.`);
      }
      if (info.isDirectory()) fail(`${path} is a folder; delete_file removes files only.`);
      unlinkSync(abs);
      return `Deleted ${show(abs)}.`;
    },

    run_command({ command, timeout_seconds }) {
      if (typeof command !== "string" || !command.trim()) fail("command is required.");
      const argv = parseCommand(command);
      if (!allowed.some((prefix) => prefix.every((word, i) => argv[i] === word))) {
        fail(`Not allowed: ${command}. Allowed commands (extra arguments may follow): ${allow.join("; ") || "none"}.`);
      }
      const seconds = Math.min(Math.max(1, Math.trunc(Number(timeout_seconds)) || 600), 1800);
      return new Promise((done) => {
        const started = Date.now();
        let output = "";
        let killed;
        const child = spawn(argv[0], argv.slice(1), { cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
        running = child;
        const collect = (chunk) => {
          output += chunk;
          if (output.length > 4 * MAX_OUTPUT) output = `${output.slice(0, MAX_OUTPUT)}${output.slice(-2 * MAX_OUTPUT)}`;
        };
        child.stdout.setEncoding("utf8").on("data", collect);
        child.stderr.setEncoding("utf8").on("data", collect);
        const killGroup = () => {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            // already gone
          }
        };
        const timer = setTimeout(() => {
          killed = `timed out after ${seconds} s`;
          killGroup();
        }, seconds * 1000);
        const finished = (code, signal, error) => {
          clearTimeout(timer);
          running = undefined;
          killGroup(); // whatever the command left running in the background
          const took = Math.round((Date.now() - started) / 100) / 10;
          const exit = error ? 127 : (code ?? 128);
          const status = error ? `could not start: ${error.message}` : killed ? `killed: ${killed}` : signal ? `killed by ${signal}` : `exit code ${exit}`;
          done({ output: `$ ${command}\n${status}, ${took} s\n${squeeze(output.trim()) || "(no output)"}`, meta: { command, exit_code: exit, seconds: took, timed_out: Boolean(killed) || undefined } });
        };
        child.on("error", (error) => finished(null, null, error));
        child.on("close", (code, signal) => finished(code, signal));
      });
    },
  };

  let running; // the command being run, so that a closed stdin can stop it
  let closing = false;
  async function handleLine(line) {
    if (closing) return;
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      return;
    }
    const { id, tool, args } = request;
    const reply = (fields) => process.stdout.write(`${JSON.stringify({ id, ...fields }).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")}\n`);
    const handler = Object.hasOwn(handlers, tool) ? handlers[tool] : undefined;
    if (!handler) return reply({ ok: false, error: `Unknown tool ${tool}.` });
    try {
      if (typeof args !== "object" || args === null || Array.isArray(args)) fail("The arguments must be a JSON object.");
      const result = await handler(args);
      reply(typeof result === "string" ? { ok: true, output: result } : { ok: true, ...result });
    } catch (error) {
      reply({ ok: false, error: error instanceof Refusal ? error.message : `${error.code ? `${error.code}: ` : ""}${error.message}` });
    }
  }

  // One request at a time, in order.
  let queue = Promise.resolve();
  const decoder = new StringDecoder("utf8");
  let pending = "";
  process.stdin.on("data", (chunk) => {
    pending += decoder.write(chunk);
    let index;
    while ((index = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, index);
      pending = pending.slice(index + 1);
      if (line.trim()) queue = queue.then(() => handleLine(line));
    }
  });
  // lmstudio-mcp went away or cancelled the task: stop the running command and quit.
  process.stdin.on("end", () => {
    closing = true;
    if (running) {
      try {
        process.kill(-running.pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    queue.then(() => process.exit(0));
  });
  process.stdout.on("error", () => process.exit(0));
  return null;
}

// Splits a command line into words like a shell would for plain words and quotes, but refuses everything that
// needs a shell: the command runs without one.
function parseCommand(line) {
  const words = [];
  let word = null;
  let quote = null;
  for (const ch of line.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else word += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      word ??= "";
    } else if (/\s/.test(ch)) {
      if (word !== null) words.push(word);
      word = null;
    } else if (SHELL_CHARS.includes(ch)) {
      fail(`Commands run without a shell, so "${ch === "\n" ? "\\n" : ch}" is not supported: no pipes, &&, ;, redirection, $variables or backslashes. Run one command at a time.`);
    } else word = (word ?? "") + ch;
  }
  if (quote) fail("Unclosed quote in the command.");
  if (word !== null) words.push(word);
  if (!words.length) fail("Empty command.");
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) fail("Commands run without a shell: VAR=value before the command is not supported.");
  return words;
}

function globToRegex(glob) {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*" && glob[i + 1] === "*") {
      source += ".*";
      i++;
      if (glob[i + 1] === "/") i++;
    } else if (ch === "*") source += "[^/]*";
    else if (ch === "?") source += "[^/]";
    else if (ch === "{") source += "(?:";
    else if (ch === "}") source += ")";
    else if (ch === "," && source.includes("(?:")) source += "|";
    else source += ch.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

// ---------- command line ----------

const COMMANDS = { mirror, prepare, setup, serve, finish, remove: ({ id }) => removeWorktree(readTask(id)), tools };

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith("--")) fail(`Unexpected argument: ${rest[i]}`);
    options[rest[i].slice(2)] = rest[++i];
  }
  const run = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
  if (!run) fail(`Unknown command: ${command}. Commands: ${Object.keys(COMMANDS).filter((c) => c !== "tools").join(", ")}.`);
  return run(options);
}

try {
  const result = main();
  if (result) process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Refusal ? error.message : String(error.stack ?? error) })}\n`);
  process.exitCode = 1;
}
