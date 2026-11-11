# Changelog

## 0.3.0 (2026-11-11)

- `files` for `chat`, `session_send` and `task_start`: paths to text files that the plugin reads and adds to the message, so Claude doesn't have to paste code, logs or documents.
- A request that is larger than the context is now explained with the numbers LM Studio gives ("needs 20,523 tokens, but the model is loaded with a 4,096-token context") instead of "closed the stream without a final result".

## 0.2.0 (2026-11-11)

- LM Studio on another machine over SSH: with the new SSH host setting (`LMSTUDIO_SSH_HOST`) the plugin runs `lms` on that machine and sends API requests through `ssh -W`. Nothing is opened on the network and every tool works, including `server_start`, `estimate_load` and loads with TTL.
- `system_ram` is the RAM of the machine that runs LM Studio: asked from `lms` over SSH, and no longer reported when only the URL of another machine is set.

## 0.1.1 (2026-11-11)

Fixes from an audit of 0.1.0.

- A lost conversation is recognised by the error field LM Studio sends (`param: previous_response_id`), not by the wording of its message. Checked against LM Studio, which deletes stored responses after 30 days.
- A rebuilt conversation keeps the end of a very long last turn instead of dropping all history.
- The "context is getting full" warning is no longer hidden by another warning.
- `session_compact` works when the model was reloaded with a smaller context.
- Taking over a leftover session lock no longer removes a lock that another process has just taken.
- Tasks that a crash left as running are pruned like other old tasks, together with their cancel files.
- `task_status` no longer piles up listeners while it waits.
- The Node.js requirement is now 20+: the tests run on 20, 22, 24 and 26.

## 0.1.0 (2026-11-11)

First release.

- MCP server with 20 tools in seven groups: server (`server_status`, `server_start`, `server_stop`), models (`list_models`, `estimate_load`, `load_model`, `unload_model`), context (`model_defaults`), downloads (`download_model`, `download_status`), sessions (`session_start`, `session_send`, `session_get`, `session_compact`, `session_delete`), background tasks (`task_start`, `task_status`, `task_cancel`) and one-off inference (`chat`, `embed`).
- Context control: per-model default load settings, sessions that refuse an instance with too little context, `reload` and `replace` to reload deliberately, context use after every answer and compaction.
- Streamed answers with MCP progress notifications; background tasks show phase, partial answer and tool calls of the local model.
- Safe for parallel use: one load per model at a time, session locks shared between Claude Code sessions, task heartbeats and cancel requests across processes, no unload of a model in use. Sessions recover from the saved transcript when LM Studio lost a conversation.
- Claude Code plugin and marketplace in one repository, with optional settings for the LM Studio URL and API token.
- Finds the LM Studio port with `lms server status` and falls back to 1234.
- No dependencies.
