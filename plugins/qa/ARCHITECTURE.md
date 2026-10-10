# qa — architecture

What runs where and why each piece sits where it does. The README says what qa does for the person
using it; this file is for whoever changes it. The code wins when the two drift.

## 1. The pieces

```
plugins/qa/
├── .claude-plugin/plugin.json   dependencies: ["base"], types; no mcpServers, no classic `hooks` key
├── hooks/hooks.json             { "modules": ["./mods/register.ts"] } — the only hook wiring
├── hooks/mods/*.ts              the hooks module (Claude Code function hooks)
├── types/index.d.ts             qa's $.state contract: the `qa` key only
├── skills/preflight/            SKILL.md (`/qa:preflight`), gate.md, rows.md, brief.md
└── scripts/doctor.cjs           the static install checks
```

The skill hands off to base by qualified names only (`base:jira-reader`, `base:jira-writer`) and cites
base's files as `<base root>/…`, the path on base's `base plugin root:` session line: the QA store
registry (`scripts/qa-stores.cjs`), the task workspace, the Steps to Test format, the break-it method
and the ADF write rules all live in base, so a second team plugin reads the same copy. qa names no
other team plugin's skill or path: the team plugins co-install and never require one another.

## 2. The skill's files

`SKILL.md` is the phase skeleton: the global rules (store access, passwords, one theme per store) and
one pointer per phase. The detail is split by when it is needed, so a run loads each file once, at its
phase, and a run that stops at Phase 1 never loads the last two: `gate.md` (Phases 1–3), `rows.md`
(Phase 4), `brief.md` (Phases 5–6). Each rule is stated in one file only; another file points at it.
base's `steps-to-test-format.md` and `jira-adf-write.md` are cited but not read by the skill —
`rows.md` carries the item → row mapping, and `base:jira-writer` reads the ADF rules itself.

The rename to `QA preflight <KEY>` is a fallback: base's title hook names the session only after a
ticket it can corroborate, once, so the skill renames when the tool exists and the title does not
already name every key of the run. The examples use a placeholder store
(`acme-us-uat.myshopify.com`) and placeholder theme ids.

## 3. How base is required

`"dependencies": ["base"]` is the whole declaration. Each load from a folder the developer owns lays
the contract of every plugin the manifest reaches through `dependencies`, transitively, into
`.claude-plugin/types/<plugin>/index.d.ts`: base's and, through base, slim's. qa's own contract never
redeclares their keys.

At run time qa checks for base itself: the engine does not install a dependency. `session.ts` looks for
a command whose `plugin` is `base` in `$.command.list()`. Absent → one toast and one `install` line; a
listing that fails says nothing.

## 4. The hooks module

`register.ts` calls one register function per file. Each file declares its own atoms and spells its
own env names: the engine's validator follows `$` only into functions declared in the same file, never
across an import, so `doctor.ts` repeats `diskOf` and the base lookup rather than importing them.

| File | Hooks | Writes |
|---|---|---|
| `session.ts` | `session.start {cwd:/^/}` start line and base check · `prompt.compose`: the `root` and `passwords` sections (ids `qa:<name>`) | `qa.started`, `qa.events` |
| `doctor.ts` | `session.start {cwd:/$/}` + `prompt.submit`: register `/qa-doctor` (every start, and a new session id) · `command.run qa-doctor` (passes `--log-dir` to `doctor.cjs`) | `qa.armed`, `qa.events` |

Pure helpers carry no `$`: `events.ts` (the 200-line cap and the `qa.jsonl` writer), `conventions/text.ts`
(the section texts). `<base root>` stays literal in the passwords text: qa
cannot see base's directory, and base's own session line names it.

The sections are fixed text, so every render repeats the last one byte for byte (the prompt cache).
The main session gets the root line and the password paragraph only; the store-access posture lives in
the skill, which is where it applies. Subagents get nothing from qa: the preflight's own subagents
are base's reader and writer, which never touch a password.

## 5. The atoms

`types/index.d.ts` declares `qa: { … }` only. Any plugin reads a qa atom; qa alone writes it.

- **`qa.events`** — `{ atMs, kind, text }`, oldest first, at most 200; kinds `start`, `install`,
  `doctor` (9 cells at most). `QA_EVENT_LOG=0` keeps it empty.
- **`qa.started`**, **`qa.armed`** — the session id whose start line and base check ran, and whose
  `/qa-doctor` is registered: a module reload repeats neither the line nor the check.

## 6. The file log

Every line pushed to `qa.events` also goes to `events.ts`'s `logLine` with a `Disk` the writing file
builds from its own `$`: `<log dir>/<session-id>/qa.jsonl`, `plugin` the literal `qa`, `version` from
qa's own manifest, the start line first in each session's file and never twice, the session's lines
kept module-local and seeded from the file after a reload, every write behind one queue, at most 2000
lines or 256 KB, never a throw into a hook, one toast per session on the first failed write. The log
directory is `DOMAINE_LOG_DIR` when absolute, else `$HOME/.claude/domaine/log`; neither, no file. qa
never sweeps: base owns the clean-up of old session folders.

## 7. The doctor

`scripts/doctor.cjs` answers what a node process can see: node, manifest, the scripts (a `.sh` keeps
its exec bit, a `.cjs` parses), base installed, the QA store registry, `gh`, base's chrome-devtools
server, `qa.jsonl`. base's directory comes from its `installPath` in `installed_plugins.json`; the
registry row runs that copy's `qa-stores.cjs path` and `list --json` with `HOME` set to the doctor's
home, and reports the file and a store count — `list --json` masks passwords, and a corrupt registry's
error text is not relayed, as a parse message can quote the file. `/qa-doctor` adds `base-live` and
`slim-live` and turns a static `base` FAIL into a WARN when the session loaded base anyway.

## 8. The tests

- `hooks/mods/tests/*.test.ts` through `claude plugin test plugins/qa` (`tests/mods-sim.sh`): the start
  line and base check, the two sections and the empty subagent share, the doctor command, `qa.jsonl`.
- `tests/qa-doctor-sim.sh`: every `doctor.cjs` row's PASS / FAIL / SKIP / WARN on a sandbox plugin
  root, home and project, base's real `qa-stores.cjs` as the registry, no secret in the output.
- `tests/team-refs-lint.sh`: every qualified name and cited path resolves against qa and base, no legacy
  name is left, and no skill names another team plugin's.
