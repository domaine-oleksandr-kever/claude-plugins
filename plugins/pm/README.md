# pm

pm is the Domaine project-management plugin for Claude Code. It holds the work of the solutions
engineers and project managers before and around a build. To install it, see
[Quick install (Claude Code)](../../README.md#quick-install-claude-code) or § Install below.

pm covers these tasks:

- project estimators and PCRs;
- the pre-submission review of an estimate;
- the merchant solutions brief;
- scoping and implementation planning, with LOE baselines and the merchant handoff;
- vendor evaluation.

The skills are imported from Domaine's `domaine-skills-solutions` repository (commit 3c96617, 2026-08-03) and adapted to Claude Code and base; update them here, not there.

pm builds on base and requires it. base supplies the Jira and doc readers, the Jira writer, the task
workspace and the shared MCP servers: Atlassian, Notion, Shopify Dev
([plugins/base/README.md](../base/README.md)). base requires slim, so pm runs with slim too.

Current release: **pm v0.3.0**.

## Status

- Claude Code only. pm is a plugin of skills, references and a hooks module (mods). It ships no
  adapter for another host.
- Requires base (`"dependencies": ["base"]` in its manifest), and slim through base. The engine does
  not install a dependency by itself, so install all three.

## Install

```text
/plugin marketplace add domaine-oleksandr-kever/claude-plugins
/plugin install slim@domaine
/plugin install band@domaine
/plugin install base@domaine
/plugin install pm@domaine
/reload-plugins
```

Then run `/base-doctor` and `/pm-doctor` to check the install (§ Doctor).

The team plugins fe, qa, be and pm co-install. Each depends on base only, and none needs another.
Install the ones your work needs beside base.

## Skills

Call the skills by their qualified names (`/pm:<skill>`). They hand off to base's agents by base's
qualified names (`base:jira-reader`, `base:doc-reader`, `base:jira-writer`). A hand-off is an offer at
the end of the run, never an automatic start. Nothing is written to Jira, Confluence or Notion without
your approval of the exact text.

| Skill | Does | Uses / hands off to |
|---|---|---|
| `/pm:project-estimator` | Domaine-style estimators, PCRs, LOE breakdowns, line items, key assumptions, out-of-scope lists and header content, in single-item, spreadsheet or full-estimator mode | `base:jira-reader`, `base:doc-reader`; a Google Drive tool when the session has one → `/pm:estimator-review` |
| `/pm:estimator-review` | read-only pre-submission review of an estimate against the SE checklist: findings per category, a prioritized fix list, the verdict; never a pricing verdict | the workbook from a Google Drive tool, a local `.xlsx` or a pasted export; Bluedot and Slack tools when present; base's notion MCP → `/pm:project-estimator` |
| `/pm:merchant-brief` | a merchant's requirements as a solutions brief: approach, effort, risk, LOE, timeline, risks, next steps | `base:jira-reader`, `base:doc-reader`, base's Shopify Dev MCP; after approval base's Atlassian or notion MCP and `base:jira-writer` |
| `/pm:solutions-engineering` | requirement scoping and the approach table, the implementation plan and merchant handoff from their templates, LOE from the worksheet, escalation paths; limitations go to the Dev MCP | `base:jira-reader`, `base:doc-reader`, base's Shopify Dev MCP → `/pm:project-estimator`, `/pm:estimator-review`, `/pm:vendor-evaluation` |
| `/pm:vendor-evaluation` | compares apps, platforms, agencies or vendors for a merchant use case, Domaine partners first when they fit | base's notion MCP (the Partnerships Database), WebSearch and WebFetch when present |

A skill can name a tool that this session may not have: Google Drive, Bluedot, Slack, a Python
`openpyxl`, web search. Such a tool is never a hard dependency. The skill then asks for a pasted
export, or it skips the source and says so.

## References

The skills cite pm's own files by their path under pm's root (`<pm root>/…`, from the session's
`pm plugin root:` line). They cite base's files by their path under base's root (`<base root>/…`).

| Reference | Read by | Holds |
|---|---|---|
| `references/loe-worksheet.md` | `/pm:project-estimator`, `/pm:solutions-engineering`, `/pm:merchant-brief`, `/pm:estimator-review` | pm's one set of LOE baselines (S / M / L by component type), sizing factors, buffers (QA only without a QA column), an example estimate |
| `references/implementation-plan-template.md` | `/pm:project-estimator`, `/pm:solutions-engineering` | the implementation plan for a Shopify engagement |
| `skills/project-estimator/references/estimator-style-notes.md` | `/pm:project-estimator` | estimator syntax and the archetype cues (migration, B2B, custom app / PCR) |
| `skills/project-estimator/references/artifact-templates.md` | `/pm:project-estimator` | the key assumptions, out-of-scope, front-page and section-blurb shapes |
| `skills/estimator-review/references/pre-submission-checklist.md` | `/pm:estimator-review`, `/pm:project-estimator` | the five-category checklist synced from Notion, one row per item: priority and how to check it against the workbook |
| `skills/estimator-review/references/estimator-structure.md` | `/pm:estimator-review` | the workbook's tabs, columns and variant tags |
| `skills/estimator-review/references/complexity-framework.md` | `/pm:estimator-review`, `/pm:project-estimator` | Low / Medium / High by risk, and the three-question screen |
| `skills/estimator-review/references/baseline-comparison.md` | `/pm:estimator-review` | when and how to compare against a Drive baseline estimator |
| `skills/solutions-engineering/references/handoff-template.md` | `/pm:solutions-engineering` | the merchant handoff document |
| `<base root>/references/task-workspace.md` (base's) | `/pm:project-estimator`, `/pm:merchant-brief`, `/pm:solutions-engineering` | the task workspace a ticket's work is saved to |
| `<base root>/references/jira-adf-write.md` (base's) | `/pm:merchant-brief` | how an approved ticket description is converted to ADF before it reaches Jira |

## Conventions

pm's one line, `pm plugin root: <path>` (the directory pm's references start from), reaches the model
through one channel on every login: a Claude Code command hook, `node hooks/conventions.cjs start`, on
`SessionStart` with the matcher `startup|clear|compact` (`hooks/hooks.json`, beside the hooks module). A
resume or a fork keeps the copy the transcript already holds. The context arrives with the first user
message, after CLAUDE.md. The text lives in one file, `hooks/conventions-text.json`; the hook fills in
pm's root. The envelope stays well under the host's ~10,000-character inline limit (a larger one is
spilled to a file).

The hook writes a marker, `<log dir>/<session-id>/conventions.pm.json`: `via`, `event`, `source`, the
`sections` it sent, `chars` and the `login` (`work`, `personal` or `unknown`, read from the login file;
doctor evidence only). `/base-doctor`'s `conventions` row reads it.
Where the log folder is missing or not writable, the marker goes to the spare folder
`<TMPDIR or /tmp>/domaine-log/<session-id>/`; the fallback below looks in both.

**Cloud fallback.** A session that no surface draws (a claude.ai cloud session, `claude -p`) and that has
no marker gets the same text from pm's hooks module instead: one context block of the first user
message (`prompt.context`, beside CLAUDE.md), read from the same file.

**Subagents** get the same line as added context at their start, through a second command hook,
`node hooks/conventions.cjs subagent` on `SubagentStart`: the main session's context does not reach a
subagent. Some agents get nothing from pm: base's readers and writer (`base:jira-reader`,
`base:jira-writer`, `base:figma-reader`, `base:doc-reader`), Claude Code's `claude-code-guide` and
`statusline-setup`, and a fork (it inherits the transcript).

**base required:** at a session start pm looks for base's skills in the command list. If they are
missing, pm shows one toast and writes one `install` line:
`pm: needs the base plugin — claude plugin install base@domaine`.

## Doctor

`/pm-doctor` checks pm's side of the install. It prints one PASS / FAIL / SKIP / WARN row per check,
the counts, and the last 10 `pm.events` lines. `/base-doctor` checks base's side (slim, the MCP
servers).

