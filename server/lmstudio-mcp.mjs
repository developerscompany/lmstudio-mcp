#!/usr/bin/env node
// LM Studio MCP server: lets Claude Code (or any MCP client) run a local LM Studio. It controls the API
// server, models (list, estimate, load, unload, download, per-model defaults), sessions with context
// control, background tasks, one-off chat and embeddings.
// No dependencies: needs only Node.js 20+. Talks to LM Studio's REST API v1 and its `lms` CLI, on this
// machine or, over SSH, on another one.

import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir, totalmem } from "node:os";
import { dirname, extname, isAbsolute, join } from "node:path";
import { Duplex } from "node:stream";
import { StringDecoder } from "node:string_decoder";

const VERSION = "0.3.1";
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const QUICK_MS = 30_000;
const STREAM_IDLE_MS = 10 * 60_000; // give up on a streamed answer after 10 minutes without any event
const MAX_IMAGE_BYTES = 20_000_000;
const MAX_FILE_BYTES = 2_000_000; // per attached text file
const CONTEXT_WARNING_PERCENT = 80;
const IMAGE_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };
const GPU_PATTERN = "^(off|max|0(\\.\\d+)?|1(\\.0+)?)$";
const NOT_A_FLAG = "^[^-]"; // values passed to `lms` must not look like command-line options
const LMS_LOAD_KEYS = ["ttl", "gpu", "parallel", "identifier"];
const REST_LOAD_KEYS = ["flash_attention", "eval_batch_size", "num_experts", "offload_kv_cache_to_gpu"];
const DEFAULT_KEYS = ["context_length", "ttl", "gpu", "parallel"];
const SESSION_KEYS = ["model", "title", "system_prompt", "context_length", "reload", "temperature", "max_output_tokens", "reasoning", "integrations"];
const COMPACT_PROMPT =
  "Summarize our conversation so far so it can continue in a fresh context. Keep every fact, decision, constraint, " +
  "open question and the current state of the work. Write compact notes in the language of the conversation, not a chat reply.";

const INSTRUCTIONS = `Tools for the user's LM Studio: server control, models, sessions, background tasks and local inference.
- Start with server_status. If LM Studio is not reachable, call server_start (not available when only a URL of another machine is set).
- Models: list_models shows what is downloaded and loaded. Check memory with estimate_load before loading. Ask the user before loading a model that needs more than about half of system_ram (in server_status: the RAM of the machine that runs LM Studio), and before every download_model: downloads can be tens of GB. load_model keeps a model that is already loaded; pass replace: true to reload it with other settings.
- Context: model_defaults saves per-model load settings (context_length, ttl, gpu, parallel) that load_model, chat, sessions and tasks then use. When the user says a model needs a certain context (for example 262144 tokens), save it there. Saved defaults are the user's choice: leave context_length out of load_model, session_start, task_start, chat and estimate_load so that they apply, and pass it only when the user asks for another value.
- Sessions are conversations kept in LM Studio: session_start (model, optional system_prompt and context_length), then session_send. Every answer shows how full the context is; past ${CONTEXT_WARNING_PERCENT}% run session_compact or start a new session. session_get lists the sessions or shows one.
- Tasks run a session turn in the background: task_start returns a task_id at once; follow it with task_status (wait_seconds waits for the result) and stop it with task_cancel. Use tasks for long jobs so you can keep working meanwhile. Tasks stop when this Claude Code session ends.
- chat is a one-off prompt without history. chat, sessions and tasks load the model when needed.
- To give the local model code, logs or documents, pass their paths in files (chat, session_send, task_start) instead of pasting the text: the files are read from disk and added to the message.
- Unload the models you loaded once the work is done, unless the user wants them kept. Check local answers before relying on them.`;

const HELP = `lmstudio-mcp ${VERSION}: MCP server (stdio) for LM Studio.

Environment (all optional):
  LMSTUDIO_BASE_URL     LM Studio API URL. Default: detected with \`lms server status\`, else http://127.0.0.1:1234
  LM_API_TOKEN          API token, if authentication is enabled in LM Studio
  LMSTUDIO_SSH_HOST     SSH host of another machine that runs LM Studio (an alias from ~/.ssh/config or user@host).
                        lms then runs there and API requests travel through SSH; LMSTUDIO_BASE_URL is ignored
  LMS_PATH              Path to the lms CLI (on the SSH host, if one is set). Default: ~/.lmstudio/bin/lms, else lms on PATH
  LMSTUDIO_TIMEOUT_MS   Timeout for loading a model. Default: 1200000 (20 min)
  LMSTUDIO_MCP_HOME     Where sessions, tasks and model defaults are kept. Default: ~/.lmstudio-mcp`;

// setTimeout can't wait longer than 2^31-1 ms, so keep the setting in a sane range.
const LOAD_TIMEOUT_MS = Math.min(Math.max(Math.trunc(Number(setting("LMSTUDIO_TIMEOUT_MS"))) || 20 * 60_000, 1000), 2 ** 31 - 1);
const HOME = setting("LMSTUDIO_MCP_HOME") ?? join(homedir(), ".lmstudio-mcp");
// LM Studio on another machine, reached over SSH: lms runs there and API requests go through `ssh -W`,
// so nothing has to listen on the network.
const SSH_HOST = setting("LMSTUDIO_SSH_HOST");

// An error to show to the caller as it is. Errors answered by LM Studio also carry `status` (HTTP) and `param`.
class UserError extends Error {
  constructor(message, details) {
    super(message);
    Object.assign(this, details);
  }
}

function log(...parts) {
  console.error("[lmstudio-mcp]", ...parts);
}

// An unset plugin option can arrive empty or as a literal "${...}" placeholder: treat both as unset.
function setting(name) {
  const value = process.env[name]?.trim();
  return value && !value.includes("${") ? value : undefined;
}

function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, v]) => v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0)));
}

function pick(object, keys) {
  return compact(Object.fromEntries(keys.map((key) => [key, object?.[key]])));
}

function gb(bytes) {
  return Number.isFinite(bytes) ? `${(bytes / 1e9).toFixed(2)} GB` : undefined;
}

function clip(text, max) {
  return typeof text === "string" && text.length > max ? `${text.slice(0, max)}…` : text;
}

function tail(text, max) {
  return typeof text === "string" && text.length > max ? `…${text.slice(-max)}` : text;
}

function now() {
  return new Date().toISOString();
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, Math.max(0, ms));
    signal?.addEventListener("abort", finish, { once: true });
  });
}

// RAM of the machine that runs LM Studio; unknown when only the URL of another machine is set.
let sshHostRam;

async function hostRam(server) {
  const gib = (bytes) => `${Math.round(bytes / 2 ** 30)} GiB`;
  if (!SSH_HOST) return isLocal(server.url) ? gib(totalmem()) : undefined;
  if (!sshHostRam) {
    const survey = await lmsJson(["runtime", "survey", "--json"]);
    const bytes = survey?.engines?.find((engine) => engine.memoryInfo?.ramCapacity)?.memoryInfo.ramCapacity;
    if (bytes) sshHostRam = gib(bytes);
  }
  return sshHostRam;
}

// ---------- local storage: sessions, tasks and model defaults ----------

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(temp, path);
      return;
    } catch (error) {
      // On Windows an antivirus scan or another reader can hold the file for a moment.
      const transient = process.platform === "win32" && ["EPERM", "EACCES", "EBUSY"].includes(error.code);
      if (!transient || attempt === 5) {
        rmSync(temp, { force: true });
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * attempt);
    }
  }
}

const SESSION_ID = /^s_[a-z0-9]+$/;
const TASK_ID = /^t_[a-z0-9]+$/;

// Reads every <id>.json in a folder; files that aren't valid or whose id looks wrong are skipped.
function listJson(folder, idPattern) {
  try {
    return readdirSync(join(HOME, folder))
      .filter((name) => name.endsWith(".json"))
      .map((name) => readJson(join(HOME, folder, name), null))
      .filter((item) => typeof item?.id === "string" && idPattern.test(item.id));
  } catch {
    return [];
  }
}

const defaultsPath = () => join(HOME, "model-defaults.json");
const sessionPath = (id) => join(HOME, "sessions", `${id}.json`);
const lockPath = (id) => join(HOME, "sessions", `${id}.lock`);
const taskPath = (id) => join(HOME, "tasks", `${id}.json`);
const cancelPath = (id) => join(HOME, "tasks", `${id}.cancel`);

function modelKey(name) {
  return name.replace(/:\d+$/, ""); // "model:2" is the second loaded instance of "model"
}

function defaultsFor(model) {
  return readJson(defaultsPath(), {})[modelKey(model)] ?? {};
}

// ---------- lms CLI ----------

function lmsPath() {
  const configured = setting("LMS_PATH");
  if (configured) return configured;
  const bundled = join(homedir(), ".lmstudio", "bin", process.platform === "win32" ? "lms.exe" : "lms");
  return existsSync(bundled) ? bundled : "lms";
}

// lms writes JSON and progress bars to stdout and its messages to stderr.
// Keep only the last redraw of each progress line and drop colour codes.
function cleanOutput(text) {
  return String(text)
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .split("\n")
    .map((line) => (line.split("\r").filter((part) => part.trim()).at(-1) ?? "").trim())
    .filter(Boolean)
    .join("\n");
}

// ---------- SSH ----------

function sshHost() {
  if (!/^[A-Za-z0-9][A-Za-z0-9._@-]*$/.test(SSH_HOST)) throw new UserError(`"${SSH_HOST}" is not a usable SSH host. Use an alias from ~/.ssh/config or user@host.`);
  return SSH_HOST;
}

function sshOptions() {
  const options = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3"];
  // Calls share one connection, so only the first one pays for the handshake.
  if (process.platform !== "win32" && !/\s/.test(HOME)) {
    mkdirSync(HOME, { recursive: true, mode: 0o700 });
    options.push("-o", "ControlMaster=auto", "-o", `ControlPath=${join(HOME, "ssh-%C")}`, "-o", "ControlPersist=120");
  }
  return options;
}

