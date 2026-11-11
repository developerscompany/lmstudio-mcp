// Runs the MCP server against a fake LM Studio (REST API with streaming), a fake `lms` CLI and a fake `ssh`.
// Run with: npm test
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "server", "lmstudio-mcp.mjs");
const work = mkdtempSync(join(tmpdir(), "lmstudio-mcp-test-"));
const fakeLms = join(work, "lms");
const lmsLog = join(work, "lms.log");
const sshLog = join(work, "ssh.log");
const SSH = { LMSTUDIO_SSH_HOST: "studio", LMS_PATH: "", PATH: `${join(work, "bin")}:${process.env.PATH}` }; // server settings for the SSH tests
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- fake LM Studio ----------

const MODELS = [
  {
    type: "llm",
    key: "tiny-llm",
    display_name: "Tiny LLM",
    publisher: "test",
    format: "gguf",
    quantization: { name: "Q4_K_M", bits_per_weight: 4 },
    size_bytes: 1_500_000_000,
    params_string: "1B",
    max_context_length: 32768,
    capabilities: { vision: true, trained_for_tool_use: true },
  },
  {
    type: "embedding",
    key: "tiny-embed",
    display_name: "Tiny Embed",
    publisher: "test",
    format: "gguf",
    quantization: { name: "Q8_0", bits_per_weight: 8 },
    size_bytes: 80_000_000,
    params_string: null,
    max_context_length: 2048,
  },
  {
    type: "llm",
    key: "slow-llm", // takes 2.5 s to load
    display_name: "Slow LLM",
    publisher: "test",
    format: "gguf",
    quantization: { name: "Q4_K_M", bits_per_weight: 4 },
    size_bytes: 3_000_000_000,
    params_string: "3B",
    max_context_length: 8192,
  },
];

let loaded; // instance id -> { model, context_length, ttlMs }
const chains = new Map(); // response_id -> conversation depth
let responses = 0;
const requests = [];

function load({ model, context_length, ttl, identifier }) {
  const info = MODELS.find((m) => m.key === model);
  if (!info) return [404, { error: { type: "model_not_found", message: `Model ${model} not found in downloaded models` } }];
  const id = identifier ?? (loaded.has(model) ? `${model}:2` : model);
  loaded.set(id, { model, context_length: context_length ?? 4096, ttlMs: ttl ? ttl * 1000 : undefined });
  return [200, { type: info.type, instance_id: id, load_time_seconds: 1.5, status: "loaded", load_config: { context_length: context_length ?? 4096 } }];
}

const routes = {
  "GET /api/v1/models": () => [
    200,
    {
      models: MODELS.map((m) => ({
        ...m,
        loaded_instances: [...loaded].filter(([, v]) => v.model === m.key).map(([id, v]) => ({ id, config: { context_length: v.context_length } })),
      })),
    },
  ],
  "POST /api/v1/models/load": async (body, req) => {
    if (body.model !== "slow-llm") return load(body);
    await delay(2500);
    return req.socket.destroyed ? [499, {}] : load(body); // the client gave up: nothing gets loaded
  },
  "POST /__lms/load": (body) => load(body),
  "POST /__forget": () => {
    chains.clear(); // like LM Studio after a restart
    return [200, {}];
  },
  "GET /__lms/ps": () => [200, [...loaded].map(([id, v]) => ({ identifier: id, ttlMs: v.ttlMs, status: "idle" }))],
  "POST /api/v1/models/unload": (body) =>
    loaded.delete(body.instance_id)
      ? [200, { instance_id: body.instance_id }]
      : [404, { error: { type: "model_not_found", message: `Model with instance identifier '${body.instance_id}' is not loaded.` } }],
  "POST /api/v1/models/download": () => [200, { job_id: "job_1", status: "downloading", total_size_bytes: 2_000_000_000, started_at: "2026-01-01T00:00:00.000Z" }],
  "GET /api/v1/models/download/status/job_1": () => [
    200,
    { job_id: "job_1", status: "downloading", total_size_bytes: 2_000_000_000, downloaded_bytes: 500_000_000, bytes_per_second: 50_000_000 },
  ],
  // Answers in reverse order to check that the server sorts by index.
  "POST /v1/embeddings": (body) => [200, { object: "list", model: body.model, data: body.input.map((_, i) => ({ index: i, embedding: i === 0 ? [1, 0] : [1, 1] })).reverse() }],
};

// POST /api/v1/chat: answers "Answer <n> to: <text>", where n counts the turns of the conversation.
// "[slow]" / "[very slow]" in the text slow the stream down, "[fill]" reports 85% of the context as used,
// "[error]" fails during the answer, "[bad request]" is refused with HTTP 400 and "[too long]" behaves like a
// request that is larger than the context: a stream that ends at once, or HTTP 500 without streaming.
// "[no answer]" fills the context with reasoning and never gets to an answer.
async function chat(body, res) {
  const instance = loaded.get(body.model);
  if (!instance) return send(res, 404, { error: { type: "model_not_found", message: `Model ${body.model} is not loaded` } });
  if (body.previous_response_id && !chains.has(body.previous_response_id)) {
    const message = `Could not find stored response for previous_response_id '${body.previous_response_id}'. Please ensure the ID is correct.`;
    return send(res, 400, { error: { message, type: "invalid_request", param: "previous_response_id", code: "invalid_value" } });
  }
  const depth = (chains.get(body.previous_response_id) ?? 0) + 1;
  const text = typeof body.input === "string" ? body.input : body.input.find((item) => item.type === "text").content;
  if (text.includes("[too long]")) {
    if (body.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      return res.end(`event: chat.start\ndata: ${JSON.stringify({ type: "chat.start", model_instance_id: body.model })}\n\n`);
    }
    const engine = { error: { code: 400, message: "request (20523 tokens) exceeds the available context size (4096 tokens), try increasing it", type: "exceed_context_size_error" } };
    return send(res, 500, { error: { message: `Engine protocol predict request returned 400: ${JSON.stringify(engine)}`, type: "internal_error", code: "unknown", param: null } });
  }
  if (text.includes("[bad request]")) return send(res, 400, { error: { message: "Invalid response format", type: "invalid_request", param: "input" } });
  const answer = text.startsWith("Summarize our conversation") ? "SUMMARY: we talked." : `Answer ${depth} to: ${text}`;
  const toolCall = { tool: "search", arguments: { q: "x" }, output: "found", provider_info: { type: "plugin", plugin_id: body.integrations?.[0] } };
  const noAnswer = text.includes("[no answer]");
  const result = {
    model_instance_id: body.model,
    output: text.includes("[error]")
      ? []
      : noAnswer
        ? [{ type: "reasoning", content: "First I look at the file. Then I keep thinking and never finish" }]
        : [{ type: "reasoning", content: "thinking" }, ...(body.integrations ? [{ type: "tool_call", ...toolCall }] : []), { type: "message", content: answer }],
    stats: {
      input_tokens: noAnswer ? instance.context_length - 20 : text.includes("[fill]") ? Math.round(instance.context_length * 0.85) : 100 * depth,
      total_output_tokens: 20,
      reasoning_output_tokens: 5,
      tokens_per_second: 42,
      time_to_first_token_seconds: 0.1,
    },
  };
  if (body.store !== false) {
    result.response_id = `resp_${++responses}`;
    chains.set(result.response_id, depth);
  }
  if (!body.stream) return send(res, 200, result);
  const events = [
    ["chat.start", { model_instance_id: body.model }],
    ["prompt_processing.progress", { progress: 0.5 }],
    ["reasoning.delta", { content: "thinking" }],
    ...(body.integrations ? [["tool_call.start", { tool: "search", provider_info: toolCall.provider_info }], ["tool_call.success", toolCall]] : []),
    ...(text.includes("[error]") ? [["error", { error: { type: "internal_error", message: "boom" } }]] : [["message.delta", { content: answer.slice(0, 6) }], ["message.delta", { content: answer.slice(6) }]]),
    ["chat.end", { result }],
  ];
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const pause = text.includes("[very slow]") ? 1000 : text.includes("[slow]") ? 400 : 0;
  for (const [type, data] of events) {
    if (res.destroyed) return;
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    if (pause) await delay(pause);
  }
  res.end();
}

