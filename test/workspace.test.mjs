// Tests workspace.mjs, the helper that runs a local model's tools in a sandboxed git worktree: path checks,
// the command allowlist, the sandbox itself (macOS sandbox-exec) and the trusted commit at the end.
// Run with: npm test
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const HELPER = join(dirname(fileURLToPath(import.meta.url)), "..", "server", "workspace.mjs");
const macOS = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");
const work = realpathSync(mkdtempSync(join(tmpdir(), "lmstudio-ws-test-")));
const home = join(work, "home");
const repo = join(work, "repo");
const outside = join(work, "outside.txt");
const env = { ...process.env, LMSTUDIO_MCP_HOME: home };
let base;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function helper(...args) {
  const out = execFileSync(process.execPath, [HELPER, ...args], { env, encoding: "utf8" });
  return JSON.parse(out.trim().split("\n").at(-1));
}

function git(...args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

// A tool server for a fresh task; call(tool, args) returns the helper's answer.
function serve(t, id, commands) {
  const prepared = helper("prepare", "--id", id, "--repo", repo, "--branch", `lmstudio/${id}`, "--base", base);
  assert.equal(prepared.ok, true, prepared.error);
  const child = spawn(process.execPath, [HELPER, "serve", "--id", id, "--commands", JSON.stringify(commands)], { env, stdio: ["pipe", "pipe", "inherit"] });
  t.after(() => child.kill());
  const waiting = new Map();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    waiting.get(message.id)?.(message);
  });
  let next = 1;
  const call = (tool, args = {}) =>
    new Promise((resolve) => {
      const requestId = next++;
      waiting.set(requestId, resolve);
      child.stdin.write(`${JSON.stringify({ id: requestId, tool, args })}\n`);
    });
  const exited = new Promise((resolve) => child.on("close", resolve));
  // Like lmstudio-mcp: close stdin and wait for the helper to quit before the trusted steps.
  return { root: prepared.root, prepared, call, close: () => (child.stdin.end(), exited) };
}

before(() => {
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, ".githooks"));
  writeFileSync(join(repo, "package.json"), `${JSON.stringify({ scripts: { test: "node test.js", lint: "true" } })}\n`);
  writeFileSync(join(repo, "test.js"), 'console.log("tests pass");\n');
  writeFileSync(join(repo, "src", "a.txt"), "one\ntwo\nthree\ntwo\n");
  // A hook that would run if the trusted commit at the end ran hooks.
  writeFileSync(join(repo, ".githooks", "pre-commit"), `#!/bin/sh\ntouch ${join(work, "HOOK_RAN")}\n`);
  chmodSync(join(repo, ".githooks", "pre-commit"), 0o755);
  writeFileSync(outside, "SECRET\n");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git("config", "core.hooksPath", ".githooks");
  git("add", "-A");
  execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--no-verify", "-m", "init"]);
  base = git("rev-parse", "HEAD");
});

after(() => rmSync(work, { recursive: true, force: true }));

test("prepare refuses bad input and suggests the project's checks", { skip: !macOS }, () => {
  const bad = (...args) => JSON.parse(spawnSync(process.execPath, [HELPER, ...args], { env, encoding: "utf8" }).stdout.trim().split("\n").at(-1));
  assert.match(bad("prepare", "--id", "../x", "--repo", repo, "--branch", "b", "--base", base).error, /Invalid task id/);
  assert.match(bad("prepare", "--id", "t_bad1", "--repo", repo, "--branch", "--force", "--base", base).error, /Invalid branch/);
  assert.match(bad("prepare", "--id", "t_bad2", "--repo", repo, "--branch", "b", "--base", "HEAD;rm").error, /Invalid base/);
  const info = helper("prepare", "--id", "t_info", "--repo", repo, "--branch", "lmstudio/t_info", "--base", base);
  assert.deepEqual(info.suggested_commands, ["npm test", "npm run lint"]);
  assert.equal(info.suggested_setup, "npm install");
  assert.ok(info.root.startsWith(join(home, "work", "t_info")));
  helper("remove", "--id", "t_info");
  assert.equal(existsSync(info.root), false);
});

