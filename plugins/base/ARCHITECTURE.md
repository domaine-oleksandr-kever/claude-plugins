# base — architecture

What runs where and why each piece sits where it does. The README says what base does for the
person using it; this file is for whoever changes it. The code wins when the two drift.

## 1. The pieces

```
plugins/base/
├── .claude-plugin/plugin.json   dependencies: ["slim"], mcpServers, types; no classic `hooks` key
├── agents/*.md                  the readers, the writer, the review agents (spawned as base:<name>)
├── skills/*/SKILL.md            commit, pre-commit-review, save-task-context, report-plugin-issue, worktree, shopify
├── references/*.md              what the agents and skills cite by ${CLAUDE_PLUGIN_ROOT}/references/…, and the team plugins by <base root>/references/…
├── hooks/hooks.json             the module (./mods/register.ts) and the SessionStart/UserPromptSubmit/SubagentStart/PreCompact/Stop command hooks
├── hooks/conventions.cjs        the command hooks: the conventions, the subagent share and its agents/<id>.json record, the dogfood and autosave stop block, the precompact line
├── hooks/title.cjs              the session-title command hooks (SessionStart, UserPromptSubmit) and title.json
├── hooks/conventions-text.json  the convention text of the command hooks
├── hooks/mods/*.ts              the hooks module (Claude Code function hooks)
├── hooks/no-verify-bypass.sh    the git-hooks guard's decision, run by guards/bash.ts
├── hooks/scratch-path-guard.cjs the scratch-path guard's decision, run by guards/scratch.ts
├── scripts/*                    the fetchers, md-to-adf, worktree-setup, doctor, scratch-hygiene, shopify-validate, edit-delegation
└── types/index.d.ts             base's $.state contract: the `base` key only
```

Mods first: a guard is a `tool.call` hook, the workspace state is a `$.state` atom, a command is
`$.command.register`. A script stays a script only where a mod cannot do the job (§5). The conventions
are such a job: the Claude Team login skips `classic.*`, `prompt.compose` and `prompt.context` for
user-tier mods, so they travel as `hooks/hooks.json` command hooks (`hooks/conventions.cjs`, text in
`hooks/conventions-text.json`), and so does the session title (`hooks/title.cjs`).

## 2. The hooks module

`register.ts` calls one register function per file. Each file declares its own atoms and spells its
own env names: the engine's validator follows `$` only into functions declared in the same file, never
across an import, so a `$` helper is never shared between files (each writer file builds its own `diskOf`
for that reason).

