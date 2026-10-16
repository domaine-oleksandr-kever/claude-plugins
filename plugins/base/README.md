# base

base is the shared Domaine plugin for Claude Code. It holds the tools that every team uses. A team
plugin (frontend, backend, QA) depends on base and adds its own skills on top. To install it, see
[Quick install (Claude Code)](../../README.md#quick-install-claude-code) in the root README.

base contains these parts:

- the readers, which turn a Jira ticket, a Figma frame or a linked doc into workspace files;
- the Jira writer and the review agents;
- the task workspace and the progress that base publishes for band;
- the commit and review guards;
- the working conventions, a doctor, and the MCP servers that the agents call.

base requires slim and reads large results through it. Only slim compresses, so every figure goes
to slim's log. base's readers call slim's `view` tool for a file or a command output.

Current release: **base v0.10.4**.

## Status

- base runs in Claude Code only. It is a plugin of skills, agents, MCP servers and a hooks module
  (mods). It ships no adapter for another host, and `scripts/install.sh --plugin base` exits 2.
- base requires slim (`"dependencies": ["slim"]` in its manifest). The engine does not install a
  dependency on its own, so install both.

## Install

```text
/plugin marketplace add domaine-oleksandr-kever/claude-plugins
/plugin install slim@domaine
/plugin install band@domaine
/plugin install base@domaine
/reload-plugins
```

Then run `/base-doctor` to check the install (§ Doctor). Next, install the team plugins for your
work. Each team plugin has its own doctor:

- fe, the frontend plugin: `/plugin install fe@domaine`, then `/fe-doctor`
  ([plugins/fe/README.md](../fe/README.md)).
- qa: `/qa-doctor` ([plugins/qa/README.md](../qa/README.md)).
- be: `/be-doctor` ([plugins/be/README.md](../be/README.md)).
- pm: `/pm-doctor` ([plugins/pm/README.md](../pm/README.md)).

To enable the same set through settings, put this in `~/.claude/settings.json`:

```json
{
  "enabledPlugins": {
    "slim@domaine": true,
    "band@domaine": true,
    "base@domaine": true
  }
}
```

`base:jira-reader` gives every downloaded screenshot and screen recording to slim's `view`. `view`
writes the resized copy (or the frames) beside the file in `.claude/tasks/<work-id>/tmp/attachments/`,
or in `.claude/base-tmp/<KEY>/` when the reader was given no workspace path; that dir is swept after
`BASE_TMP_TTL` hours. If the permission check would ask about that write, slim asks you once per file
(Yes/No). To skip the question, add allow rules for both dirs to the project's
`.claude/settings.json`:

```json
{ "permissions": { "allow": ["Write(.claude/tasks/**)", "Write(.claude/base-tmp/**)"] } }
```

Resizing and frame cutting need `ffmpeg` + `ffprobe` on PATH. macOS `sips` covers images only.
Without these tools, the files stay downloaded but are not resized, and the reader says so in its
`attachments_note`. Claude then looks at an image the task needs through one read of the original,
never a batch of them; a recording without frames cannot be looked at.

## Agents

Spawn each agent by its qualified name (`base:<agent>`). When two plugins ship agents, a bare name
does not resolve.

| Agent | Does | Model |
|---|---|---|
| `base:jira-reader` | reads one ticket — fields, comments, attachments — writes `ticket.md` and `comments.md` to the workspace; downloads images and recordings (into the workspace, else `.claude/base-tmp/<KEY>/`), resizes them through slim's `view` | sonnet |
| `base:figma-reader` | reads one Figma node through a Figma MCP or the REST API, writes `figma-<node-id>.md`; the REST tree is compacted by slim's `view` | sonnet |
| `base:doc-reader` | reads one linked doc (Notion, Confluence, web) and writes a task-focused extract | sonnet |
| `base:jira-writer` | writes one approved value to one Jira field or comment, converted to ADF, and reads it back | sonnet |
| `base:bug-hunter` | adversarial correctness review of the branch's diff | opus |
| `base:change-reviewer` | comment accuracy, refactors and rule conformance on the changed files; the `profile` and its team rules come in the brief | opus |

The three readers need slim. They read big MCP results that slim's mcp channel compacts, and they
call `mcp__slim__view` for files on disk. If slim is not loaded, base refuses to spawn them.

The Jira reader, the doc reader and the writer run on a `tools:` allowlist. The allowlist holds the
built-ins they use, slim, and the Atlassian and Notion servers. Each server appears under both
`mcp__plugin_base_…` and the user-scope name. Their `disallowedTools:` removes every write tool of
those servers that they do not need. figma-reader denies the Atlassian and Notion servers whole.

## References and scripts

The agents cite these files by their path under the plugin root. `tests/base-refs-lint.sh` checks
that every cited path exists.

| File | Holds |
|---|---|
| `references/jira-field-ids.md`, `references/jira-custom-fields.md` | the meetdomaine site's custom-field ids, the request shape, and how to rediscover an id |
| `references/jira-freshness-check.md` | `base:jira-reader`'s cached-ticket check (changelog first, comment-only refresh) |
| `references/jira-attachments.md` | the read-only Jira token, `scripts/jira-attachments.sh`, `scripts/external-screenshots.sh`, and the resize through `view` |
| `references/jira-reader-attachments.md` | `base:jira-reader`'s download steps, read only when a ticket has attachments or linked screenshots |
| `references/jira-adf-write.md` | writing ADF to a field or a comment, `scripts/md-to-adf.cjs`, the read-back check |
| `references/figma-rest.md` | the Figma source ladder, the REST token, `scripts/figma-rest.sh`, the compact tree through `view` |
| `references/figma-reader-rest.md` | `base:figma-reader`'s rung-3 steps, read only when the ladder lands on REST |
| `references/reading-linked-docs.md` | which links a caller reads and with which reader |
| `references/task-workspace.md`, `references/task-workspace-freshness.md` | the `.claude/tasks/<work-id>/` layout, its read and write rules, `progress.md`, the freshness probes |
| `references/review-flow.md` | the branch review flow: the `.git/.base-review` marker, which agent runs which check |
| `references/commit-message-format.md` | Conventional Commits with the house rules |
| `references/steps-to-test-format.md` | the Steps to Test field's General and Bug templates and the theme resolution: what a team plugin's Steps to Test writer writes and `/qa:preflight` reads rows from |
| `references/break-it-qa.md` | the break-it QA method: deriving and executing the hostile-value and timing rows of a team plugin's QA and of `/qa:preflight` |
| `references/shopify-recipes.md` | `/base:shopify`'s Admin GraphQL recipes, validated on API 2026-10 with their scopes and how to read each answer; the PDP "why does X not show" checklist; the `metafieldsSet` and `productUpdate` templates |
| `references/shopify-custom-data.md` | metafield and metaobject rules: `$app` vs merchant namespaces, definitions, `metafieldsSet` writes, metaobject `ACTIVE` status, reference metafields |
| `references/shopify-analytics.md` | ShopifyQL through `shopifyqlQuery`: the wrapper, `parseErrors`, `read_reports`, example statements |

The fetchers (`scripts/jira-attachments.sh`, `scripts/external-screenshots.sh`,
`scripts/figma-rest.sh`) share `scripts/_common.sh`. Credentials go in a private `0600` curl config,
never in the argv. Every download goes to a directory that git ignores. The fetchers only download;
slim resizes and compacts.

| Script | Run by | Does |
|---|---|---|
| `scripts/md-to-adf.cjs` | `base:jira-writer` | Markdown → ADF for a Jira field or comment |
| `scripts/review-scope.sh` | `/base:pre-commit-review`, `/base:commit`, a team plugin's PR gate | the review scope and its `diff_hash` for the `.git/.base-review` marker: merge-base to working tree, untracked files included, build-dirtied rewrites kept out; `--check` prints one line `marker=fresh\|stale\|other-branch\|none` (the marker against this branch and scope) for `/base:commit`'s gate |
| `scripts/worktree-setup.sh` | `/base:worktree` | creates or removes a sibling `git worktree` with its own branch and dev port, the `.claude/tasks` link back to the main checkout, and the `--copy` list |
| `scripts/doctor.cjs` | `/base-doctor`, or by hand | the static install checks (below); `--json` for the command |
| `scripts/scratch-hygiene.cjs` | base's hooks module, once per session | sweeps `.claude/base-tmp` of files older than `BASE_TMP_TTL` hours and keeps it in `.git/info/exclude` |
| `scripts/qa-stores.cjs` | a QA engineer by hand; `/qa:preflight` reads it | the QA store registry, one file per machine (`~/.config/domaine/qa-stores.json`, dir 0700, file 0600): `list`, `get <store>` (the only command that prints a password; `--field password\|alias\|defaultTheme\|domain\|notes` prints that one value raw, nothing for a field the store lacks), `find`, `set`, `unset`, `path` |
| `scripts/shopify-validate.cjs` | `/base:shopify` where no dev-mcp server is loaded (a cloud session) | validates one Admin GraphQL document through `npx -y @shopify/dev-mcp@latest` over stdio: `--file`, `--code` or stdin, `--version` (default `2026-10`); prints `result=valid\|invalid\|unavailable` and the server's detail text; exit 0 / 1 / 3 (unavailable: send the operation anyway), 2 = usage; a timeout before the server speaks leaves `npx` to finish its install instead of killing it, and `error=server_exited_early` names the `_npx` dir to delete |

## Skills

Invoke each skill by its qualified name (`/base:<skill>`). A team plugin's skills call them by the
same names.

| Skill | Does |
|---|---|
| `/base:commit` | a Conventional Commits commit, directly — only on a reviewed tree: no fresh `.git/.base-review` marker for this branch and diff (`review-scope.sh --check`) → runs `/base:pre-commit-review` first; the developer's own "commit without review" request in the same turn (not negated) is the only bypass; offers a ticket scope |
| `/base:pre-commit-review` | the branch review before a commit: ticket references and untracked files inline, `base:change-reviewer` for comments, refactors and rules, `base:bug-hunter` for correctness; a plan to approve, then the agreed edits and the marker. The caller passes the `profile` word its team plugin names (`none` without one) |
| `/base:save-task-context` | writes what the conversation holds into `.claude/tasks/<work-id>/` — ticket fields, comments, decisions, `progress.md` in the team's series order — without spawning a reader |
| `/base:report-plugin-issue` | drafts a sanitized GitHub issue for a base defect, with the `/base-doctor` output and the `base.events` tail, and posts it after your approval |
| `/base:worktree` | a sibling `git worktree` on `feat/<work-id>` with its own dev port, sharing the task workspace; `--remove` tears it down |
| `/base:shopify` | store questions and Admin GraphQL: a routing table to the recipes, answers with evidence (field, value, file key), validation through a remote store connector's own validate tool, the dev-mcp `validate` tool or `scripts/shopify-validate.cjs` (never blocking), a mutation only after a "yes" in a separate turn, then a runner table: Shopify CLI `store execute`, a remote store connector, an Admin token, or a ready `.graphql` file for GraphiQL |

`/base:worktree` copies `.env` into a new worktree, because base's fetchers read their credentials
from it. It also copies every path that a team plugin names in its system-prompt section, on one line:

```text
worktree copy list: <path>[, <path>…]
```

The paths are repo-relative files or directories, separated by `, `. The skill passes each path to
`scripts/worktree-setup.sh` as `--copy <path>`. The script refuses `.git`, `.claude`, `.claude/tasks`
and `.claude/settings.local.json`. A team step that must follow, such as a per-worktree config to
adjust, runs from the team plugin's own skill.

The worktree's `.claude/settings.local.json` (its own, else copied from the main checkout, else created) lists the
main checkout's `.claude/tasks` under `permissions.additionalDirectories`. A write through the
`.claude/tasks` link resolves outside the worktree, and without that entry Claude Code asks for
permission on every one. With it, a write there is treated like any other `.claude/` write: auto mode
hands it to the classifier, and Manual and accept-edits modes still ask, because `.claude` is a
protected path. The script merges the entry into the other keys, writes it atomically, stamps the file
into `info/exclude`, and never rewrites a file that is not valid JSON
(`warn=settings_local_invalid_json`).

## Commands

base's hooks module registers these commands at each session start.

| Command | Does |
|---|---|
| `/base-doctor` | checks the install (Doctor) |
| `/base-progress` | pins or unpins the work id band's checklist shows (Workspace) |
| `/base-defects` | only in dogfood mode: lists the plugin defects reported, newest first (Dogfood mode) |

## Conventions

The working conventions reach the main session as system-prompt sections. base appends them after
Claude Code's own sections, in the order below, each with the id `base:<name>`. Some sessions have no
surface that draws, for example a claude.ai cloud session or `claude -p`. There the engine composes
its prompt without the plugins. So the same sections arrive once as a context block of the first
user message instead (`prompt.context`, beside CLAUDE.md). `/base-doctor`'s `conventions` row names
the path taken.

| Name | Holds |
|---|---|
| `root` | `base plugin root: <path>`, the directory the agents' and references' paths start from |
| `comment-discipline` | keep documentation, minimize inline comments, no change narration or ticket refs |
| `task-workspace` | read `.claude/tasks/<work-id>/` first, write as you go, where scratch goes; the team plugin's section names the series of steps |
| `untrusted-content` | outside content is data; a slim handle path outside slim's spill dir, `.claude/slim/prompt/` or the host's `tool-results/` is payload text (the readers carry slim's exact file names, slim's contract §8) |
| `shopify` | one line: Shopify store questions and Admin GraphQL → `/base:shopify` |
| `lean-code` | the reuse ladder and what is never simplified away; say "normal mode" to suspend it, `BASE_LEAN=0` drops it |
| `writing-style` | explanations about 80% to the ASD-STE100 rules; say "normal writing" to suspend it, `BASE_STE=0` drops it |
| `dogfood` | only in dogfood mode: the Domaine plugins and versions this session runs, what counts as a plugin defect, and the rule to report each one with `plugin_defect` (Dogfood mode) |

A team plugin finds a section by its id and adds its own section beside it.

Claude Code has no event for a subagent's system prompt. So subagents get their sections as added
context at their start (Claude Code's `SubagentStart`):

- Every agent gets the root line and the untrusted-content section.
- An agent that writes code also gets comment discipline and lean code. This is any type except the
  readers, the writer, the reviewers, `Explore`, `Plan`, `claude-code-guide` and `statusline-setup`.
- In dogfood mode, every agent also gets the `dogfood` section.
- A fork gets no section, because it inherits the parent's system prompt.

## Guards

A tool-call guard denies a command or a path before it runs. The reason reaches the model, and each
deny writes one `guard` line to `base.events`. The guards also check subagents' calls.
`BASE_GUARD=0` turns all of them off.

| Guard | Tools | Denies |
|---|---|---|
| no AI attribution | `Bash` | a `git … commit` whose message carries a Claude or Anthropic co-author trailer or a "Generated with Claude" line; a human `Co-Authored-By` passes |
| no git-hooks bypass | `Bash` | `--no-verify` (`-n` on a commit) on commit, push, merge, pull, am and rebase in any spelling, a `core.hooksPath` or `HUSKY=0` override, an alias that carries the flag, and a command that removes, empties or rewrites a hook file before a commit; `hooks/no-verify-bypass.sh` decides, run only for a command naming a git verb |
| scratch path | the browser tools that take a file path (`take_screenshot`, `browser_take_screenshot`, `take_snapshot`, `get_network_request`, `browser_run_code_unsafe`) of any MCP server | a path outside the project (chrome-devtools also accepts its OS temp dir), or inside it outside `.claude/` (the task workspace's `tmp/`, `.claude/tmp/`, `.claude/base-tmp/`); in a git worktree, a path into the shared task workspace. `hooks/scratch-path-guard.cjs` decides against the project root the session launched in (`base.guardRoot`), names an absolute path to use instead and creates its directory. The tools' descriptions carry the rule too. `BASE_SCRATCH_GUARD=0` turns this one off |

base's playwright server writes its own files under `.claude/base-tmp/playwright`. When the guard
allows a write there, it adds `/.claude/base-tmp/` to `.git/info/exclude`. If a guard cannot run
(its script fails or times out), it lets the call through.

## Workspace

base resolves a work id and publishes its task workspace as `$.state` atoms (shared state values).
band draws them in its checklist and Log panes. Any plugin reads the atoms; only base writes them.

base picks the work id in this order:

1. The pinned id, when its `.claude/tasks/<id>/` exists.
2. The last ticket that a person's prompt named. A Jira `/browse/` URL corroborates a key, and so
   does a project that already has a `.claude/tasks/<KEY>` dir. `UTF-8` or `SHA-256` alone does not.
3. The branch's ticket key, then its kebab slug, when that workspace exists.
4. The newest `progress.md` written within 12 hours.

The ids from rungs 3 and 4 are only guessed (`guessed: true`): the autosave levers wait until the
session touches that workspace.

base re-reads the workspace when a file in its root changes. It checks every 30 s, and at once after
a Write or Edit under `.claude/tasks/`. base resolves the work id again after a
`git checkout`/`switch`/`worktree`, a directory change, a /clear, and every two minutes.

| Atom | Value |
|---|---|
| `base.progress` | the parsed progress.md of the work id (`{ workId, branch, hasWorkspace, done, total, current, rows, notesTail, mtimeMs, lastSavableMs, agentsSince, editsSince, stale, guessed }`), or `{ workId: null, branch }` |
| `base.savable` | this session's savable events, `{ atMs, kind: 'agent' \| 'edit' \| 'mcp', workId }`, at most 200 |
| `base.background` | the ids of background agents the main loop launched that have not stopped yet, at most 200 |
| `base.autosave` | the turn counter, its start, the turn whose stop was last blocked, and the write the prompt line last fired for |
| `base.compactMarker` | the last `compact:` line autosave wrote: `{ workId, notesMs, priorMs }`, so it never counts as a save |
| `base.pin` | the work id `/base-progress` pinned, or null |
| `base.lastKey` | the last ticket a person's prompt named this session |
| `base.sessionId` | the session the atoms describe |
| `base.events` | base's log lines for band's Log pane, oldest first, at most 200: `{ atMs, kind, text }` |
| `base.started`, `base.checked`, `base.titled` | the session id whose start line, install checks and title are done (`<id>:user` when the person titled it) |
| `base.guardRoot` | the project root the session launched in, which the scratch-path guard measures against |
| `base.swept` | the session id whose base-tmp and event-log sweeps ran |
| `base.dogfood` | dogfood mode's session: `{ sid, failMs, script, blockedMs, reportMs }` — the last plugin-script failure, the failure whose stop was blocked, the last `plugin_defect` report |

**Autosave.** A savable event is one of these, in the main loop: an Agent call that returned its
result, the stop of a background agent it launched, a Write / Edit outside `.claude/`, or an MCP
result over slim's 4 KB gate. The event belongs to the
work id that base published when it happened.

The workspace is `stale` when two things are true. First, no file in its root was written for 20
minutes, or for 5 minutes once the context window is 85 % full. A reader's `ticket.md` counts;
`tmp/` does not. Second, the newest savable event of its work id came after that write. A guessed workspace is
never stale. band's Compact reads the same flag, so it never saves into a guessed workspace either.

While the workspace is stale, autosave does three things:

- A person's prompt gets one context line that asks to save to notes.md. The line comes once until
  the next workspace write.
- A turn that did savable work and wrote nothing to the workspace is blocked at its stop. A turn
  without savable work of its own is never blocked, and launching a background agent is not savable
  work. It never happens when the stop hook is already active, and at most once per 3 turns.
- An auto-compact appends one `compact:` pointer line to notes.md. This line is not a save: the
  workspace stays stale, and the next prompt gets the line again.

A workspace found from the branch or as the newest `progress.md` is guessed, and autosave leaves it
alone. The session adopts it with the first Read, Write or Edit under it, a Bash command naming
`.claude/tasks/<id>/`, a write into it, a prompt that names its key, or a pin. The three levers
apply from then on, and a /clear makes it guessed again.

`BASE_AUTOSAVE=0` turns the three off.

`/base-progress <work-id>` pins the work id that band's checklist shows. `/base-progress -` unpins,
and `/base-progress` alone names the pin. The checklist itself is band's `/band-progress`.

`base.events` has these kinds:

- `start`: base's version, once per session.
- `install`: slim is missing.
- `refuse`: a reader refused.
- `workspace`: the work id base now publishes, or `none` when base leaves every workspace.
- `title`: the session title base set.
- `guard`: a guard's deny, with the tool and the reason.
- `doctor`: the counts of a `/base-doctor` run.
- `defect`: in dogfood mode, a `plugin_defect` report (`<plugin>: <title>`) or a failed plugin
  script (`script failed: <basename>`).

band and slim write their own session, model, compaction, rate and compression lines. Each line
also goes to base's file on disk (Event log on disk).

## Event log on disk

Every Domaine plugin (slim, band, base, fe, qa, be, pm) writes the lines that it publishes to its own
file. So the origin of a line is on the line, written by that plugin, and nobody infers it from a
pane.

- **Where:** `$HOME/.claude/domaine/log/<session-id>/<plugin>.jsonl`. Examples are `base.jsonl`,
  `band.jsonl`, `slim.jsonl`, and a team plugin's own file, such as fe's `fe.jsonl`.
  `DOMAINE_LOG_DIR` (an absolute directory) replaces `$HOME/.claude/domaine/log`. The
  `<session-id>/` folder is still made under it. With neither (a cloud session), no file is written.
  The log is never under the project.
- **Line:** one JSON object per line, oldest first:
  `{"ts":"2026-10-08T12:34:56.789Z","plugin":"base","version":"0.1.0","session":"<id>","kind":"guard","agent":"main","text":"Bash: a git hooks bypass"}`.
  `ts` is the event's time in UTC. `plugin` and `version` are the writer's own name and release.
  `agent` is the subagent type that caused the line, or `main`. `kind` and `text` are the line as
  `base.events` has it.
- **Start line:** the first line that a plugin writes for a session id is `start` /
  `<plugin> <version>`. This is also true under the new id that a `/clear` opens, where no session
  start runs. A session whose lines already hold a start line gets no second one. A module reload or
  a resume in a fresh process goes on from the file.
- **base's lines:** every `base.events` line, with `agent` always `main`. The first line of a
  session's file is `start` / `base <version>`. After a /clear (a new session id with no session
  start), base writes that line before the new session's first event.
- **Writing:** the engine has no append, so the whole file is rewritten after every line. The file
  holds at most 2000 lines or 256 KB, and the oldest lines drop first (past the cap, the start line
  too). A reload of the module picks up the file of the same session and goes on. A write that fails
  never reaches the hook. The first failure in a session toasts
  `base: event log not written: <reason>`.
- **Off:** `BASE_EVENT_LOG=0` stops base's file and its `base.events` lines alike.
- **Clean-up:** base sweeps session folders whose newest file is older than 7 days. Its
  `/base-doctor` row `event-log` names the folder, and each file's line count and newest time. The
  other plugins never delete.

The sweep runs once per session, and again after a /clear, in the background. It sweeps
`$HOME/.claude/domaine/log` only; you clean a `DOMAINE_LOG_DIR` yourself. The sweep does not run when
that directory resolves anywhere but its own spelling (a symbolic link). It touches only folders that
are named like a session id and hold nothing but `*.jsonl` files. It skips the current session's
folder, and a folder that resolves anywhere but its own place under that directory. It deletes the
rest with `rm -rf`, because the engine's file API cannot delete.

## Session start

- **Install checks** run at the first prompt of each session. (slim registers its tools at its own
  session start.) Without slim's `mcp__slim__view` tool, base shows one line and one toast:
  `slim is not loaded — claude plugin install slim@domaine`.
- **Reader refusal**: while `mcp__slim__view` is missing, base denies a spawn of `base:jira-reader`,
  `base:figma-reader` or `base:doc-reader`. The deny reads `base: <agent> needs the slim plugin —
  claude plugin install slim@domaine`. It applies through the Agent tool and through any plugin's
  spawn. The writer and the reviewers run without slim.
- **Session title** is `<KEY> — <summary>`, cut at 100 bytes. The summary comes from the
  `# <KEY> — …` heading of `.claude/tasks/<KEY>/ticket.md`; without that heading, the title is the
  key alone. base takes the key from the branch's ticket key when the session starts and
  `.claude/tasks/` holds that key or another key of its project. Else base takes it from the first
  prompt you write that names a corroborated ticket. That is the most recent ticket the prompt names,
  as the workspace resolver picks. base sets the title once per session. It keeps a title that you
  gave the session (`--name` at start, `/rename` later).

- **base-tmp sweep** runs once per session, and again after a /clear, in the background. The session
  start never waits for it. It deletes files in `.claude/base-tmp` older than `BASE_TMP_TTL` hours
  (24 by default). Directories and symlinks stay. It also holds `base:jira-reader`'s downloads for a
  ticket read with no task workspace (`.claude/base-tmp/<KEY>/`); the download scripts add
  `.claude/base-tmp/` to `.git/info/exclude` the first time they write there.
- **Event-log sweep** runs alongside it. It deletes session folders under `$HOME/.claude/domaine/log`
  whose newest file is older than 7 days (Event log on disk).

## Doctor

`/base-doctor` checks the install. It prints one PASS / FAIL / SKIP / WARN row per check, the
counts, and the last 10 `base.events` lines:

| Row | Checks |
|---|---|
| `node`, `platform` | Node 18 or newer; native Windows is refused (the scripts need bash) |
| `manifest`, `hooks`, `scripts` | the manifest's version, a plugin name the engine loads a hooks module for (`core` and `engine` are its own), its `slim` dependency, the hooks module files, the scripts' exec bits |
| `slim` | slim installed (user scope or this project) and enabled — else `claude plugin install slim@domaine` |
| `base-tmp` | `.claude/base-tmp`: files, size, how many the next sweep removes, whether git ignores it |
| `event-log` | this session's event-log folder and, per `<plugin>.jsonl` there, its line count and newest `ts`; no folder yet passes (a /clear's new session has none before its first line); a folder with no file warns (every write failed) unless `BASE_EVENT_LOG=0` |
| `switches` | only when a `BASE_*` switch holds a value outside its domain in Environment switches (an on/off switch set to anything but `0` or `1`, an unknown `BASE_FIGMA_SOURCE`, a `BASE_TMP_TTL` that is not hours, a `BASE_SHOPIFY_VALIDATE_TIMEOUT` outside 1-600 seconds, a `BASE_DOGFOOD_REPO` that is not `<owner>/<repo>`): warns with the value the reader falls back to |
| `slim-live` | what this session loaded: slim's `mcp__slim__view` tool registered |
| `conventions` | how the conventions reached the model: `in the system prompt: N renders through prompt.compose`, or `in the first user message as a prompt.context block` where no surface draws (cloud, `claude -p`); FAIL after a prompt went out = neither path carried them, and the detail says which prompt events this host fired (SessionStart and the surfaces it saw, UserPromptSubmit, prompt.context) |
| `defects` | only in dogfood mode: PASS `none in 7 days`, WARN `<N> in 7 days, newest <title>` — the reports of the home index and this project's `.claude/plugin-defects/` |
| `mcp:<server>` | each MCP server of base's manifest connects; sign-in needed fails with the `/mcp` pointer; `figma-dev-mode` (the Figma desktop app's local server) only warns |

