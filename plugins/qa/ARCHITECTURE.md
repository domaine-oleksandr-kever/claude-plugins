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
├── skills/preflight/            SKILL.md (`/qa:preflight`) and its REFERENCE.md
└── scripts/doctor.cjs           the static install checks
```

The skill hands off to base by qualified names only (`base:jira-reader`, `base:jira-writer`) and cites
base's files as `<base root>/…`, the path on base's `base plugin root:` session line: the QA store
registry (`scripts/qa-stores.cjs`), the task workspace, the Steps to Test format, the break-it method
and the ADF write rules all live in base, so a second team plugin reads the same copy. qa names no
other team plugin's skill or path: the team plugins co-install and never require one another.

## 2. What came from fnd, and what changed

The skill is fnd's `qa-preflight`, renamed `preflight`. The phases, the read-only posture, the
password rules, the theme question and gate, the evidence rules, the brief template and the Jira
comment rules are fnd's text. What changed is plumbing:

- the readers and the writer are base's (`base:jira-reader`, `base:jira-writer`); the registry is
  `<base root>/scripts/qa-stores.cjs` and the references are base's, cited by base's root;
- the host branches went (Claude Code only): one AskUserQuestion, `SendUserFile` in the desktop app
  else absolute paths, subagents on `model: opus`;
- the rename to `QA preflight <KEY>` stays, as a fallback: base's title hook names the session only
  after a ticket it can corroborate, once, so the skill renames when the tool exists and the title
  does not already name every key of the run;
- the developer-side QA skill is "the developer's own QA pass", and the Admin GraphQL reads of the
  stand-in search name no script, as qa ships none;
- the examples use a placeholder store (`acme-us-uat.myshopify.com`) and placeholder theme ids.

`steps-to-test-format.md` and `break-it-qa.md` moved from fe to base in the same step, as both the
frontend skills and this one read them.

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
| `session.ts` | `session.start {cwd:/^/}` start line and base check · `prompt.compose`: the `root` and `store-access` sections (ids `qa:<name>`) · `classic.SubagentStart`: the subagents' share as `additionalContext` | `qa.started`, `qa.events` |
| `doctor.ts` | `session.start {cwd:/$/}` + `prompt.submit`: register `/qa-doctor` (every start, and a new session id) · `command.run qa-doctor` (passes `--log-dir` to `doctor.cjs`) | `qa.armed`, `qa.events` |

Pure helpers carry no `$`: `events.ts` (the 200-line cap and the `qa.jsonl` writer), `conventions/text.ts`
(the section texts and the agent patterns). `<base root>` stays literal in the store-access text: qa
cannot see base's directory, and base's own session line names it.

The sections are fixed text, so every render repeats the last one byte for byte (the prompt cache).
Subagents: base's readers and writer and Claude Code's helpers get nothing; base's reviewers the root
line; every other agent the root line and the store-access posture.

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
  line and base check, the two sections and the subagent shares, the doctor command, `qa.jsonl`.
- `tests/qa-doctor-sim.sh`: every `doctor.cjs` row's PASS / FAIL / SKIP / WARN on a sandbox plugin
  root, home and project, base's real `qa-stores.cjs` as the registry, no secret in the output.
- `tests/team-refs-lint.sh`: every qualified name and cited path resolves against qa and base, no fnd
  name is left, and no skill names another team plugin's.
