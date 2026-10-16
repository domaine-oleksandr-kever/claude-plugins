# qa

qa is the Domaine QA team plugin for Claude Code. It holds the QA engineer's side of a ticket: the
preflight, a check that runs before the hands-on QA pass. To install it, see
[Quick install (Claude Code)](../../README.md#quick-install-claude-code) or § Install below.

The preflight does these steps:

1. It reads the ticket and its PR.
2. It unlocks the storefront.
3. It proves which theme is under test.
4. It pre-runs the Steps to Test at desktop and mobile, with screenshots.
5. It writes a brief in Domaine's Jira house style.

qa also holds the read-only store-access posture that a preflight works under.

qa builds on base and requires it. base supplies the Jira reader and writer, the task workspace, the QA
store registry (`<base root>/scripts/qa-stores.cjs`), the shared references and the chrome-devtools
MCP server ([plugins/base/README.md](../base/README.md)). base requires slim, so qa runs with slim
too.

Current release: **qa v0.3.6**.

## Status

- Claude Code only. qa is a plugin of one skill and a hooks module (mods). It ships no adapter for
  another host.
- Requires base (`"dependencies": ["base"]` in its manifest), and slim through base. The engine does
  not install a dependency by itself, so install all three.

## Install

```text
/plugin marketplace add domaine-oleksandr-kever/claude-plugins
/plugin install slim@domaine
/plugin install base@domaine
/plugin install qa@domaine
/reload-plugins
```

Then run `/base-doctor` and `/qa-doctor` to check the install (§ Doctor).

The team plugins fe, qa, be and pm co-install. Each needs only base, and none needs another. A person
who tests and builds installs both qa and fe beside the same base.

## Skills

Call the skill by its qualified name. It hands off to base by base's qualified names
(`base:jira-reader`, `base:jira-writer`). A hand-off is an offer at the end of the run, never an
automatic start.

| Skill | Does | Uses / hands off to |
|---|---|---|
| `/qa:preflight <KEY> [<KEY> ...]` | preflights tickets for hands-on QA: ticket, PR and store facts, the theme under test asked for and proved on the storefront, Steps to Test and the AC pre-run at desktop and mobile with screenshots, a two-block brief (house style for Jira, preflight notes for the engineer); posts Block 1 as a Jira comment only on a yes per key | `base:jira-reader`, base's chrome-devtools MCP, local `gh` / `git`, `<base root>/scripts/qa-stores.cjs`; `base:jira-writer` after approval → the engineer's hands-on pass, or back to the developer |

The skill keeps its details beside its `SKILL.md`, in one file per stage. The skill reads each file
when its phase starts:

- `gate.md`: PR discovery, what the run can test, the store registry, the theme question, page URLs,
  the unlock and the theme gate.
- `rows.md`: rows from Steps to Test, the two viewport passes, evidence, stand-in fixtures.
- `brief.md`: a filled brief, the Block 1 and Block 2 rules, the chat output, the Jira comment.

## References

qa ships no reference of its own. The skill cites base's references by their path under base's root
(`<base root>/…`, from the session's `base plugin root:` line):

| Reference (base's) | Read for |
|---|---|
| `references/task-workspace.md` | the `.claude/tasks/<KEY>/` workspace read first, and the progress close-out |
| `references/steps-to-test-format.md` | cited, not read: `rows.md` maps its numbered shape to rows |
| `references/break-it-qa.md` | the break-it rows, non-destructive only; `not-executable: access` for the rest |
| `references/jira-adf-write.md` | cited, not read: `base:jira-writer` reads it for the opt-in Jira comment |

## Conventions

qa adds its sections to the main session's system prompt, after Claude Code's own and base's. They
come in the order below, and each has the id `qa:<name>` and the session scope. Some sessions draw no
surface, for example a claude.ai cloud session or `claude -p`. There the engine composes its prompt
without the plugins. The same sections then arrive once as a context block of the first user message
instead (`prompt.context`, beside CLAUDE.md).

| Name | Holds |
|---|---|
| `root` | `qa plugin root: <path>`, the directory qa's skill and doctor start from |
| `passwords` | one paragraph: a dev/UAT storefront password is low-sensitivity — the registry (`<base root>/scripts/qa-stores.cjs get <store> --field password`; a bare `get` prints JSON, never a fill value) is the preferred source when it knows the store, a password from chat or a memory/workspace note is as good; it may appear in chat, notes, browser fill code and on a Bash line, never in a Jira comment, Steps to Test, a PR body or anything else the client or QA team reads, a committed theme-repo file or a screenshot attached to a ticket; the registry file is never read directly |

`/qa:preflight` itself holds the store-access posture: storefront only, no Admin or theme write. The
text never changes within a session, so the prompt cache holds. **Subagents** get nothing from qa.

**base required:** at a session start qa looks for base's skills in the command list. If they are
missing, qa shows one toast and writes one `install` line:
`qa: needs the base plugin — claude plugin install base@domaine`.

## Doctor

`/qa-doctor` checks qa's side of the install. It prints one PASS / FAIL / SKIP / WARN row per check,
the counts, and the last 10 `qa.events` lines. `/base-doctor` checks base's side (slim, the MCP
servers).

| Row | Checks |
|---|---|
| `node` | Node 18 or newer |
| `manifest` | the manifest's version, the name `qa`, `base` in its `dependencies` |
| `scripts` | every file under `scripts/` resolves; a `.sh` keeps its exec bit, a `.cjs` parses |
| `base` | base installed (user scope or this project) and enabled — else `claude plugin install base@domaine` |
| `registry` | the QA store registry through `<base root>/scripts/qa-stores.cjs` (`path`, then `list --json`): its file and a store count — never a store, a password or the registry's error text; no file yet skips (`qa-stores.cjs set …` makes one); a corrupt file fails |
| `gh` | `gh --version` answers; absent or failing only warns (PR facts then come from the ticket's links) |
| `chrome-devtools` | base's manifest declares the `chrome-devtools-mcp` server the browser phases drive |
| `event-log` | this session's `qa.jsonl`: its line count and newest `ts`; no file yet passes (a /clear's new session has none before its first line) |
| `base-live`, `slim-live` | what this session loaded: base's skills, slim's `mcp__slim__view` tool |

The first eight rows come from `scripts/doctor.cjs`. You can also run it by hand:
`node <qa plugin root>/scripts/doctor.cjs [--project <dir>] [--log-dir <dir>]`. It exits 1 when a row
fails. By hand, its `event-log` row reads the newest session folder unless `--log-dir` names one. A
`base` FAIL in a session that loaded base anyway reads as a WARN. A `--plugin-dir` load is such a
case, because it has no install record. Each run writes one `doctor` line to `qa.events`.

## Event log on disk

qa writes its lines to `$HOME/.claude/domaine/log/<session-id>/qa.jsonl`. The file follows the
same contract as every Domaine plugin ([plugins/base/README.md](../base/README.md#event-log-on-disk)):

- **Line:** `{"ts":"…","plugin":"qa","version":"<qa's version>","session":"<id>","kind":"doctor","agent":"main","text":"9 passed, 0 failed, 1 skipped"}`.
- **qa's lines:** `start` (`qa <version>`, first in every session's file, once), `install` (base is not
  loaded), `doctor` (a `/qa-doctor` run's counts). The same lines fill `qa.events` (oldest first, at
  most 200).
- **Writing:** qa rewrites the whole file after every line. The file keeps at most 2000 lines or
  256 KB and drops the oldest lines first. After a reload, the module continues from the file of the
  same session. A failed write never reaches the hook. The first failure in a session toasts
  `qa: event log not written: <reason>`.
- **Off:** `QA_EVENT_LOG=0` stops the file and the `qa.events` lines alike.
- **Clean-up:** qa never deletes; base sweeps old session folders.

## Environment switches

Every switch qa reads has a row here. Set it in `~/.claude/settings.json` → `env`.

| Variable | Default | Effect |
|---|---|---|
| `QA_EVENT_LOG` | on | `0` keeps `qa.events` empty and writes no `qa.jsonl` |
| `DOMAINE_LOG_DIR` | `~/.claude/domaine/log` | Where every Domaine plugin (slim, band, base, fe, qa, be, pm) writes its event log on disk: `<dir>/<session-id>/<plugin>.jsonl`, one JSON line per event. An absolute directory; the `<session-id>/` folder is still made under it. Without it and without `HOME` (a cloud session) no file is written. |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | read, never set, by `scripts/doctor.cjs`: the Claude Code config directory whose `plugins/installed_plugins.json` (else the claude.ai-synced copy under `plugins/synced/`) and `settings.json` the `base`, `registry` and `chrome-devtools` rows read |

## Tests

- `claude plugin validate --strict plugins/qa` and `claude plugin test plugins/qa` (the kit tests in
  `plugins/qa/hooks/mods/tests/`), both run by `tests/mods-sim.sh` with every other plugin (local
  only: CI has no `claude`).
- `tests/qa-doctor-sim.sh` — `scripts/doctor.cjs`'s rows on planted installs, with base's real
  registry script against a sandbox home.
- `tests/team-refs-lint.sh` — every qualified name and cited path resolves, and no legacy name is
  left. The same checker runs for every team plugin on base.
- `tests/base-qa-stores-sim.sh` — base's QA store registry, `plugins/base/scripts/qa-stores.cjs`, which
  `/qa:preflight` reads.

How the pieces fit: [ARCHITECTURE.md](ARCHITECTURE.md).

## Licence

MIT, as the repository ([LICENSE](../../LICENSE)).