The rows up to `switches` come from `scripts/doctor.cjs`. You can also run it by hand:
`node <base plugin root>/scripts/doctor.cjs [--project <dir>] [--log-dir <dir>]`. It exits 1 when a
row fails. By hand, its `event-log` row reads the newest session folder, unless `--log-dir` names
one. The session rows need the command. Each run writes one `doctor` line to `base.events`.

## Dogfood mode

Dogfood mode turns every session into a test run of the Domaine plugins (slim, band, base, fe, be,
qa, pm), which are development builds. When dogfood mode is off, nothing in this section exists.

There are two ways to turn it on:

1. Set `BASE_DOGFOOD=1` in `~/.claude/settings.json` → `env`. Use this on a machine of yours, or in
   a cloud environment's variables.
2. Add your claude.ai account id to `plugins/base/dogfood.json` (`accounts`:
   `CLAUDE_CODE_ACCOUNT_UUID` → name). The file follows the plugin into every synced sandbox. This
   includes the claude.ai chat, where you cannot set a variable. `BASE_DOGFOOD=0` turns a listed
   account off.

- **Convention** `dogfood` goes in the system prompt, or in the context block where nothing draws.
  It holds three things:
  - The plugins and versions. base reads its own manifest, slim's `slim.info`, and the others from
    `installed_plugins.json`. A plugin that settings enable without a record is named without a
    version.
  - What counts as a defect: a script that failed or printed odd output, a hook or mod that threw or
    showed a notice, a skill that contradicts the code or itself, a doctor FAIL, wrong slim output,
    or a convention that is wrong for this host.
  - The rule. Report each defect (with `plugin_defect` where it is listed) before or while you work around it, never
    silently. The reply carries `Plugin defect: <title> → <path>`. Offer a GitHub issue, but never
    file one unasked (for where nothing draws, see below). Never put a secret, token or storefront
    password in a report.
