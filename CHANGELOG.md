# Changelog

## 0.4.1 (2026-11-14)

- The sandbox of coding tasks never opens the home folder, a folder above it or a folder right below it for reading. Before, a Node installed in `~/bin` (or a PATH entry there) would have opened the whole home folder. The folders that hold keys and tokens (`~/.ssh`, `~/.config`, `~/.aws`, the keychains and others) are closed explicitly as well. Found by an automated security review of 0.4.0.

## 0.4.0 (2026-11-14)

Coding tasks: Claude hands a whole coding job to a local model and only writes the brief and reviews the result.

- `task_start` with `folder` (a git repository) runs the local model as a coding agent in its own git worktree on a new branch `lmstudio/<task_id>`, on the machine that runs LM Studio. Over SSH the base commit is pushed to a mirror there and the branch is fetched back when the task ends.
- The model gets seven tools: `list_files`, `read_file`, `search`, `write_file`, `edit_file`, `delete_file` and `run_command`. Commands come from an allowlist (`commands`, default: the project's test, typecheck and lint scripts, plus read-only git) and run without a shell.
- The tools and every command run under macOS `sandbox-exec` with a deny-by-default profile: no network, writes only inside the worktree, nothing of the home folder outside it readable, no terminals. The worktree comes from a bare mirror, never from the repository itself.
- The final commit runs git without hooks, ignores the worktree's `.git` file and leaves out git repositories the model created. Before it the task folder is renamed, so a process the model left running loses its write access; then the worktree is deleted. These came from a security review of the first version.
- `setup` (default: the install command for the lockfile) runs before the model starts. `max_steps`, `max_minutes` and `task_cancel` bound the task; the work done so far is committed in every case.
- The model's report is marked as data from an untrusted model.
- `task_status` shows the steps, the latest tool calls and the context use while a coding task runs, and at the end the model's report, `git diff --stat`, the branch, the checks it ran and the patch file. `show_calls` lists every tool call.
- New file `server/workspace.mjs`: the worktree, the sandbox and the model's tools. It is copied to the SSH host when needed.

## 0.3.2 (2026-11-11)

- A session lock is released only while it still belongs to the process that releases it. Before, a process that had stalled for more than 30 seconds (a sleeping laptop, for example) could remove the lock of the process that took the session over. Found by a local model reviewing this code through the plugin.

## 0.3.1 (2026-11-11)

Found by running a real task through a fresh Claude Code session.

- Claude is now told to leave `context_length` out so that a model's saved default applies; a call that asks for less than the saved default gets a note in its result. Before, Claude picked a small context by itself and the model ran out of room.
- When the context fills up before the model gets to its answer, the reply says so and shows where its reasoning ended, instead of only "(empty answer)". `chat` reports context use too.

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