| File | Hooks | Writes |
|---|---|---|
| `session.ts` | `session.start {cwd:/^/}` start line · `prompt.submit {text:/^/}` the slim check at a session's first prompt · `tool.call {tool:'Agent'}` + `agent.spawn {subagentType}` reader refusal | `base.started`, `base.checked`, `base.events` |
| `workspace/progress.ts` | `session.start`, `prompt.submit` (both unmatched) · `session.end {reason:'clear'}` · `tool.call` Write/Edit and `{tool:'Bash'}` (a checkout) · the 30 s tick re-resolves on a new session root · `tool.call {tool:/^(Agent|Task)$/}` and `{tool:/^mcp__/}` (savable events) · `tool.call {tool:'Read'}` (adopts a guessed workspace) · the 30 s tick also adopts `title.json` as the `title` line · `turn.complete` with an `agentId` (a background agent's stop is savable) · every progress update mirrored to `autosave-state.json` · a new `compact-marker.json` adopted as `base.compactMarker` · `command.run base-progress` | `base.progress`, `base.pin`, `base.lastKey`, `base.sessionId`, `base.savable`, `base.background`, `base.events` |
| `workspace/autosave.ts` | `prompt.submit {text:/(?:)/}` (the stale-workspace context line, the turn counter mirrored to `autosave-state.json`); the turn-end block and the `compact:` marker are `conventions.cjs stop` / `precompact` | `base.autosave`, `base.compactMarker`, `autosave-state.json` |
| `guards/bash.ts` | `tool.call {tool:/^Bash$/}`: the attribution rule (pure, `guards/attribution.ts`), then `hooks/no-verify-bypass.sh` for a command naming a git verb | `base.events` |
| `guards/mcp.ts` | `tool.call {tool:/^mcp__(?!slim__\|base__)/}`: a subagent's Jira/Confluence/Notion write by tool name on any server, refused by its type from `<log dir>/<session>/agents/<id>.json` (no record = refused); a base reader or writer's call on a server listing none of its vendors' `SIGNATURE` tools, refused; then base's own `mcp__plugin_base_…` tool refused once per session while a server that is no plugin's lists the same tool and the `SIGNATURE` tool (`$.tool.list()`); `SIGNATURE` is shared with the doctor | `base.mcpSoft`, `base.events` |
| `guards/edit.ts` | `tool.call {tool:/^(Edit\|Write\|NotebookEdit)$/}`: a main-loop (no `agentId`) change to a file under the session root outside `.claude/` refused while the rules marker's `edit.model` names a delegate (escapes: the session's family at or below it, `/base-edit-direct`, `BASE_GUARD=0`), an allowed one counted · `tool.call {tool:/^(Read\|Grep)$/}` + `{tool:'mcp__slim__view'}` + `{tool:'Bash', command:/(steps-to-test\|pr-body)\.md/}`: a main-loop read of `.claude/tasks/<id>/{steps-to-test,pr-body}.md` refused (a Bash segment through `drafter-check.cjs`, `gh pr … --body-file`, `test -s` or `ls` allowed), same escapes · `tool.call {tool:'Bash', command:SHELL_WRITE}`: a main-loop shell write counted, never refused · `session.start {cwd:/(?:)$/}` + `prompt.submit {text:/(?:)$/}`: register `/base-edit-direct` · `command.run base-edit-direct` (composer, bridge or sdk origin only) | `base.mainEdits`, `base.delegation`, `base.events` |
| `guards/scratch.ts` | `session.start {cwd:/./}` latches the launch root · `tool.describe` + `tool.call` on the browser tools that take a path → `hooks/scratch-path-guard.cjs` | `base.guardRoot`, `base.events` |
| `doctor.ts` | `session.start {cwd:/$/}` + `prompt.submit {text:/$/}`: register `/base-doctor` (every start, and a new session id), start the base-tmp and event-log sweeps unawaited, once per session id · `command.run base-doctor` (passes `--log-dir` to `doctor.cjs`; the `conventions` row from the command-hook markers, the `defects` row under `BASE_DOGFOOD=1`, the `delegate` row's session suffix from `base.mainEdits`) | `base.swept`, `base.events`, `base.mainEdits` (read) |
| `dogfood.ts` | `BASE_DOGFOOD=1` only: `session.start {cwd:/(?:)/}` registers the `plugin_defect` tool (`$.tool.register`, served by `tool.call {tool:'mcp__base__plugin_defect'}`) and `/base-defects` · `prompt.submit {text:/^(?:)/}` re-registers the command for a new session id · `tool.call {tool:'Bash', command:/plugins\//}` the nudge on a failed plugin script, and the main loop's failure appended as `{script, line, ms}` to the mirrored `errors` (a `plugin_defect` report clears them) · `command.run base-defects`; every update of `base.dogfood` is mirrored to `<log dir>/<session>/dogfood-state.json`, where the `Stop` command hook blocks once | `base.dogfood`, `base.events`, `dogfood-state.json`; the report files under `<project>/.claude/plugin-defects/` and `~/.claude/plugin-defects/index.md` |

Pure helpers carry no `$`: `events.ts` (the 200-line cap, and the `base.jsonl` writer, §3), `node-hook.ts` (the argv/stdin a delegated
script gets, its JSON answer), `workspace/progress-parse.ts`, `workspace/workid.ts`,
`guards/attribution.ts`, `dogfood/text.ts` (the tool's schema, the report's name and body, the install-record
readings, the login file's account, the plugin-script test).

Engine rules this layout follows:

- **One unmatched hook per event per plugin.** Every further `session.start`, `prompt.submit` or
  Bash `tool.call` hook takes a matcher that matches everything but differs from the others
  (`{cwd:/^/}`, `{cwd:/./}`, `{cwd:/$/}`; `{tool:'Bash'}` vs `{tool:/^Bash$/}`). A new hook on one of
  those events needs yet another distinct matcher.
- **One throwing `session.start` hook skips the plugin's others**: every `$` call there is wrapped.
- **A /clear starts a new session id without a `session.start`**: whatever must hold per session is
  re-done at the first `prompt.submit` whose id differs (the command registrations, the sweep, the
  install checks).
- **The main session's hook context does not reach a subagent.** A subagent gets base's share from the
  `SubagentStart` command hook (the root line and the untrusted-content rail for every agent; comment
  discipline and lean code for an agent that writes code; `dogfood` in dogfood mode).
- **No title setter on `$`.** The session title rides the `sessionTitle` field of the `SessionStart` and
  `UserPromptSubmit` command hooks (`hooks/title.cjs`); the progress tick adopts its `title.json` into
  `base.events`.

## 3. The atoms and how band reads them

`types/index.d.ts` declares `base: { … }` only. Any plugin reads a base atom; base alone writes it.

- **`base.progress`** — `{ workId, branch, hasWorkspace, done, total, current, rows, notesTail,
  mtimeMs, lastSavableMs, agentsSince, editsSince, stale }` for the resolved work id, or `{ workId: null, branch }`. band's checklist and digest
  read it (`snapshotOf` wants a non-empty string `workId`; `rows[]` of `{ mark, text }` with `mark` in
  `done|current|waiting|todo`; `total === 0` means no progress.md yet, `hasWorkspace === false` no
  workspace). `mtimeMs` is base's own tick compare. `stale` (with `lastSavableMs`, `agentsSince`,
  `editsSince`) is what `workspace/autosave.ts` and band's compact act on.
- **`base.events`** — `{ atMs, kind, text }`, oldest first, at most 200; band's Log pane merges it with
  its own, slim's and the team plugins' lines. Kinds fit band's 9-cell kind column and never take the kinds band
  and slim own (`session`, `model`, `compact`, `rate`, `slim`, `lookup`). `BASE_EVENT_LOG=0` keeps it
  empty and writes no file.
- **`base.jsonl`** — every line pushed to `base.events` is also handed to `events.ts`'s `logLine` with a
  `Disk` the writing file builds from its own `$` (`diskOf`: the validator rejects `$` passed across an
  import), and each pushEvent site awaits that write itself rather than leaving the file to a
  `state.set` hook (slim's way). The writer keeps the session's lines module-local, seeds them from the
  file after a reload, and rewrites `<log dir>/<session-id>/base.jsonl` whole (2000 lines / 256 KB)
  inside one write queue, so concurrent events never share a snapshot. `doctor.ts` sweeps session-id-named
  `$HOME/.claude/domaine/log/<id>/` folders of `*.jsonl` past 7 days with `rm -rf` (`$.fs` has no
  delete), never when the root resolves elsewhere.
- **`base.pin`**, **`base.lastKey`**, **`base.sessionId`** — the resolver's inputs.
- **`base.started`**, **`base.checked`**, **`base.swept`** — per-session-id
  latches, so a module reload or a repeated start does each thing once.
- **`base.mcpSoft`** — `{ sid, tools }`: base's own MCP tools refused once this session for a connector twin; the second call runs, a new session id starts empty.
- **`base.guardRoot`** — the project root the session launched in. The MCP servers' working
  directories were fixed there, so the scratch guard measures against it even after `/cd` or a
  worktree move changes `$.session.root()`.

band has no dependency on base: it declares the `base` keys it reads in its own types. Its checklist
draws `base.progress` and its hints name `/base:save-task-context`; its Log pane merges `base.events`.

## 4. slim is required

- **Declared**: `"dependencies": ["slim"]` in the manifest. The engine lays slim's contract into
  `.claude-plugin/types/` (gitignored) on each load, so `slim.*` typechecks without a redeclaration.
  It does not install slim.
- **Detected live**: slim registers `mcp__slim__view` at its own session start, so base asks
  `$.tool.list()` at the first prompt of each session and on every reader spawn, never at its own
  session start (slim may not have registered yet).
- **Enforced where it matters**: a spawn of `base:jira-reader`, `base:figma-reader` or
  `base:doc-reader` is denied while the view tool is missing — through the Agent tool's `tool.call`
  and through `agent.spawn` (another plugin's `$.agent.spawn`, or a bare name the engine resolved).
  The writer and the reviewers do not need slim and run.
- **Doctor**: `doctor.cjs` reads `installed_plugins.json` and the user, project and local settings for
  slim; `/base-doctor` adds what the session loaded (`slim-live`, `conventions`) and each MCP
  server's `$.mcp.connect` answer. A slim the install record lacks but the session loaded is a WARN.

## 5. What stays a script, and why

| Script | Why not a mod |
|---|---|
| `hooks/no-verify-bypass.sh` | a shell-grammar heuristic pinned row by row by `tests/no-verify-bypass-matrix.sh`; `guards/bash.ts` spawns it only for a command naming a git verb |
| `hooks/scratch-path-guard.cjs` | needs `os.tmpdir()` (chrome-devtools writes to its temp dir) and `realpath` across symlinks, which `$` does not offer; it also creates the remediation directory and stamps the exclude |
| `scripts/doctor.cjs` | static checks a node process answers without a session, also run by hand; the mod adds the session rows |
| `scripts/edit-delegation.cjs` | a module two node processes share (the SessionStart hook, the doctor), so one function decides the delegate model |
| `scripts/scratch-hygiene.cjs` | deletes files: `$.fs` has no unlink |
| `scripts/worktree-setup.sh` | git plumbing, port probes and `npm ci` the skill runs as one command |
| `scripts/shopify-validate.cjs` | a CLI `/base:shopify` runs where the session loads no manifest MCP server: it spawns the dev-mcp server through `npx` and speaks stdio JSON-RPC to it |
| `scripts/figma-rest.sh`, `jira-attachments.sh`, `external-screenshots.sh`, `md-to-adf.cjs` | the agents run a CLI on a file; credentials ride a private curl config, never the argv |

A delegated script answers like a classic PreToolUse hook (JSON `permissionDecision` on stdout, or
exit 2 with the reason on stderr); `node-hook.ts` builds the call and reads the answer, and a script
that cannot run or times out lets the call through.
