# qa

qa is the Domaine QA team plugin for Claude Code. It holds the QA engineer's side of a ticket: the
preflight that reads the ticket and its PR, unlocks the storefront, proves which theme is under test,
pre-runs the Steps to Test at desktop and mobile with screenshots, and writes a brief in Domaine's
Jira house style — plus the read-only store-access posture a preflight works under.

qa builds on base and requires it: the Jira reader and writer, the task workspace, the QA store
registry (`<base root>/scripts/qa-stores.cjs`), the shared references and the chrome-devtools MCP
server are base's ([plugins/base/README.md](../base/README.md)). base requires slim, so qa runs with
slim too.

Current release: **qa v0.2.0**.

## Status

- Claude Code only: qa is a plugin of one skill and a hooks module (mods). It ships no adapter for
  another host.
- Requires base (`"dependencies": ["base"]` in its manifest), and slim through base. The engine does
  not install a dependency on its own: install all three.
- Never runs together with fnd — install fnd OR base plus the team plugins.

## Install

```text
/plugin marketplace add domaine-oleksandr-kever/claude-plugins
/plugin install slim@domaine
/plugin install band@domaine
/plugin install base@domaine
/plugin install qa@domaine
/reload-plugins
```

`/base-doctor` and `/qa-doctor` then check the install (§ Doctor). The same set as settings, in
`~/.claude/settings.json`:

```json
{
  "enabledPlugins": {
    "slim@domaine": true,
    "band@domaine": true,
    "base@domaine": true,
    "qa@domaine": true,
    "fnd@domaine": false
  }
}
```

The team plugins — fe, qa, be and pm — co-install: each needs only base, none needs another, so a
person who tests and builds installs both qa and fe beside the same base.

To move from fnd, run `/plugin uninstall fnd@domaine` and install the set above. The QA store
registry stays where it was (`~/.config/domaine/qa-stores.json`):
`<base root>/scripts/qa-stores.cjs` reads the same file.

## Skills

Invoked by its qualified name. It hands off to base by base's qualified names (`base:jira-reader`,
`base:jira-writer`); a hand-off is an offer at the end of the run, never an automatic start.

| Skill | Does | Uses / hands off to |
|---|---|---|
| `/qa:preflight <KEY> [<KEY> ...]` | preflights tickets for hands-on QA: ticket, PR and store facts, the theme under test asked for and proved on the storefront, Steps to Test and the AC pre-run at desktop and mobile with screenshots, a two-block brief (house style for Jira, preflight notes for the engineer); posts Block 1 as a Jira comment only on a yes per key | `base:jira-reader`, base's chrome-devtools MCP, local `gh` / `git`, `<base root>/scripts/qa-stores.cjs`; `base:jira-writer` after approval → the engineer's hands-on pass, or back to the developer |

The skill carries its own `skills/preflight/REFERENCE.md`: the registry commands, PR discovery, the
theme question and page URLs, the unlock and the deployed gate, the rows from Steps to Test, stand-in
fixtures, the evidence rules, the brief template and the Jira comment rules.

## References