| Row | Checks |
|---|---|
| `node` | Node 18 or newer |
| `manifest` | the manifest's version, the name `pm`, `base` in its `dependencies` |
| `scripts` | every `scripts/*.cjs` parses; every `scripts/*.sh` but a sourced `_*.sh` keeps its exec bit and answers `--help` |
| `base` | base installed (user scope or this project) and enabled — else `claude plugin install base@domaine` |
| `atlassian`, `notion-mcp` | base's manifest, read at its install path, declares the server pm's skills reach Jira, Confluence and Notion through; skipped when base is not installed and enabled, failed when its manifest is unreadable |
| `event-log` | this session's `pm.jsonl`: its line count and newest `ts`; no file yet passes (a /clear's new session has none before its first line) |
| `base-live`, `slim-live` | what this session loaded: base's skills, slim's `mcp__slim__view` tool |

The first seven rows come from `scripts/doctor.cjs`. You can also run it by hand:
`node <pm plugin root>/scripts/doctor.cjs [--project <dir>] [--log-dir <dir>]`. It exits 1 when a row
fails. By hand, its `event-log` row reads the newest session folder unless `--log-dir` names one. A
static `base` FAIL for a base that the session loaded anyway (a `--plugin-dir` load) reads as a WARN
in `/pm-doctor`. Each run writes one `doctor` line to `pm.events`.

