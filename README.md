# LM Studio for Claude Code

Let Claude Code run your [LM Studio](https://lmstudio.ai): start and stop the server, load and unload models with the context length they need, keep conversations with local models going, hand them long jobs in the background and follow their progress. LM Studio can run on the same computer or on another one that you reach with SSH, for example a desktop at the office used from a laptop over Tailscale.

It is a Claude Code plugin with one small MCP server: a single file with no dependencies that needs only Node.js 20 or newer. The server also works with any other MCP client.

> Not affiliated with LM Studio or Element Labs.

## What you can ask

- "Is LM Studio running? What's loaded right now?"
- "Always load qwen3.8 with a 256k context."
- "Will gpt-oss-120b fit in memory with a 64k context?"
- "Start a session with the local model as a code reviewer, then send it these files one by one."
- "Give the local model `src/api.ts` and `docs/api.md` in the background and ask what the docs get wrong."
- "Run this analysis on the local model in the background and tell me when it's done."
- "How full is the context of that session? Compact it."
- "Download granite-4-micro and tell me when it's done."
- "Unload everything, I need the RAM."

## Install

```bash
claude plugin marketplace add developerscompany/lmstudio-mcp
claude plugin install lmstudio@lmstudio-mcp
```

Or inside Claude Code: `/plugin marketplace add developerscompany/lmstudio-mcp`, then `/plugin install lmstudio@lmstudio-mcp`. Start a new session (or run `/reload-plugins`) and check `/mcp`.

Third-party marketplaces don't update automatically by default. Update with `claude plugin update lmstudio@lmstudio-mcp`, or turn on auto-update in `/plugin` → Marketplaces.

**Requirements**

- LM Studio 0.4 or newer (REST API v1), or LM Studio Bionic
- Node.js 20 or newer (tested on 20, 22, 24 and 26)
- The `lms` CLI that ships with LM Studio, for starting and stopping the server, memory estimates and loads with TTL or GPU settings. Everything else works over the API alone.
- For LM Studio on another machine over SSH: an `ssh` client here, and macOS or Linux there.

## Tools

| Group | Tools | What they do |
|---|---|---|
| Server | `server_status`, `server_start`, `server_stop` | Reachability, URL in use, loaded models with TTL, running tasks; start or stop the API server (localhost only) |
| Models | `list_models`, `estimate_load`, `load_model`, `unload_model` | Downloaded and loaded models; memory needed before loading; load with context length, TTL, GPU offload, parallel slots, flash attention; unload one or all |
| Context | `model_defaults` | Per-model load settings (context length, TTL, GPU, parallel) used by every load |
| Downloads | `download_model`, `download_status` | Download from the LM Studio catalog or a Hugging Face URL and follow the progress |
| Sessions | `session_start`, `session_send`, `session_get`, `session_compact`, `session_delete` | Conversations with a local model that keep their history, with text files and images, and context use after every answer |
| Tasks | `task_start`, `task_status`, `task_cancel` | Run a prompt (with text files and images) in the background, follow its progress, wait for the result or stop it |
| One-off | `chat`, `embed` | A single prompt (optionally with text files and images) without history; embeddings with a similarity matrix |

## Sessions, context and tasks

**Context control.** `model_defaults` stores the settings a model should always be loaded with, for example `context_length: 262144` for a model that only works well with its full context. `load_model`, `chat`, sessions and tasks use them whenever a call doesn't say otherwise. A session never runs on an instance with less context than it needs: if the model is loaded with a smaller context, the call stops and asks for `reload: true`, which unloads it and loads it again. `load_model` keeps a model that is already loaded unless you pass `replace: true`, and parallel calls for a model that isn't loaded yet wait for one load, so a second copy of a 90 GB model is never loaded by accident. A model that a session request or task is using is never unloaded or reloaded under it.

**Sessions.** `session_start` loads the model if needed and opens a conversation; `session_send` adds a message. LM Studio keeps the conversation on its side (`store` and `previous_response_id` of its chat API), so only the new message is sent each time. Every answer reports how full the context is, for example `45,210 / 262,144 tokens (17%)`, and warns from 80%. `session_compact` asks the model to summarize the conversation; the next message starts a fresh context that begins with that summary. A session handles one request at a time, also when several Claude Code sessions use it. LM Studio deletes stored conversations after 30 days; when it no longer has one, the next message rebuilds it from the saved transcript and says so. Sessions can give the local model LM Studio plugins or MCP servers configured in LM Studio through `integrations` (for example `"mcp/github"`); the tool calls it makes are shown with the answer.

**Tasks.** `task_start` runs a message in a new or existing session in the background and returns a task id at once. `task_status` shows the phase (loading model, reading prompt with a percentage, thinking, calling a tool, answering), the answer so far and, when done, the full result; `wait_seconds` waits for it. `task_cancel` stops it. Tasks run inside the MCP server, so they stop when the Claude Code session that started them ends; they are then marked as interrupted. Other Claude Code sessions can see their status and cancel them. Finished tasks are kept for 14 days (at most 200).

**Files.** `chat`, `session_send` and `task_start` take `files`: absolute paths to text files such as code, logs or documents, up to 2 MB each. The plugin reads them and adds them to the message, so Claude doesn't have to paste their contents. A session's saved transcript keeps the paths, not the contents. When a request doesn't fit the context, LM Studio refuses it and the plugin says how many tokens it needs.

Long calls (`session_send`, `chat`, `session_compact`) send MCP progress notifications, so Claude Code shows what the model is doing.

Sessions, tasks and model defaults are kept in `~/.lmstudio-mcp` (files readable only by you). Change the folder with `LMSTUDIO_MCP_HOME`.

## Configuration

For LM Studio on the same computer there is nothing to set: the server reads the port from `lms server status`. Without `lms` it uses `http://127.0.0.1:1234`; LM Studio Bionic listens on 1235 by default, so set the URL in that case.

The plugin has three optional settings. Claude Code may say they are "not yet set"; leave them empty for LM Studio on the same computer, or set them with `/plugin configure lmstudio@lmstudio-mcp`:

- **SSH host**: for LM Studio on another machine that you reach with SSH (see below).
- **LM Studio URL**: for LM Studio on another machine that you reach by URL, or on this one without `lms`.
- **API token**: only if API authentication is on in LM Studio. It is kept in the system keychain.

Other MCP clients use environment variables:

| Variable | Default |
|---|---|
| `LMSTUDIO_BASE_URL` | detected with `lms`, else `http://127.0.0.1:1234` |
| `LM_API_TOKEN` | none |
| `LMSTUDIO_SSH_HOST` | none; the SSH host of the machine that runs LM Studio |
| `LMS_PATH` | `~/.lmstudio/bin/lms`, else `lms` on `PATH`; with an SSH host, the path on that machine |
| `LMSTUDIO_TIMEOUT_MS` | `1200000` (20 min), for loading a model |
| `LMSTUDIO_MCP_HOME` | `~/.lmstudio-mcp`, where sessions, tasks and model defaults are kept |

## LM Studio on another machine

**Over SSH (recommended).** Set the SSH host to the machine that runs LM Studio: an alias from `~/.ssh/config` or `user@host`. The plugin then runs `lms` on that machine and sends every API request through the SSH connection (`ssh -W`). LM Studio keeps listening on localhost only, so nothing is opened on the network, and every tool works: starting the server, memory estimates, loads with TTL. `system_ram` is the RAM of that machine.

It works wherever `ssh <host>` connects without asking for a password: on the same network, over Tailscale or another VPN. The other machine needs macOS or Linux. Sessions, tasks and model defaults stay on the computer where Claude Code runs, and images are read there too. When an SSH host is set, the URL setting is ignored.

```bash
claude plugin install lmstudio@lmstudio-mcp --config ssh_host=my-desktop
```

**By URL.** Turn on API authentication in LM Studio and set the URL and token. The token travels in clear text over plain HTTP, so use a private network. `server_start`, `server_stop`, `estimate_load` and loads with TTL or GPU settings need `lms`, so they are not available this way, and `system_ram` is not reported.

## Other MCP clients

Claude Code without the plugin:

```bash
git clone https://github.com/developerscompany/lmstudio-mcp ~/lmstudio-mcp
claude mcp add lmstudio -- node ~/lmstudio-mcp/server/lmstudio-mcp.mjs
```

Claude Desktop, Cursor and other clients:

```json
{
  "mcpServers": {
    "lmstudio": { "command": "npx", "args": ["-y", "github:developerscompany/lmstudio-mcp#v0.3.0"] }
  }
}
```

## Security

- The server talks only to the LM Studio URL. No telemetry; downloads are made by LM Studio itself.
- `lms` runs with fixed arguments and never through a local shell; values that look like command-line flags are rejected, and loads through `lms` need an exact model key.
- Over SSH, every argument is quoted for the shell of the other machine, and the SSH host must be a plain host name or alias, so it can't carry options.
- `server_start` never opens the server to the network or turns on CORS; it ignores `LMS_SERVER_HOST` from the environment.
- Images and text files for `chat`, sessions and tasks must be absolute paths: images under 20 MB, text files under 2 MB. They are read on the computer where Claude Code runs and sent only to LM Studio.

## Development

```bash
npm test                          # tests against a fake LM Studio and a fake lms, no network
claude plugin validate . --strict
claude --plugin-dir .             # try the plugin without installing it
```

The whole server is [`server/lmstudio-mcp.mjs`](server/lmstudio-mcp.mjs): MCP over stdio (JSON-RPC 2.0), protocol versions 2024-11-05 to 2025-11-25.

## License

[MIT](LICENSE)