- **Tool** `mcp__base__plugin_defect` is registered at session start. Its fields:
  - `plugin`: one of the seven.
  - `kind`: `skill`, `script`, `hook`, `mod`, `doctor`, `output`, `docs` or `other`.
  - `title`: one line, 120 characters.
  - `path`: `file:line`, or empty.
  - `observed`, `expected`, `reproduce`.
  - `evidence`: cut at 2 KB, and the report says so.
  - `suspect`: `plugin`, `project` or `unsure`.
  - `github`: default false; true where nothing draws.

  The tool treats every field as data. It strips control characters. Observed, Expected, Reproduce
  and Evidence sit in fences that no field text can close. The file name comes from the date, the
  plugin and a slug of the title (`[a-z0-9-]`, 40 characters). The tool writes nowhere else.
- **Report** goes to `<project>/.claude/plugin-defects/<YYYY-MM-DD>-<plugin>-<slug>.md`, with `-2`,
  `-3` on a clash. Its frontmatter is `plugin`, `version`, `kind`, `suspect`, `date`, `session`,
  `work_id`. Its sections are Observed, Expected, Reproduce, Evidence and Environment. The tool fills
  Environment itself: the project root, the git remote, branch and commit, the plugin versions, the
  surfaces, the Claude Code version, the session and the work id.