function send(res, status, payload) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

const api = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : undefined;
  requests.push({ method: req.method, url: req.url, body, auth: req.headers.authorization });
  if (req.method === "POST" && req.url === "/api/v1/chat") return chat(body, res);
  const route = routes[`${req.method} ${req.url}`];
  const [status, payload] = route ? await route(body, req) : [404, { error: `Unexpected endpoint or method. (${req.method} ${req.url})` }];
  send(res, status, payload);
});
let port;

before(async () => {
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  port = api.address().port;
  // Like the real lms: JSON and progress redraws on stdout, messages on stderr.
  writeFileSync(
    fakeLms,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
require("node:fs").appendFileSync(${JSON.stringify(lmsLog)}, JSON.stringify(args) + "\\n");
const [command, sub] = args;
const say = (text) => process.stderr.write(text + "\\n");
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const call = (path, body) => fetch("http://127.0.0.1:${port}" + path, body ? { method: "POST", body: JSON.stringify(body) } : undefined).then((r) => r.json());
const stopped = process.env.FAKE_LMS_STOPPED_PORT;
(async () => {
  if (command === "server" && sub === "status") console.log(JSON.stringify(stopped ? { running: false, port: Number(stopped) } : { running: true, port: ${port} }));
  else if (command === "server" && sub === "start") say("Success! Server is now running on port ${port}");
  else if (command === "server" && sub === "stop") say("Stopped the server");
  else if (command === "ps") console.log(JSON.stringify(await call("/__lms/ps")));
  else if (command === "runtime" && sub === "survey") console.log(JSON.stringify({ status: "ok", engines: [{ name: "a" }, { name: "b", memoryInfo: { ramCapacity: 64 * 2 ** 30 } }] }));
  else if (command === "load" && args.includes("--estimate-only")) say("Model: " + sub + "\\nEstimated Total Memory: 1.00 GiB");
  else if (command === "load") {
    await call("/__lms/load", { model: sub, context_length: Number(flag("--context-length")) || undefined, ttl: Number(flag("--ttl")) || undefined, identifier: flag("--identifier") });
    process.stdout.write("\\rLoading " + sub + " 0% ⠋\\rLoading " + sub + " 100% ⠙\\r");
    say("Model loaded successfully in 1.00ms.");
  } else {
    say("unexpected: " + args.join(" "));
    process.exit(1);
  }
})();
`,
  );
  chmodSync(fakeLms, 0o755);

  // The "other machine" for the SSH tests: its home has lms where LM Studio installs it.
  mkdirSync(join(work, "remote", ".lmstudio", "bin"), { recursive: true });
  symlinkSync(fakeLms, join(work, "remote", ".lmstudio", "bin", "lms"));
  // A fake ssh: `-W host:port` pipes stdin and stdout to that port, anything else runs the command line
  // in a shell, as the login shell of the other machine would.
  mkdirSync(join(work, "bin"));
  writeFileSync(
    join(work, "bin", "ssh"),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const options = [];
const rest = [];
let forward;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "-o") options.push(args[++i]);
  else if (args[i] === "-W") forward = args[++i];
  else rest.push(args[i]);
}
const [host, command] = rest;
require("node:fs").appendFileSync(${JSON.stringify(sshLog)}, JSON.stringify({ host, forward, command, options }) + "\\n");
if (host === "unreachable") {
  process.stderr.write("ssh: connect to host unreachable port 22: Operation timed out\\n");
  process.exit(255);
}
if (forward) {
  const socket = require("node:net").connect(Number(forward.split(":")[1]), forward.split(":")[0]);
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
  socket.on("error", (error) => {
    process.stderr.write("channel 0: open failed: connect failed: " + error.message + "\\n");
    process.exit(255);
  });
  socket.on("close", () => process.exit(0));
} else {
  const child = require("node:child_process").spawn("sh", ["-c", command], { stdio: "inherit", env: { ...process.env, HOME: ${JSON.stringify(join(work, "remote"))} } });
  child.on("close", (code) => process.exit(code ?? 1));
}
`,
  );
  chmodSync(join(work, "bin", "ssh"), 0o755);
});

after(() => {
  api.closeAllConnections();
  api.close();
  rmSync(work, { recursive: true, force: true });
});

beforeEach(() => {
  loaded = new Map([["tiny-embed", { model: "tiny-embed", context_length: 2048 }]]);
  requests.length = 0;
  writeFileSync(lmsLog, "");
  writeFileSync(sshLog, "");
});

function lmsCalls() {
  return readFileSync(lmsLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line).join(" "));
}

const sent = (url) => requests.filter((r) => r.url === url);

function sshCalls() {
  return readFileSync(sshLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

// ---------- minimal MCP client ----------

function connect(env = {}) {
  const home = mkdtempSync(join(work, "home-"));
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, LMS_PATH: fakeLms, LMSTUDIO_BASE_URL: "", LM_API_TOKEN: "", LMSTUDIO_MCP_HOME: home, ...env },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const listeners = [];
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    for (const listener of [...listeners]) listener(message);
  });
  const write = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  let nextId = 1;
  const request = (method, params = {}) =>
    new Promise((resolve) => {
      const id = nextId++;
      const listener = (message) => {
        if (message.id !== id) return;
        listeners.splice(listeners.indexOf(listener), 1);
        resolve(message);
      };
      listeners.push(listener);
      write({ jsonrpc: "2.0", id, method, params });
    });
  const call = async (name, args = {}, meta) => {
    const { result, error } = await request("tools/call", { name, arguments: args, ...(meta ? { _meta: meta } : {}) });
    if (error) throw Object.assign(new Error(error.message), { code: error.code });
    const text = result.content[0].text;
    return { text, isError: Boolean(result.isError), json: () => JSON.parse(text), meta: () => JSON.parse(text.slice(text.lastIndexOf("\n") + 1)) };
  };
  return { home, write, request, call, onMessage: (listener) => listeners.push(listener), close: () => child.kill() };
}

function session(t, env) {
  const client = connect(env);
  t.after(client.close);
  return client;
}

// ---------- protocol ----------

test("initialize negotiates the protocol version and sends instructions", async (t) => {
  const c = session(t);
  const known = await c.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  assert.equal(known.result.protocolVersion, "2025-06-18");
  assert.equal(known.result.serverInfo.name, "lmstudio-mcp");
  assert.ok(known.result.capabilities.tools);
  assert.match(known.result.instructions, /server_status/);
  assert.match(known.result.instructions, /session_start/);
  assert.match(known.result.instructions, /task_start/);
  assert.ok(known.result.instructions.length < 4096);
  const unknown = await c.request("initialize", { protocolVersion: "1999-01-01" });
  assert.equal(unknown.result.protocolVersion, "2025-11-25");
  assert.deepEqual((await c.request("ping")).result, {});
});