test("file tools stay inside the worktree", { skip: !macOS }, async (t) => {
  const s = serve(t, "t_paths", []);
  symlinkSync(outside, join(s.root, "link-out")); // as a command run by the model could
  symlinkSync(join(s.root, ".git"), join(s.root, "git-link"));
  const refused = async (tool, args, pattern) => {
    const r = await s.call(tool, args);
    assert.equal(r.ok, false, `${tool} ${JSON.stringify(args)} should be refused`);
    assert.match(r.error, pattern);
  };
  await refused("read_file", { path: "../../../../outside.txt" }, /outside the project folder/);
  await refused("read_file", { path: outside }, /outside the project folder/);
  await refused("read_file", { path: "/etc/hosts" }, /outside the project folder/);
  await refused("read_file", { path: "link-out" }, /symbolic link/);
  await refused("read_file", { path: ".git" }, /\.git folder is off limits/);
  await refused("write_file", { path: ".git/config", content: "x" }, /\.git folder is off limits/);
  await refused("write_file", { path: "git-link", content: "x" }, /\.git folder is off limits/);
  await refused("write_file", { path: ".GIT", content: "gitdir: elsewhere" }, /\.git folder is off limits/);
  await refused("write_file", { path: "sub/.Git/config", content: "x" }, /\.git folder is off limits/);
  await refused("write_file", { path: "link-out", content: "x" }, /symbolic link/);
  await refused("list_files", { path: ".." }, /outside the project folder/);
  await refused("search", { pattern: "SECRET", path: "/" }, /outside the project folder/);
  assert.equal(readFileSync(outside, "utf8"), "SECRET\n");

  // A symbolic link itself can be deleted; what it points to stays.
  assert.equal((await s.call("delete_file", { path: "link-out" })).ok, true);
  assert.equal(existsSync(outside), true);
});