## Event log on disk

pm writes its lines to `$HOME/.claude/domaine/log/<session-id>/pm.jsonl`. The file follows the
same contract as every Domaine plugin ([plugins/base/README.md](../base/README.md#event-log-on-disk)):

- **Line:** `{"ts":"…","plugin":"pm","version":"<pm's version>","session":"<id>","kind":"doctor","agent":"main","text":"9 passed, 0 failed, 0 skipped"}`.
- **pm's lines:** `start` (`pm <version>`, first in every session's file, once), `install` (base is not
  loaded), `doctor` (a `/pm-doctor` run's counts). The same lines fill `pm.events` (oldest first, at
  most 200).
- **Writing:** pm rewrites the whole file after every line. The file keeps at most 2000 lines or
  256 KB and drops the oldest lines first. After a reload, the module continues from the file of the
  same session. A failed write never reaches the hook. The first failure in a session toasts
  `pm: event log not written: <reason>`.
- **Off:** `PM_EVENT_LOG=0` stops the file and the `pm.events` lines alike.
- **Clean-up:** pm never deletes; base sweeps old session folders.

## Environment switches

Every switch pm reads has a row here. Set it in `~/.claude/settings.json` → `env`.

| Variable | Default | Effect |
|---|---|---|
| `PM_EVENT_LOG` | on | `0` keeps `pm.events` empty and writes no `pm.jsonl` |
| `DOMAINE_LOG_DIR` | `~/.claude/domaine/log` | Where every Domaine plugin (slim, band, base, fe, qa, be, pm) writes its event log on disk: `<dir>/<session-id>/<plugin>.jsonl`, one JSON line per event. An absolute directory; the `<session-id>/` folder is still made under it. Without it and without `HOME` (a cloud session) no file is written. The `hooks/conventions.cjs` command hook writes its marker `conventions.pm.json` there too. |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | read, never set, by `scripts/doctor.cjs`: the Claude Code config directory whose `plugins/installed_plugins.json` (else the claude.ai-synced copy under `plugins/synced/`) and `settings.json` the `base`, `atlassian` and `notion-mcp` rows read; by the `hooks/conventions.cjs` command hook: the login file it labels in its marker (`<dir>/.claude.json`, or `~/.claude.json` for the default directory) |
| `TMPDIR` | `/tmp` | read, never set, by the `hooks/conventions.cjs` command hook and the hooks module: `<dir>/domaine-log/<session-id>/` is the spare folder of the marker where the log folder is missing or not writable |
| `CLAUDE_PLUGIN_ROOT` | set by Claude Code | read, never set, by the `hooks/conventions.cjs` command hook: pm's root, filled into the root line (the script's own parent directory when unset) |

## Tests

- `claude plugin validate --strict plugins/pm` and `claude plugin test plugins/pm` (the kit tests in
  `plugins/pm/hooks/mods/tests/`), both run by `tests/mods-sim.sh` with every other plugin (local
  only: CI has no `claude`).
- `tests/hooks-sim.sh`, block "Domaine command hooks" (`DHt*`) — `hooks/conventions.cjs` run as the host
  runs it: the envelope, the marker, bad stdin, an unwritable or moved log dir, the login label, the
  subagent share per agent type, the text file.
- `tests/pm-doctor-sim.sh` — `scripts/doctor.cjs`'s rows on planted installs.
- `tests/team-refs-lint.sh` — every qualified name and cited path resolves, and no legacy name is
  left. The same checker runs for every team plugin on base.

How the pieces fit: [ARCHITECTURE.md](ARCHITECTURE.md).

## Licence

MIT, as the repository ([LICENSE](../../LICENSE)).