test("tools/list exposes every tool with an object schema", async (t) => {
  const c = session(t);
  const { result } = await c.request("tools/list");
  assert.deepEqual(
    result.tools.map((tool) => tool.name),
    [
      "server_status",
      "server_start",
      "server_stop",
      "list_models",
      "model_defaults",
      "estimate_load",
      "load_model",
      "unload_model",
      "download_model",
      "download_status",
      "session_start",
      "session_send",
      "session_get",
      "session_compact",
      "session_delete",
      "task_start",
      "task_status",
      "task_cancel",
      "chat",
      "embed",
    ],
  );
  for (const tool of result.tools) {
    assert.equal(tool.inputSchema.type, "object", tool.name);
    assert.ok(tool.description.length > 20, tool.name);
    assert.equal(tool.run, undefined, tool.name);
  }
});

test("arguments are checked against the schema", async (t) => {
  const c = session(t);
  assert.match((await c.call("load_model", {})).text, /Missing required argument "model"/);
  assert.match((await c.call("load_model", { model: "--engine-config-file=/tmp/x" })).text, /does not match/);
  assert.match((await c.call("list_models", { kind: "llm" })).text, /Unknown argument "kind"/);
  assert.match((await c.call("estimate_load", { model: "tiny-llm", gpu: "lots" })).text, /does not match/);
  assert.match((await c.call("chat", { model: "tiny-llm", prompt: "x", temperature: 3 })).text, /must be at most 1/);
  assert.match((await c.call("embed", { model: "tiny-embed", texts: [] })).text, /needs at least 1/);
  assert.match((await c.call("session_get", { session_id: "../../etc/passwd" })).text, /does not match/);
  assert.match((await c.call("task_status", { task_id: "t_../x" })).text, /does not match/);
  await assert.rejects(c.call("no_such_tool"), { code: -32602 });
  assert.equal((await c.request("resources/list")).error.code, -32601);
  assert.equal(lmsCalls().filter((call) => call.startsWith("load")).length, 0);
});

test("a cancelled call gets no reply and the server keeps working", async (t) => {
  const c = session(t);
  let answered = false;
  c.onMessage((message) => {
    if (message.id === 999) answered = true;
  });
  c.write({ jsonrpc: "2.0", id: 999, method: "tools/call", params: { name: "chat", arguments: { model: "tiny-llm", prompt: "[slow] x" } } });
  await delay(600);
  c.write({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 999, reason: "test" } });
  assert.deepEqual((await c.request("ping")).result, {});
  await delay(2500);
  assert.equal(answered, false);
});

test("a request without id is a notification and gets no reply", async (t) => {
  const c = session(t);
  const messages = [];
  c.onMessage((message) => messages.push(message));
  c.write({ jsonrpc: "2.0", method: "tools/call", params: { name: "list_models", arguments: {} } });
  assert.deepEqual((await c.request("ping")).result, {});
  await delay(300);
  assert.deepEqual(messages.filter((m) => m.id === undefined || m.id === null), []);
  assert.equal(sent("/api/v1/models").length, 0);
});

test("U+2028 and U+2029 inside JSON strings don't break the framing", { timeout: 10_000 }, async (t) => {
  const c = session(t);
  const result = await c.call("chat", { model: "tiny-llm", prompt: "line\u2028one\u2029two" });
  assert.equal(result.isError, false);
  assert.match(result.text, /^Answer 1 to: line\u2028one\u2029two/);
});

test("__proto__ in the arguments is rejected", async (t) => {
  const c = session(t);
  const result = await c.call("load_model", { model: "tiny-llm", ["__proto__"]: { gpu: "--engine-config-file=/tmp/x" } });
  assert.equal(result.isError, true);
  assert.match(result.text, /Unknown argument "__proto__"/);
  assert.deepEqual(lmsCalls().filter((call) => call.startsWith("load")), []);
});

test("a slow REST call ends with a timeout message", async (t) => {
  const c = session(t, { LMSTUDIO_TIMEOUT_MS: "1000" });
  const result = await c.call("load_model", { model: "slow-llm" });
  assert.equal(result.isError, true);
  assert.match(result.text, /did not respond to POST \/api\/v1\/models\/load for 1 s/);
});

