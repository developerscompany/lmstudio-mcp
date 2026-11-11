# Changelog

## 0.1.0 (2026-11-11)

First release.

- MCP server with 20 tools in seven groups: server (`server_status`, `server_start`, `server_stop`), models (`list_models`, `estimate_load`, `load_model`, `unload_model`), context (`model_defaults`), downloads (`download_model`, `download_status`), sessions (`session_start`, `session_send`, `session_get`, `session_compact`, `session_delete`), background tasks (`task_start`, `task_status`, `task_cancel`) and one-off inference (`chat`, `embed`).
- Context control: per-model default load settings, sessions that refuse an instance with too little context, `reload` and `replace` to reload deliberately, context use after every answer and compaction.
- Streamed answers with MCP progress notifications; background tasks show phase, partial answer and tool calls of the local model.
- Safe for parallel use: one load per model at a time, session locks shared between Claude Code sessions, task heartbeats and cancel requests across processes, no unload of a model in use. Sessions recover from the saved transcript when LM Studio lost a conversation.
- Claude Code plugin and marketplace in one repository, with optional settings for the LM Studio URL and API token.
- Finds the LM Studio port with `lms server status` and falls back to 1234.
- No dependencies; Node.js 18+.
