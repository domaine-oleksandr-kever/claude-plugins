# be

be is the Domaine backend team plugin for Claude Code. It holds the Shopify app and extension work:
scoping an app, extension or Function build with its APIs, limitations and level of effort, finding
the right Shopify source for a question, and answering "can Shopify do X?" with the limitation, the
workaround and what to tell the merchant.

The skills are imported from Domaine's `domaine-skills-solutions` repository (commit 3c96617, 2026-08-03) and adapted to Claude Code and base; update them here, not there.

be builds on base and requires it: the Jira and doc readers, the Jira writer, the task workspace and
the shared MCP servers (Atlassian, Notion, the Shopify Dev MCP) are base's
([plugins/base/README.md](../base/README.md)). base requires slim, so be runs with slim too.

Current release: **be v0.3.1**.

## Status

- Claude Code only: be is a plugin of skills, one skill reference, a doctor script, a docs-search
  script and a hooks module (mods). It ships no adapter for another host, and
  `scripts/install.sh --plugin be` exits 2.
- Requires base (`"dependencies": ["base"]` in its manifest), and slim through base. The engine does
  not install a dependency on its own: install all three.

## Install

```text
/plugin marketplace add domaine-oleksandr-kever/claude-plugins
/plugin install slim@domaine
/plugin install band@domaine
/plugin install base@domaine
/plugin install be@domaine
/reload-plugins
```

`/base-doctor` and `/be-doctor` then check the install (§ Doctor). The same set as settings, in
`~/.claude/settings.json`:

```json
{
  "enabledPlugins": {
    "slim@domaine": true,
    "band@domaine": true,
    "base@domaine": true,
    "be@domaine": true
  }
}
```

The team plugins fe, qa, be and pm co-install beside base: add the ones your work needs, none of them
requires another.

## Skills

Invoked by their qualified names (`/be:<skill>`). They hand off to base's agents by base's qualified
names (`base:jira-reader`, `base:doc-reader`, `base:jira-writer`). A write to Jira happens only after
the user approved the text.

| Skill | Does | Uses / hands off to |
|---|---|---|
| `/be:app-scope` | scopes a Shopify app or extension build: requirements, extension types, API scopes and webhooks, limitations, an LOE table by component, the scope document, next steps | `base:jira-reader` (a ticket or epic), `base:doc-reader` (a Confluence or Notion page, a web URL), base's Shopify Dev MCP server, `/be:platform-limitations`; after approval base's Atlassian MCP creates the drafted tickets (Markdown description), `base:jira-writer` fills a field of an existing one |
| `/be:shopify-resources` | which Shopify source answers which question, in priority order: the Dev MCP, shopify.dev, the Help Center, the two communities | base's Shopify Dev MCP server, Atlassian and Notion servers through `base:jira-reader` / `base:doc-reader`; → `/be:app-scope`, `/be:platform-limitations` |
| `/be:platform-limitations` | a limitation → workaround → what to tell the merchant answer for checkout, Functions, metafields, theme, API, integration and B2B limits, the limit verified through the Dev MCP when available; it reads only the section the question names | its reference below, base's Shopify Dev MCP server |

## References

The skills cite be's own files by their path under be's root (`<be root>/…`, the session's
`be plugin root:` line) and base's by their path under base's root (`<base root>/…`).

| Reference | Read by | Holds |
|---|---|---|
| `skills/platform-limitations/references/limitation-workarounds.md` | `/be:platform-limitations` | the limitation and workaround tables by area, stamped with the Admin API version and date the rows were checked (a row the docs do not cover is marked *(unverified)*), and the escalation steps when a limit has no workaround |
| `<base root>/references/task-workspace.md` (base's) | `/be:app-scope` | the task workspace a ticket's scope is saved to |

### Scripts

| Script | Run by | Does |
|---|---|---|
| `scripts/doctor.cjs` | `/be-doctor`, or by hand | the static install checks (§ Doctor) |
| `scripts/shopify-docs.cjs` | `/be:shopify-resources`, `/be:platform-limitations` on a host with no Dev MCP wiring | one search of shopify.dev's documentation (`POST https://shopify.dev/assistant/search`, the endpoint the Dev MCP wraps): at most 4000 characters, 20 s, an `error=` line and exit 1 when it fails (`retry_after=<s>` on a 429 that names one); `--` ends the flags; it needs the same egress as the MCP server |

## Conventions

be adds one section to the main session's system prompt, after Claude Code's own and base's, with
the id `be:<name>`: `root`, the line `be plugin root: <path>` the skills resolve `<be root>` from. It
never changes within a session, so the prompt cache holds.

**Subagents** get the same line as added context at their start (Claude Code's `SubagentStart`),
except base's readers and writer (`base:jira-reader`, `base:jira-writer`, `base:figma-reader`,
`base:doc-reader`) and Claude Code's `claude-code-guide` and `statusline-setup`, which get nothing
from be.

**base required:** at a session start be looks for base's skills in the command list. Without them it
shows one toast and writes one `install` line: `be: needs the base plugin — claude plugin install
base@domaine`.

## Doctor

`/be-doctor` checks be's side of the install and prints one PASS / FAIL / SKIP / WARN row per check,
the counts, and the last 10 `be.events` lines. `/base-doctor` checks base's side (slim, the MCP servers).

| Row | Checks |
|---|---|
| `node` | Node 18 or newer |
| `manifest` | the manifest's version, the name `be`, `base` in its `dependencies` |
| `scripts` | every `scripts/*.sh` but a sourced `_*.sh` keeps its exec bit, every `scripts/*.cjs` parses |
| `base` | base installed (user scope or this project) and enabled — else `claude plugin install base@domaine` |
| `shopify-dev-mcp` | base's installed manifest declares the `shopify-dev-mcp` server the skills check API facts and limits against; skipped when base is not installed and enabled |
| `event-log` | this session's `be.jsonl`: its line count and newest `ts`; no file yet passes (a /clear's new session has none before its first line) |
| `base-live`, `slim-live` | what this session loaded: base's skills, slim's `mcp__slim__view` tool |
| `dev-mcp-live` | the Shopify Dev MCP's `learn_shopify_api` tool is in this session; WARN when it is not (the server declared but not connected): the skills then fall back to `scripts/shopify-docs.cjs` |