test("the version is the same everywhere", () => {
  const root = join(dirname(SERVER), "..");
  const version = execFileSync(process.execPath, [SERVER, "--version"], { encoding: "utf8" }).trim();
  assert.equal(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version, version);
  assert.equal(JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8")).version, version);
  assert.match(readFileSync(join(root, "README.md"), "utf8"), new RegExp(`lmstudio-mcp#v${version.replaceAll(".", "\\.")}"`));
  assert.match(readFileSync(join(root, "CHANGELOG.md"), "utf8"), new RegExp(`^## ${version.replaceAll(".", "\\.")} `, "m"));
});

// ---------- server ----------

test("finds the server port with lms and lists models", async (t) => {
  const c = session(t);
  const list = (await c.call("list_models")).json();
  assert.deepEqual(list[0], {
    key: "tiny-llm",
    type: "llm",
    name: "Tiny LLM",
    publisher: "test",
    format: "gguf",
    quantization: "Q4_K_M",
    size: "1.50 GB",
    params: "1B",
    max_context: 32768,
    capabilities: ["vision", "tool_use"],
  });
  const loadedOnly = (await c.call("list_models", { loaded_only: true })).json();
  assert.deepEqual(loadedOnly.map((m) => m.key), ["tiny-embed"]);
  assert.deepEqual(loadedOnly[0].loaded, [{ instance_id: "tiny-embed", context_length: 2048 }]);
  assert.equal((await c.call("list_models", { type: "embedding" })).json().length, 1);
  assert.ok(lmsCalls().includes("server status --json"));
});

test("an unset plugin option placeholder falls back to auto-detection", async (t) => {
  const c = session(t, { LMSTUDIO_BASE_URL: "${user_config.base_url}", LM_API_TOKEN: "${user_config.api_token}" });
  const status = (await c.call("server_status")).json();
  assert.equal(status.reachable, true);
  assert.equal(status.base_url, `http://127.0.0.1:${port}`);
  assert.equal(status.url_source, "lms server status");
  assert.deepEqual(status.loaded_models, [{ instance_id: "tiny-embed", model: "tiny-embed", type: "embedding", context_length: 2048, state: "idle" }]);
  assert.equal(sent("/api/v1/models").at(-1).auth, undefined);
});

test("a stopped server is reported with its last port", async (t) => {
  const c = session(t, { FAKE_LMS_STOPPED_PORT: "9" });
  const status = (await c.call("server_status")).json();
  assert.equal(status.reachable, false);
  assert.equal(status.base_url, "http://127.0.0.1:9");
  assert.equal(status.lms_cli.server_running, false);
  assert.match(status.error, /server is not running \(last port 9\)\. Start it with server_start/);
});

test("works without lms when the URL is set", async (t) => {
  const c = session(t, { LMS_PATH: join(work, "no-lms-here"), LMSTUDIO_BASE_URL: `http://127.0.0.1:${port}` });
  const status = (await c.call("server_status")).json();
  assert.equal(status.reachable, true);
  assert.equal(status.lms_cli.available, false);
  assert.equal((await c.call("list_models")).json().length, 3);
  const start = await c.call("server_start");
  assert.equal(start.isError, true);
  assert.match(start.text, /`lms` not found/);
});

test("server_start, server_stop and estimate_load use lms", async (t) => {
  const c = session(t);
  const started = (await c.call("server_start", { port: 4321 })).json();
  assert.equal(started.running, true);
  assert.match(started.message, /^Success! Server is now running/);
  assert.ok(lmsCalls().includes("server start --port 4321"));
  const estimate = await c.call("estimate_load", { model: "tiny-llm", context_length: 4096 });
  assert.match(estimate.text, /^Model: tiny-llm\nEstimated Total Memory: 1\.00 GiB/);
  assert.match(estimate.text, /System RAM: \d+ GiB$/);
  assert.ok(lmsCalls().includes("load tiny-llm --estimate-only -y --context-length 4096"));
  assert.equal((await c.call("server_stop")).json().running, true); // the fake lms always reports a running server
  assert.ok(lmsCalls().includes("server stop"));
});

test("sends the API token when one is set", async (t) => {
  const c = session(t, { LM_API_TOKEN: "secret-token" });
  await c.call("list_models");
  assert.equal(sent("/api/v1/models").at(-1).auth, "Bearer secret-token");
});

test("explains how to recover when LM Studio is down", async (t) => {
  const c = session(t, { LMSTUDIO_BASE_URL: "http://127.0.0.1:9" });
  const result = await c.call("list_models");
  assert.equal(result.isError, true);
  assert.match(result.text, /Cannot reach LM Studio at http:\/\/127\.0\.0\.1:9 .*server_start/);
});

test("lms-based tools refuse to act on a remote LM Studio", async (t) => {
  const c = session(t, { LMSTUDIO_BASE_URL: "http://192.0.2.10:1234" });
  for (const [name, args] of [
    ["server_start", {}],
    ["server_stop", {}],
    ["estimate_load", { model: "tiny-llm" }],
    ["load_model", { model: "tiny-llm", ttl: 60 }],
  ]) {
    const result = await c.call(name, args);
    assert.equal(result.isError, true, name);
    assert.match(result.text, /needs LM Studio on this machine/, name);
  }
  assert.deepEqual(lmsCalls(), []);
});

// ---------- LM Studio on another machine over SSH ----------

test("over SSH, lms runs on the other machine and API requests travel through ssh", async (t) => {
  const c = session(t, { ...SSH, LMSTUDIO_BASE_URL: "http://192.0.2.1:9" }); // the URL is ignored
  const status = (await c.call("server_status")).json();
  assert.equal(status.reachable, true);
  assert.equal(status.ssh_host, "studio");
  assert.equal(status.url_source, "lms on studio (SSH)");
  assert.equal(status.base_url, `http://127.0.0.1:${port}`);
  assert.equal(status.lms_cli.path, "studio:~/.lmstudio/bin/lms");
  assert.equal(status.system_ram, "64 GiB");
  assert.equal((await c.call("list_models")).json().length, 3);
  assert.match((await c.call("chat", { model: "tiny-llm", prompt: "Hi" })).text, /^Answer 1 to: Hi/);
  assert.match((await c.call("estimate_load", { model: "tiny-llm" })).text, /System RAM of studio: 64 GiB$/);

  const calls = sshCalls();
  assert.ok(calls.every((call) => call.host === "studio" && call.options.includes("BatchMode=yes")));
  assert.ok(calls.some((call) => call.command === `env -u LMS_SERVER_HOST "$HOME/.lmstudio/bin/lms" 'server' 'status' '--json'`));
  const forwards = calls.filter((call) => call.forward);
  assert.ok(forwards.length >= 3);
  assert.ok(forwards.every((call) => call.forward === `127.0.0.1:${port}`));
});

test("over SSH, arguments reach lms exactly as given", async (t) => {
  const c = session(t, SSH);
  const identifier = `it's a "test" $HOME; echo x`;
  const result = (await c.call("load_model", { model: "tiny-llm", ttl: 60, identifier })).json();
  assert.equal(result.status, "loaded");
  assert.equal(result.instances[0].instance_id, identifier);
  const load = readFileSync(lmsLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((args) => args[0] === "load");
  assert.deepEqual(load, ["load", "tiny-llm", "-y", "--ttl", "60", "--identifier", identifier]);
});

test("over SSH, problems with the connection are reported clearly", async (t) => {
  const unreachable = await session(t, { ...SSH, LMSTUDIO_SSH_HOST: "unreachable" }).call("server_status");
  assert.equal(unreachable.isError, true);
  assert.match(unreachable.text, /^Cannot reach unreachable over SSH: ssh: connect to host unreachable port 22: Operation timed out/);

  const noLms = await session(t, { ...SSH, LMS_PATH: "/nonexistent/lms" }).call("list_models");
  assert.equal(noLms.isError, true);
  assert.match(noLms.text, /`lms` not found on studio/);

  writeFileSync(sshLog, "");
  const option = await session(t, { ...SSH, LMSTUDIO_SSH_HOST: "-oProxyCommand=touch /tmp/x" }).call("list_models");
  assert.equal(option.isError, true);
  assert.match(option.text, /is not a usable SSH host/);
  assert.deepEqual(sshCalls(), []);
});

test("over SSH, a stopped server is started with lms on the other machine", async (t) => {
  const c = session(t, { ...SSH, FAKE_LMS_STOPPED_PORT: "9" });
  const down = await c.call("list_models");
  assert.equal(down.isError, true);
  assert.match(down.text, /server is not running \(last port 9\)\. Start it with server_start/);
  assert.match((await c.call("server_start")).json().message, /^Success! Server is now running/);
  assert.ok(sshCalls().some((call) => call.command?.endsWith(`'server' 'start'`)));
});

// ---------- models ----------

test("load_model uses the REST API and keeps a model that is already loaded", async (t) => {
  const c = session(t);
  const result = (await c.call("load_model", { model: "tiny-llm", context_length: 8192, flash_attention: false })).json();
  assert.equal(result.instance_id, "tiny-llm");
  assert.deepEqual(result.config, { context_length: 8192 });
  assert.deepEqual(sent("/api/v1/models/load")[0].body, { model: "tiny-llm", context_length: 8192, flash_attention: false, echo_load_config: true });

  const again = (await c.call("load_model", { model: "tiny-llm", context_length: 16384 })).json();
  assert.equal(again.status, "already_loaded");
  assert.equal(sent("/api/v1/models/load").length, 1);

  const replaced = (await c.call("load_model", { model: "tiny-llm", context_length: 16384, replace: true })).json();
  assert.deepEqual(replaced.replaced, ["tiny-llm"]);
  assert.deepEqual(replaced.config, { context_length: 16384 });
  assert.deepEqual(sent("/api/v1/models/unload")[0].body, { instance_id: "tiny-llm" });
});

test("load_model with ttl or gpu goes through lms", async (t) => {
  const c = session(t);
  const result = (await c.call("load_model", { model: "tiny-llm", ttl: 600, gpu: "max" })).json();
  assert.equal(result.status, "loaded");
  assert.equal(result.message, "Model loaded successfully in 1.00ms.");
  assert.deepEqual(result.instances, [{ instance_id: "tiny-llm", model: "tiny-llm", type: "llm", context_length: 4096, ttl_seconds: 600, state: "idle" }]);
  assert.ok(lmsCalls().includes("load tiny-llm -y --gpu max --ttl 600"));
  assert.equal(sent("/api/v1/models/load").length, 0);
});

test("lms loads need an exact model key", async (t) => {
  const c = session(t);
  for (const [name, args] of [
    ["load_model", { model: "tiny", ttl: 60 }],
    ["estimate_load", { model: "tiny" }],
  ]) {
    const result = await c.call(name, args);
    assert.equal(result.isError, true, name);
    assert.match(result.text, /No downloaded model has the key "tiny"/, name);
  }
  assert.deepEqual(lmsCalls().filter((call) => call.startsWith("load")), []);
});

test("load_model refuses to mix lms and REST options", async (t) => {
  const c = session(t);
  const result = await c.call("load_model", { model: "tiny-llm", ttl: 60, flash_attention: true });
  assert.equal(result.isError, true);
  assert.match(result.text, /Can't combine ttl/);
  assert.match((await c.call("load_model", { model: "tiny-llm", identifier: "x", replace: true })).text, /replace doesn't apply with identifier/);
});

test("parallel calls load a model only once", async (t) => {
  const c = session(t);
  const chats = await Promise.all([c.call("chat", { model: "tiny-llm", prompt: "one" }), c.call("chat", { model: "tiny-llm", prompt: "two" })]);
  assert.deepEqual(chats.map((r) => r.isError), [false, false]);
  assert.equal(sent("/api/v1/models/load").length, 1);

  await c.call("unload_model", { all: true });
  const tasks = await Promise.all([c.call("task_start", { model: "tiny-llm", prompt: "job one" }), c.call("task_start", { model: "tiny-llm", prompt: "job two" })]);
  for (const task of tasks) assert.equal((await c.call("task_status", { task_id: task.json().task_id, wait_seconds: 10 })).meta().status, "done");
  assert.equal(sent("/api/v1/models/load").length, 2);
  assert.deepEqual([...loaded.keys()], ["tiny-llm"]);
});

test("a model used by a running task can't be replaced or unloaded", async (t) => {
  const c = session(t);
  const task = (await c.call("task_start", { model: "tiny-llm", prompt: "[slow] busy work" })).json();
  await delay(600);
  const replaced = await c.call("load_model", { model: "tiny-llm", replace: true });
  assert.equal(replaced.isError, true);
  assert.match(replaced.text, new RegExp(`in use by task ${task.task_id}`));
  assert.equal((await c.call("unload_model", { all: true })).isError, true);
  assert.equal(sent("/api/v1/models/unload").length, 0);
  await c.call("task_status", { task_id: task.task_id, wait_seconds: 15 });
  assert.deepEqual((await c.call("unload_model", { all: true })).json().unloaded.sort(), ["tiny-embed", "tiny-llm"]);
});

test("LM Studio errors come back as tool errors", async (t) => {
  const c = session(t);
  const result = await c.call("load_model", { model: "missing" });
  assert.equal(result.isError, true);
  assert.match(result.text, /HTTP 404 model_not_found\): Model missing not found/);
});

test("model_defaults are saved and used when loading", async (t) => {
  const c = session(t);
  assert.deepEqual((await c.call("model_defaults", { model: "tiny-llm", context_length: 8192, ttl: 300 })).json(), { "tiny-llm": { context_length: 8192, ttl: 300 } });
  assert.deepEqual((await c.call("model_defaults")).json(), { "tiny-llm": { context_length: 8192, ttl: 300 } });
  assert.deepEqual((await c.call("list_models")).json()[0].defaults, { context_length: 8192, ttl: 300 });

  const viaLms = (await c.call("load_model", { model: "tiny-llm" })).json();
  assert.deepEqual(viaLms.defaults_used, { context_length: 8192, ttl: 300 });
  assert.ok(lmsCalls().includes("load tiny-llm -y --context-length 8192 --ttl 300"));

  // A REST-only option keeps the saved context length but drops the saved ttl.
  await c.call("unload_model", { instance_id: "tiny-llm" });
  await c.call("load_model", { model: "tiny-llm", flash_attention: true });
  assert.deepEqual(sent("/api/v1/models/load").at(-1).body, { model: "tiny-llm", context_length: 8192, flash_attention: true, echo_load_config: true });

  assert.deepEqual((await c.call("model_defaults", { model: "tiny-llm", clear: true })).json(), { "tiny-llm": "cleared" });
  assert.deepEqual(JSON.parse(readFileSync(join(c.home, "model-defaults.json"), "utf8")), {});
});

test("unload_model unloads one instance or all of them", async (t) => {
  const c = session(t);
  assert.deepEqual((await c.call("unload_model", { all: true })).json(), { unloaded: ["tiny-embed"] });
  assert.equal((await c.call("unload_model", { all: true })).text, "No models are loaded.");
  const missing = await c.call("unload_model", { instance_id: "tiny-embed" });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /is not loaded/);
  assert.equal((await c.call("unload_model")).isError, true);
});

test("download_model and download_status report progress", async (t) => {
  const c = session(t);
  const started = (await c.call("download_model", { model: "qwen/qwen3-4b" })).json();
  assert.equal(started.job_id, "job_1");
  assert.equal(started.total_size, "2.00 GB");
  const status = (await c.call("download_status", { job_id: "job_1" })).json();
  assert.equal(status.progress, "25.0%");
  assert.equal(status.speed, "50.0 MB/s");
});

// ---------- chat and embeddings ----------

test("chat loads the model when needed and streams the answer", async (t) => {
  const c = session(t);
  const notes = [];
  c.onMessage((message) => message.method === "notifications/progress" && notes.push(message.params));
  const result = await c.call("chat", { model: "tiny-llm", prompt: "Hi", system_prompt: "Be brief", max_output_tokens: 20 }, { progressToken: "p1" });
  assert.match(result.text, /^Answer 1 to: Hi/);
  assert.doesNotMatch(result.text, /thinking/);
  assert.equal(result.meta().loaded_now, true);
  assert.equal(result.meta().stats.tokens_per_second, 42);
  assert.deepEqual(sent("/api/v1/models/load")[0].body, { model: "tiny-llm", echo_load_config: true });
  assert.deepEqual(sent("/api/v1/chat")[0].body, { model: "tiny-llm", input: "Hi", store: false, system_prompt: "Be brief", max_output_tokens: 20, stream: true });
  assert.ok(notes.length >= 1);
  assert.equal(notes[0].progressToken, "p1");
  assert.match(notes[0].message, /reading prompt/);

  const withReasoning = await c.call("chat", { model: "tiny-llm", prompt: "Hi", include_reasoning: true });
  assert.match(withReasoning.text, /--- reasoning ---\nthinking/);
  assert.equal(sent("/api/v1/models/load").length, 1); // already loaded the second time
});

test("chat asks for reload when the loaded context is too small", async (t) => {
  const c = session(t);
  await c.call("load_model", { model: "tiny-llm" }); // 4096 tokens
  const refused = await c.call("chat", { model: "tiny-llm", prompt: "Hi", context_length: 8192 });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /loaded with a 4096-token context, but 8192 tokens are needed.*reload: true/);
  const reloaded = await c.call("chat", { model: "tiny-llm", prompt: "Hi", context_length: 8192, reload: true });
  assert.match(reloaded.text, /^Answer 1 to: Hi/);
  assert.deepEqual(sent("/api/v1/models/load").at(-1).body, { model: "tiny-llm", context_length: 8192, echo_load_config: true });
});

test("chat attaches images, shows tool calls and reports stream errors", async (t) => {
  const c = session(t);
  const image = join(work, "pixel.png");
  writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await c.call("chat", { model: "tiny-llm", prompt: "What is this?", images: [image] });
  assert.deepEqual(sent("/api/v1/chat")[0].body.input, [
    { type: "text", content: "What is this?" },
    { type: "image", data_url: "data:image/png;base64,iVBORw==" },
  ]);
  assert.match((await c.call("chat", { model: "tiny-llm", prompt: "x", images: [join(work, "missing.png")] })).text, /Image not found/);
  assert.match((await c.call("chat", { model: "tiny-llm", prompt: "x", images: [join(work, "notes.txt")] })).text, /Unsupported image type/);

  const withTools = await c.call("chat", { model: "tiny-llm", prompt: "Find it", integrations: ["mcp/search"] });
  assert.match(withTools.text, /--- tool calls by the local model ---\n\[\{"tool":"search","arguments":\{"q":"x"\},"output":"found"\}\]/);

  const failed = await c.call("chat", { model: "tiny-llm", prompt: "[error]" });
  assert.equal(failed.isError, true);
  assert.match(failed.text, /could not answer \(internal_error\): boom/);
});

test("text files are read from disk and added to the message", async (t) => {
  const c = session(t);
  const notes = join(work, "notes.md");
  const code = join(work, "code.js");
  writeFileSync(notes, "# Notes\nfirst line\n");
  writeFileSync(code, "export const x = 1;\n");
  await c.call("chat", { model: "tiny-llm", prompt: "Review these", files: [notes, code] });
  assert.equal(
    sent("/api/v1/chat").at(-1).body.input,
    `Review these\n\n--- file: ${notes} ---\n# Notes\nfirst line\n\n--- end of file ---\n\n--- file: ${code} ---\nexport const x = 1;\n\n--- end of file ---`,
  );

  // In a session the transcript keeps the paths, not the contents.
  const { session_id } = (await c.call("session_start", { model: "tiny-llm" })).json();
  await c.call("session_send", { session_id, message: "Summarize", files: [notes] });
  assert.match(sent("/api/v1/chat").at(-1).body.input, /^Summarize\n\n--- file: .*notes\.md ---\n# Notes/);
  const turn = (await c.call("session_get", { session_id })).json().turns[0];
  assert.equal(turn.content, "Summarize");
  assert.deepEqual(turn.files, [notes]);
  await fetch(`http://127.0.0.1:${port}/__forget`, { method: "POST" });
  await c.call("session_send", { session_id, message: "And now?" });
  assert.match(sent("/api/v1/chat").at(-1).body.system_prompt, new RegExp(`User: Summarize\\n\\[attached files, not repeated here: .*notes\\.md\\]`));

  const task = (await c.call("task_start", { session_id, prompt: "Check the code", files: [code] })).json();
  assert.match((await c.call("task_status", { task_id: task.task_id, wait_seconds: 10 })).text, /^Answer 2 to: Check the code\n\n--- file: .*code\.js ---/);
});

test("files that can't be attached are refused before anything is sent", async (t) => {
  const c = session(t);
  const binary = join(work, "data.bin");
  const big = join(work, "big.txt");
  writeFileSync(binary, Buffer.from([1, 2, 0, 3]));
  writeFileSync(big, "x".repeat(2_000_001));
  const call = (files) => c.call("chat", { model: "tiny-llm", prompt: "x", files });
  assert.match((await call(["relative.txt"])).text, /Use an absolute path for files/);
  assert.match((await call([join(work, "missing.txt")])).text, /File not found/);
  assert.match((await call([work])).text, /Not a file/);
  assert.match((await call([binary])).text, /Not a text file/);
  assert.match((await call([big])).text, /File is larger than 2 MB/);
  assert.match((await c.call("task_start", { model: "tiny-llm", prompt: "x", files: [join(work, "missing.txt")] })).text, /File not found/);
  assert.equal(sent("/api/v1/chat").length, 0);
  assert.equal((await c.call("session_get")).text, "No sessions yet. Start one with session_start.");
});

test("a request that is larger than the context is explained", async (t) => {
  const c = session(t);
  const result = await c.call("chat", { model: "tiny-llm", prompt: "[too long] a huge prompt" });
  assert.equal(result.isError, true);
  assert.equal(result.text, "The request needs 20,523 tokens, but the model is loaded with a 4,096-token context. Send less, run session_compact, or load the model with a larger context.");
  assert.deepEqual(sent("/api/v1/chat").map((r) => r.body.stream), [true, undefined]);
});

test("an answer that never came because the context filled up is explained", async (t) => {
  const c = session(t);
  const chat = await c.call("chat", { model: "tiny-llm", prompt: "[no answer] think hard" });
  assert.match(chat.text, /^\(empty answer\)\n\n--- the model gave no answer; its reasoning ended with ---\nFirst I look at the file\. Then I keep thinking and never finish\n\n--- meta ---/);
  assert.equal(chat.meta().context, "4,096 / 4,096 tokens (100%)");
  assert.match(chat.meta().warning, /^The context is full, so the answer is cut off or missing/);

  const task = (await c.call("task_start", { model: "tiny-llm", prompt: "[no answer] review" })).json();
  const done = await c.call("task_status", { task_id: task.task_id, wait_seconds: 10 });
  assert.match(done.text, /^\(empty answer\)\n\n--- the model gave no answer; its reasoning ended with ---\nFirst I look/);
  assert.match(done.meta().warning, /^The context is full/);
});

test("a context below the saved default is pointed out", async (t) => {
  const c = session(t);
  await c.call("model_defaults", { model: "tiny-llm", context_length: 16384 });
  const note = /context_length 4096 is below the saved default of this model \(16384\)/;
  assert.match((await c.call("load_model", { model: "tiny-llm", context_length: 4096 })).json().note, note);
  assert.match((await c.call("session_start", { model: "tiny-llm", context_length: 4096 })).json().note, note);
  assert.match((await c.call("task_start", { model: "tiny-llm", context_length: 4096, prompt: "job" })).json().note, note);
  await c.call("unload_model", { all: true }).catch(() => {});
  assert.equal((await c.call("session_start", { model: "tiny-llm", reload: true })).json().note, undefined);
});

test("embed returns the cosine similarity matrix", async (t) => {
  const c = session(t);
  const result = (await c.call("embed", { model: "tiny-embed", texts: ["a", "b"] })).json();
  assert.deepEqual(result, { model: "tiny-embed", count: 2, dimensions: 2, cosine_similarity: [[1, 0.7071], [0.7071, 1]] });
  const withVectors = (await c.call("embed", { model: "tiny-embed", texts: ["a"], include_vectors: true })).json();
  assert.deepEqual(withVectors.vectors, [[1, 0]]);
});

// ---------- sessions ----------

test("sessions keep the conversation in LM Studio and report context use", async (t) => {
  const c = session(t);
  const started = (await c.call("session_start", { model: "tiny-llm", title: "demo", system_prompt: "Be brief", context_length: 8192 })).json();
  assert.match(started.session_id, /^s_[a-z0-9]+$/);
  assert.equal(started.context, "0 / 8,192 tokens (0%)");
  assert.equal(started.loaded_now, true);
  assert.deepEqual(sent("/api/v1/models/load")[0].body, { model: "tiny-llm", context_length: 8192, echo_load_config: true });

  const first = await c.call("session_send", { session_id: started.session_id, message: "first" });
  assert.match(first.text, /^Answer 1 to: first/);
  assert.equal(first.meta().context, "120 / 8,192 tokens (1%)");
  const firstBody = sent("/api/v1/chat")[0].body;
  assert.deepEqual(firstBody, { model: "tiny-llm", input: "first", system_prompt: "Be brief", store: true, stream: true });

  const second = await c.call("session_send", { session_id: started.session_id, message: "second" });
  assert.match(second.text, /^Answer 2 to: second/);
  const secondBody = sent("/api/v1/chat")[1].body;
  assert.match(secondBody.previous_response_id, /^resp_\d+$/);
  assert.equal(secondBody.system_prompt, undefined);

  const list = (await c.call("session_get")).json();
  assert.deepEqual(list.map((s) => [s.session_id, s.title, s.exchanges, s.context]), [[started.session_id, "demo", 2, "220 / 8,192 tokens (3%)"]]);
  const detail = (await c.call("session_get", { session_id: started.session_id, last: 1 })).json();
  assert.equal(detail.turns_total, 4);
  assert.deepEqual(detail.turns.map((turn) => turn.role), ["user", "assistant"]);
  assert.equal(detail.settings.system_prompt, "Be brief");
  assert.ok(existsSync(join(c.home, "sessions", `${started.session_id}.json`)));
});

test("a full context triggers a warning and session_compact starts a fresh context", async (t) => {
  const c = session(t);
  const { session_id } = (await c.call("session_start", { model: "tiny-llm", system_prompt: "Be brief" })).json();
  const full = await c.call("session_send", { session_id, message: "[fill] a lot" });
  assert.equal(full.meta().context, "3,502 / 4,096 tokens (85%)");
  assert.match(full.meta().warning, /session_compact/);

  const compacted = (await c.call("session_compact", { session_id })).json();
  assert.equal(compacted.context_before, "3,502 / 4,096 tokens (85%)");
  assert.equal(compacted.summary, "SUMMARY: we talked.");
  const compactBody = sent("/api/v1/chat").at(-1).body;
  assert.equal(compactBody.store, false);
  assert.match(compactBody.previous_response_id, /^resp_\d+$/);

  const next = await c.call("session_send", { session_id, message: "next" });
  assert.match(next.text, /^Answer 1 to: next/);
  const nextBody = sent("/api/v1/chat").at(-1).body;
  assert.equal(nextBody.previous_response_id, undefined);
  assert.equal(nextBody.system_prompt, "Be brief\n\nSummary of the conversation so far:\nSUMMARY: we talked.");
});

test("a session continues from its saved transcript when LM Studio lost the conversation", async (t) => {
  const c = session(t);
  const forget = () => fetch(`http://127.0.0.1:${port}/__forget`, { method: "POST" });
  const { session_id } = (await c.call("session_start", { model: "tiny-llm", system_prompt: "Be brief" })).json();
  await c.call("session_send", { session_id, message: "first" });
  await forget();

  const second = await c.call("session_send", { session_id, message: "second" });
  assert.equal(second.isError, false);
  assert.match(second.text, /^Answer 1 to: second/);
  assert.match(second.meta().warning, /rebuilt from the saved transcript/);
  const retry = sent("/api/v1/chat").at(-1).body;
  assert.equal(retry.previous_response_id, undefined);
  assert.equal(retry.system_prompt, "Be brief\n\nEarlier messages of this conversation:\nUser: first\n\nAssistant: Answer 1 to: first");

  const third = await c.call("session_send", { session_id, message: "third" });
  assert.match(third.text, /^Answer 2 to: third/);
  assert.equal(third.meta().warning, undefined);

  await forget();
  const compacted = (await c.call("session_compact", { session_id })).json();
  assert.equal(compacted.summary, "SUMMARY: we talked.");
  const compactBody = sent("/api/v1/chat").at(-1).body;
  assert.equal(compactBody.previous_response_id, undefined);
  assert.match(compactBody.input, /\n\nConversation:\nUser: first\n\nAssistant: Answer 1 to: first/);
});

test("a refused request that is not about the conversation is reported, not retried", async (t) => {
  const c = session(t);
  const { session_id } = (await c.call("session_start", { model: "tiny-llm" })).json();
  await c.call("session_send", { session_id, message: "first" });
  const before = sent("/api/v1/chat").length;
  const refused = await c.call("session_send", { session_id, message: "[bad request]" });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /HTTP 400 invalid_request\): Invalid response format/);
  assert.equal(sent("/api/v1/chat").length, before + 1);
  assert.match((await c.call("session_send", { session_id, message: "second" })).text, /^Answer 2 to: second/);
});

