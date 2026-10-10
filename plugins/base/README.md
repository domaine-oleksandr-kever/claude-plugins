# base

base is the shared Domaine plugin for Claude Code. It holds what every team uses: the readers that
turn a Jira ticket, a Figma frame or a linked doc into workspace files, the Jira writer, the review
agents, the task workspace and the progress it publishes for band, the commit and review guards, the
working conventions, a doctor, and the MCP servers those agents call. A team plugin (frontend,
backend, QA) adds its own skills on top and depends on base.

base reads large results through slim and requires it: compression happens only inside slim, so every
figure lands in slim's log, and base's readers call slim's `view` tool for a file or a command output.

Current release: **base v0.7.0**.

## Status

- Claude Code only: base is a plugin of skills, agents, MCP servers and a hooks module (mods). It
  ships no adapter for another host, and `scripts/install.sh --plugin base` exits 2.
- Requires slim (`"dependencies": ["slim"]` in its manifest). The engine does not install a
  dependency on its own: install both.
- Never runs together with fnd, which ships the same agents and MCP servers. Install fnd OR base
  plus a team plugin.

## Install

```text
/plugin marketplace add domaine-oleksandr-kever/claude-plugins
/plugin install slim@domaine
/plugin install band@domaine
/plugin install base@domaine
/reload-plugins
```

`/base-doctor` then checks the install (§ Doctor). Then the team plugins for your work, each with its
own doctor: fe, the frontend one (`/plugin install fe@domaine`, then `/fe-doctor`;
[plugins/fe/README.md](../fe/README.md)); qa (`/qa-doctor`; [plugins/qa/README.md](../qa/README.md));
be (`/be-doctor`; [plugins/be/README.md](../be/README.md)); pm (`/pm-doctor`;
[plugins/pm/README.md](../pm/README.md)).
The same set as settings, in `~/.claude/settings.json`:

```json
{
  "enabledPlugins": {
    "slim@domaine": true,
    "band@domaine": true,
    "base@domaine": true,
    "fnd@domaine": false
  }
}
```

