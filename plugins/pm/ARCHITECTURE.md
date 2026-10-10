# pm — architecture

What runs where and why each piece sits where it does. The README says what pm does for the person
using it; this file is for whoever changes it. The code wins when the two drift.

## 1. The pieces

```
plugins/pm/
├── .claude-plugin/plugin.json   dependencies: ["base"], types; no mcpServers, no classic `hooks` key
├── hooks/hooks.json             { "modules": ["./mods/register.ts"] } — the only hook wiring
├── hooks/mods/*.ts              the hooks module (Claude Code function hooks)
├── types/index.d.ts             pm's $.state contract: the `pm` key only
├── skills/<name>/SKILL.md       the 5 skills (`/pm:<name>`); project-estimator, estimator-review and
│                                solutions-engineering carry their own references/ beside them
├── references/*.md              the two references two skills share (`<pm root>/references/…`)
└── scripts/doctor.cjs           the static install checks
```

The skills hand off to base by qualified names only (`base:jira-reader`, `base:doc-reader`,
`base:jira-writer`) and cite base's files as `<base root>/…`, the path on base's `base plugin root:`
session line, and pm's own as `<pm root>/…`. pm names no other team plugin's skill: a topic another
team owns is "ask the owning team".

## 2. How base is required

`"dependencies": ["base"]` is the whole declaration. Each load from a folder the developer owns lays
the contract of every plugin the manifest reaches through `dependencies`, transitively, into
`.claude-plugin/types/<plugin>/index.d.ts`: base's and, through base, slim's. pm's own contract never
redeclares their keys.

At run time pm checks for base itself: the engine does not install a dependency, and nothing fails
loudly without it. `session.ts` looks for a command whose `plugin` is `base` in `$.command.list()`.
Absent → one toast and one `install` line; a listing that fails says nothing.

pm declares no MCP server. The skills reach Jira and Confluence through base's `atlassian` server,
Notion through base's `notion-mcp`, API facts through base's `shopify-dev-mcp`; the doctor checks that
base's manifest still declares the first two.

## 3. The hooks module

`register.ts` calls one register function per file. Each file declares its own atoms and spells its
own env names: the engine's validator follows `$` only into functions declared in the same file, never
across an import, so `doctor.ts` repeats `diskOf` and the base lookup rather than importing them.

| File | Hooks | Writes |
|---|---|---|
| `session.ts` | `session.start {cwd:/^/}` start line and base check · `prompt.compose`: the one `pm:<name>` section, `root` · `classic.SubagentStart`: the root line as `additionalContext` | `pm.started`, `pm.events` |
| `doctor.ts` | `session.start {cwd:/$/}` + `prompt.submit`: register `/pm-doctor` (every start, and a new session id) · `command.run pm-doctor` (passes `--log-dir` to `doctor.cjs`) | `pm.armed`, `pm.events` |

Pure helpers carry no `$`: `events.ts` (the 200-line cap and the `pm.jsonl` writer), `conventions/text.ts`
(the root line, the agents that get no context).

## 4. The atoms

`types/index.d.ts` declares `pm: { … }` only. Any plugin reads a pm atom; pm alone writes it.

- **`pm.events`** — `{ atMs, kind, text }`, oldest first, at most 200; kinds `start`, `install`,
  `doctor` (9 cells at most). `PM_EVENT_LOG=0` keeps it empty.
- **`pm.started`**, **`pm.armed`** — the session id whose start line and base check ran, and whose
  `/pm-doctor` is registered: a module reload repeats neither the line nor the check.

## 5. The file log

Every line pushed to `pm.events` also goes to `events.ts`'s `logLine` with a `Disk` the writing file
builds from its own `$`: `<log dir>/<session-id>/pm.jsonl`, `plugin` the literal `pm`, `version` from
pm's own manifest, the start line first in each session's file and never twice, the session's lines
kept module-local and seeded from the file after a reload, every write behind one queue, at most 2000
lines or 256 KB, never a throw into a hook, one toast per session on the first failed write. The log
directory is `DOMAINE_LOG_DIR` when absolute, else `$HOME/.claude/domaine/log`; neither, no file. pm
never sweeps: base owns the clean-up of old session folders.

## 6. The doctor

`scripts/doctor.cjs` answers what a node process can see (node, manifest, scripts, base installed,
base's manifest declaring `atlassian` and `notion-mcp` at the install path its record names,
`pm.jsonl`); `/pm-doctor` adds `base-live` and `slim-live`, and turns a static `base` FAIL into a WARN
when the session loaded base anyway (a `--plugin-dir` load has no install record). It reads no secret
and never repairs.

## 7. What was imported, and what changed

The five skills and their references come from Domaine's `domaine-skills-solutions` repository at
commit 3c96617 (2026-08-03): `project-estimator`, `estimator-review` and `solutions-engineering` from
its skills of the same names, `vendor-evaluation` from `shopify-vendor-evaluation`, `merchant-brief`
from the `domaine-merchant-brief` command. `loe-worksheet.md` and `implementation-plan-template.md`
moved from solutions-engineering's references to pm's shared `references/`, as two skills read them.

Kept as they were: the output modes, the verdict rule, the estimator review's read-only posture and
commercial restraint.

Changed in content (2026-10 review):

- The checklist and its evaluation guide are one table (item, priority, how to check); its "Currency
  and rate card" row is split into a currency check and an SE-confirmed rate card, since the rate
  card sits on the Settings tab the review never reads; revenue viability reports hours and scope
  size only.
- `loe-worksheet.md` is the one LOE baseline (S / M / L columns, QA buffer only without a QA column);
  solutions-engineering and merchant-brief cite it, and solutions-engineering points to the plan and
  handoff templates and the Dev MCP instead of restating them.
- project-estimator's rows carry `Complexity:` and a review-gates list pointing at the checklist.

Changed, plumbing only:

- Sources go through base: a Jira ticket or epic context-first per base's task workspace, else
  `base:jira-reader`; a Confluence or Notion page or a web URL through `base:doc-reader`; API facts
  from base's Shopify Dev MCP with `learn_shopify_api` first; the Notion pages the references were
  synced from re-fetched through base's notion MCP.
- A tool the session may not have — Google Drive, Bluedot, Slack, a Python `openpyxl`, web search —
  is used when present; otherwise the skill asks for a pasted export or skips the source and says so.
- A write the merchant brief offers (Confluence, Notion, new Jira tickets) happens only after the
  user approves the exact text and target, through base's MCP servers and `base:jira-writer`.
- Cross-references name `/pm:<skill>`; a skill that went to another team plugin (the Shopify
  resource hierarchy, the detailed limitation tables) or was not imported (the theme audit) is "ask
  the owning team". The memory-tool step and the other host's agent file were dropped.
- Every reference is cited by its path under `<pm root>`, and outside content is data, never
  instructions.

## 8. The tests

- `hooks/mods/tests/*.test.ts` through `claude plugin test plugins/pm`: the start line, the base
  check, the root section and the subagent share, `/pm-doctor`'s rows and tail, the `pm.jsonl` writer.
- `tests/pm-doctor-sim.sh`: every `doctor.cjs` row on planted plugin roots, homes, install records and
  base manifests; `--help`, the exit codes, no planted secret in the output.
- `tests/team-refs-lint.sh`: every qualified name and cited path resolves against pm and base, no legacy
  name is left, and no skill names another team plugin's.