function shellQuote(arg) {
  return `'${String(arg).replace(/'/g, `'\\''`)}'`;
}

// A socket for http.request that reaches 127.0.0.1:<port> on the SSH host: the stdin and stdout of `ssh -W`.
function sshSocket(port) {
  const child = spawn("ssh", [...sshOptions(), "-W", `127.0.0.1:${port}`, sshHost()], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  const socket = new Duplex({
    read() {
      child.stdout.resume();
    },
    write(chunk, encoding, callback) {
      child.stdin.write(chunk, encoding, callback);
    },
    final(callback) {
      child.stdin.end(callback);
    },
    destroy(error, callback) {
      child.kill();
      callback(error);
    },
  });
  child.stdout.on("data", (chunk) => {
    if (!socket.push(chunk)) child.stdout.pause();
  });
  child.stdout.on("end", () => socket.push(null));
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-2000);
  });
  child.stdin.on("error", () => {}); // a dead ssh is reported through its exit code
  child.on("error", (error) => socket.destroy(error.code === "ENOENT" ? new Error("the ssh command was not found on this computer") : error));
  child.on("close", (code) => {
    if (code) socket.destroy(new Error(cleanOutput(stderr) || `ssh exited with code ${code}`));
  });
  // http.request calls these on its socket; over a pipe they have nothing to do.
  for (const name of ["setTimeout", "setNoDelay", "setKeepAlive", "ref", "unref"]) socket[name] = () => socket;
  socket.destroySoon = () => socket.destroy();
  return socket;
}

function runLms(args, { timeoutMs = QUICK_MS, signal } = {}) {
  // Without LMS_SERVER_HOST in its environment, `lms server start` binds to 127.0.0.1 only.
  const { LMS_SERVER_HOST, ...env } = process.env;
  const options = { timeout: timeoutMs, signal, maxBuffer: 16 * 1024 * 1024, env: { ...env, NO_COLOR: "1", FORCE_COLOR: "0" } };
  let file = lmsPath();
  let argv = args;
  if (SSH_HOST) {
    // The login shell of the other machine parses this line, so every argument is quoted.
    const lms = setting("LMS_PATH") ? shellQuote(setting("LMS_PATH")) : '"$HOME/.lmstudio/bin/lms"';
    file = "ssh";
    argv = [...sshOptions(), sshHost(), `env -u LMS_SERVER_HOST ${lms} ${args.map(shellQuote).join(" ")}`];
  }
  return new Promise((resolve, reject) => {
    execFile(file, argv, options, (error, stdout, stderr) => {
      const output = { stdout: cleanOutput(stdout), stderr: cleanOutput(stderr) };
      if (!error) return resolve(output);
      if (error.name === "AbortError") return reject(new UserError("Cancelled."));
      if (error.killed) return reject(new UserError(`\`lms ${args.join(" ")}\` timed out after ${Math.round(timeoutMs / 1000)} s.`));
      if (SSH_HOST) {
        if (error.code === "ENOENT") return reject(new UserError("The ssh command was not found on this computer."));
        if (error.code === 255) return reject(new UserError(`Cannot reach ${SSH_HOST} over SSH: ${output.stderr || error.message}`));
        if (error.code === 126 || error.code === 127) {
          return reject(new UserError(`LM Studio CLI \`lms\` not found on ${SSH_HOST}. It ships with LM Studio in ~/.lmstudio/bin; or set LMS_PATH to its path there.`));
        }
      } else if (error.code === "ENOENT") {
        return reject(new UserError("LM Studio CLI `lms` not found. It ships with LM Studio in ~/.lmstudio/bin; or set LMS_PATH."));
      }
      reject(new UserError(`\`lms ${args.join(" ")}\` failed: ${output.stderr || output.stdout || error.message}`));
    });
  });
}

let lmsFailure; // why the last lmsJson() call failed

async function lmsJson(args) {
  try {
    const { stdout } = await runLms(args);
    const data = JSON.parse(stdout.slice(stdout.search(/[[{]/)));
    lmsFailure = undefined;
    return data;
  } catch (error) {
    lmsFailure = error.message;
    return null;
  }
}

function lmsServerStatus() {
  return lmsJson(["server", "status", "--json"]);
}

// TTL and idle/busy state of loaded models: the REST API doesn't report them.
async function lmsLoaded() {
  const list = await lmsJson(["ps", "--json"]);
  return new Map((Array.isArray(list) ? list : []).map((m) => [m.identifier, compact({ ttl_seconds: m.ttlMs ? m.ttlMs / 1000 : undefined, state: m.status })]));
}

function lmsLoadFlags({ context_length, gpu, parallel, ttl, identifier }) {
  const flags = [];
  if (context_length) flags.push("--context-length", String(context_length));
  if (gpu !== undefined) flags.push("--gpu", gpu);
  if (parallel) flags.push("--parallel", String(parallel));
  if (ttl) flags.push("--ttl", String(ttl));
  if (identifier) flags.push("--identifier", identifier);
  return flags;
}

// ---------- REST API ----------

// The URL found with lms is kept for a short while, so a burst of calls doesn't start lms every time.
let serverCache = null;

async function resolveServer({ fresh = false } = {}) {
  const configured = setting("LMSTUDIO_BASE_URL");
  if (configured && !SSH_HOST) return { url: configured.replace(/\/+$/, ""), source: "LMSTUDIO_BASE_URL" };
  if (!fresh && serverCache && Date.now() - serverCache.at < 15_000) return serverCache.server;
  const status = await lmsServerStatus();
  // Over SSH the port is only known from lms on that machine; the URL is the one LM Studio has there.
  if (SSH_HOST && !status) throw new UserError(lmsFailure ?? `Cannot run lms on ${SSH_HOST} over SSH.`);
  const server = status?.port
    ? { url: `http://127.0.0.1:${status.port}`, source: SSH_HOST ? `lms on ${SSH_HOST} (SSH)` : "lms server status", status }
    : { url: "http://127.0.0.1:1234", source: "default", status };
  serverCache = { server, at: Date.now() };
  return server;
}

function forgetServer() {
  serverCache = null;
}

// With -y, lms loads the closest match for an inexact key, so check that the key exists exactly.
async function assertExactKey(model, server, signal) {
  let keys;
  try {
    const { models = [] } = await api("GET", "/api/v1/models", undefined, { server, signal });
    keys = models.map((m) => m.key);
  } catch (error) {
    if (signal?.aborted) throw error;
    const list = await lmsJson(["ls", "--json"]);
    keys = Array.isArray(list) ? list.map((m) => m.modelKey) : undefined;
  }
  if (keys && !keys.includes(model)) throw new UserError(`No downloaded model has the key "${model}". Use an exact key from list_models.`);
}

function isLocal(url) {
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

const SSH_HINT = "To use lms on that machine, set its SSH host (LMSTUDIO_SSH_HOST) instead of the URL.";

async function requireLocal(feature) {
  const server = await resolveServer();
  if (!isLocal(server.url)) {
    throw new UserError(`${feature} needs LM Studio on this machine (it uses the lms CLI), but LMSTUDIO_BASE_URL points to ${server.url}. ${SSH_HINT}`);
  }
  return server;
}

async function openRequest(method, path, body, { timeoutMs = QUICK_MS, signal, server } = {}) {
  const target = server ?? (await resolveServer());
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const headers = { Accept: "application/json" };
  if (payload !== undefined) Object.assign(headers, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  const token = setting("LM_API_TOKEN");
  if (token) headers.Authorization = `Bearer ${token}`;

  const controller = new AbortController();
  let timer;
  const restartTimer = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), timeoutMs);
  };
  const cancel = () => controller.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  const close = () => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  };
  const fail = (error) => {
    if (error instanceof UserError) return error;
    if (signal?.aborted) return new UserError("Cancelled.");
    if (controller.signal.aborted) return new UserError(`LM Studio did not respond to ${method} ${path} for ${Math.round(timeoutMs / 1000)} s.`);
    forgetServer();
    if (target.status?.running === false) {
      return new UserError(`The LM Studio server is not running${target.status.port ? ` (last port ${target.status.port})` : ""}. Start it with server_start.`);
    }
    const reason = error.code || error.cause?.code || error.message;
    if (SSH_HOST) return new UserError(`Cannot reach LM Studio on ${SSH_HOST} over SSH (${reason}). Check \`ssh ${SSH_HOST}\`, and that its server runs (server_start).`);
    return new UserError(`Cannot reach LM Studio at ${target.url} (${reason}). Start it with server_start, or set LMSTUDIO_BASE_URL if it runs elsewhere.`);
  };

  restartTimer();
  try {
    // node:http rather than fetch: fetch gives up after 5 minutes without response headers, too short for big models.
    const url = new URL(target.url + path);
    const response = await new Promise((resolve, reject) => {
      const options = { method, headers, signal: controller.signal };
      if (SSH_HOST) options.createConnection = () => sshSocket(url.port);
      const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, options, resolve);
      req.on("error", reject);
      req.end(payload);
    });
    response.setEncoding("utf8");
    return { response, restartTimer, close, fail };
  } catch (error) {
    close();
    throw fail(error);
  }
}

function parseResponse(response, text, method, path) {
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { text };
  }
  const status = response.statusCode;
  if (status >= 200 && status < 300) return data;
  const problem = typeof data.error === "string" ? data.error : data.error?.message || text || response.statusMessage;
  const details = { status, param: data.error?.param };
  const overflow = /request \((\d+) tokens\) exceeds the available context size \((\d+) tokens\)/.exec(problem);
  if (overflow) {
    const [needed, context] = overflow.slice(1).map((count) => Number(count).toLocaleString("en-US"));
    throw new UserError(`The request needs ${needed} tokens, but the model is loaded with a ${context}-token context. Send less, run session_compact, or load the model with a larger context.`, details);
  }
  if (status === 401 || status === 403) {
    throw new UserError(`LM Studio refused the request (HTTP ${status}): ${problem}. If API authentication is on, set LM_API_TOKEN.`, details);
  }
  const kind = typeof data.error === "object" && data.error?.type ? ` ${data.error.type}` : "";
  throw new UserError(`LM Studio ${method} ${path} failed (HTTP ${status}${kind}): ${problem}`, details);
}

async function readBody(response) {
  let text = "";
  for await (const chunk of response) text += chunk;
  return text;
}

async function api(method, path, body, options = {}) {
  const { response, close, fail } = await openRequest(method, path, body, options);
  let text;
  try {
    text = await readBody(response);
  } catch (error) {
    throw fail(error);
  } finally {
    close();
  }
  return parseResponse(response, text, method, path);
}