To move from fnd, run `/plugin uninstall fnd@domaine` first, then install the set above.
fnd is frozen and supported until 2027-06-30; the whole move is in the root README
([fnd is frozen](../../README.md#fnd-is-frozen)).

`base:jira-reader` hands every downloaded screenshot and screen recording to slim's `view`, which
writes the resized copy (or the frames) beside it in `.claude/tasks/<work-id>/tmp/attachments/`.
When the permission check would ask about that write, slim asks you once per file (Yes/No). An
allow rule in the project's `.claude/settings.json` skips the question:

```json
{ "permissions": { "allow": ["Write(.claude/tasks/**)"] } }
```

Resizing and frame cutting need `ffmpeg` + `ffprobe` on PATH (macOS `sips` covers images only);
without them the files stay downloaded and the reader says so in its `attachments_note`.

## Agents

Spawned by their qualified names (`base:<agent>`); a bare name does not resolve once two plugins
ship agents.

| Agent | Does | Model |
|---|---|---|
| `base:jira-reader` | reads one ticket — fields, comments, attachments — writes `ticket.md` and `comments.md` to the workspace; downloads images and recordings, resizes them through slim's `view` | sonnet |
| `base:figma-reader` | reads one Figma node through a Figma MCP or the REST API, writes `figma-<node-id>.md`; the REST tree is compacted by slim's `view` | sonnet |
| `base:doc-reader` | reads one linked doc (Notion, Confluence, web) and writes a task-focused extract | sonnet |
| `base:jira-writer` | writes one approved value to one Jira field or comment, converted to ADF, and reads it back | sonnet |
| `base:bug-hunter` | adversarial correctness review of the branch's diff | opus |
| `base:change-reviewer` | comment accuracy, refactors and rule conformance on the changed files; the `profile` and its team rules come in the brief | opus |

The three readers need slim: they read big MCP results compacted by slim's mcp channel and call
`mcp__slim__view` for files on disk. Without slim loaded, base refuses to spawn them. The readers
and the writer keep a denylist of every Jira and Confluence write tool they do not need, under
both `mcp__plugin_base_atlassian__…` and the user-scope `mcp__atlassian__…` names.

## References and scripts

The agents cite these by their path under the plugin root; `tests/base-refs-lint.sh` checks that
every cited path exists.

| File | Holds |
|---|---|
| `references/jira-field-ids.md`, `references/jira-custom-fields.md` | the meetdomaine site's custom-field ids, the request shape, and how to rediscover an id |
| `references/jira-freshness-check.md` | `base:jira-reader`'s cached-ticket check (changelog first, comment-only refresh) |
| `references/jira-attachments.md` | the read-only Jira token, `scripts/jira-attachments.sh`, `scripts/external-screenshots.sh`, and the resize through `view` |
| `references/jira-adf-write.md` | writing ADF to a field or a comment, `scripts/md-to-adf.cjs`, the read-back check |
| `references/figma-rest.md` | the Figma source ladder, the REST token, `scripts/figma-rest.sh`, the compact tree through `view` |
| `references/reading-linked-docs.md` | which links a caller reads and with which reader |
| `references/task-workspace.md`, `references/task-workspace-freshness.md` | the `.claude/tasks/<work-id>/` layout, its read and write rules, `progress.md`, the freshness probes |
| `references/review-flow.md` | the branch review flow: the `.git/.base-review` marker, which agent runs which check |
| `references/commit-message-format.md` | Conventional Commits with the house rules |
| `references/steps-to-test-format.md` | the Steps to Test field's General and Bug templates and the theme resolution: what a team plugin's Steps to Test writer writes and `/qa:preflight` reads rows from |
| `references/break-it-qa.md` | the break-it QA method: deriving and executing the hostile-value and timing rows of a team plugin's QA and of `/qa:preflight` |

The fetchers (`scripts/jira-attachments.sh`, `scripts/external-screenshots.sh`,
`scripts/figma-rest.sh`) share `scripts/_common.sh`: credentials ride a private `0600` curl config,
never the argv, and every download lands in a directory git ignores. They download only; slim
resizes and compacts.

| Script | Run by | Does |
|---|---|---|
| `scripts/md-to-adf.cjs` | `base:jira-writer` | Markdown → ADF for a Jira field or comment |
| `scripts/worktree-setup.sh` | `/base:worktree` | creates or removes a sibling `git worktree` with its own branch and dev port, the `.claude/tasks` link back to the main checkout, and the `--copy` list |
| `scripts/doctor.cjs` | `/base-doctor`, or by hand | the static install checks (below); `--json` for the command |
| `scripts/scratch-hygiene.cjs` | base's hooks module, once per session | sweeps `.claude/base-tmp` of files older than `BASE_TMP_TTL` hours and keeps it in `.git/info/exclude` |
| `scripts/qa-stores.cjs` | a QA engineer by hand; `/qa:preflight` reads it | the QA store registry, one file per machine (`~/.config/domaine/qa-stores.json`, dir 0700, file 0600): `list`, `get <store>` (the only command that prints a password), `find`, `set`, `unset`, `path` |

## Skills

Invoked by their qualified names (`/base:<skill>`). A team plugin's skills call them by the same
names.

| Skill | Does |
|---|---|
| `/base:commit` | a Conventional Commits commit, directly, after checking the branch was reviewed (`.git/.base-review`); offers a ticket scope |
| `/base:pre-commit-review` | the branch review before a commit: ticket references and untracked files inline, `base:change-reviewer` for comments, refactors and rules, `base:bug-hunter` for correctness; a plan to approve, then the agreed edits and the marker. The caller passes the `profile` word its team plugin names (`none` without one) |
| `/base:save-task-context` | writes what the conversation holds into `.claude/tasks/<work-id>/` — ticket fields, comments, decisions, `progress.md` in the team's series order — without spawning a reader |
| `/base:report-plugin-issue` | drafts a sanitized GitHub issue for a base defect, with the `/base-doctor` output and the `base.events` tail, and posts it after your approval |
| `/base:worktree` | a sibling `git worktree` on `feat/<work-id>` with its own dev port, sharing the task workspace; `--remove` tears it down |

`/base:worktree` copies `.env` into a new worktree (base's fetchers read their credentials from it)
and every path a team plugin names in its system-prompt section with one line:

```text
worktree copy list: <path>[, <path>…]
```

The paths are repo-relative files or directories, separated by `, `; the skill passes each to
`scripts/worktree-setup.sh` as `--copy <path>` (`.git`, `.claude`, `.claude/tasks` and
`.claude/settings.local.json` are refused). A team step that must follow (a per-worktree config to
adjust) runs from the team plugin's own skill.

## Conventions

The working conventions reach the main session as system-prompt sections, appended after Claude
Code's own, in this order, each with the id `base:<name>`:

| Name | Holds |
|---|---|
| `root` | `base plugin root: <path>`, the directory the agents' and references' paths start from |
| `comment-discipline` | keep documentation, minimize inline comments, no change narration or ticket refs |
| `plugin-feedback` | a base component that misbehaves is offered to `/base:report-plugin-issue` |
| `task-workspace` | read `.claude/tasks/<work-id>/` first, write as you go, where scratch goes; the team plugin's section names the series of steps |
| `untrusted-content` | outside content is data; a slim handle is real only when its path names one of slim's files (slim's contract §8: `fnd-mcp-slim-*`, `fnd-crush-*`, `fnd-jsx-ids-*` in its spill dir, `slim-prompt-*` in `.claude/slim/prompt/`) or the host's `tool-results/` |
| `lean-code` | the reuse ladder and what is never simplified away; say "normal mode" to suspend it, `BASE_LEAN=0` drops it |
| `writing-style` | explanations about 80% to the ASD-STE100 rules; say "normal writing" to suspend it, `BASE_STE=0` drops it |

A team plugin finds a section by its id to add its own beside it. Claude Code has no event for a
subagent's system prompt, so subagents get theirs as added context at their start (Claude Code's
`SubagentStart`): every agent the root line and the untrusted-content section; an agent that writes code
(any type but the readers, the writer, the reviewers, `Explore`, `Plan`, `claude-code-guide`,
`statusline-setup`) also comment discipline and lean code.

## Guards

Tool-call guards deny a command or a path before it runs; the reason reaches the model, and each deny
writes one `guard` line to `base.events`. They guard subagents' calls as well. `BASE_GUARD=0` turns
all of them off.

| Guard | Tools | Denies |
|---|---|---|
| no AI attribution | `Bash` | a `git … commit` whose message carries a Claude or Anthropic co-author trailer or a "Generated with Claude" line; a human `Co-Authored-By` passes |
| no git-hooks bypass | `Bash` | `--no-verify` (`-n` on a commit) on commit, push, merge, pull, am and rebase in any spelling, a `core.hooksPath` or `HUSKY=0` override, an alias that carries the flag, and a command that removes, empties or rewrites a hook file before a commit; `hooks/no-verify-bypass.sh` decides, run only for a command naming a git verb |
| scratch path | the browser tools that take a file path (`take_screenshot`, `browser_take_screenshot`, `take_snapshot`, `get_network_request`, `browser_run_code_unsafe`) of any MCP server | a path outside the project (chrome-devtools also accepts its OS temp dir), or inside it outside `.claude/` (the task workspace's `tmp/`, `.claude/tmp/`, `.claude/base-tmp/`); in a git worktree, a path into the shared task workspace. `hooks/scratch-path-guard.cjs` decides against the project root the session launched in (`base.guardRoot`), names an absolute path to use instead and creates its directory. The tools' descriptions carry the rule too. `BASE_SCRATCH_GUARD=0` turns this one off |

base's playwright server writes its own files under `.claude/base-tmp/playwright`, and the guard
adds `/.claude/base-tmp/` to `.git/info/exclude` when it allows a write there. A guard that cannot
run (its script fails or times out) lets the call through.

## Workspace

base publishes the task workspace of the work id it resolves as `$.state` atoms; band draws them
(its checklist and Log panes). Any plugin reads them, base alone writes them. The work id is, in
order: the pinned id when its `.claude/tasks/<id>/` exists; the last ticket a person's prompt named
(a Jira `/browse/` URL, or a project that already has a `.claude/tasks/<KEY>` dir, corroborates a
key: `UTF-8` or `SHA-256` alone does not); the branch's ticket key, then its kebab slug, when that
workspace exists; the newest `progress.md` written within 12 hours. base re-reads the workspace
when progress.md or notes.md changes (checked every 30 s, at once after a Write or Edit under
`.claude/tasks/`), and resolves again after a `git checkout`/`switch`/`worktree`, a directory
change, a /clear, and every two minutes.

| Atom | Value |
|---|---|
| `base.progress` | the parsed progress.md of the work id (`{ workId, branch, hasWorkspace, done, total, current, rows, notesTail, mtimeMs, lastSavableMs, agentsSince, editsSince, stale }`), or `{ workId: null, branch }` |
| `base.savable` | this session's savable events, `{ atMs, kind: 'agent' \| 'edit' \| 'mcp' }`, at most 200 |
| `base.autosave` | the turn counter, its start, the turn whose stop was last blocked, and the last turn that wrote the workspace |
| `base.pin` | the work id `/base-progress` pinned, or null |
| `base.lastKey` | the last ticket a person's prompt named this session |
| `base.sessionId` | the session the atoms describe |
| `base.events` | base's log lines for band's Log pane, oldest first, at most 200: `{ atMs, kind, text }` |
| `base.started`, `base.checked`, `base.titled` | the session id whose start line, install checks and title are done (`<id>:user` when the person titled it) |
| `base.guardRoot` | the project root the session launched in, which the scratch-path guard measures against |
| `base.swept` | the session id whose base-tmp and event-log sweeps ran |

**Autosave.** A savable event is an Agent call that returned, a Write / Edit outside `.claude/`, or an
MCP result over slim's 4 KB gate.
The workspace is `stale` when progress.md and notes.md were last written over 20 minutes ago and
before the newest savable event. While it is stale, a prompt gets one context line asking to save to
notes.md first; a turn that wrote nothing to the workspace, after savable work in it or 3 turns
without a workspace write, is blocked at its stop once (never when the stop hook is already active, at most once per 3 turns); an auto-compact
appends one `compact:` pointer line to notes.md. `BASE_AUTOSAVE=0` turns the three off.

`/base-progress <work-id>` pins the work id band's checklist shows, `/base-progress -` unpins, and
`/base-progress` alone names the pin. The checklist itself is band's `/band-progress`.

`base.events` kinds: `start` (base's version, once per session), `install` (slim missing, fnd
present), `refuse` (a reader refused), `workspace` (the work id base now publishes, `none` when it
leaves every workspace), `title` (the session title base set), `guard` (a guard's deny: the
tool and the reason), `doctor` (a `/base-doctor` run's counts). band and slim write their own
session, model, compaction, rate and compression lines. Each line also goes to base's file on disk
(Event log on disk).

## Event log on disk

Every Domaine plugin (slim, band, base, fe, qa, be, pm) writes the lines it publishes itself to its
own file, so the origin of a line is on the line, written by that plugin, not inferred from a pane:

- **Where:** `$HOME/.claude/domaine/log/<session-id>/<plugin>.jsonl` (`base.jsonl`, `band.jsonl`,
  `slim.jsonl`, and a team plugin's own, such as fe's `fe.jsonl`). `DOMAINE_LOG_DIR` (an absolute directory) replaces `$HOME/.claude/domaine/log`; the
  `<session-id>/` folder is still made under it. With neither (a cloud session) no file is written.
  Never under the project.
- **Line:** one JSON object per line, oldest first:
  `{"ts":"2026-10-08T12:34:56.789Z","plugin":"base","version":"0.1.0","session":"<id>","kind":"guard","agent":"main","text":"Bash: a git hooks bypass"}`.
  `ts` is the event's time in UTC, `plugin` and `version` the writer's own name and release, `agent`
  the subagent type that caused the line or `main`, `kind` and `text` the line as `base.events` has it.
- **Start line:** the first line a plugin writes for a session id is `start` / `<plugin> <version>`,
  also under the new id a `/clear` opens, where no session start runs. A session whose lines already
  hold a start line gets no second one: a module reload or a resume in a fresh process goes on from
  the file.
- **base's lines:** every `base.events` line, `agent` always `main`. The first line of a session's
  file is `start` / `base <version>`; after a /clear (a new session id with no session start) base
  writes that line before the new session's first event.
- **Writing:** the whole file is rewritten after every line (the engine has no append), at most 2000
  lines or 256 KB, oldest dropped first (the start line too, past the cap). A reload of the module
  picks up the file of the same session and goes on. A write that fails never reaches the hook; the
  first failure in a session toasts `base: event log not written: <reason>`.
- **Off:** `BASE_EVENT_LOG=0` stops base's file and its `base.events` lines alike.
- **Clean-up:** base sweeps session folders whose newest file is older than 7 days, and its
  `/base-doctor` row `event-log` names the folder and each file's line count and newest time. The other
  plugins never delete.

The sweep runs once per session (and again after a /clear), in the background, over
`$HOME/.claude/domaine/log` only — a `DOMAINE_LOG_DIR` is yours to clean — and not at all when that
directory itself resolves anywhere but its own spelling (a symbolic link). It touches only folders
named like a session id that hold nothing but `*.jsonl` files, skips the current session's folder and
a folder that resolves anywhere but its own place under that directory; the rest goes with `rm -rf`,
as the engine's file API cannot delete.

## Session start

- **Install checks**, at the first prompt of each session (slim registers its tools at its own
  session start): without slim's `mcp__slim__view` tool, one line and one toast `slim is not loaded —
  claude plugin install slim@domaine`; with fnd enabled in the settings (`fnd@<marketplace>: true`) or
  any fnd command loaded, `fnd and base must not run together — …`: the remedy names the enabled key
  (`claude plugin uninstall fnd@<marketplace>`) or, with no key, the claude.ai-synced / `--plugin-dir` copy.
- **Reader refusal**: while `mcp__slim__view` is missing, a spawn of `base:jira-reader`,
  `base:figma-reader` or `base:doc-reader` is denied with `base: <agent> needs the slim plugin —
  claude plugin install slim@domaine`, through the Agent tool and through any plugin's spawn. The
  writer and the reviewers run without slim.
- **Session title** `<KEY> — <summary>`, the summary from the `# <KEY> — …` heading of
  `.claude/tasks/<KEY>/ticket.md` (the key alone without one), cut at 100 bytes: from the branch's
  ticket key when the session starts, else from the first prompt you write that names a corroborated
  ticket (the most recent one it names, as the workspace resolver picks). Once per session; a title
  you gave the session (`--name` at start, `/rename` later) is kept.

- **base-tmp sweep**, once per session (and again after a /clear), in the background — the session
  start never waits for it: files in `.claude/base-tmp` older than `BASE_TMP_TTL` hours (24 by
  default) are deleted; directories and symlinks stay.
- **Event-log sweep**, alongside it: session folders under `$HOME/.claude/domaine/log` whose newest
  file is older than 7 days (Event log on disk).

## Doctor

`/base-doctor` checks the install and prints one PASS / FAIL / SKIP / WARN row per check, the counts,
and the last 10 `base.events` lines:

| Row | Checks |
|---|---|
| `node`, `platform` | Node 18 or newer; native Windows is refused (the scripts need bash) |
| `manifest`, `hooks`, `scripts` | the manifest's version, a plugin name the engine loads a hooks module for (`core` and `engine` are its own), its `slim` dependency, the hooks module files, the scripts' exec bits |
| `slim` | slim installed (user scope or this project) and enabled — else `claude plugin install slim@domaine` |
| `fnd` | fnd not installed; installed and enabled fails (`fnd and base must not run together`), installed and disabled warns |
| `base-tmp` | `.claude/base-tmp`: files, size, how many the next sweep removes, whether git ignores it |
| `event-log` | this session's event-log folder and, per `<plugin>.jsonl` there, its line count and newest `ts`; no folder yet passes (a /clear's new session has none before its first line); a folder with no file warns (every write failed) unless `BASE_EVENT_LOG=0` |
| `switches` | only when a `BASE_*` switch holds a value outside its domain in Environment switches (an on/off switch set to anything but `0` or `1`, an unknown `BASE_FIGMA_SOURCE`, a `BASE_TMP_TTL` that is not hours): warns with the value the reader falls back to |
| `slim-live`, `fnd-live` | what this session loaded: slim's `mcp__slim__view` tool registered, no fnd command or enabled fnd |
| `mcp:<server>` | each MCP server of base's manifest connects; sign-in needed fails with the `/mcp` pointer; `figma-dev-mode` (the Figma desktop app's local server) only warns |

The rows up to `switches` come from `scripts/doctor.cjs`, which also runs by hand:
`node <base plugin root>/scripts/doctor.cjs [--project <dir>] [--log-dir <dir>]`; it exits 1 when a
row fails. By hand its `event-log` row reads the newest session folder unless `--log-dir` names one.
The session rows need the command. One `doctor` line goes to `base.events` per run.

## Environment switches

Every switch base reads has a row here; set it in `~/.claude/settings.json` → `env`.

| Variable | Default | Effect |
|---|---|---|
| `BASE_EVENT_LOG` | on | `0` keeps `base.events` empty and writes no `base.jsonl`: band's Log pane shows no base line |
| `DOMAINE_LOG_DIR` | `~/.claude/domaine/log` | Where every Domaine plugin (slim, band, base, fe, qa, be, pm) writes its event log on disk: `<dir>/<session-id>/<plugin>.jsonl`, one JSON line per event. An absolute directory; the `<session-id>/` folder is still made under it. Without it and without `HOME` (a cloud session) no file is written. |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | read, never set, by `scripts/doctor.cjs`: the Claude Code config directory whose `plugins/installed_plugins.json` and `settings.json` the `slim` and `fnd` rows read |
| `BASE_GUARD` | on | `0` turns every guard off: the attribution and git-hooks guards on Bash, and the scratch-path guard |
| `BASE_LEAN` | on | `0` drops the lean-code convention from the system prompt and from code-writing subagents |
| `BASE_SCRATCH_GUARD` | on | `0` turns the scratch-path guard off: the browser tools write wherever their path points |
| `BASE_STE` | on | `0` drops the writing-style convention (ASD-STE100) from the system prompt |
| `BASE_FIGMA_SOURCE` | `auto` | `base:figma-reader`'s source ladder: `auto` tries the Figma MCPs, then the REST API; `mcp` never uses the token; `rest` skips the MCPs. Process environment only |
| `BASE_SESSION_TITLE` | on | `0` leaves the session title to Claude Code |
| `BASE_TMP_TTL` | `24` | hours a file in `.claude/base-tmp` lives before the session sweep deletes it; `0` turns the sweep off |
| `BASE_AUTOSAVE` | on | `0` turns the workspace autosave levers off: the stale-workspace line on a prompt, the one-time block at turn end, the `compact:` marker before an auto-compact. `base.progress` still carries `stale` |

The fetchers read their credentials from the process environment first, else from the project's
gitignored `./.env` (`--env <file>` names another): `JIRA_EMAIL` + `JIRA_API_TOKEN` (a read-only
scoped Atlassian token, `references/jira-attachments.md`), `JIRA_SITE` (default
`meetdomaine.atlassian.net`), `FIGMA_TOKEN` (a read-only Figma token, `references/figma-rest.md`).
Agents never read `.env` themselves.

## Tests

`claude plugin validate --strict plugins/base` and `claude plugin test plugins/base` (the kit tests in
`plugins/base/hooks/mods/tests/`), both run by `tests/mods-sim.sh` with every other plugin. The
scripts and texts have their own suites:

| Suite | Covers |
|---|---|
| `tests/base-guards-sim.sh` | `hooks/scratch-path-guard.cjs` as the mod runs it: the verdicts, the remediation paths, the launch root, worktrees, the exclude stamp of `scripts/scratch-hygiene.cjs` |
| `tests/no-verify-bypass-matrix.sh` | `hooks/no-verify-bypass.sh`: every bypass row blocked, every legitimate command allowed (the same matrix as fnd's copy) |
| `tests/base-refs-lint.sh` | no fnd, host or old-compressor name in plugins/base; every MCP server, cited path, agent, skill, command, `BASE_*` switch and markdown link resolves, and so does every team plugin's path, skill or agent the shared text names (`<fe root>/…`, `/qa:preflight`) |
| `tests/base-jira-attachments-sim.sh` | `scripts/jira-attachments.sh` against a fake curl: credentials, gates, caps, cache, videos kept whole, the transport retry |
| `tests/base-external-screenshots-sim.sh` | `scripts/external-screenshots.sh`: the allow-list, redirect hops, `og:image` resolution, the format from the bytes, cache, pacing, no resample |
| `tests/base-figma-rest-sim.sh` | `scripts/figma-rest.sh`: the token, the modes, `--policy`, the cache, retries, the out-dir gate |
| `tests/base-md-to-adf.mjs` | `scripts/md-to-adf.cjs`: the ADF it writes, the CLI contract, round trips through slim's adf engine |
| `tests/base-doctor-sim.sh` | `scripts/doctor.cjs` against sandbox plugin roots, homes, projects and log folders: every row's verdicts, `--json`, `--log-dir`, Windows |
| `tests/base-scripts-sim.sh` | `scripts/worktree-setup.sh` against scratch git repos (branches, ports, removal guards, the `--copy` list) and the `scripts/scratch-hygiene.cjs` sweep |
| `tests/base-qa-stores-sim.sh` | `scripts/qa-stores.cjs`: `list`, `get`, `find`, `set`, `unset`, `path`, file and dir modes, the password printed by `get` only |

How the pieces fit — the mods, the atoms band reads, why some checks stay scripts:
[ARCHITECTURE.md](ARCHITECTURE.md).

## Licence

MIT, as the repository ([LICENSE](../../LICENSE)).