The first six rows come from `scripts/doctor.cjs`, which also runs by hand:
`node <be plugin root>/scripts/doctor.cjs [--project <dir>] [--log-dir <dir>]`; it exits 1 when a row
fails. By hand its `event-log` row reads the newest session folder unless `--log-dir` names one. A
static `base` FAIL for a base the session loaded anyway (a `--plugin-dir` load) reads as a WARN in
`/be-doctor`. One `doctor` line goes to `be.events` per run.

## Event log on disk

be writes its lines to `$HOME/.claude/domaine/log/<session-id>/be.jsonl` under the same contract as
every Domaine plugin ([plugins/base/README.md](../base/README.md#event-log-on-disk)):

- **Line:** `{"ts":"…","plugin":"be","version":"<be's version>","session":"<id>","kind":"doctor","agent":"main","text":"6 passed, 0 failed, 0 skipped"}`.
- **be's lines:** `start` (`be <version>`, first in every session's file, once), `install` (base is not
  loaded), `doctor` (a `/be-doctor` run's counts). The same lines fill `be.events` (oldest first, at
  most 200).
- **Writing:** the whole file is rewritten after every line, at most 2000 lines or 256 KB, oldest
  dropped first; a reload of the module goes on from the file of the same session. A write that
  fails never reaches the hook; the first failure in a session toasts `be: event log not written:
  <reason>`.
- **Off:** `BE_EVENT_LOG=0` stops the file and the `be.events` lines alike.
- **Clean-up:** be never deletes; base sweeps old session folders.

## Environment switches

Every switch be reads has a row here; set it in `~/.claude/settings.json` → `env`.

| Variable | Default | Effect |
|---|---|---|
| `BE_EVENT_LOG` | on | `0` keeps `be.events` empty and writes no `be.jsonl` |
| `DOMAINE_LOG_DIR` | `~/.claude/domaine/log` | Where every Domaine plugin (slim, band, base, fe, qa, be, pm) writes its event log on disk: `<dir>/<session-id>/<plugin>.jsonl`, one JSON line per event. An absolute directory; the `<session-id>/` folder is still made under it. Without it and without `HOME` (a cloud session) no file is written. |
| `BE_SHOPIFY_DOCS_URL` | `https://shopify.dev/assistant/search` | the endpoint `scripts/shopify-docs.cjs` posts to (tests point it at a local stub) |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | read, never set, by `scripts/doctor.cjs`: the Claude Code config directory whose `plugins/installed_plugins.json` (else the claude.ai-synced copy under `plugins/synced/`) and `settings.json` the `base` and `shopify-dev-mcp` rows read |

## Tests

- `claude plugin validate --strict plugins/be` and `claude plugin test plugins/be` (the kit tests in
  `plugins/be/hooks/mods/tests/`), both run by `tests/mods-sim.sh` with every other plugin (local
  only: CI has no `claude`).
- `tests/be-doctor-sim.sh` — `scripts/doctor.cjs`'s rows on planted installs.
- `tests/be-shopify-docs-sim.sh` — `scripts/shopify-docs.cjs` against a local stub: an answer, the cap,
  a timeout, soft errors, a refused connection, usage.
- `tests/team-refs-lint.sh` — every qualified name and cited path resolves, no legacy plugin name is left
  (the same checker for every team plugin on base).

How the pieces fit: [ARCHITECTURE.md](ARCHITECTURE.md).

## Licence

MIT, as the repository ([LICENSE](../../LICENSE)).