// POST /api/v1/chat as a server-sent event stream. Calls onEvent for every event and returns the final
// result (same shape as a non-streamed answer). The timeout restarts with every event, so long answers
// are fine as long as LM Studio keeps sending something.
async function chatStream(body, { signal, onEvent } = {}) {
  const path = "/api/v1/chat";
  const { response, restartTimer, close, fail } = await openRequest("POST", path, { ...body, stream: true }, { signal, timeoutMs: STREAM_IDLE_MS });
  try {
    if (response.statusCode !== 200 || !String(response.headers["content-type"] ?? "").includes("text/event-stream")) {
      return parseResponse(response, await readBody(response), "POST", path);
    }
    let buffer = "";
    let result;
    let failure;
    let started = false; // the model has begun to answer
    const handle = (block) => {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (!data) return;
      let event;
      try {
        event = JSON.parse(data);
      } catch {
        return;
      }
      if (event.type === "chat.end") result = event.result;
      else if (event.type === "error") failure = event.error;
      else if (/^(reasoning|message|tool_call)\./.test(event.type)) started = true;
      onEvent?.(event);
    };
    for await (const chunk of response) {
      restartTimer();
      buffer += chunk;
      let match;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        handle(buffer.slice(0, match.index));
        buffer = buffer.slice(match.index + match[0].length);
      }
    }
    if (buffer.trim()) handle(buffer);
    const answered = (result?.output ?? []).some((item) => item.type === "message" && item.content);
    if (failure && !answered) throw new UserError(`LM Studio could not answer (${failure.type}): ${failure.message}`);
    // When LM Studio can't start an answer (the request is larger than the context, for one), it ends the
    // stream without a word. The same request without streaming says why.
    if (!result && !failure && !started) return await api("POST", path, body, { signal, timeoutMs: STREAM_IDLE_MS });
    if (!result) throw new UserError("LM Studio closed the stream without a final result.");
    return failure ? { ...result, warning: `LM Studio reported an error during the answer (${failure.type}): ${failure.message}` } : result;
  } catch (error) {
    throw fail(error);
  } finally {
    close();
  }
}

// LM Studio reports many engine details per loaded instance; these are the ones worth showing.
const INSTANCE_KEYS = ["context_length", "parallel", "flash_attention", "num_experts"];

async function loadedInstances(server, signal) {
  const { models = [] } = await api("GET", "/api/v1/models", undefined, { server, signal });
  return models.flatMap((m) => (m.loaded_instances ?? []).map((i) => ({ instance_id: i.id, model: m.key, type: m.type, ...pick(i.config, INSTANCE_KEYS) })));
}

function capabilityList(capabilities) {
  if (!capabilities) return undefined;
  return ["vision", "trained_for_tool_use", "reasoning"].filter((c) => capabilities[c]).map((c) => (c === "trained_for_tool_use" ? "tool_use" : c));
}

function imageDataUrl(path) {
  if (!isAbsolute(path)) throw new UserError(`Use an absolute path for images: ${path}`);
  const type = IMAGE_TYPES[extname(path).toLowerCase()];
  if (!type) throw new UserError(`Unsupported image type: ${path}. Use PNG, JPEG, WebP or GIF.`);
  let info;
  try {
    info = statSync(path);
  } catch {
    throw new UserError(`Image not found: ${path}`);
  }
  if (!info.isFile()) throw new UserError(`Not a file: ${path}`);
  if (info.size > MAX_IMAGE_BYTES) throw new UserError(`Image is larger than 20 MB: ${path}`);
  return `data:${type};base64,${readFileSync(path).toString("base64")}`;
}

// Text files attached to a message are read here and added to it, so the caller doesn't have to paste them.
function attachFiles(text, files) {
  const parts = [text];
  for (const path of files ?? []) {
    if (!isAbsolute(path)) throw new UserError(`Use an absolute path for files: ${path}`);
    let info;
    try {
      info = statSync(path);
    } catch {
      throw new UserError(`File not found: ${path}`);
    }
    if (!info.isFile()) throw new UserError(`Not a file: ${path}`);
    if (info.size > MAX_FILE_BYTES) throw new UserError(`File is larger than 2 MB: ${path}`);
    const content = readFileSync(path);
    if (content.includes(0)) throw new UserError(`Not a text file: ${path}`);
    parts.push(`--- file: ${path} ---\n${content.toString("utf8")}\n--- end of file ---`);
  }
  return parts.join("\n\n");
}

function buildInput(text, images, files) {
  const message = attachFiles(text, files);
  if (!images?.length) return message;
  return [{ type: "text", content: message }, ...images.map((path) => ({ type: "image", data_url: imageDataUrl(path) }))];
}

function cosine(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return normA && normB ? Math.round((dot / Math.sqrt(normA * normB)) * 10_000) / 10_000 : 0;
}

// ---------- loading models ----------

// Loads a model through the REST API, or through `lms` when ttl, gpu, parallel or identifier are set.
// Saved model defaults fill in whatever the call leaves out.
async function loadModel(args, signal) {
  const lmsKeys = LMS_LOAD_KEYS.filter((k) => args[k] !== undefined);
  const restKeys = REST_LOAD_KEYS.filter((k) => args[k] !== undefined);
  if (lmsKeys.length && restKeys.length) {
    throw new UserError(`Can't combine ${lmsKeys.join(", ")} (lms CLI) with ${restKeys.join(", ")} (REST API) in one call. Pick one group.`);
  }
  const server = await resolveServer();
  const defaults = defaultsFor(args.model);
  const settings = { ...defaults, ...args };
  // Saved defaults never switch a REST-only call to lms, and lms works only for LM Studio on this machine.
  if (restKeys.length || !isLocal(server.url)) for (const k of LMS_LOAD_KEYS) if (args[k] === undefined) delete settings[k];
  const defaultsUsed = pick(defaults, DEFAULT_KEYS.filter((k) => args[k] === undefined && settings[k] !== undefined));

  if (!LMS_LOAD_KEYS.some((k) => settings[k] !== undefined)) {
    const body = compact({ ...pick(settings, ["model", "context_length", ...REST_LOAD_KEYS]), echo_load_config: true });
    const r = await api("POST", "/api/v1/models/load", body, { server, signal, timeoutMs: LOAD_TIMEOUT_MS });
    return {
      instance: { instance_id: r.instance_id, context_length: r.load_config?.context_length },
      report: compact({ status: r.status, instance_id: r.instance_id, type: r.type, load_time_seconds: r.load_time_seconds, config: r.load_config, defaults_used: defaultsUsed }),
    };
  }
  await assertExactKey(settings.model, server, signal);
  const { stderr } = await runLms(["load", settings.model, "-y", ...lmsLoadFlags(settings)], { timeoutMs: LOAD_TIMEOUT_MS, signal });
  const extra = await lmsLoaded();
  const instances = (await loadedInstances(server, signal))
    .filter((i) => (settings.identifier ? i.instance_id === settings.identifier : i.model === settings.model))
    .map((i) => ({ ...i, ...extra.get(i.instance_id) }));
  const newest = instances.at(-1);
  return {
    instance: newest && { instance_id: newest.instance_id, context_length: newest.context_length },
    report: compact({ status: "loaded", instances, message: stderr, defaults_used: defaultsUsed }),
  };
}

async function unloadAll(instances, server, signal) {
  for (const i of instances) await api("POST", "/api/v1/models/unload", { instance_id: i.instance_id }, { server, signal, timeoutMs: 120_000 });
}

// One load per model at a time in this process: parallel calls for a model that isn't loaded yet would
// otherwise each load their own copy.
const modelLocks = new Map();

async function withModelLock(model, fn) {
  const key = modelKey(model);
  const previous = modelLocks.get(key) ?? Promise.resolve();
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const mine = previous.then(() => gate);
  modelLocks.set(key, mine);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (modelLocks.get(key) === mine) modelLocks.delete(key);
  }
}

// Unloading a model while a session request or task uses it would cut that answer off.
function assertModelIdle(model, exceptSessionId) {
  const key = modelKey(model);
  let names = [];
  try {
    names = readdirSync(join(HOME, "sessions"));
  } catch {
    return; // no sessions yet
  }
  // Only sessions with a lock file can be in use, so only those are read.
  for (const id of names.filter((name) => name.endsWith(".lock")).map((name) => name.slice(0, -5))) {
    if (id === exceptSessionId || !SESSION_ID.test(id)) continue;
    const lock = readLock(id);
    if (!lock || modelKey(String(readJson(sessionPath(id), {})?.model ?? "")) !== key) continue;
    throw new UserError(`${model} is in use by ${lock.task_id ? `task ${lock.task_id}` : `session ${id}`}. Wait for it or cancel it first.`);
  }
}

// Returns a loaded instance of `model`, loading it first if needed. With strict, the instance must have at
// least the wanted context (the given one, else the model's saved default); reload replaces a smaller one.
async function ensureLoaded(model, { context_length, strict = false, reload = false, session_id } = {}, signal) {
  return withModelLock(model, async () => {
    const server = await resolveServer();
    const instances = (await loadedInstances(server, signal)).filter((i) => i.instance_id === model || i.model === model);
    const wanted = context_length ?? defaultsFor(model).context_length;
    const fitting = instances.find((i) => !strict || !wanted || (i.context_length ?? 0) >= wanted);
    if (fitting) return { instance_id: fitting.instance_id, context_length: fitting.context_length };
    if (instances.length) {
      const have = instances[0].context_length;
      if (!reload) {
        throw new UserError(
          `${model} is loaded with ${have ? `a ${have}-token context` : "an unknown context length"}, but ${wanted} tokens are needed. ` +
            "Call again with reload: true to unload it and load it with the larger context.",
        );
      }
      assertModelIdle(model, session_id);
      await unloadAll(instances, server, signal);
    }
    const { instance, report } = await loadModel(compact({ model: modelKey(model), context_length: wanted }), signal);
    if (!instance) throw new UserError(`LM Studio did not report a loaded instance of ${model}.`);
    return { ...instance, loaded_now: true, load_time_seconds: report.load_time_seconds };
  });
}

// ---------- answers, progress and context ----------

function summarizeOutput(result) {
  const items = result.output ?? [];
  const text = (type) => items.filter((o) => o.type === type).map((o) => o.content).join("\n\n");
  const toolCalls = items
    .filter((o) => o.type === "tool_call" || o.type === "invalid_tool_call")
    .map((o) => compact({ tool: o.tool ?? o.metadata?.tool_name, arguments: o.arguments ?? o.metadata?.arguments, output: clip(o.output, 500), failed: o.reason }));
  return { answer: text("message"), reasoning: text("reasoning"), tool_calls: toolCalls };
}