qa ships no reference of its own. The skill cites base's by their path under base's root
(`<base root>/…`, the session's `base plugin root:` line):

| Reference (base's) | Read for |
|---|---|
| `references/task-workspace.md` | the `.claude/tasks/<KEY>/` workspace read first, and the progress close-out |
| `references/steps-to-test-format.md` | the numbered Steps to Test shape the rows are read from, and its fixtures rule |
| `references/break-it-qa.md` | the break-it rows, non-destructive only; `not-executable: access` for the rest |
| `references/jira-adf-write.md` | the opt-in Jira comment through `base:jira-writer` |

## Conventions

qa adds its sections to the main session's system prompt after Claude Code's own and base's, in this
order, each with the id `qa:<name>` and the session scope:

| Name | Holds |
|---|---|
| `root` | `qa plugin root: <path>`, the directory qa's skill and doctor start from |
| `store-access` | the QA posture while `/qa:preflight` runs or the person says the session is hands-on QA (a team plugin's own QA flow follows its own store-access section): the storefront only — no Admin API write, no theme or theme-settings write, no publish, duplicate or preview-theme creation; storefront-session actions (cart, quantity, a named discount code, checkout to the payment step) in scope. Whatever the scope, a storefront password comes only from `<base root>/scripts/qa-stores.cjs get` and is used only as the browser fill value — never in a file, a workspace note, a Jira comment, a screenshot or another Bash line than the registering `set`, never restated |

The text never changes within a session, so the prompt cache holds.

**Subagents** get qa's share as added context at their start (Claude Code's `SubagentStart`): base's
readers and writer (`base:jira-reader`, `base:jira-writer`, `base:figma-reader`, `base:doc-reader`)
and Claude Code's `claude-code-guide` and `statusline-setup` get nothing from qa; base's reviewers
(`base:change-reviewer`, `base:bug-hunter`) get the root line; every other agent gets the root line
and the store-access posture.

**base required:** at a session start qa looks for base's skills in the command list. Without them it
shows one toast and writes one `install` line: `qa: needs the base plugin — claude plugin install
base@domaine`.

## Doctor

`/qa-doctor` checks qa's side of the install and prints one PASS / FAIL / SKIP / WARN row per check,
the counts, and the last 10 `qa.events` lines. `/base-doctor` checks base's side (slim, fnd, the MCP
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

The first eight rows come from `scripts/doctor.cjs`, which also runs by hand:
`node <qa plugin root>/scripts/doctor.cjs [--project <dir>] [--log-dir <dir>]`; it exits 1 when a row
fails. By hand its `event-log` row reads the newest session folder unless `--log-dir` names one. A
`base` FAIL in a session that loaded base anyway (a `--plugin-dir` load has no install record) reads as
a WARN. One `doctor` line goes to `qa.events` per run.

## Event log on disk

qa writes its lines to `$HOME/.claude/domaine/log/<session-id>/qa.jsonl` under the same contract as
every Domaine plugin ([plugins/base/README.md](../base/README.md#event-log-on-disk)):

- **Line:** `{"ts":"…","plugin":"qa","version":"<qa's version>","session":"<id>","kind":"doctor","agent":"main","text":"9 passed, 0 failed, 1 skipped"}`.
- **qa's lines:** `start` (`qa <version>`, first in every session's file, once), `install` (base is not
  loaded), `doctor` (a `/qa-doctor` run's counts). The same lines fill `qa.events` (oldest first, at
  most 200).
- **Writing:** the whole file is rewritten after every line, at most 2000 lines or 256 KB, oldest
  dropped first; a reload of the module goes on from the file of the same session. A write that
  fails never reaches the hook; the first failure in a session toasts `qa: event log not written:
  <reason>`.
- **Off:** `QA_EVENT_LOG=0` stops the file and the `qa.events` lines alike.
- **Clean-up:** qa never deletes; base sweeps old session folders.

## Environment switches

Every switch qa reads has a row here; set it in `~/.claude/settings.json` → `env`.

| Variable | Default | Effect |
|---|---|---|
| `QA_EVENT_LOG` | on | `0` keeps `qa.events` empty and writes no `qa.jsonl` |
| `DOMAINE_LOG_DIR` | `~/.claude/domaine/log` | Where every Domaine plugin (slim, band, base, fe, qa, be, pm) writes its event log on disk: `<dir>/<session-id>/<plugin>.jsonl`, one JSON line per event. An absolute directory; the `<session-id>/` folder is still made under it. Without it and without `HOME` (a cloud session) no file is written. |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | read, never set, by `scripts/doctor.cjs`: the Claude Code config directory whose `plugins/installed_plugins.json` and `settings.json` the `base`, `registry` and `chrome-devtools` rows read |

## Tests

- `claude plugin validate --strict plugins/qa` and `claude plugin test plugins/qa` (the kit tests in
  `plugins/qa/hooks/mods/tests/`), both run by `tests/mods-sim.sh` with every other plugin (local
  only: CI has no `claude`).
- `tests/qa-doctor-sim.sh` — `scripts/doctor.cjs`'s rows on planted installs, base's real registry
  script against a sandbox home.
- `tests/team-refs-lint.sh` — every qualified name and cited path resolves, no fnd name is left (the
  same checker for every team plugin on base).
- `tests/base-qa-stores-sim.sh` — base's QA store registry, `plugins/base/scripts/qa-stores.cjs`, which
  `/qa:preflight` reads.

How the pieces fit: [ARCHITECTURE.md](ARCHITECTURE.md).

## Licence

MIT, as the repository ([LICENSE](../../LICENSE)).