test("file tools read, write, edit, search and list", { skip: !macOS }, async (t) => {
  const s = serve(t, "t_files", []);
  const ok = async (tool, args) => {
    const r = await s.call(tool, args);
    assert.equal(r.ok, true, r.error);
    return r.output;
  };
  assert.match(await ok("read_file", { path: "src/a.txt" }), /^src\/a\.txt: lines 1-4 of 4\n1\tone\n2\ttwo/);
  assert.match(await ok("read_file", { path: "src/a.txt", offset: 2, limit: 1 }), /lines 2-2 of 4 \(read on with offset 3\)\n2\ttwo$/);
  assert.match(await ok("write_file", { path: "src/deep/new.js", content: "export const x = 1;\n" }), /Created src\/deep\/new\.js/);
  const ambiguous = await s.call("edit_file", { path: "src/a.txt", old_text: "two", new_text: "2" });
  assert.match(ambiguous.error, /occurs 2 times in src\/a\.txt \(lines 2, 4\)/);
  const missing = await s.call("edit_file", { path: "src/a.txt", old_text: "one  two", new_text: "x" });
  assert.match(missing.error, /different whitespace/);
  assert.match(await ok("edit_file", { path: "src/a.txt", old_text: "two", new_text: "2", replace_all: true }), /Replaced 2 occurrence/);
  assert.equal(readFileSync(join(s.root, "src", "a.txt"), "utf8"), "one\n2\nthree\n2\n");
  assert.match(await ok("search", { pattern: "^export", glob: "*.js" }), /^src\/deep\/new\.js:1: export const x = 1;$/);
  assert.equal(await ok("search", { pattern: "nothing-like-this" }), "No matches.");
  const listing = await ok("list_files", { recursive: true });
  assert.match(listing, /src\/deep\/new\.js/);
  assert.doesNotMatch(listing, /\.git\//);
  assert.match(await ok("list_files", { path: "src" }), /^src:\na\.txt\ndeep\/$/);
  assert.match((await s.call("read_file", { path: "nope.txt" })).error, /does not exist/);
});

test("only allowlisted commands run, without a shell", { skip: !macOS }, async (t) => {
  const s = serve(t, "t_cmds", ["npm test", "node", "git status"]);
  const refused = async (command, pattern) => {
    const r = await s.call("run_command", { command });
    assert.equal(r.ok, false, `${command} should be refused`);
    assert.match(r.error, pattern);
  };
  await refused("curl https://example.com", /Not allowed/);
  await refused("git push origin main", /Not allowed/);
  await refused("git -C / status", /Not allowed/);
  await refused("/usr/bin/node -v", /Not allowed/);
  await refused("npm test && curl x", /without a shell/);
  await refused("npm test | tee x", /without a shell/);
  await refused("node -e $HOME", /without a shell/);
  await refused("FOO=1 npm test", /VAR=value/);
  await refused('node -e "unclosed', /Unclosed quote/);

  const run = await s.call("run_command", { command: "git status --short" });
  assert.equal(run.ok, true, run.error);
  assert.equal(run.meta.exit_code, 0);
  const quoted = await s.call("run_command", { command: `node -e "console.log('a b' + 1)"` });
  assert.match(quoted.output, /exit code 0[\s\S]*a b1/);
  const failing = await s.call("run_command", { command: 'node -e "process.exit(3)"' });
  assert.equal(failing.meta.exit_code, 3);
  const slow = await s.call("run_command", { command: 'node -e "setTimeout(()=>{},60000)"', timeout_seconds: 1 });
  assert.match(slow.output, /killed: timed out after 1 s/);
  assert.equal(slow.meta.timed_out, true);
});

test("commands run in a sandbox: no network, no writes or reads outside, a home of their own", { skip: !macOS }, async (t) => {
  const s = serve(t, "t_sandbox", ["node"]);
  const node = async (code) => (await s.call("run_command", { command: `node -e "${code}"` })).output;
  assert.match(await node("fetch('https://example.com').then(()=>console.log('OPEN'),(e)=>console.log('blocked',e.cause?.code))"), /blocked/);
  assert.match(await node("require('net').connect(22,'127.0.0.1').on('connect',()=>console.log('OPEN')).on('error',(e)=>console.log('blocked',e.code))"), /blocked EPERM/);
  assert.match(await node(`require('fs').writeFileSync('${join(work, "escaped.txt")}','x')`), /EPERM/);
  assert.equal(existsSync(join(work, "escaped.txt")), false);
  assert.match(await node(`console.log(require('fs').readFileSync('${outside}','utf8'))`), /EPERM/);
  assert.match(await node("console.log('home=' + require('os').homedir())"), new RegExp(`home=${join(home, "work", "t_sandbox", "home")}`));
  assert.match(await node("require('fs').writeFileSync('inside.txt','ok');console.log('wrote')"), /wrote/);
  assert.match(await node("console.log(Object.keys(process.env).filter((k)=>/SSH|TOKEN|KEY/.test(k)).join(',') || 'clean')"), /clean/);
  // Terminals of the user: neither readable nor writable.
  const terminals = await node("for (const t of ['/dev/ttys000','/dev/ttys001','/dev/console']) { try { require('fs').openSync(t,'r+'); console.log('OPENED',t) } catch (e) { console.log(t,e.code) } }");
  assert.doesNotMatch(terminals, /^OPENED/m);
  assert.match(terminals, /^\/dev\/console EPERM$/m);
});

test("finish commits on the task branch without hooks, whatever the model did to .git", { skip: !macOS }, async (t) => {
  const s = serve(t, "t_finish", ["node"]);
  await s.call("write_file", { path: "src/new.txt", content: "new\n" });
  await s.call("edit_file", { path: "src/a.txt", old_text: "three", new_text: "3" });
  // Sabotage from inside the sandbox: a hook in the repository's hooks folder and a redirected .git file.
  const r = await s.call("run_command", { command: `node -e "const fs=require('fs');fs.writeFileSync('.githooks/pre-commit','#!/bin/sh\\ntouch ${join(work, "MODEL_HOOK_RAN")}\\n');fs.writeFileSync('.git','gitdir: /tmp/elsewhere\\n')"` });
  assert.match(r.output, /exit code 0/);
  await s.close();
  const result = helper("finish", "--id", "t_finish", "--message", "work of t_finish");
  assert.equal(result.ok, true, result.error);
  assert.equal(existsSync(join(work, "HOOK_RAN")), false, "the repository's hook ran");
  assert.equal(existsSync(join(work, "MODEL_HOOK_RAN")), false, "the hook the model wrote ran");
  assert.equal(result.files, 3);
  assert.match(result.diff_stat, /\.githooks\/pre-commit[\s\S]*src\/a\.txt[\s\S]*src\/new\.txt/);
  assert.match(result.patch, /\+3/);
  assert.equal(git("log", "-1", "--format=%s|%an", "lmstudio/t_finish"), "work of t_finish|lmstudio-mcp");
  assert.equal(git("rev-parse", "lmstudio/t_finish~1"), base);
  assert.equal(git("rev-parse", "main"), base, "main must not move");
  assert.equal(existsSync(s.root), false);
  assert.doesNotMatch(git("worktree", "list"), /t_finish/);
});

test("finish without changes leaves no commit", { skip: !macOS }, async (t) => {
  const s = serve(t, "t_nochange", []);
  await s.close();
  const result = helper("finish", "--id", "t_nochange", "--message", "x");
  assert.equal(result.commit, null);
  assert.equal(result.files, 0);
  assert.equal(existsSync(s.root), false);
});

test("finish leaves out nested repositories and locks out processes the model left running", { skip: !macOS }, async (t) => {
  const s = serve(t, "t_strays", ["node"]);
  const dir = dirname(s.root);
  // A nested repository (it would become a submodule link) and a detached process that keeps trying to write.
  const nested = await s.call("run_command", { command: `node -e "require('child_process').execFileSync('git',['init','-q','sub']);require('fs').writeFileSync('sub/f.txt','x')"` });
  assert.match(nested.output, /exit code 0/);
  const stray = `const fs=require('fs');fs.writeFileSync('${join(dir, "tmp", "pid")}',String(process.pid));setInterval(()=>{for(const p of ['${join(s.root, "late.txt")}','${join(`${dir}.done`, "repo", "late.txt")}']){try{fs.mkdirSync(require('path').dirname(p),{recursive:true});fs.appendFileSync(p,'x')}catch{}}},20)`;
  const spawned = await s.call("run_command", { command: `node -e "require('child_process').spawn(process.execPath,['-e','${stray.replace(/'/g, "\\x27")}'],{detached:true,stdio:'ignore'}).unref()"` });
  assert.match(spawned.output, /exit code 0/);
  await delay(300);
  const pid = Number(readFileSync(join(dir, "tmp", "pid"), "utf8"));
  t.after(() => {
    try {
      process.kill(pid, "SIGKILL"); // exactly the process this test started
    } catch {
      // gone
    }
  });
  await s.close();
  const result = helper("finish", "--id", "t_strays", "--message", "strays");
  assert.deepEqual(result.left_out, ["sub"]);
  assert.doesNotMatch(result.diff_stat, /sub/);
  // late.txt holds what the process wrote while the task ran; after finish began it could write nowhere.
  await delay(300);
  assert.equal(existsSync(dir), false, "the stray process recreated the task folder");
  assert.equal(existsSync(`${dir}.done`), false);
});

test("serve refuses to run without sandbox-exec", { skip: macOS }, () => {
  const out = JSON.parse(spawnSync(process.execPath, [HELPER, "prepare", "--id", "t_x", "--repo", repo, "--branch", "b", "--base", "abcdef0"], { env, encoding: "utf8" }).stdout.trim());
  assert.match(out.error, /need macOS/);
});