- **Index** `~/.claude/plugin-defects/index.md` has one line per report:
  `- <date> <plugin> <title> → <absolute path>`. The tool skips it without a writable home (a cloud
  session). When the index exists but does not read, the tool leaves it whole and the result says so.
- **GitHub**: `github: true` runs `gh issue create --repo <repo> --title '[<plugin>] <title>' --body-file
  <report>` and returns the URL. `<repo>` is `BASE_DOGFOOD_REPO`, else the github marketplace that
  base was installed from. The tool reports a gh failure in the result and never retries it.
- **Subagents** also get the `dogfood` section at their start, because any agent may run a plugin
  script. A subagent's failed plugin script nudges and logs, but does not block the main loop's stop.
- **Nudge**: a Bash command can run a plugin script and fail. A plugin script is
  `plugins/<name>/scripts/…` of the seven, or anything of theirs under `~/.claude/plugins/cache/`.
  A failure is an error result, or `Error` in the stderr. The result then gets one line for the model,
  `base dogfood: a plugin script failed — report it with plugin_defect (not among your tools: in your reply) before working around it`,
  and a `defect` event. In the main loop, the next stop without a report since then is blocked once
  per failure. A designed refusal is not a failure, so it gets no nudge. A refusal is output whose
  `error=` lines all name a refusal, or, with no `error=` line, a `<script stem>: …` line (a base
  script's die). A refusal is the caller's input or usage (`usage`, `unknown_arg`, `missing_value`,
  `--env requires …`, `invalid_store`, `from_file_invalid_json`, …), a guard (`*_refused`,
  `*_mismatch`, `settings_drift`, `ambiguous_env`, `not_applied`, …), something named that is not
  there (`theme_not_found`, `variables_file_not_found`, …) or a credential not set up
  (`no_admin_token`, `no_theme_token`, `no_jira_credentials`, `no_figma_token`). Every other `error=`
  reason is a failure: a missing tool or plugin file (`jq_not_found`, `shopify_cli_not_found`,
  `common_lib_not_found`), a credential set but rejected (`invalid_admin_token`), a remote call (`http_*`,
  `gql_errors`), or the script's own work (`*_failed`, `*_unverifiable`). `Error` in the output
  always makes it a failure. When the script is not the line's last command (`script; echo done`,
  `script | head`), the exit code is not its own: a failed result with a crash the script's own
  trace names (`Error` with a stack frame `<script>:12`, or a shell's `<script>: line 12:`), or a
  failure `error=` line even at exit 0, nudges and logs, and the stop is never blocked; another
  command's `Error` (tsc, a husky hook) does not. A trailing `2>&1` still counts as last. A call the
  permission layer denied (the auto mode classifier, a rule, the user) never ran: no nudge.
- **`/base-defects`** lists the index newest first, then this project's `.claude/plugin-defects/`.
  The doctor's `defects` row counts the last 7 days.

**Where nothing draws** (claude.ai/code, `claude -p`), the report file and `~` end with the session.
There the tool still writes the file and returns the whole report in a fenced block. It also files
the GitHub issue, unless the call passes `github: false`. The result says when gh is missing or
fails. The convention tells the model to paste the whole report into its reply under the
`Plugin defect:` line, and to write that report itself when no `plugin_defect` tool is listed (some
cloud sessions lack base's tool server). That line then ends `→ in this reply`, since no file was
written. The owner then copies it into a session in the plugin repo.

To read the reports from the plugin repo, start at the index. It names every report on this machine
by its absolute path. Each file stands alone: Reproduce and Environment say where and on which
versions. The frontmatter sorts the reports by plugin, kind and suspect.

## Environment switches

Every switch base reads has a row here; set it in `~/.claude/settings.json` → `env`.

| Variable | Default | Effect |
|---|---|---|
| `BASE_EVENT_LOG` | on | `0` keeps `base.events` empty and writes no `base.jsonl`: band's Log pane shows no base line |
| `DOMAINE_LOG_DIR` | `~/.claude/domaine/log` | Where every Domaine plugin (slim, band, base, fe, qa, be, pm) writes its event log on disk: `<dir>/<session-id>/<plugin>.jsonl`, one JSON line per event. An absolute directory; the `<session-id>/` folder is still made under it. Without it and without `HOME` (a cloud session) no file is written. |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | read, never set, by `scripts/doctor.cjs`: the Claude Code config directory whose `plugins/installed_plugins.json` (else the claude.ai-synced copy under `plugins/synced/`) and `settings.json` the `slim` row reads; dogfood mode reads the plugin versions and the marketplace repo from its `plugins/` |
| `CLAUDE_CODE_ACCOUNT_UUID` | — | read, never set: the claude.ai account id of the session (set by the host in every claude.ai sandbox); dogfood mode is on when `plugins/base/dogfood.json` lists it (Dogfood mode) |
| `BASE_GUARD` | on | `0` turns every guard off: the attribution and git-hooks guards on Bash, and the scratch-path guard |
| `BASE_LEAN` | on | `0` drops the lean-code convention from the system prompt and from code-writing subagents |
| `BASE_SCRATCH_GUARD` | on | `0` turns the scratch-path guard off: the browser tools write wherever their path points |
| `BASE_STE` | on | `0` drops the writing-style convention (ASD-STE100) from the system prompt |
| `BASE_FIGMA_SOURCE` | `auto` | `base:figma-reader`'s source ladder: `auto` tries the Figma MCPs, then the REST API; `mcp` never uses the token; `rest` skips the MCPs. Process environment only |
| `BASE_SESSION_TITLE` | on | `0` leaves the session title to Claude Code |
| `BASE_TMP_TTL` | `24` | hours a file in `.claude/base-tmp` lives before the session sweep deletes it; `0` turns the sweep off |
| `BASE_DOGFOOD` | off | `1` turns dogfood mode on, `0` turns it off for an account `dogfood.json` lists (Dogfood mode): the `dogfood` convention, the `plugin_defect` tool, the nudge and the one blocked stop after a failed plugin script, `/base-defects`, the doctor's `defects` row. Off, none of them exists |
| `BASE_DOGFOOD_REPO` | the marketplace repo | `<owner>/<repo>` a `plugin_defect` call with `github: true` (or, where nothing draws, without `github: false`) files its issue in; unset, the github repo of the marketplace base was installed from (`known_marketplaces.json`), and without one the tool asks for this switch |
| `BASE_AUTOSAVE` | on | `0` turns the workspace autosave levers off: the stale-workspace line on a prompt, the block at turn end (at most once per 3 turns), the `compact:` marker before an auto-compact. `base.progress` still carries `stale` |
| `BASE_SHOPIFY_VALIDATE` | on | `0` makes `scripts/shopify-validate.cjs` answer `result=unavailable` (`error=disabled`, exit 3) without spawning the server |
| `BASE_SHOPIFY_VALIDATE_TIMEOUT` | `90` | seconds `scripts/shopify-validate.cjs` waits in all (the first `npx` download included) before it answers `error=timeout`; 1-600, another value is read as `90`; `--timeout` outranks it |

The fetchers read their credentials from the process environment first. Else they read the
project's gitignored `./.env`; `--env <file>` names another file. The credentials are:

- `JIRA_EMAIL` + `JIRA_API_TOKEN`: a read-only scoped Atlassian token (`references/jira-attachments.md`).
- `JIRA_SITE`: default `meetdomaine.atlassian.net`.
- `FIGMA_TOKEN`: a read-only Figma token (`references/figma-rest.md`).

Agents never read `.env` themselves.

## Tests

`tests/mods-sim.sh` runs `claude plugin validate --strict plugins/base` and
`claude plugin test plugins/base` with every other plugin. The second command runs the kit tests in
`plugins/base/hooks/mods/tests/`. The scripts and texts have their own suites:

| Suite | Covers |
|---|---|
| `tests/base-guards-sim.sh` | `hooks/scratch-path-guard.cjs` as the mod runs it: the verdicts, the remediation paths, the launch root, worktrees, the exclude stamp of `scripts/scratch-hygiene.cjs` |
| `tests/no-verify-bypass-matrix.sh` | `hooks/no-verify-bypass.sh`: every bypass row blocked, every legitimate command allowed |
| `tests/base-refs-lint.sh` | no legacy-plugin, host or old-compressor name in plugins/base; every MCP server, cited path, agent, skill, command, `BASE_*` switch and markdown link resolves, and so does every team plugin's path, skill or agent the shared text names (`<fe root>/…`, `/qa:preflight`) |
| `tests/base-jira-attachments-sim.sh` | `scripts/jira-attachments.sh` against a fake curl: credentials, gates (the `.claude/base-tmp/` no-workspace dir stamped once), caps, cache, videos kept whole, the transport retry |
| `tests/base-external-screenshots-sim.sh` | `scripts/external-screenshots.sh`: the allow-list, redirect hops, `og:image` resolution, the format from the bytes, cache, pacing, no resample |
| `tests/base-figma-rest-sim.sh` | `scripts/figma-rest.sh`: the token, the modes, `--policy`, the cache, retries, the out-dir gate |
| `tests/base-md-to-adf.mjs` | `scripts/md-to-adf.cjs`: the ADF it writes, the CLI contract, round trips through slim's adf engine |
| `tests/base-doctor-sim.sh` | `scripts/doctor.cjs` against sandbox plugin roots, homes, projects and log folders: every row's verdicts, `--json`, `--log-dir`, Windows |
| `tests/base-scripts-sim.sh` | `scripts/worktree-setup.sh` against scratch git repos (branches, ports, removal guards, the `--copy` list, the `settings.local.json` registration) and the `scripts/scratch-hygiene.cjs` sweep |
| `tests/base-review-flow-sim.sh` | `scripts/review-scope.sh` against scratch git repos: the base, the merge-base, the hash over tracked and untracked work, the build-dirtied exclusion, the `--check` marker verdicts (fresh / stale / other-branch / none, read-only, per worktree), bash 3.2 |
| `tests/base-qa-stores-sim.sh` | `scripts/qa-stores.cjs`: `list`, `get` (JSON and `--field` raw values, a missing field prints nothing, an unknown field is a usage error), `find`, `set`, `unset`, `path`, file and dir modes, the password printed by `get` only |
| `tests/base-shopify-validate-sim.sh` | `scripts/shopify-validate.cjs` against a fake `npx` on `PATH`: the handshake and the constant prompt, valid / invalid, stray frames, every unavailable shape incl. `server_exited_early` and its `_npx` dir, a plain `INVALID` status, the timeout and the kill after the server spoke, no kill while `npx` still installs, `BASE_SHOPIFY_VALIDATE=0`, usage; `SIM_LIVE=1` adds two cases against the real server |

[ARCHITECTURE.md](ARCHITECTURE.md) tells how the pieces fit: the mods, the atoms that band reads,
and why some checks stay scripts.

## Licence

MIT, as the repository ([LICENSE](../../LICENSE)).
