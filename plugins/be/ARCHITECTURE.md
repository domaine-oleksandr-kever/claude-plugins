# be — architecture

What runs where and why each piece sits where it does. The README says what be does for the person
using it; this file is for whoever changes it. The code wins when the two drift.

## 1. The pieces

```
plugins/be/
├── .claude-plugin/plugin.json   dependencies: ["base"], types; no mcpServers, no classic `hooks` key
├── hooks/hooks.json             { "modules": ["./mods/register.ts"] } — the only hook wiring
├── hooks/mods/*.ts              the hooks module (Claude Code function hooks)
├── types/index.d.ts             be's $.state contract: the `be` key only
├── skills/<name>/SKILL.md       the 3 skills (`/be:<name>`); platform-limitations carries its tables
│                                in references/limitation-workarounds.md
├── scripts/doctor.cjs           the static install checks
└── scripts/shopify-docs.cjs     one shopify.dev docs search for a host with no Dev MCP wiring
```

The skills hand off to base by qualified names only (`base:jira-reader`, `base:doc-reader`,
`base:jira-writer`) and cite base's files as `<base root>/…`, the path on base's `base plugin root:`
session line. be declares no MCP server: the Shopify Dev MCP, Atlassian and Notion servers are base's.

## 2. What was imported

The three skills come from Domaine's `domaine-skills-solutions` repository at commit 3c96617
(2026-08-03): `app-scope` from its `/domaine-app-scope` command, `shopify-resources` from its skill of
that name, `platform-limitations` from the solutions-engineering skill's `limitation-workarounds.md`,
which became a skill of its own with the tables as its reference. The domain judgment — the
questions, the extension-type table, the LOE table and its buffer, the scope template, the resource
hierarchy, every limitation and workaround row, the escalation steps — is kept as written. What
changed is the plumbing: base's readers for a ticket, an epic or a page, base's Shopify Dev MCP
server with `learn_shopify_api` first, Jira writes after approval only (a new ticket through base's
Atlassian MCP, a field of an existing one through `base:jira-writer`),
the task workspace when a ticket key is in play, the "connected tools" host list reduced to base's
servers, and cross-references kept only to skills that landed in be. The skills now live here.

## 3. How base is required

`"dependencies": ["base"]` is the whole declaration. Each load from a folder the developer owns lays
the contract of every plugin the manifest reaches through `dependencies`, transitively, into
`.claude-plugin/types/<plugin>/index.d.ts`: base's and, through base, slim's. be's own contract never
redeclares their keys.

At run time be checks for base itself: the engine does not install a dependency, and nothing fails
loudly without it. `session.ts` looks for a command whose `plugin` is `base` in `$.command.list()`.
Absent → one toast and one `install` line; a listing that fails says nothing.

## 4. The hooks module

`register.ts` calls one register function per file. Each file declares its own atoms and spells its
own env names: the engine's validator follows `$` only into functions declared in the same file, never
across an import, so `doctor.ts` repeats `diskOf` and the base lookup rather than importing them.

| File | Hooks | Writes |
|---|---|---|
| `session.ts` | `session.start {cwd:/^/}` start line, base check · `prompt.compose`: the `root` section (id `be:<name>`) · `classic.SubagentStart`: the root line as `additionalContext` | `be.started`, `be.events` |
| `doctor.ts` | `session.start {cwd:/$/}` + `prompt.submit`: register `/be-doctor` (every start, and a new session id) · `command.run be-doctor` (passes `--log-dir` to `doctor.cjs`) | `be.armed`, `be.events` |

Pure helpers carry no `$`: `events.ts` (the 200-line cap and the `be.jsonl` writer),
`conventions/text.ts` (the root line and the agents that get no context).

## 5. The atoms

`types/index.d.ts` declares `be: { … }` only. Any plugin reads a be atom; be alone writes it.

- **`be.events`** — `{ atMs, kind, text }`, oldest first, at most 200; kinds `start`, `install`,
  `doctor` (9 cells at most). `BE_EVENT_LOG=0` keeps it empty.
- **`be.started`**, **`be.armed`** — the session id whose start line and base check ran, and whose
  `/be-doctor` is registered: a module reload repeats neither the line nor the check.

## 6. The file log

Every line pushed to `be.events` also goes to `events.ts`'s `logLine` with a `Disk` the writing file
builds from its own `$`: `<log dir>/<session-id>/be.jsonl`, `plugin` the literal `be`, `version` from
be's own manifest, the start line first in each session's file and never twice, the session's lines
kept module-local and seeded from the file after a reload, every write behind one queue, at most 2000
lines or 256 KB, never a throw into a hook, one toast per session on the first failed write. The log
directory is `DOMAINE_LOG_DIR` when absolute, else `$HOME/.claude/domaine/log`; neither, no file. be
never sweeps: base owns the clean-up of old session folders.

## 7. The doctor

`scripts/doctor.cjs` answers what a node process can see (node, manifest, the scripts' exec bits and
parse, base installed, base's installed manifest declaring `shopify-dev-mcp`, `be.jsonl`); `/be-doctor`
adds `base-live` and `slim-live` and turns a static `base` FAIL into a WARN when the session loaded base
anyway (a `--plugin-dir` load has no install record). It only reports, never repairs.

## 8. The tests

- `plugins/be/hooks/mods/tests/*.test.ts` — the module under `claude plugin test`: the start line and
  base check, the section and the subagent context, the doctor command, `be.jsonl`.
- `tests/be-doctor-sim.sh` — every `doctor.cjs` row PASS / FAIL / SKIP / WARN on sandbox installs,
  `--help`, the exit codes, no secret in the output.
- `tests/be-shopify-docs-sim.sh` — `shopify-docs.cjs` against a local http stub: an answer, the cap, a
  timeout, soft errors, a refused connection, usage.
- `tests/team-refs-lint.sh` — every qualified name and cited path resolves against be and base, no fnd
  name is left, and no skill names another team plugin's.
