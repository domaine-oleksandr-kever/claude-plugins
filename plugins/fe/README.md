# fe

fe is the Domaine frontend team plugin for Claude Code. It holds the Shopify theme work: the skills that
take a ticket from a Technical Approach to a pull request and a preview theme, the steps to test, the
breaking-changes and translation tools, the `fe:theme-explorer` agent, the project profile (Foundation,
another theme, or none) and the store-access rules.

fe builds on base and requires it: the Jira, Figma and doc readers, the Jira writer, the review agents,
the task workspace, the commit and review skills, the guards and the shared MCP servers are base's
([plugins/base/README.md](../base/README.md)). base requires slim, so fe runs with slim too.

Current release: **fe v0.3.0**.

## Status

- Claude Code only: fe is a plugin of skills, an agent, references, scripts and a hooks module (mods).
  It ships no adapter for another host, and `scripts/install.sh --plugin fe` exits 2.
- Requires base (`"dependencies": ["base"]` in its manifest), and slim through base. The engine does
  not install a dependency on its own: install all three.
- Never runs together with fnd — install fnd OR base plus fe.

## Install

```text
/plugin marketplace add domaine-oleksandr-kever/claude-plugins
/plugin install slim@domaine
/plugin install band@domaine
/plugin install base@domaine
/plugin install fe@domaine
/reload-plugins
```

`/base-doctor` and `/fe-doctor` then check the install (§ Doctor). The same set as settings, in
`~/.claude/settings.json`:

```json
{
  "enabledPlugins": {
    "slim@domaine": true,
    "band@domaine": true,
    "base@domaine": true,
    "fe@domaine": true,
    "fnd@domaine": false
  }
}
```

The team plugins fe, qa, be and pm co-install: each needs only base, and none needs another.

To move from fnd, run `/plugin uninstall fnd@domaine`, install the set above, and rename every `FND_` key fe reads to its `FE_` name (`FND_PROFILE`, `FND_GQL_PROBE_CACHE`, `FND_CPT_THROTTLE_WAITS`, `FND_CPT_OVERLAY_VERIFY`, `FND_CPT_OVERLAY_VERIFY_WAIT`, `FND_THEME_JSON_VERIFY`, `FND_THEME_JSON_VERIFY_WAIT`) in `.claude/domaine.env`, `~/.config/domaine/env` and `~/.claude/settings.json` → `env`: fe does not read the old keys.

## Skills

Invoked by their qualified names (`/fe:<skill>`). They hand off to base's skills and agents by base's
qualified names (`/base:commit`, `/base:pre-commit-review`, `base:jira-reader`, …). A hand-off is an
offer at the end of the run, never an automatic start; only `/fe:ship` runs the series by itself.

| Skill | Does | Uses / hands off to |
|---|---|---|
| `/fe:ship` | a ready ticket end to end: one interview, one plan and QA-checklist approval, then the series runs itself (implement, QA, review and commit, PR, Steps to Test) | `base:jira-reader`, `base:figma-reader`, `base:doc-reader`, `fe:theme-explorer`; offers `/base:worktree` before it starts; a missing TA → `/fe:write-technical-approach` |
| `/fe:write-technical-approach` | drafts a Technical Approach from the ticket's Description and Acceptance Criteria, then writes the field after approval | `base:jira-reader`, `base:doc-reader`, `base:jira-writer` → `/fe:develop-feature-or-fix` |
| `/fe:develop-feature-or-fix` | implements an approved Technical Approach with in-browser validation | `base:jira-reader`, `base:figma-reader`, `base:doc-reader`, `fe:theme-explorer`, `base:bug-hunter` → `/fe:qa-feature-or-fix` |
| `/fe:qa-feature-or-fix` | structured QA of a finished change against its ticket: checklist, browser checks, pass / fail report | `base:jira-reader`, `base:figma-reader`, `base:jira-writer` → `/base:pre-commit-review` (with the profile word) once every blocking check passes |
| `/fe:write-steps-to-test` | Steps to Test in Domaine's format, written to the field after approval | `base:jira-reader`, `base:doc-reader`, `base:jira-writer` → `/fe:create-pull-request` when the branch has no PR |
| `/fe:create-pull-request` | a pull request with the Domaine description and the theme-preview table | `base:jira-reader`, `base:change-reviewer`, `base:bug-hunter`, `/fe:preview-theme`'s script → `/fe:write-steps-to-test` while the field is empty |
| `/fe:preview-theme` | creates or refreshes an unpublished preview theme from the branch; in a new worktree, un-pins the copied store config first | `scripts/create-preview-theme.sh`, `scripts/worktree-theme.sh` |
| `/fe:preflight-checks` | checks the project, the tools and the dev server before work starts | → `/fe:write-technical-approach` or `/fe:develop-feature-or-fix` |
| `/fe:fix-accessibility-issue` | fixes an accessibility issue in theme components | → `/base:commit` |
| `/fe:get-breaking-changes` | lists the breaking changes merged since the last major version in `breaking-changes.md` | → `/fe:fix-breaking-changes` |
| `/fe:fix-breaking-changes` | applies the documented breaking changes to templates and settings data | its bundled script template; reads `/fe:get-breaking-changes`'s report |
| `/fe:update-translations` | translates storefront and schema strings into the theme's other languages | the project's own update-translations.js (fe ships none) |