test("a rebuilt conversation keeps the end of a very long last turn and still warns about a full context", async (t) => {
  const c = session(t);
  const { session_id } = (await c.call("session_start", { model: "tiny-llm" })).json(); // 4096 tokens
  await c.call("session_send", { session_id, message: `start ${"x".repeat(6000)} END-OF-FIRST` });
  await fetch(`http://127.0.0.1:${port}/__forget`, { method: "POST" });
  const next = await c.call("session_send", { session_id, message: "[fill] next" });
  const system = sent("/api/v1/chat").at(-1).body.system_prompt;
  assert.match(system, /^Earlier messages of this conversation:\n…/);
  assert.ok(system.endsWith("END-OF-FIRST"));
  assert.ok(system.length < 4200);
  assert.match(next.meta().warning, /rebuilt from the saved transcript\. The context is getting full/);
});

test("session_compact works after the model was reloaded with a smaller context", async (t) => {
  const c = session(t);
  const { session_id } = (await c.call("session_start", { model: "tiny-llm", context_length: 8192 })).json();
  await c.call("session_send", { session_id, message: "first" });
  await c.call("load_model", { model: "tiny-llm", context_length: 4096, replace: true });
  const compacted = await c.call("session_compact", { session_id });
  assert.equal(compacted.isError, false);
  assert.equal(compacted.json().summary, "SUMMARY: we talked.");
  const send = await c.call("session_send", { session_id, message: "more" });
  assert.match(send.text, /loaded with a 4096-token context, but 8192 tokens are needed.*reload: true/);
});