// Keeps a small live picture of a streamed answer; returns true when something visible changed.
function trackEvent(progress, event) {
  switch (event.type) {
    case "model_load.start":
    case "model_load.progress":
      progress.phase = "loading model";
      progress.percent = Math.round((event.progress ?? 0) * 100);
      return true;
    case "prompt_processing.start":
    case "prompt_processing.progress":
      progress.phase = "reading prompt";
      progress.percent = Math.round((event.progress ?? 0) * 100);
      return true;
    case "reasoning.start":
    case "reasoning.delta":
      progress.phase = "thinking";
      delete progress.percent;
      return true;
    case "tool_call.start":
      progress.phase = `calling ${event.tool}`;
      delete progress.percent;
      progress.tool_calls = (progress.tool_calls ?? 0) + 1;
      return true;
    case "message.start":
    case "message.delta":
      progress.phase = "answering";
      delete progress.percent;
      progress.partial = (progress.partial ?? "") + (event.content ?? "");
      return true;
    default:
      return false;
  }
}

function progressLine(progress) {
  return [progress.phase, progress.percent !== undefined ? `${progress.percent}%` : undefined, progress.partial ? `${progress.partial.length} characters written` : undefined]
    .filter(Boolean)
    .join(", ");
}

function contextUsage(stats, limit) {
  const used = (stats?.input_tokens ?? 0) + (stats?.total_output_tokens ?? 0);
  return compact({ used, limit, percent: limit ? Math.round((used / limit) * 100) : undefined });
}

function formatContext(context) {
  if (!context) return undefined;
  const n = (x) => x.toLocaleString("en-US");
  return context.limit ? `${n(context.used ?? 0)} / ${n(context.limit)} tokens (${context.percent ?? 0}%)` : `${n(context.used ?? 0)} tokens`;
}

function fullContextWarning(context) {
  return context?.percent >= 99 ? "The context is full, so the answer is cut off or missing: use a larger context, compact the session or turn reasoning down." : undefined;
}

function contextWarning(context) {
  if (context?.percent >= 99) return fullContextWarning(context);
  return context?.percent >= CONTEXT_WARNING_PERCENT ? "The context is getting full: run session_compact or start a new session." : undefined;
}

// The answer of the model for a report; when there is none, the end of its reasoning shows what went wrong.
function answerParts(answer, reasoning, includeReasoning) {
  const parts = [answer || "(empty answer)"];
  if (includeReasoning && reasoning) parts.push(`--- reasoning ---\n${reasoning}`);
  else if (!answer && reasoning) parts.push(`--- the model gave no answer; its reasoning ended with ---\n${tail(reasoning, 1500)}`);
  return parts;
}

// A caller that passes a smaller context than the saved default has probably overridden the user's choice by accident.
function belowDefaultNote(model, contextLength) {
  const saved = defaultsFor(model).context_length;
  if (!contextLength || !saved || contextLength >= saved) return undefined;
  return `context_length ${contextLength} is below the saved default of this model (${saved}). Unless the user asked for it, leave context_length out.`;
}

function allWarnings(warning, context) {
  return [warning, contextWarning(context)].filter(Boolean).join(" ") || undefined;
}

const STAT_KEYS = ["input_tokens", "total_output_tokens", "reasoning_output_tokens", "tokens_per_second", "time_to_first_token_seconds", "model_load_time_seconds"];

// ---------- sessions ----------

function saveSession(session) {
  writeJson(sessionPath(session.id), session);
}

function loadSession(id) {
  const session = readJson(sessionPath(id), null);
  if (!session) throw new UserError(`Unknown session ${id}. session_get lists the sessions.`);
  session.turns = Array.isArray(session.turns) ? session.turns : [];
  return session;
}

// A session runs one request at a time, also across Claude Code sessions on this computer. The holder keeps
// sessions/<id>.lock fresh; a lock whose process is gone or that went stale is ignored.
const LOCK_STALE_MS = 30_000;
const heldLocks = new Map(); // session id -> heartbeat timer

// Who holds the session's lock (`holder`, null when nobody does) and, for a lock file nobody holds any
// more, the identity of that leftover file.
function inspectLock(id) {
  let info;
  try {
    info = statSync(lockPath(id));
  } catch {
    return { holder: null };
  }
  const lock = readJson(lockPath(id), {});
  const age = Date.now() - info.mtimeMs;
  let held;
  if (!Number.isInteger(lock.pid)) held = age < 2000; // being written right now
  else held = lock.pid === process.pid ? heldLocks.has(id) : isAlive(lock.pid) && age < LOCK_STALE_MS;
  return held ? { holder: lock } : { holder: null, leftover: info };
}

function readLock(id) {
  return inspectLock(id).holder;
}

function isBusy(id) {
  return Boolean(readLock(id));
}

// Takes the session's lock or explains who holds it. Returns the function that releases it.
function lockSession(id, holder = {}) {
  const { holder: current, leftover } = inspectLock(id);
  if (current) {
    throw new UserError(
      current.task_id
        ? `Session ${id} is busy with task ${current.task_id}. Wait with task_status or stop it with task_cancel.`
        : `Session ${id} is busy with another request.`,
    );
  }
  mkdirSync(join(HOME, "sessions"), { recursive: true, mode: 0o700 });
  if (leftover) {
    // Remove the leftover only while it is still that same file: another process may have taken the lock meanwhile.
    try {
      const info = statSync(lockPath(id));
      if (info.ino === leftover.ino && info.mtimeMs === leftover.mtimeMs) rmSync(lockPath(id), { force: true });
    } catch {
      // already gone
    }
  }
  let fd;
  try {
    fd = openSync(lockPath(id), "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") throw new UserError(`Session ${id} is busy with another request.`);
    throw error;
  }
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, ...holder, since: now() }));
  } finally {
    closeSync(fd);
  }
  const timer = setInterval(() => {
    try {
      const time = new Date();
      utimesSync(lockPath(id), time, time);
    } catch {
      // the next refresh tries again
    }
  }, 5000);
  timer.unref?.();
  heldLocks.set(id, timer);
  return () => {
    clearInterval(timer);
    heldLocks.delete(id);
    try {
      rmSync(lockPath(id), { force: true });
    } catch (error) {
      log(`could not remove the lock of ${id}: ${error.message}`);
    }
  };
}

async function createSession(args, signal, { load = true } = {}) {
  const wanted = args.context_length ?? defaultsFor(args.model).context_length;
  const instance = load ? await ensureLoaded(args.model, { context_length: wanted, strict: true, reload: args.reload }, signal) : undefined;
  const session = compact({
    id: newId("s"),
    title: args.title ?? `${modelKey(args.model)} session`,
    model: args.model,
    context_length: wanted,
    ...pick(args, ["system_prompt", "temperature", "max_output_tokens", "reasoning", "integrations"]),
    instance_id: instance?.instance_id,
    created_at: now(),
    updated_at: now(),
  });
  session.last_response_id = null;
  session.context = compact({ used: 0, limit: instance?.context_length, percent: instance?.context_length ? 0 : undefined });
  session.turns = [];
  saveSession(session);
  return { session, instance };
}

// The saved exchanges since the last compaction, newest last, within roughly `budget` characters.
function recentTranscript(session, budget) {
  const lines = [];
  let used = 0;
  for (const turn of [...session.turns].reverse()) {
    if (turn.role === "system") break; // compaction marker
    const attached = turn.files?.length ? `\n[attached files, not repeated here: ${turn.files.join(", ")}]` : "";
    const line = `${turn.role === "user" ? "User" : "Assistant"}: ${turn.content ?? ""}${attached}`;
    if (used + line.length > budget) {
      if (!lines.length) lines.unshift(tail(line, budget)); // the newest turn alone is too long: keep its end
      break;
    }
    lines.unshift(line);
    used += line.length;
  }
  return lines.join("\n\n");
}

// System prompt for a new chain: the session's instructions, the summary of compacted history and, when
// LM Studio lost the conversation, the saved exchanges since then (about a quarter of the context).
function chainStart(session, limit) {
  const recent = recentTranscript(session, Math.max(4000, limit ?? 16000));
  return (
    [session.system_prompt, session.summary && `Summary of the conversation so far:\n${session.summary}`, recent && `Earlier messages of this conversation:\n${recent}`]
      .filter(Boolean)
      .join("\n\n") || undefined
  );
}

// LM Studio answers HTTP 400 with param "previous_response_id" when it no longer has that response;
// it deletes stored responses after 30 days.
function isLostChain(error) {
  return error instanceof UserError && error.status >= 400 && error.status < 500 && error.param === "previous_response_id";
}

// One exchange in a session. LM Studio keeps the history (store + previous_response_id), so only the new
// message is sent. A new chain (first message, after session_compact, or when LM Studio lost the
// conversation) starts with chainStart().
async function runTurn(session, { message, images, files, max_output_tokens, reload }, { signal, onEvent } = {}) {
  const input = buildInput(message, images, files);
  const instance = await ensureLoaded(session.model, { context_length: session.context_length, strict: true, reload, session_id: session.id }, signal);
  const body = compact({
    model: instance.instance_id,
    input,
    store: true,
    temperature: session.temperature,
    max_output_tokens: max_output_tokens ?? session.max_output_tokens,
    reasoning: session.reasoning,
    integrations: session.integrations,
  });
  let result;
  let rebuilt;
  if (session.last_response_id) {
    try {
      result = await chatStream({ ...body, previous_response_id: session.last_response_id }, { signal, onEvent });
    } catch (error) {
      if (!isLostChain(error)) throw error;
      rebuilt = "LM Studio no longer had this conversation, so it was rebuilt from the saved transcript.";
    }
  }
  result ??= await chatStream(compact({ ...body, system_prompt: chainStart(session, instance.context_length) }), { signal, onEvent });
  const output = summarizeOutput(result);
  const stats = pick(result.stats, STAT_KEYS);
  session.instance_id = instance.instance_id;
  session.last_response_id = result.response_id ?? null;
  session.context = contextUsage(result.stats, instance.context_length);
  session.turns.push(compact({ role: "user", content: message, images: images?.length, files, at: now() })); // files by path only
  session.turns.push(compact({ role: "assistant", content: output.answer, tool_calls: output.tool_calls, stats, at: now() }));
  session.updated_at = now();
  saveSession(session);
  const warnings = [rebuilt, result.warning, result.response_id ? undefined : "LM Studio returned no response_id; the next message starts a new conversation."];
  return { ...output, stats, context: session.context, warning: warnings.filter(Boolean).join(" ") || undefined };
}