The progress rows these skills tick in a ticket's `progress.md` are fe's `progress-series` section
(§ Conventions).

**A worktree:** `/base:worktree` makes the checkout, copies `.env` and `shopify.theme.toml` (fe's
`worktree copy list:` line) and records a dev port; then `/fe:preview-theme` in the worktree runs
`scripts/worktree-theme.sh`, which un-pins the copied config once (a worktree never inherits the
main checkout's session theme) and prints the dev-server line with that port. On the main checkout
the script answers `error=not_a_linked_worktree` and the skill goes on without it. `/fe:ship` offers
the same two steps before it starts.

fnd's `smoke-test` skill has no fe copy: `/base-doctor` and `/fe-doctor` check an install. The
`qa-preflight` skill moves to the qa plugin (`/qa:preflight`).

## Agent

| Agent | Does |
|---|---|
| `fe:theme-explorer` | read-only scout of the theme: which files, sections and snippets a change touches; the `profile` comes in its brief |

## References and scripts

The skills and the agent cite fe's own files by their path under fe's root (`<fe root>/…`, the
session's `fe plugin root:` line) and base's by their path under base's root (`<base root>/…`);
`tests/team-refs-lint.sh` checks that every cited path exists.

| Reference | Read by | Holds |
|---|---|---|
| `references/session-theme.md` | `/fe:ship`, `/fe:preview-theme`, `/fe:create-pull-request` | one preview theme per work stream: the gate, the pin into `shopify.theme.toml`, the worktree un-pin |
| `references/preview-theme-errors.md` | `/fe:preview-theme`, `/fe:create-pull-request`, `/fe:develop-feature-or-fix`, `/fe:ship` | `create-preview-theme.sh`'s `error=` outcomes, Shopify rejections and page deep-links |
| `references/theme-gotchas.md` | `/fe:develop-feature-or-fix` | Shopify theme traps that fail silently: dropped settings, presets, Liquid limits, cascade layers, browser checks |
| `references/technical-approach-format.md` | `/fe:write-technical-approach` | the short TA format |
| `references/research-pressure-test.md` | `/fe:write-technical-approach`, `/fe:develop-feature-or-fix`, `/fe:ship` | cross-checking a draft plan against fresh external sources |
| `references/metafield-metaobject-setup.md` | `/fe:develop-feature-or-fix`, `/fe:qa-feature-or-fix`, `/fe:write-technical-approach`, `/fe:ship` | inspecting, creating, mocking and binding store metafields and metaobjects |
| `references/store-auth-troubleshooting.md` | through `metafield-metaobject-setup.md` | when `shopify store auth` fails, and the re-auth blurb |
| `references/theme-customizer-state.md` | `/fe:develop-feature-or-fix`, `/fe:qa-feature-or-fix`, `/fe:write-technical-approach` | reading and driving the theme editor's state through theme JSON |
| `references/customizer-sandbox.md` | through `theme-customizer-state.md` | a disposable theme for a walk that would thrash the shared dev theme |
| `references/preflight-checklist.md` | `/fe:preflight-checks`, `/fe:develop-feature-or-fix`, `/fe:qa-feature-or-fix` | the environment checklist |
| `references/pipeline-mode.md`, `references/pipeline-phases.md` | `/fe:ship` | the run contract and the phase briefs |
| `references/eslint-no-restricted-syntax.md` | `/fe:develop-feature-or-fix`, `/fe:fix-accessibility-issue`, `/fe:ship` | Foundation only: state through `data-*` attributes, not `classList` / `style.*` |
| `references/section-css-variables-pattern.md` | `/fe:develop-feature-or-fix`, `/fe:ship` | Foundation only: a section that drives its blocks' sizes through CSS variables |

| Script | Run by | Does |
|---|---|---|
| `scripts/create-preview-theme.sh` | `/fe:preview-theme`, `/fe:create-pull-request`, `/fe:ship` | builds and pushes an unpublished preview theme (`create`), re-pushes one (`refresh`), pins the session theme (`pin`) |
| `scripts/session-theme.sh` | sourced by `create-preview-theme.sh`, run by `worktree-theme.sh` | the pin and un-pin grammar of `shopify.theme.toml` (`# fe:session-theme`, `# fe:superseded`; a pin fnd wrote is read too) |
| `scripts/worktree-theme.sh` | `/fe:preview-theme` in a worktree, `/fe:ship` | the Shopify half of a new worktree: the one-time un-pin and the dev-server line |
| `scripts/theme-json.sh` | the skills, through the `store-access` section | reads and writes a theme's JSON files (`templates/*.json`, `config/settings_data.json`) with a read-back check |
| `scripts/shopify-admin-gql.sh` | the skills, through the `store-access` section | one Admin GraphQL call against the project's store |
| `scripts/project-profile.sh` | fe's hooks module, `worktree-theme.sh`, the doctor, the skills' fallback | prints `foundation`, `theme` or `none` |
| `scripts/doctor.cjs` | `/fe-doctor`, or by hand | the static install checks (§ Doctor) |
| `scripts/_shopify-common.sh` | sourced by the store scripts | the shared Shopify CLI and config helpers |

`/fe:fix-breaking-changes` copies its own `skills/fix-breaking-changes/scripts/fix-breaking-changes.template.js`
into the project and removes it after the run. `/fe:write-steps-to-test` names the QA store registry,
`<base root>/scripts/qa-stores.cjs`, only to say why it does not read it.

## Conventions

fe adds its sections to the main session's system prompt after Claude Code's own and base's, in this
order, each with the id `fe:<name>`:

| Name | Holds | When |
|---|---|---|
| `root` | `fe plugin root: <path>`, the directory fe's scripts and references start from | always |
| `profile` | `fe project profile: <foundation\|theme\|none>` | always |
| `comment-discipline-foundation` | LiquidDoc on every snippet param; `src/entry/core/*` is protected; the Liquid core is hand-synced from the foundation repo, so prefer a copy | profile `foundation` |
| `store-access` | the two store runners, `scripts/shopify-admin-gql.sh` and `scripts/theme-json.sh`, with their paths under fe's root; never `Read` `.env` or `shopify.theme.toml` | the project root holds `shopify.theme.toml` or `.env` |
| `worktree` | `worktree copy list: shopify.theme.toml` (the line `/base:worktree` reads), then `/fe:preview-theme` in the new worktree | always |
| `progress-series` | the rows of a ticket's `progress.md` in order — `write-technical-approach`, `develop-feature-or-fix`, `qa-feature-or-fix`, `pre-commit-review`, `commit`, `write-steps-to-test`, `create-pull-request` — and the skill that ticks each; a batch lists its tickets, then the same tail | always |

**The profile** is decided once per session id (a `/clear` decides again): `FE_PROFILE` when it holds
one of the three words, else `scripts/project-profile.sh` on the project root, which also reads
`FE_PROFILE` from `.claude/domaine.env` or `~/.config/domaine/env` and otherwise detects
(`snippets/@*.liquid`, `sections/core-*.liquid`, `blocks/core-*.liquid` or `src/entry/core/` ⇒
`foundation`; `layout/theme.liquid` ⇒ `theme`; else `none`). A probe that fails or times out (5 s)
gives `none` and one `profile` line saying why. The sections never change within a session, so the
prompt cache holds.

**Subagents** get fe's share as added context at their start (Claude Code's `SubagentStart`; the
engine has no event for a subagent's system prompt): base's readers and writer (`base:jira-reader`,
`base:jira-writer`, `base:figma-reader`, `base:doc-reader`) and Claude Code's `claude-code-guide` and
`statusline-setup` get nothing from fe; the read-only agents
(`fe:theme-explorer`, `base:change-reviewer`, `base:bug-hunter`, `Explore`, `Plan`) get the root, the
profile and the Foundation section; every other agent also gets store access when it applies.

**base required:** at a session start fe looks for base's skills in the command list. Without them it
shows one toast and writes one `install` line: `fe: needs the base plugin — claude plugin install
base@domaine`.

## Doctor

`/fe-doctor` checks fe's side of the install and prints one PASS / FAIL / SKIP / WARN row per check,
the counts, and the last 10 `fe.events` lines. `/base-doctor` checks base's side (slim, fnd, the MCP
servers).

| Row | Checks |
|---|---|
| `node` | Node 18 or newer |
| `manifest` | the manifest's version, the name `fe`, `base` in its `dependencies` |
| `scripts` | every `scripts/*.sh` but the sourced `_*.sh` keeps its exec bit and answers `--help` (`project-profile.sh` is probed by the `profile` row) |
| `base` | base installed (user scope or this project) and enabled — else `claude plugin install base@domaine` |
| `shopify-cli` | `shopify version` answers; absent or failing only warns (the store scripts need it, the rest of fe does not) |
| `profile` | the word and how it was decided: `FE_PROFILE`, `project-profile.sh`, or a fallback to `none` (warns); in a session, the session's own decision |
| `store-config` | `shopify.theme.toml` and `.env` present at the project root — presence only, never a value; one missing warns; neither in a `none` project skips |
| `event-log` | this session's `fe.jsonl`: its line count and newest `ts`; no file yet passes (a /clear's new session has none before its first line) |
| `base-live`, `slim-live` | what this session loaded: base's skills, slim's `mcp__slim__view` tool |