test("session_start reloads a model with a smaller context only when asked", async (t) => {
  const c = session(t);
  await c.call("load_model", { model: "tiny-llm" }); // 4096 tokens
  const refused = await c.call("session_start", { model: "tiny-llm", context_length: 8192 });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /reload: true/);
  const started = (await c.call("session_start", { model: "tiny-llm", context_length: 8192, reload: true })).json();
  assert.equal(started.context, "0 / 8,192 tokens (0%)");
  assert.deepEqual(sent("/api/v1/models/unload")[0].body, { instance_id: "tiny-llm" });
});

test("session_start uses the model's saved context length", async (t) => {
  const c = session(t);
  await c.call("model_defaults", { model: "tiny-llm", context_length: 16384 });
  const started = (await c.call("session_start", { model: "tiny-llm" })).json();
  assert.equal(started.context, "0 / 16,384 tokens (0%)");
});

test("session_delete removes a session and its tasks", async (t) => {
  const c = session(t);
  const task = (await c.call("task_start", { model: "tiny-llm", prompt: "quick job" })).json();
  await c.call("task_status", { task_id: task.task_id, wait_seconds: 10 });
  assert.deepEqual((await c.call("session_delete", { session_id: task.session_id })).json(), { deleted: [task.session_id] });
  assert.match((await c.call("session_get", { session_id: task.session_id })).text, /Unknown session/);
  assert.deepEqual(readdirSync(join(c.home, "tasks")).filter((f) => f.endsWith(".json")), []);
});