function turnReport(session, turn, includeReasoning) {
  const parts = answerParts(turn.answer, turn.reasoning, includeReasoning);
  if (turn.tool_calls?.length) parts.push(`--- tool calls by the local model ---\n${JSON.stringify(turn.tool_calls)}`);
  const meta = compact({ session_id: session.id, context: formatContext(turn.context), warning: allWarnings(turn.warning, turn.context), stats: turn.stats });
  parts.push(`--- session ---\n${JSON.stringify(meta)}`);
  return parts.join("\n\n");
}

// ---------- background tasks ----------

const runningTasks = new Map(); // task id -> { task, controller, done }
const finishedTasks = new Map(); // recent tasks of this process, in case their last save failed

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// Tasks of this process come from memory. A task running elsewhere needs a live process that refreshed
// heartbeat_at recently; otherwise it was interrupted.
function taskView(task) {
  const own = runningTasks.get(task.id)?.task ?? finishedTasks.get(task.id);
  if (own) return own;
  if (task.status !== "running") return task;
  const beat = Date.parse(task.heartbeat_at ?? task.started_at);
  const orphan = task.pid === process.pid || !isAlive(task.pid) || !(Date.now() - beat < LOCK_STALE_MS);
  return orphan ? { ...task, status: "interrupted" } : task;
}

function listTasks() {
  return listJson("tasks", TASK_ID).map(taskView);
}

function getTask(id) {
  const own = runningTasks.get(id)?.task ?? finishedTasks.get(id);
  if (own) return own;
  const task = readJson(taskPath(id), null);
  if (!task) throw new UserError(`Unknown task ${id}. task_status without task_id lists the tasks.`);
  return taskView(task);
}

function persistTask(task) {
  task.heartbeat_at = now();
  writeJson(taskPath(task.id), task);
}

// Keeps the tasks folder small: finished tasks go after 14 days, and beyond the newest 200.
function pruneTasks() {
  try {
    const cutoff = Date.now() - 14 * 24 * 3600_000;
    listTasks() // through taskView, so tasks cut short by a crash count as finished too
      .filter((t) => t.status !== "running")
      .sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)))
      .forEach((t, index) => {
        if (index < 200 && Date.parse(t.finished_at ?? t.started_at) >= cutoff) return;
        rmSync(taskPath(t.id), { force: true });
        rmSync(cancelPath(t.id), { force: true });
      });
  } catch (error) {
    log(`could not prune old tasks: ${error.message}`);
  }
}

function startTask(sessionId, { prompt, images, files, max_output_tokens, reload }) {
  const task = { id: newId("t"), session_id: sessionId, prompt, status: "running", pid: process.pid, started_at: now(), progress: { phase: "starting" } };
  const release = lockSession(sessionId, { task_id: task.id });
  let session;
  try {
    session = loadSession(sessionId); // a fresh copy now that the lock is held
    task.model = session.model;
    persistTask(task);
  } catch (error) {
    release();
    throw error;
  }
  pruneTasks();
  const controller = new AbortController();
  // Every 2 seconds: save the progress (which is also the heartbeat) and look for a cancel request from another process.
  const timer = setInterval(() => {
    try {
      if (existsSync(cancelPath(task.id))) controller.abort();
      persistTask(task);
    } catch (error) {
      log(`could not save task ${task.id}: ${error.message}`);
    }
  }, 2000);
  const done = runTurn(session, { message: prompt, images, files, max_output_tokens, reload }, { signal: controller.signal, onEvent: (event) => trackEvent(task.progress, event) })
    .then((turn) => Object.assign(task, { status: "done", answer: turn.answer, reasoning: turn.reasoning || undefined, tool_calls: turn.tool_calls, stats: turn.stats, context: turn.context, warning: turn.warning }))
    .catch((error) => Object.assign(task, { status: controller.signal.aborted ? "cancelled" : "failed", error: error.message }))
    .finally(() => {
      clearInterval(timer);
      task.finished_at = now();
      if (task.status === "done") delete task.progress;
      finishedTasks.set(task.id, task);
      if (finishedTasks.size > 50) finishedTasks.delete(finishedTasks.keys().next().value);
      runningTasks.delete(task.id);
      release();
      try {
        rmSync(cancelPath(task.id), { force: true });
        writeJson(taskPath(task.id), task);
      } catch (error) {
        log(`could not save task ${task.id}: ${error.message}`);
      }
    })
    .catch((error) => log(error?.stack ?? error));
  runningTasks.set(task.id, { task, controller, done });
  return task;
}

function elapsed(task) {
  const end = task.finished_at ? Date.parse(task.finished_at) : Date.now();
  return `${Math.round((end - Date.parse(task.started_at)) / 1000)} s`;
}

function taskReport(task) {
  const head = compact({ task_id: task.id, session_id: task.session_id, model: task.model, status: task.status, elapsed: elapsed(task), prompt: clip(task.prompt, 300), error: task.error });
  if (task.status === "running") {
    const p = task.progress ?? {};
    return compact({ ...head, progress: compact({ phase: p.phase, percent: p.percent, tool_calls: p.tool_calls, answer_so_far: tail(p.partial, 1000) }) });
  }
  if (task.status !== "done") return compact({ ...head, answer_so_far: tail(task.progress?.partial, 1000) });
  const meta = compact({ ...head, context: formatContext(task.context), warning: allWarnings(task.warning, task.context), tool_calls: task.tool_calls, stats: task.stats });
  return [...answerParts(task.answer, task.reasoning, false), `--- task ---\n${JSON.stringify(meta)}`].join("\n\n");
}

// ---------- tools ----------

const S = {
  model: { type: "string", pattern: NOT_A_FLAG, description: "Model key from list_models." },
  context_length: { type: "integer", minimum: 1, description: "Context window in tokens." },
  ttl: { type: "integer", minimum: 1, description: "Unload automatically after this many idle seconds." },
  gpu: { type: "string", pattern: GPU_PATTERN, description: 'GPU offload: "off", "max" or a ratio such as "0.5".' },
  parallel: { type: "integer", minimum: 1, description: "How many predictions may run at the same time." },
  session_id: { type: "string", pattern: SESSION_ID.source, description: "Session id from session_start or session_get." },
  task_id: { type: "string", pattern: TASK_ID.source, description: "Task id from task_start or task_status." },
  images: { type: "array", items: { type: "string" }, description: "Absolute paths to PNG, JPEG, WebP or GIF files, for vision models." },
  files: { type: "array", items: { type: "string" }, description: "Absolute paths to text files (code, logs, documents) to add to the message, up to 2 MB each. Use this instead of pasting file contents." },
  system_prompt: { type: "string", description: "System instructions." },
  temperature: { type: "number", minimum: 0, maximum: 1, description: "0 is deterministic." },
  max_output_tokens: { type: "integer", minimum: 1, description: "Upper limit for generated tokens per answer." },
  reasoning: { type: "string", enum: ["off", "low", "medium", "high", "on"], description: "Reasoning effort, for models that support it." },
  integrations: { type: "array", items: { type: "string" }, description: 'LM Studio plugins or MCP servers the local model may use, as configured in LM Studio, e.g. "mcp/github".' },
  include_reasoning: { type: "boolean", description: "Also return the model's reasoning text." },
  reload: { type: "boolean", description: "If the model is loaded with a smaller context than needed, unload it and load it again." },
};