The first eight rows come from `scripts/doctor.cjs`, which also runs by hand:
`node <fe plugin root>/scripts/doctor.cjs [--project <dir>] [--log-dir <dir>]`; it exits 1 when a row
fails. By hand its `event-log` row reads the newest session folder unless `--log-dir` names one. One
`doctor` line goes to `fe.events` per run.

## Event log on disk

fe writes its lines to `$HOME/.claude/domaine/log/<session-id>/fe.jsonl` under the same contract as
every Domaine plugin ([plugins/base/README.md](../base/README.md#event-log-on-disk)):

- **Line:** `{"ts":"…","plugin":"fe","version":"<fe's version>","session":"<id>","kind":"profile","agent":"main","text":"theme (project-profile.sh)"}`.
- **fe's lines:** `start` (`fe <version>`, first in every session's file, once), `install` (base is not
  loaded), `profile` (the word and how it was decided), `doctor` (a `/fe-doctor` run's counts). The
  same lines fill `fe.events` (oldest first, at most 200).
- **Writing:** the whole file is rewritten after every line, at most 2000 lines or 256 KB, oldest
  dropped first; a reload of the module goes on from the file of the same session. A write that
  fails never reaches the hook; the first failure in a session toasts `fe: event log not written:
  <reason>`.
- **Off:** `FE_EVENT_LOG=0` stops the file and the `fe.events` lines alike.
- **Clean-up:** fe never deletes; base sweeps old session folders.

band's Log pane (`/band-log`) shows fe's lines beside the other plugins', `fe` in its plugin column.

## Environment switches

Every switch fe reads has a row here; set it in `~/.claude/settings.json` → `env`. The store scripts
also read their switches from `~/.config/domaine/env`, and the tuning ones (`FE_PROFILE`,
`FE_GQL_PROBE_CACHE`, `FE_CPT_THROTTLE_WAITS`, `FE_CPT_OVERLAY_VERIFY_WAIT`,
`FE_THEME_JSON_VERIFY_WAIT`, `SHOPIFY_ADMIN_GQL_QUIET`) from the nearest `.claude/domaine.env` too;
the process environment wins.

| Variable | Default | Effect |
|---|---|---|
| `FE_PROFILE` | detected | `foundation`, `theme` or `none` (spaces around it trimmed) forces the project profile instead of detecting it; any other value is ignored and the profile is detected |
| `FE_EVENT_LOG` | on | `0` keeps `fe.events` empty and writes no `fe.jsonl` |
| `DOMAINE_LOG_DIR` | `~/.claude/domaine/log` | Where every Domaine plugin (slim, band, base, fe, qa, be, pm) writes its event log on disk: `<dir>/<session-id>/<plugin>.jsonl`, one JSON line per event. An absolute directory; the `<session-id>/` folder is still made under it. Without it and without `HOME` (a cloud session) no file is written. |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | read, never set, by `scripts/doctor.cjs`: the Claude Code config directory whose `plugins/installed_plugins.json` and `settings.json` the `base` row reads |
| `FE_GQL_PROBE_CACHE` | `21600` | seconds `shopify-admin-gql.sh` reuses its `shopify version` probe and its "`store execute` is unavailable for this store" fact; `0` re-probes on every call (right after a `shopify store auth`) |
| `FE_CPT_THROTTLE_WAITS` | `20 60` | pauses, in seconds, between `create-preview-theme.sh`'s push retries after Shopify answers `Throttled`; one retry per value, empty turns retrying off |
| `FE_CPT_OVERLAY_VERIFY` | `1` | `0` skips `create-preview-theme.sh`'s overlay read-back (`overlay=skipped`); with it, each overlaid `*.json` the theme silently dropped prints `warn=overlay_file_dropped` |
| `FE_CPT_OVERLAY_VERIFY_WAIT` | `2` | seconds before the overlay read-back's one re-pull when a file comes back missing |
| `FE_THEME_JSON_VERIFY` | `1` | `0` skips `theme-json.sh set`'s read-back verify (`verified=skipped`); with it, a write the theme does not serve exits 6 with `error=not_applied` |
| `FE_THEME_JSON_VERIFY_WAIT` | `2` | seconds `theme-json.sh set` waits before its one read-back retry |
| `SHOPIFY_ADMIN_GQL_QUIET` | off | a non-`0` value shortens `shopify-admin-gql.sh`'s engine-fallback note to `note=engine=token` |
| `TOML_PATH` | `shopify.theme.toml` | the config `create-preview-theme.sh`, `theme-json.sh` and `shopify-admin-gql.sh` read (`store =`, the dev theme's `theme =`, the Theme Access token), and the file `create-preview-theme.sh`'s pin rewrites — point it at a copy when the real config must not change. In a toml with `[environments.*]` blocks every value comes from one block: `--env <name>` (`create-preview-theme.sh` only), else `SHOPIFY_FLAG_ENVIRONMENT`, else `dev`, else `development`, else the top-level keys |
| `SHOPIFY_CLI_THEME_TOKEN` | unset | Theme Access token for the `shopify` CLI: `create-preview-theme.sh`'s last resort after the toml's `password =` (and its only token for a store other than the toml's); `theme-json.sh --engine themecli` prefers it over the toml. Never printed |
| `SHOPIFY_STORE` | unset | the store `theme-json.sh`, `shopify-admin-gql.sh` and `create-preview-theme.sh` use when `--store` is not passed, ahead of the toml's `store =`. A store other than the toml's refuses `create-preview-theme.sh create` and the pin; `refresh` then pushes with `SHOPIFY_CLI_THEME_TOKEN` |
| `SHOPIFY_FLAG_ENVIRONMENT` | unset | read, never set, by fe: the Shopify CLI's own environment selector, taken by the three store scripts as the default `[environments.<name>]` block of `shopify.theme.toml`; a name no block carries is `error=env_not_found` |
| `SHOPIFY_ADMIN_TOKEN` | unset | Admin API access token for `shopify-admin-gql.sh`'s token engine, ahead of the `--env` dotenv file |
| `SHOPIFY_ADMIN_API_VERSION` | `2026-04` | the Admin API version `shopify-admin-gql.sh` requests when `--api-version` is not passed |

## Tests

- `claude plugin validate --strict plugins/fe` and `claude plugin test plugins/fe` (the kit tests in
  `plugins/fe/hooks/mods/tests/`), both run by `tests/mods-sim.sh` with every other plugin (local
  only: CI has no `claude`).
- `tests/fe-scripts-sim.sh` — the store scripts, `worktree-theme.sh` and `project-profile.sh` against
  stub CLIs and synthetic configs.
- `tests/fe-doctor-sim.sh` — `scripts/doctor.cjs`'s rows on planted installs.
- `tests/team-refs-lint.sh` — every qualified name and cited path resolves, no fnd name is left (the
  same checker for every team plugin on base).
- `tests/base-qa-stores-sim.sh` — base's QA store registry, `plugins/base/scripts/qa-stores.cjs`, which
  `/fe:write-steps-to-test` names.

How the pieces fit: [ARCHITECTURE.md](ARCHITECTURE.md).

## Licence

MIT, as the repository ([LICENSE](../../LICENSE)).