// ---------- tasks ----------

test("tasks run in the background and report progress and results", async (t) => {
  const c = session(t);
  const startedAt = Date.now();
  const task = (await c.call("task_start", { model: "tiny-llm", prompt: "[slow] write a report", context_length: 8192 })).json();
  assert.ok(Date.now() - startedAt < 1500, "task_start must not wait for the answer");
  assert.match(task.task_id, /^t_[a-z0-9]+$/);
  assert.equal(task.status, "running");

  await delay(1200);
  const running = (await c.call("task_status", { task_id: task.task_id })).json();
  assert.equal(running.status, "running");
  assert.ok(running.progress.phase);

  const busy = await c.call("session_send", { session_id: task.session_id, message: "hello?" });
  assert.equal(busy.isError, true);
  assert.match(busy.text, /busy with task/);

  const done = await c.call("task_status", { task_id: task.task_id, wait_seconds: 15 });
  assert.match(done.text, /^Answer 1 to: \[slow\] write a report/);
  assert.equal(done.meta().status, "done");
  assert.equal(done.meta().context, "120 / 8,192 tokens (1%)");

  const list = (await c.call("task_status")).json();
  assert.deepEqual(list.map((row) => [row.task_id, row.status]), [[task.task_id, "done"]]);
  assert.equal(JSON.parse(readFileSync(join(c.home, "tasks", `${task.task_id}.json`), "utf8")).status, "done");

  // The task's session continues where the task left off.
  const follow = await c.call("session_send", { session_id: task.session_id, message: "thanks" });
  assert.match(follow.text, /^Answer 2 to: thanks/);
});