const TOOLS = [
  {
    name: "server_status",
    title: "LM Studio: server status",
    description: "Check whether the LM Studio API is reachable, which URL is used, which models are loaded (with TTL) and which background tasks run. Call this first.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run(_args, { signal }) {
      const server = await resolveServer({ fresh: true });
      let loaded;
      let error;
      try {
        loaded = await loadedInstances(server, signal);
      } catch (e) {
        error = e.message;
      }
      let lms;
      if (isLocal(server.url)) {
        const status = server.status ?? (await lmsServerStatus());
        const path = SSH_HOST ? `${SSH_HOST}:${setting("LMS_PATH") ?? "~/.lmstudio/bin/lms"}` : lmsPath();
        lms = status ? { path, server_running: status.running, port: status.port } : { path, available: false };
        if (status && loaded?.length) {
          const extra = await lmsLoaded();
          loaded = loaded.map((i) => ({ ...i, ...extra.get(i.instance_id) }));
        }
      }
      const tasks = listTasks()
        .filter((t) => t.status === "running")
        .map((t) => compact({ task_id: t.id, session_id: t.session_id, phase: t.progress?.phase }));
      return compact({
        reachable: !error,
        base_url: server.url,
        url_source: server.source,
        ssh_host: SSH_HOST,
        loaded_models: loaded,
        error,
        running_tasks: tasks,
        lms_cli: lms,
        system_ram: await hostRam(server),
      });
    },
  },
  {
    name: "server_start",
    title: "LM Studio: start server",
    description: "Start the LM Studio API server on this machine (lms server start). Without port it reuses the last port. Listens on localhost only.",
    inputSchema: {
      type: "object",
      properties: { port: { type: "integer", minimum: 1, maximum: 65535, description: "Port to listen on. Default: the port used last time (usually 1234)." } },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async run({ port }, { signal }) {
      await requireLocal("server_start");
      const { stdout, stderr } = await runLms(["server", "start", ...(port ? ["--port", String(port)] : [])], { timeoutMs: 120_000, signal });
      forgetServer();
      const status = await lmsServerStatus();
      return compact({ running: status?.running, base_url: status?.port ? `http://127.0.0.1:${status.port}` : undefined, message: stderr || stdout });
    },
  },
  {
    name: "server_stop",
    title: "LM Studio: stop server",
    description: "Stop the LM Studio API server on this machine (lms server stop). Other apps that use the API lose access until it is started again.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    async run(_args, { signal }) {
      await requireLocal("server_stop");
      const { stdout, stderr } = await runLms(["server", "stop"], { timeoutMs: 60_000, signal });
      forgetServer();
      const status = await lmsServerStatus();
      return compact({ running: status?.running ?? false, message: stderr || stdout });
    },
  },
  {
    name: "list_models",
    title: "LM Studio: list models",
    description: "List the models downloaded to LM Studio with key, type, size, quantization, max context, capabilities, loaded instances and saved defaults.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["all", "llm", "embedding"], description: "Filter by model type. Default: all." },
        loaded_only: { type: "boolean", description: "Only models that are loaded right now." },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run({ type = "all", loaded_only = false }, { signal }) {
      const { models = [] } = await api("GET", "/api/v1/models", undefined, { signal });
      const defaults = readJson(defaultsPath(), {});
      const list = models
        .filter((m) => type === "all" || m.type === type)
        .filter((m) => !loaded_only || m.loaded_instances?.length)
        .map((m) =>
          compact({
            key: m.key,
            type: m.type,
            name: m.display_name,
            publisher: m.publisher,
            format: m.format,
            quantization: m.quantization?.name,
            size: gb(m.size_bytes),
            params: m.params_string,
            max_context: m.max_context_length,
            capabilities: capabilityList(m.capabilities),
            loaded: (m.loaded_instances ?? []).map((i) => ({ instance_id: i.id, ...pick(i.config, INSTANCE_KEYS) })),
            defaults: defaults[m.key],
          }),
        );
      return list.length ? list : "No models match.";
    },
  },
  {
    name: "model_defaults",
    title: "LM Studio: per-model defaults",
    description:
      "Save default load settings for a model: context length, TTL, GPU offload, parallel slots. load_model, chat, sessions and tasks use them whenever a setting is not given. " +
      "With only model it shows that model's defaults, without arguments all of them; clear: true removes them.",
    inputSchema: {
      type: "object",
      properties: {
        model: S.model,
        context_length: { ...S.context_length, description: "Context window to load the model with, e.g. 262144." },
        ttl: S.ttl,
        gpu: S.gpu,
        parallel: S.parallel,
        clear: { type: "boolean", description: "Remove the saved defaults of this model." },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async run(args) {
      const all = readJson(defaultsPath(), {});
      const changes = pick(args, DEFAULT_KEYS);
      if (!args.model) {
        if (args.clear || Object.keys(changes).length) throw new UserError("Pass model to change defaults.");
        return Object.keys(all).length ? all : "No defaults saved.";
      }
      const key = modelKey(args.model);
      if (args.clear) delete all[key];
      else if (Object.keys(changes).length) all[key] = { ...all[key], ...changes };
      else return { [key]: all[key] ?? "no defaults saved" };
      writeJson(defaultsPath(), all);
      return { [key]: all[key] ?? "cleared" };
    },
  },
  {
    name: "estimate_load",
    title: "LM Studio: estimate memory",
    description: "Estimate the memory a model needs before loading it (lms load --estimate-only; nothing is loaded). Use it before loading large models.",
    inputSchema: {
      type: "object",
      required: ["model"],
      properties: {
        model: S.model,
        context_length: { ...S.context_length, description: "Context length to estimate for. Default: the model's saved default. Leave it out unless the user asks for a specific context: a saved default is the user's choice for this model." },
        gpu: S.gpu,
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run({ model, context_length, gpu }, { signal }) {
      const server = await requireLocal("estimate_load");
      await assertExactKey(model, server, signal);
      const settings = { context_length: context_length ?? defaultsFor(model).context_length, gpu: gpu ?? defaultsFor(model).gpu };
      const { stdout, stderr } = await runLms(["load", model, "--estimate-only", "-y", ...lmsLoadFlags(settings)], { timeoutMs: 120_000, signal });
      return `${stderr || stdout}\n\nSystem RAM${SSH_HOST ? ` of ${SSH_HOST}` : ""}: ${(await hostRam(server)) ?? "unknown"}`;
    },
  },
  {
    name: "load_model",
    title: "LM Studio: load model",
    description:
      "Load a model into memory. Large models can take minutes and most of the RAM: run estimate_load first and get the user's OK for big ones. " +
      "If the model is already loaded it is kept as it is; pass replace: true to reload it with other settings. Saved model_defaults fill in missing settings. " +
      "ttl, gpu, parallel and identifier use the lms CLI (LM Studio on this machine only); flash_attention, eval_batch_size, num_experts and " +
      "offload_kv_cache_to_gpu use the REST API. The two groups can't be mixed in one call.",
    inputSchema: {
      type: "object",
      required: ["model"],
      properties: {
        model: S.model,
        context_length: { ...S.context_length, description: "Context window in tokens. Default: the saved default, else the model's own setting. Leave it out unless the user asks for a specific context: a saved default is the user's choice for this model." },
        ttl: S.ttl,
        gpu: S.gpu,
        parallel: S.parallel,
        identifier: { type: "string", pattern: NOT_A_FLAG, description: "Custom instance id; loads a separate instance even if the model is already loaded." },
        flash_attention: { type: "boolean", description: "Flash attention (llama.cpp engine only)." },
        eval_batch_size: { type: "integer", minimum: 1, description: "Tokens per evaluation batch (llama.cpp engine only)." },
        num_experts: { type: "integer", minimum: 1, description: "Active experts for MoE models (llama.cpp engine only)." },
        offload_kv_cache_to_gpu: { type: "boolean", description: "false keeps the KV cache in RAM (llama.cpp engine only)." },
        replace: { type: "boolean", description: "Unload the loaded instance(s) of this model first, then load it with these settings." },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async run({ replace, ...settings }, { signal }) {
      const server = await resolveServer();
      const lmsKeys = LMS_LOAD_KEYS.filter((k) => settings[k] !== undefined);
      if (lmsKeys.length && !isLocal(server.url)) {
        throw new UserError(`load_model with ${lmsKeys.join(", ")} needs LM Studio on this machine (it uses the lms CLI), but LMSTUDIO_BASE_URL points to ${server.url}. ${SSH_HINT}`);
      }
      if (replace && settings.identifier) throw new UserError("replace doesn't apply with identifier: an identifier always loads a separate instance.");
      return withModelLock(settings.model, async () => {
        const existing = settings.identifier ? [] : (await loadedInstances(server, signal)).filter((i) => i.model === settings.model);
        if (existing.length) {
          if (!replace) return { status: "already_loaded", instances: existing, note: "Pass replace: true to unload it and load it again with other settings." };
          assertModelIdle(settings.model);
          await unloadAll(existing, server, signal);
        }
        const { report } = await loadModel(settings, signal);
        return compact({ ...report, replaced: existing.map((i) => i.instance_id), note: belowDefaultNote(settings.model, settings.context_length) });
      });
    },
  },
  {
    name: "unload_model",
    title: "LM Studio: unload model",
    description: "Unload a loaded model instance to free memory, or every loaded model with all: true. Refuses while a session request or task uses the model.",
    inputSchema: {
      type: "object",
      properties: {
        instance_id: { type: "string", description: "Instance id from list_models or server_status." },
        all: { type: "boolean", description: "Unload every loaded model." },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async run({ instance_id, all }, { signal }) {
      if (!all && !instance_id) throw new UserError("Pass instance_id (see list_models) or all: true.");
      const server = await resolveServer();
      const loaded = await loadedInstances(server, signal);
      const targets = all ? loaded : loaded.filter((i) => i.instance_id === instance_id);
      for (const i of targets) assertModelIdle(i.model);
      const ids = all ? targets.map((i) => i.instance_id) : [instance_id];
      if (!ids.length) return "No models are loaded.";
      const unloaded = [];
      for (const id of ids) {
        const result = await api("POST", "/api/v1/models/unload", { instance_id: id }, { server, signal, timeoutMs: 120_000 });
        unloaded.push(result.instance_id ?? id);
      }
      return { unloaded };
    },
  },
  {
    name: "download_model",
    title: "LM Studio: download model",
    description:
      'Start downloading a model from the LM Studio catalog (e.g. "qwen/qwen3-4b") or a Hugging Face URL. ' +
      "Downloads can be tens of GB: confirm the model with the user first. Returns a job_id for download_status.",
    inputSchema: {
      type: "object",
      required: ["model"],
      properties: {
        model: { type: "string", description: 'Catalog id such as "openai/gpt-oss-20b", or a full Hugging Face URL.' },
        quantization: { type: "string", description: 'Quantization such as "Q4_K_M" (Hugging Face URLs only).' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async run({ model, quantization }, { signal }) {
      const result = await api("POST", "/api/v1/models/download", compact({ model, quantization }), { timeoutMs: 120_000, signal });
      return compact({ ...result, total_size: gb(result.total_size_bytes), next: result.job_id ? `download_status with job_id "${result.job_id}"` : undefined });
    },
  },
  {
    name: "download_status",
    title: "LM Studio: download progress",
    description: "Progress of a download started with download_model.",
    inputSchema: {
      type: "object",
      required: ["job_id"],
      properties: { job_id: { type: "string", description: "job_id returned by download_model." } },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run({ job_id }, { signal }) {
      const r = await api("GET", `/api/v1/models/download/status/${encodeURIComponent(job_id)}`, undefined, { signal });
      const share = r.total_size_bytes ? r.downloaded_bytes / r.total_size_bytes : undefined;
      return compact({
        job_id: r.job_id,
        status: r.status,
        progress: Number.isFinite(share) ? `${(share * 100).toFixed(1)}%` : undefined,
        downloaded: gb(r.downloaded_bytes),
        total: gb(r.total_size_bytes),
        speed: r.bytes_per_second ? `${(r.bytes_per_second / 1e6).toFixed(1)} MB/s` : undefined,
        estimated_completion: r.estimated_completion,
        started_at: r.started_at,
        completed_at: r.completed_at,
      });
    },
  },
  {
    name: "session_start",
    title: "LM Studio: start a session",
    description:
      "Start a conversation with a local model that LM Studio remembers across messages. Loads the model if needed, with context_length " +
      "(else the saved default) as the minimum context. Then use session_send, or task_start to run a message in the background.",
    inputSchema: {
      type: "object",
      required: ["model"],
      properties: {
        model: S.model,
        title: { type: "string", description: "Short name to recognise the session later." },
        system_prompt: S.system_prompt,
        context_length: { ...S.context_length, description: "Context the session needs. Default: the model's saved default. Leave it out unless the user asks for a specific context: a saved default is the user's choice for this model." },
        reload: S.reload,
        temperature: S.temperature,
        max_output_tokens: S.max_output_tokens,
        reasoning: S.reasoning,
        integrations: S.integrations,
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async run(args, { signal }) {
      const { session, instance } = await createSession(args, signal);
      return compact({
        session_id: session.id,
        title: session.title,
        model: session.model,
        instance_id: instance.instance_id,
        context: formatContext(session.context),
        loaded_now: instance.loaded_now,
        load_time_seconds: instance.load_time_seconds,
        note: belowDefaultNote(args.model, args.context_length),
      });
    },
  },
  {
    name: "session_send",
    title: "LM Studio: send to a session",
    description: "Send a message in a session, with optional text files and images, and wait for the answer. Reports how full the context is. For long jobs use task_start instead.",
    inputSchema: {
      type: "object",
      required: ["session_id", "message"],
      properties: {
        session_id: S.session_id,
        message: { type: "string", description: "The message to send." },
        images: S.images,
        files: S.files,
        max_output_tokens: S.max_output_tokens,
        include_reasoning: S.include_reasoning,
        reload: S.reload,
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async run(args, { signal, progress }) {
      loadSession(args.session_id); // an unknown id fails before anything is locked
      const release = lockSession(args.session_id);
      try {
        const session = loadSession(args.session_id); // a fresh copy now that the lock is held
        const state = {};
        const turn = await runTurn(session, args, { signal, onEvent: (event) => trackEvent(state, event) && progress(progressLine(state)) });
        return turnReport(session, turn, args.include_reasoning);
      } finally {
        release();
      }
    },
  },
  {
    name: "session_get",
    title: "LM Studio: sessions",
    description: "Without session_id: list the sessions with model, turns and context use. With session_id: settings, context use, summary and the latest turns.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: S.session_id,
        last: { type: "integer", minimum: 1, description: "How many recent exchanges to show. Default: 10." },
        full: { type: "boolean", description: "Show whole messages instead of the first 1500 characters." },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run({ session_id, last = 10, full = false }) {
      if (!session_id) {
        const sessions = listJson("sessions", SESSION_ID).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
        if (!sessions.length) return "No sessions yet. Start one with session_start.";
        return sessions.map((s) =>
          compact({
            session_id: s.id,
            title: s.title,
            model: s.model,
            exchanges: (Array.isArray(s.turns) ? s.turns : []).filter((t) => t?.role === "assistant").length,
            context: formatContext(s.context),
            busy: isBusy(s.id) || undefined,
            updated_at: s.updated_at,
          }),
        );
      }
      const s = loadSession(session_id);
      return compact({
        session_id: s.id,
        title: s.title,
        model: s.model,
        instance_id: s.instance_id,
        context_length: s.context_length,
        context: formatContext(s.context),
        warning: contextWarning(s.context),
        busy: isBusy(s.id) || undefined,
        settings: pick(s, ["system_prompt", "temperature", "max_output_tokens", "reasoning", "integrations"]),
        summary: s.summary,
        turns_total: s.turns.length,
        turns: s.turns.slice(-last * 2).map((t) => compact({ ...t, content: full ? t.content : clip(t.content, 1500) })),
      });
    },
  },
  {
    name: "session_compact",
    title: "LM Studio: compact a session",
    description:
      "Free the context of a session: the model summarizes the conversation, and the next message starts a fresh context that begins with that summary. " +
      "Use it when session_send or task_status warns that the context is getting full.",
    inputSchema: {
      type: "object",
      required: ["session_id"],
      properties: {
        session_id: S.session_id,
        instructions: { type: "string", description: "What the summary must keep, in addition to the usual facts, decisions and open work." },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async run({ session_id, instructions }, { signal, progress }) {
      loadSession(session_id); // an unknown id fails before anything is locked
      const release = lockSession(session_id);
      try {
        const session = loadSession(session_id);
        if (!session.last_response_id) return "Nothing to compact: the current context of this session is still empty.";
        const instance = await ensureLoaded(session.model, { context_length: session.context_length }, signal);
        const state = {};
        const onEvent = (event) => trackEvent(state, event) && progress(progressLine(state));
        const prompt = instructions ? `${COMPACT_PROMPT}\n\nAlso keep: ${instructions}` : COMPACT_PROMPT;
        const base = compact({ model: instance.instance_id, store: false, reasoning: session.reasoning });
        let result;
        try {
          result = await chatStream({ ...base, input: prompt, previous_response_id: session.last_response_id }, { signal, onEvent });
        } catch (error) {
          if (!isLostChain(error)) throw error;
          // LM Studio no longer has the conversation: summarize the saved transcript instead.
          const history = [session.summary && `Summary so far:\n${session.summary}`, recentTranscript(session, Math.max(4000, instance.context_length ?? 16000))];
          const input = `${prompt}\n\nConversation:\n${history.filter(Boolean).join("\n\n")}`;
          result = await chatStream(compact({ ...base, input, system_prompt: session.system_prompt }), { signal, onEvent });
        }
        const summary = summarizeOutput(result).answer;
        if (!summary) throw new UserError("The model returned an empty summary; the session was left unchanged.");
        const before = session.context;
        session.summary = summary;
        session.last_response_id = null;
        session.compactions = (session.compactions ?? 0) + 1;
        session.context = contextUsage({ input_tokens: 0, total_output_tokens: result.stats?.total_output_tokens ?? 0 }, instance.context_length);
        session.turns.push({ role: "system", content: `Context compacted. Summary:\n${summary}`, at: now() });
        session.updated_at = now();
        saveSession(session);
        return compact({ session_id: session.id, context_before: formatContext(before), context_now: formatContext(session.context), summary: clip(summary, 2000) });
      } finally {
        release();
      }
    },
  },
  {
    name: "session_delete",
    title: "LM Studio: delete sessions",
    description: "Delete a session (or all of them) with its tasks. Loaded models stay loaded.",
    inputSchema: {
      type: "object",
      properties: { session_id: S.session_id, all: { type: "boolean", description: "Delete every session." } },
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    async run({ session_id, all }) {
      if (!all && !session_id) throw new UserError("Pass session_id or all: true.");
      if (session_id) loadSession(session_id); // unknown ids fail here
      const ids = all ? listJson("sessions", SESSION_ID).map((s) => s.id) : [session_id];
      if (!ids.length) return "No sessions to delete.";
      const busy = ids.filter(isBusy);
      if (busy.length) throw new UserError(`Busy sessions can't be deleted: ${busy.join(", ")}. Cancel their tasks first.`);
      const tasks = listJson("tasks", TASK_ID);
      for (const id of ids) {
        rmSync(sessionPath(id), { force: true });
        rmSync(lockPath(id), { force: true });
        for (const t of tasks.filter((task) => task.session_id === id)) {
          rmSync(taskPath(t.id), { force: true });
          rmSync(cancelPath(t.id), { force: true });
        }
      }
      return { deleted: ids };
    },
  },
  {
    name: "task_start",
    title: "LM Studio: start a background task",
    description:
      "Run a prompt, with optional text files and images, on a local model in the background and return a task_id at once. Pass session_id to continue a session, or model " +
      "(plus optional session settings) to start a new session for the task. Follow it with task_status; stop it with task_cancel.",
    inputSchema: {
      type: "object",
      required: ["prompt"],
      properties: {
        prompt: { type: "string", description: "What the local model should do." },
        session_id: { ...S.session_id, description: "Run the task inside this session." },
        model: { ...S.model, description: "Model for a new session, when session_id is not given." },
        title: { type: "string", description: "Name for the new session. Default: the start of the prompt." },
        system_prompt: S.system_prompt,
        context_length: { ...S.context_length, description: "Context the new session needs. Default: the model's saved default. Leave it out unless the user asks for a specific context: a saved default is the user's choice for this model." },
        reload: S.reload,
        temperature: S.temperature,
        max_output_tokens: S.max_output_tokens,
        reasoning: S.reasoning,
        integrations: S.integrations,
        images: S.images,
        files: S.files,
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async run(args, { signal }) {
      const newSessionOnly = ["title", "system_prompt", "context_length", "temperature", "reasoning", "integrations"].filter((k) => args[k] !== undefined);
      if (args.session_id && args.model) throw new UserError("Pass session_id or model, not both.");
      if (args.session_id && newSessionOnly.length) throw new UserError(`${newSessionOnly.join(", ")} only apply to a new session; leave them out with session_id.`);
      if (!args.session_id && !args.model) throw new UserError("Pass session_id to continue a session, or model to start a new one.");
      buildInput(args.prompt, args.images, args.files); // unreadable files fail now rather than in the background
      const session = args.session_id
        ? loadSession(args.session_id)
        : (await createSession({ ...pick(args, SESSION_KEYS), title: args.title ?? clip(args.prompt, 60) }, signal, { load: false })).session;
      const task = startTask(session.id, {
        prompt: args.prompt,
        images: args.images,
        files: args.files,
        max_output_tokens: args.session_id ? args.max_output_tokens : undefined, // a new session keeps it as its own setting
        reload: args.reload,
      });
      const note = args.model ? belowDefaultNote(args.model, args.context_length) : undefined;
      return compact({ task_id: task.id, session_id: session.id, status: task.status, note, next: "task_status with wait_seconds to wait for the result; task_cancel to stop it." });
    },
  },
  {
    name: "task_status",
    title: "LM Studio: task status",
    description:
      "Without task_id: list recent tasks. With task_id: progress of a running task (phase, answer so far, tool calls) or the full result of a finished one. " +
      "wait_seconds waits up to that long for the task to finish before answering.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: S.task_id,
        wait_seconds: { type: "integer", minimum: 1, maximum: 600, description: "Wait up to this many seconds for the task to finish." },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run({ task_id, wait_seconds }, { signal }) {
      if (!task_id) {
        const tasks = listTasks()
          .sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)))
          .slice(0, 20);
        if (!tasks.length) return "No tasks yet. Start one with task_start.";
        return tasks.map((t) => compact({ task_id: t.id, session_id: t.session_id, status: t.status, elapsed: elapsed(t), prompt: clip(t.prompt, 80), phase: t.status === "running" ? t.progress?.phase : undefined }));
      }
      let task = getTask(task_id);
      const deadline = Date.now() + (wait_seconds ?? 0) * 1000;
      while (task.status === "running" && Date.now() < deadline && !signal.aborted) {
        const live = runningTasks.get(task_id);
        if (live) await Promise.race([live.done, sleep(Math.min(deadline - Date.now(), 60_000), signal)]);
        else await sleep(Math.min(deadline - Date.now(), 2000), signal);
        task = getTask(task_id);
      }
      return taskReport(task);
    },
  },
  {
    name: "task_cancel",
    title: "LM Studio: cancel a task",
    description: "Stop a running background task. The session keeps everything up to the previous answer.",
    inputSchema: { type: "object", required: ["task_id"], properties: { task_id: S.task_id } },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    async run({ task_id }) {
      const live = runningTasks.get(task_id);
      if (live) {
        live.controller.abort();
        await live.done;
        return { task_id, status: live.task.status };
      }
      const task = getTask(task_id);
      if (task.status !== "running") return { task_id, status: task.status, note: "The task is not running." };
      // The task runs in another process, which checks for this file every 2 seconds.
      writeFileSync(cancelPath(task_id), now(), { mode: 0o600 });
      return { task_id, status: "cancel requested", note: "The task runs in another Claude Code session and stops within a few seconds." };
    },
  },
  {
    name: "chat",
    title: "LM Studio: one-off prompt",
    description:
      "Send a single prompt (with optional text files and images) to a local model and get its answer with speed stats; nothing is remembered. " +
      "Loads the model if needed. For conversations use sessions, for long jobs task_start.",
    inputSchema: {
      type: "object",
      required: ["model", "prompt"],
      properties: {
        model: { ...S.model, description: "Model key or loaded instance id." },
        prompt: { type: "string", description: "The user message." },
        system_prompt: S.system_prompt,
        images: S.images,
        files: S.files,
        temperature: S.temperature,
        max_output_tokens: S.max_output_tokens,
        reasoning: S.reasoning,
        context_length: { ...S.context_length, description: "Minimum context for this prompt; the model is loaded with it if needed. Default: the model's saved default. Leave it out unless the user asks for a specific context: a saved default is the user's choice for this model." },
        reload: S.reload,
        integrations: S.integrations,
        include_reasoning: S.include_reasoning,
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async run(args, { signal, progress }) {
      const input = buildInput(args.prompt, args.images, args.files);
      const instance = await ensureLoaded(args.model, { context_length: args.context_length, strict: args.context_length !== undefined, reload: args.reload }, signal);
      const state = {};
      const result = await chatStream(
        compact({ model: instance.instance_id, input, store: false, ...pick(args, ["system_prompt", "temperature", "max_output_tokens", "reasoning", "integrations"]) }),
        { signal, onEvent: (event) => trackEvent(state, event) && progress(progressLine(state)) },
      );
      const output = summarizeOutput(result);
      const parts = answerParts(output.answer, output.reasoning, args.include_reasoning);
      if (output.tool_calls.length) parts.push(`--- tool calls by the local model ---\n${JSON.stringify(output.tool_calls)}`);
      const context = contextUsage(result.stats, instance.context_length);
      const warning = [result.warning, fullContextWarning(context)].filter(Boolean).join(" ") || undefined;
      const meta = compact({ model_instance_id: result.model_instance_id, loaded_now: instance.loaded_now, context: formatContext(context), warning, stats: pick(result.stats, STAT_KEYS) });
      parts.push(`--- meta ---\n${JSON.stringify(meta)}`);
      return parts.join("\n\n");
    },
  },
  {
    name: "embed",
    title: "LM Studio: embeddings",
    description: "Embed texts with a local embedding model. Returns the dimensions and the cosine-similarity matrix between the texts; raw vectors only on request.",
    inputSchema: {
      type: "object",
      required: ["model", "texts"],
      properties: {
        model: { type: "string", description: "Embedding model key (list_models with type embedding)." },
        texts: { type: "array", items: { type: "string" }, minItems: 1, description: "Texts to embed." },
        include_vectors: { type: "boolean", description: "Also return the raw vectors (large)." },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, // may load the model
    async run({ model, texts, include_vectors }, { signal }) {
      const result = await api("POST", "/v1/embeddings", { model, input: texts }, { timeoutMs: LOAD_TIMEOUT_MS, signal });
      const vectors = [...(result.data ?? [])].sort((a, b) => a.index - b.index).map((d) => d.embedding);
      return compact({
        model: result.model,
        count: vectors.length,
        dimensions: vectors[0]?.length,
        cosine_similarity: vectors.length > 1 ? vectors.map((a) => vectors.map((b) => cosine(a, b))) : undefined,
        vectors: include_vectors ? vectors : undefined,
      });
    },
  },
];

// ---------- argument checks ----------

function checkValue(rule, value) {
  if (rule.type === "string" && typeof value !== "string") return "must be a string";
  if (rule.type === "boolean" && typeof value !== "boolean") return "must be true or false";
  if (rule.type === "integer" && !Number.isInteger(value)) return "must be an integer";
  if (rule.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) return "must be a number";
  if (rule.type === "array") {
    if (!Array.isArray(value)) return "must be an array";
    if (rule.minItems && value.length < rule.minItems) return `needs at least ${rule.minItems} item(s)`;
    if (rule.items?.type === "string" && value.some((v) => typeof v !== "string")) return "must contain only strings";
  }
  if (rule.enum && !rule.enum.includes(value)) return `must be one of: ${rule.enum.join(", ")}`;
  if (rule.minimum !== undefined && value < rule.minimum) return `must be at least ${rule.minimum}`;
  if (rule.maximum !== undefined && value > rule.maximum) return `must be at most ${rule.maximum}`;
  if (rule.pattern && !new RegExp(rule.pattern).test(value)) return `does not match ${rule.pattern}`;
  return null;
}

function checkArgs(schema, raw) {
  const args = raw ?? {};
  if (typeof args !== "object" || Array.isArray(args)) throw new UserError("Tool arguments must be a JSON object.");
  const rules = schema.properties ?? {};
  for (const key of Object.keys(args)) {
    // hasOwn, not `in`: "__proto__" must not slip through as a known argument.
    if (!Object.hasOwn(rules, key)) throw new UserError(`Unknown argument "${key}". Allowed: ${Object.keys(rules).join(", ") || "none"}.`);
  }
  for (const key of schema.required ?? []) {
    if (args[key] === undefined || args[key] === null || args[key] === "") throw new UserError(`Missing required argument "${key}".`);
  }
  const clean = Object.create(null);
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    const problem = checkValue(rules[key], value);
    if (problem) throw new UserError(`Argument "${key}" ${problem}.`);
    clean[key] = value;
  }
  return clean;
}

// ---------- MCP over stdio (JSON-RPC 2.0, one message per line) ----------

const toolsByName = new Map(TOOLS.map((tool) => [tool.name, tool]));
const runningCalls = new Map();

function send(message) {
  // U+2028/U+2029 are valid in JSON strings but end a line for some readers (readline in Node 24+): escape them.
  process.stdout.write(`${JSON.stringify(message).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")}\n`);
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

// Sends notifications/progress for a call when the client asked for them (params._meta.progressToken).
function progressReporter(token, signal) {
  if (token === undefined || token === null) return () => {};
  let count = 0;
  let last = 0;
  return (message) => {
    if (signal.aborted || Date.now() - last < 1000) return;
    last = Date.now();
    send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress: ++count, message } });
  };
}

async function callTool(id, params) {
  const tool = toolsByName.get(params?.name);
  if (!tool) return replyError(id, -32602, `Unknown tool: ${params?.name}`);
  const controller = new AbortController();
  runningCalls.set(id, controller);
  try {
    const progress = progressReporter(params._meta?.progressToken, controller.signal);
    const output = await tool.run(checkArgs(tool.inputSchema, params.arguments), { signal: controller.signal, progress });
    if (controller.signal.aborted) return;
    controller.abort(); // stops any late progress notification
    reply(id, { content: [{ type: "text", text: typeof output === "string" ? output : JSON.stringify(output, null, 2) }] });
  } catch (error) {
    if (controller.signal.aborted) return;
    controller.abort();
    if (!(error instanceof UserError)) log(error?.stack ?? error);
    const text = error instanceof UserError ? error.message : `Unexpected error: ${error?.message ?? error}`;
    reply(id, { content: [{ type: "text", text }], isError: true });
  } finally {
    runningCalls.delete(id);
  }
}

async function handle(message) {
  if (Array.isArray(message)) return message.forEach((item) => handle(item).catch((error) => log(error?.stack ?? error))); // JSON-RPC batch (protocol 2025-03-26)
  const { id, method, params } = message ?? {};
  const isRequest = id !== undefined && id !== null;
  if (typeof method !== "string") {
    if (isRequest) replyError(id, -32600, "Invalid request");
    return;
  }
  if (!isRequest) {
    // Notifications never get a reply; the only one that matters here is a cancellation.
    if (method === "notifications/cancelled") runningCalls.get(params?.requestId)?.abort();
    return;
  }
  switch (method) {
    case "initialize": {
      const asked = params?.protocolVersion;
      const protocolVersion = PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0];
      log(`v${VERSION} ready for ${params?.clientInfo?.name ?? "client"} (protocol ${protocolVersion}, asked ${asked})`);
      return reply(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "lmstudio-mcp", title: "LM Studio", version: VERSION },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, { tools: TOOLS.map(({ run, ...definition }) => definition) });
    case "tools/call":
      return callTool(id, params);
    default:
      return replyError(id, -32601, `Method not found: ${method}`);
  }
}

if (process.argv.includes("--version")) {
  console.log(VERSION);
  process.exit(0);
}
if (process.argv.includes("--help")) {
  console.log(HELP);
  process.exit(0);
}

process.stdout.on("error", () => process.exit(0)); // client went away

function onLine(line) {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return replyError(null, -32700, "Parse error");
  }
  handle(message).catch((error) => log(error?.stack ?? error));
}

// Split stdin on "\n" only. readline in Node 24+ also ends lines at U+2028/U+2029, which can appear inside JSON strings.
const decoder = new StringDecoder("utf8");
let pending = "";
process.stdin.on("data", (chunk) => {
  pending += decoder.write(chunk);
  let index;
  while ((index = pending.indexOf("\n")) !== -1) {
    const line = pending.slice(0, index);
    pending = pending.slice(index + 1);
    onLine(line);
  }
});
process.stdin.on("end", () => {
  onLine(pending + decoder.end());
  // Background tasks can't outlive this process: record them as interrupted and free their sessions.
  for (const { task } of runningTasks.values()) {
    try {
      writeJson(taskPath(task.id), { ...task, status: "interrupted", finished_at: now() });
    } catch {
      // other processes see the stale heartbeat instead
    }
  }
  for (const id of heldLocks.keys()) rmSync(lockPath(id), { force: true });
  process.exit(0);
});