test("task_cancel stops a running task", async (t) => {
  const c = session(t);
  const task = (await c.call("task_start", { model: "tiny-llm", prompt: "[slow] long job" })).json();
  await delay(700);
  assert.deepEqual((await c.call("task_cancel", { task_id: task.task_id })).json(), { task_id: task.task_id, status: "cancelled" });
  assert.equal((await c.call("task_status", { task_id: task.task_id })).json().status, "cancelled");
  assert.equal((await c.call("session_get", { session_id: task.session_id })).json().turns_total, 0);
});

test("task_start checks its arguments before starting", async (t) => {
  const c = session(t);
  assert.match((await c.call("task_start", { prompt: "x" })).text, /Pass session_id to continue a session, or model/);
  assert.match((await c.call("task_start", { prompt: "x", model: "tiny-llm", session_id: "s_abc" })).text, /not both/);
  assert.match((await c.call("task_start", { prompt: "x", session_id: "s_abc", system_prompt: "y" })).text, /only apply to a new session/);
  assert.match((await c.call("task_start", { prompt: "x", model: "tiny-llm", images: [join(work, "missing.png")] })).text, /Image not found/);
});

test("two Claude Code sessions share sessions and tasks safely", async (t) => {
  const a = session(t);
  const b = session(t, { LMSTUDIO_MCP_HOME: a.home });
  const task = (await a.call("task_start", { model: "tiny-llm", prompt: "[very slow] shared job" })).json();
  await delay(300);
  assert.match((await b.call("session_send", { session_id: task.session_id, message: "hi" })).text, new RegExp(`busy with task ${task.task_id}`));
  assert.match((await b.call("session_delete", { session_id: task.session_id })).text, /Busy sessions can't be deleted/);
  assert.equal((await b.call("task_status", { task_id: task.task_id })).json().status, "running");
  assert.equal((await b.call("task_cancel", { task_id: task.task_id })).json().status, "cancel requested");
  assert.equal((await a.call("task_status", { task_id: task.task_id, wait_seconds: 10 })).json().status, "cancelled");
  assert.equal((await b.call("task_status", { task_id: task.task_id })).json().status, "cancelled");
  assert.deepEqual((await b.call("session_delete", { session_id: task.session_id })).json(), { deleted: [task.session_id] });
});

test("stale tasks and locks don't block anything", async (t) => {
  const c = session(t);
  mkdirSync(join(c.home, "tasks"), { recursive: true });
  mkdirSync(join(c.home, "sessions"), { recursive: true });
  const minuteAgo = new Date(Date.now() - 60_000);
  // This test process is alive, but it stopped refreshing the task a minute ago (like a reused pid).
  writeFileSync(
    join(c.home, "tasks", "t_stale1.json"),
    JSON.stringify({ id: "t_stale1", session_id: "s_stale1", status: "running", pid: process.pid, started_at: minuteAgo.toISOString(), heartbeat_at: minuteAgo.toISOString() }),
  );
  assert.equal((await c.call("task_status", { task_id: "t_stale1" })).json().status, "interrupted");

  writeFileSync(join(c.home, "sessions", "s_stale1.json"), JSON.stringify({ id: "s_stale1", model: "tiny-llm", turns: [] }));
  const lock = join(c.home, "sessions", "s_stale1.lock");
  writeFileSync(lock, JSON.stringify({ pid: process.pid }));
  utimesSync(lock, minuteAgo, minuteAgo);
  assert.equal((await c.call("session_get")).json()[0].busy, undefined);

  utimesSync(lock, new Date(), new Date()); // a fresh lock of a live process
  assert.equal((await c.call("session_get")).json()[0].busy, true);
  assert.match((await c.call("session_delete", { session_id: "s_stale1" })).text, /Busy sessions can't be deleted/);

  utimesSync(lock, minuteAgo, minuteAgo);
  assert.deepEqual((await c.call("session_delete", { session_id: "s_stale1" })).json(), { deleted: ["s_stale1"] });
});

test("a task survives when its folder can't be written", { skip: process.platform === "win32" }, async (t) => {
  const c = session(t);
  const task = (await c.call("task_start", { model: "tiny-llm", prompt: "[slow] write while read-only" })).json();
  const folder = join(c.home, "tasks");
  chmodSync(folder, 0o500);
  t.after(() => chmodSync(folder, 0o700));
  const done = await c.call("task_status", { task_id: task.task_id, wait_seconds: 15 });
  assert.match(done.text, /^Answer 1 to: \[slow\] write while read-only/);
  assert.deepEqual((await c.request("ping")).result, {});
  assert.match((await c.call("session_send", { session_id: task.session_id, message: "next" })).text, /^Answer 2 to: next/);
});

test("broken session files don't break the session list", async (t) => {
  const c = session(t);
  mkdirSync(join(c.home, "sessions"), { recursive: true });
  writeFileSync(join(c.home, "sessions", "s_bad1.json"), JSON.stringify({ id: "s_bad1" }));
  writeFileSync(join(c.home, "sessions", "s_evil.json"), JSON.stringify({ id: "../../etc/x" }));
  writeFileSync(join(c.home, "sessions", "s_junk.json"), "not json");
  assert.deepEqual((await c.call("session_get")).json().map((s) => [s.session_id, s.exchanges]), [["s_bad1", 0]]);
  assert.equal((await c.call("session_get", { session_id: "s_bad1" })).json().turns_total, 0);
});

test("old tasks are pruned, also those cut short by a crash", async (t) => {
  const c = session(t);
  mkdirSync(join(c.home, "tasks"), { recursive: true });
  const old = new Date(Date.now() - 15 * 24 * 3600_000).toISOString();
  const recent = new Date(Date.now() - 3600_000).toISOString();
  const write = (id, fields) => writeFileSync(join(c.home, "tasks", `${id}.json`), JSON.stringify({ id, session_id: "s_x", prompt: "p", pid: 99999999, ...fields }));
  write("t_olddone", { status: "done", started_at: old, finished_at: old });
  write("t_oldcrash", { status: "running", started_at: old });
  write("t_recent", { status: "running", started_at: recent });
  writeFileSync(join(c.home, "tasks", "t_oldcrash.cancel"), "x");
  const task = (await c.call("task_start", { model: "tiny-llm", prompt: "new job" })).json();
  await c.call("task_status", { task_id: task.task_id, wait_seconds: 10 });
  assert.deepEqual(readdirSync(join(c.home, "tasks")).sort(), [`${task.task_id}.json`, "t_recent.json"].sort());
});

test("a task whose process is gone shows as interrupted", async (t) => {
  const c = session(t);
  mkdirSync(join(c.home, "tasks"), { recursive: true });
  writeFileSync(
    join(c.home, "tasks", "t_gone1.json"),
    JSON.stringify({ id: "t_gone1", session_id: "s_x", status: "running", pid: 99999999, started_at: new Date().toISOString(), prompt: "old" }),
  );
  assert.equal((await c.call("task_status", { task_id: "t_gone1" })).json().status, "interrupted");
  assert.equal((await c.call("task_cancel", { task_id: "t_gone1" })).json().status, "interrupted");
});
