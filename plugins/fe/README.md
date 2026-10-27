# fe

fe is the Domaine frontend team plugin for Claude Code. It holds the Shopify theme work. Its skills
take a ticket from a Technical Approach (TA) to a pull request and a preview theme. To install it, see
[Quick install (Claude Code)](../../README.md#quick-install-claude-code) or § Install below.

fe also holds these parts:

- the Steps to Test skill;
- the breaking-changes and translation tools;
- the `fe:theme-explorer` scout and the `fe:stt-drafter` / `fe:pr-body-drafter` drafters;
- the project profile: Foundation, another theme, or none;
- the store-access rules.

fe builds on base and requires it. base supplies the Jira, Figma and doc readers, the Jira writer, the
review agents, the task workspace, the commit and review skills, the guards and the shared MCP servers
([plugins/base/README.md](../base/README.md)). base requires slim, so fe runs with slim too.

Current release: **fe v0.12.1**.

## Status

- Claude Code only. fe is a plugin of skills, agents, references, scripts and a hooks module (mods).
  It ships no adapter for another host, and `scripts/install.sh --plugin fe` exits 2.
- Requires base (`"dependencies": ["base"]` in its manifest), and slim through base. The engine does
  not install a dependency by itself, so install all three.

## Install

```text
/plugin marketplace add domaine-oleksandr-kever/claude-plugins
/plugin install slim@domaine
/plugin install band@domaine
/plugin install base@domaine
/plugin install fe@domaine
/reload-plugins
```

Then run `/base-doctor` and `/fe-doctor` to check the install (§ Doctor). To enable the same set
through settings, add this to `~/.claude/settings.json`:

```json
{
  "enabledPlugins": {
    "slim@domaine": true,
    "band@domaine": true,
    "base@domaine": true,
    "fe@domaine": true
  }
}
```

The team plugins fe, qa, be and pm co-install. Each needs only base, and none needs another.

## Skills

Call the skills by their qualified names (`/fe:<skill>`). They hand off to base's skills and agents by
base's qualified names (`/base:commit`, `/base:pre-commit-review`, `base:jira-reader`, …). A hand-off
is an offer at the end of the run, never an automatic start. Only `/fe:ship` runs the series by itself.

| Skill | Does | Uses / hands off to |
|---|---|---|
| `/fe:ship` | a ready ticket end to end: one interview, one plan and QA-checklist approval, then the series runs itself (implement, QA, review and commit, PR, Steps to Test) | `base:jira-reader`, `base:figma-reader`, `base:doc-reader`, `fe:theme-explorer`; offers `/base:worktree` before it starts; a missing TA → `/fe:write-technical-approach` |
| `/fe:write-technical-approach` | drafts a Technical Approach from the ticket's Description and Acceptance Criteria, then writes the field after approval | `base:jira-reader`, `base:doc-reader`, `base:jira-writer` → `/fe:develop-feature-or-fix` |
| `/fe:develop-feature-or-fix` | implements an approved Technical Approach with in-browser validation on the work stream's preview theme | `base:jira-reader`, `base:figma-reader`, `base:doc-reader`, `fe:theme-explorer`, `base:bug-hunter`, `scripts/create-preview-theme.sh` → `/fe:qa-feature-or-fix` |
| `/fe:qa-feature-or-fix` | structured QA of a finished change against its ticket: checklist, browser checks, pass / fail report | `base:jira-reader`, `base:figma-reader`, `base:jira-writer`, `scripts/create-preview-theme.sh` → `/base:pre-commit-review` (with the profile word) once every blocking check passes |
| `/fe:write-steps-to-test` | Steps to Test in Domaine's format, written to the field after approval; the series' last step | `base:jira-reader`, `base:doc-reader`, `fe:stt-drafter`, `scripts/drafter-check.cjs`, `base:jira-writer` → `/fe:create-pull-request` when the branch has no PR |
| `/fe:create-pull-request` | a pull request with the Domaine description: a plain-English Summary, the theme-preview table, To check steps and screenshot placeholders | `base:jira-reader`, `base:change-reviewer`, `base:bug-hunter`, `/fe:preview-theme`'s script, `fe:pr-body-drafter`, `scripts/drafter-check.cjs` → `/fe:write-steps-to-test` while the field is empty |
| `/fe:preview-theme` | creates or refreshes an unpublished preview theme from the branch; in a new worktree, un-pins the copied store config first | `scripts/create-preview-theme.sh`, `scripts/worktree-theme.sh` |
| `/fe:preflight-checks` | checks the project, the tools and the dev server before work starts | → `/fe:write-technical-approach` or `/fe:develop-feature-or-fix` |
| `/fe:fix-accessibility-issue` | fixes an accessibility issue in theme components | → `/base:commit` |
| `/fe:get-breaking-changes` | lists the breaking changes merged since the last major version in `breaking-changes.md` | → `/fe:fix-breaking-changes` |
| `/fe:fix-breaking-changes` | applies the documented breaking changes to templates and settings data | its bundled script template; reads `/fe:get-breaking-changes`'s report |
| `/fe:update-translations` | translates storefront and schema strings into the theme's other languages | the project's own update-translations.js (fe ships none) |

fe's `progress-series` section (§ Conventions) lists the progress rows that these skills tick in a
ticket's `progress.md`.

**A worktree:** fe sets up a worktree in two steps. `/fe:ship` offers the same two steps before it
starts.

1. `/base:worktree` makes the checkout, copies `.env` and `shopify.theme.toml` (fe's
   `worktree copy list:` line) and records a dev port.
2. `/fe:preview-theme` in the worktree runs `scripts/worktree-theme.sh`. The script un-pins the copied
   config once, because a worktree never inherits the main checkout's session theme. Then it prints
   the dev-server line with that port.

On the main checkout the script answers `error=not_a_linked_worktree`, and the skill continues
without it.

## Agents

| Agent | Does |
|---|---|
| `fe:theme-explorer` | read-only scout of the theme: which files, sections and snippets a change touches; the `profile` comes in its brief |
| `fe:stt-drafter` | drafts Steps to Test into the workspace `steps-to-test.md` (sonnet); returns ESCALATE / LOOKUP, an answer, or the path + an unconfirmed list, never the text |
| `fe:pr-body-drafter` | drafts the PR title and body into the workspace `pr-body.md`, and after the PR exists the Jira PR-link comment into `jira-comment.md` (`PR: <url> — <title>`, a short brief only on request, never a preview link) (haiku); returns ESCALATE, an answer, or the path, title, Summary and an unconfirmed list |

## References and scripts

The skills and the agents cite fe's own files by their path under fe's root (`<fe root>/…`, from the
session's `fe plugin root:` line). They cite base's files by their path under base's root
(`<base root>/…`). `tests/team-refs-lint.sh` checks that every cited path exists.

| Reference | Read by | Holds |
|---|---|---|
| `references/session-theme.md` | `/fe:ship`, `/fe:preview-theme`, `/fe:create-pull-request`, `/fe:develop-feature-or-fix`, `/fe:qa-feature-or-fix` | one preview theme per work stream: the gate, the pin into `shopify.theme.toml`, the worktree un-pin |
| `references/preview-theme-errors.md` | `/fe:preview-theme`, `/fe:create-pull-request`, `/fe:develop-feature-or-fix`, `/fe:qa-feature-or-fix`, `/fe:ship`, `fe:pr-body-drafter` | how to read a `create-preview-theme.sh` run (its workspace lines and warnings), one entry per `error=` key, Shopify rejections and page deep-links |
| `references/theme-gotchas.md` | `/fe:develop-feature-or-fix`, `/fe:preview-theme` | Shopify theme traps that fail silently: dropped settings, presets, Liquid limits, cascade layers, browser checks; preview-theme recipes (templates-only push, stale hashed CSS, Playwright setContent) |
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
| `references/drafter-loop.md` | `/fe:write-steps-to-test`, `/fe:create-pull-request` | the drafter loop: spawn, receipt check, ESCALATE / LOOKUP relay, SendMessage continuation, ask / revise, caps, the never-read rule, the re-spawn fallback |

| Script | Run by | Does |
|---|---|---|
| `scripts/create-preview-theme.sh` | `/fe:preview-theme`, `/fe:create-pull-request`, `/fe:develop-feature-or-fix`, `/fe:qa-feature-or-fix`, `/fe:ship` | builds and pushes an unpublished preview theme (`create`), re-pushes one (`refresh`), pins the session theme (`pin`). `create --duplicate-of <theme-id\|name> --store <store>` copies a theme on that store server-side, waits until `theme list` shows the copy ready, then pushes the branch code into it; `--brand <b>` (create, refresh) exports `BRAND=<b>` to the build and does nothing else |
| `scripts/session-theme.sh` | sourced by `create-preview-theme.sh`, run by `worktree-theme.sh` | the pin and un-pin grammar of `shopify.theme.toml` (`# fe:session-theme`, `# fe:superseded`) |
| `scripts/worktree-theme.sh` | `/fe:preview-theme` in a worktree, `/fe:ship` | the Shopify half of a new worktree: the one-time un-pin and the dev-server line |
| `scripts/theme-json.sh` | the skills, through the `store-access` section | reads and writes a theme's JSON files (`templates/*.json`, `config/settings_data.json`) with a read-back check; `locate <id>` finds which store holds a theme (the stores in `<base root>/scripts/qa-stores.cjs` plus every store the toml's `[environments.*]` blocks name, or `--stores a,b`, or `--store <one>`) |
| `scripts/shopify-admin-gql.sh` | the skills, through the `store-access` section | one Admin GraphQL call against the project's store |
| `scripts/project-profile.sh` | fe's hooks module, `worktree-theme.sh`, the doctor, the skills' fallback | prints `foundation`, `theme` or `none` |
| `scripts/doctor.cjs` | `/fe-doctor`, or by hand | the static install checks (§ Doctor) |
| `scripts/drafter-check.cjs` | `fe:stt-drafter`, `fe:pr-body-drafter`, `/fe:write-steps-to-test`, `/fe:create-pull-request` | checks a drafter's file (`file stt\|pr\|jira`: structure, the PR core skeleton, the Theme preview table by default — `--no-preview` honored only when the workspace `notes.md` records `preview-decision: no preview`, Summary sentence lengths, the Jira comment's PR line and brief size with no preview link, theme id or editor URL, no AI attribution) and its reply (`receipt stt\|pr\|jira`: one kind, no empty field) in code, printing counts and `fail` lines only — never the draft |
| `scripts/_shopify-common.sh` | sourced by the store scripts | the shared Shopify CLI and config helpers |

`/fe:fix-breaking-changes` copies its own `skills/fix-breaking-changes/scripts/fix-breaking-changes.template.js`
into the project and removes the copy after the run. `theme-json.sh locate` reads the QA store registry's
store list (`<base root>/scripts/qa-stores.cjs list --json`, never a password) from base's install beside fe.

## Conventions

fe's sections reach the model through one channel on every login: a Claude Code command hook,
`node hooks/conventions.cjs start`, on `SessionStart` with the matcher `startup|clear|compact`
(`hooks/hooks.json`, beside the hooks module). A resume or a fork keeps the copy the transcript already
holds. The context arrives with the first user message, after CLAUDE.md, in the order below. The
text lives in one file, `hooks/conventions-text.json`; the hook fills in the roots. The envelope stays
well under the host's ~10,000-character inline limit (a larger one is spilled to a file).

The hook writes a marker, `<log dir>/<session-id>/conventions.fe.json`: `via`, `event`, `source`, the
`sections` it sent, `chars`, the `login` (`work`, `personal` or `unknown`, read from the login file; doctor
evidence only) and the `profile` it decided. `/base-doctor`'s `conventions` row reads it.
Where the log folder is missing or not writable, the marker goes to the spare folder
`<TMPDIR or /tmp>/domaine-log/<session-id>/`.

| Name | Holds | When |
|---|---|---|
| `root` | `fe plugin root: <path>`, the directory fe's scripts and references start from; the same line defines `<fe root>` and `<base root>` (the `base plugin root:` path) for every fe skill, agent and reference, and says to spell both out in commands since `${CLAUDE_PLUGIN_ROOT}` is empty in the Bash tool's shell | always |
| `profile` | `fe project profile: <foundation\|theme\|none>` | always |
| `comment-discipline-foundation` | LiquidDoc on every snippet param; `src/entry/core/*` is protected; the Liquid core is hand-synced from the foundation repo, so prefer a copy | profile `foundation` |
| `store-access` | the two store runners, `scripts/shopify-admin-gql.sh` and `scripts/theme-json.sh`, with their paths under fe's root; never `Read` `.env` or `shopify.theme.toml` | the project root holds `shopify.theme.toml`, or `.env` with a profile other than `none` |
| `worktree` | `worktree copy list: shopify.theme.toml` (the line `/base:worktree` reads), then `/fe:preview-theme` in the new worktree | the project root holds `shopify.theme.toml` |
| `preview-default-on` / `preview-default-off` | `fe preview default: preview theme` — `/fe:develop-feature-or-fix` and `/fe:qa-feature-or-fix` validate on the work stream's preview theme — or `fe preview default: local dev server (FE_PREVIEW_DEFAULT=0)`; the skills key on this line and never read the switch | the project root holds `shopify.theme.toml` (no preview theme without it) |
| `preview-links` | `## fe convention — preview link in every report`: a reply that reports a check, validation, repro or refresh on a preview theme opens with `Preview: <store>/<page path>?preview_theme_id=<id>` (one per page checked), `Editor: <editor_url>` and `Password:` when the storefront has one, the values from `create-preview-theme.sh`'s `preview_url=` / `editor_url=` or the `session-theme:` line — the id alone never counts; reaches ad-hoc fixes as well as the skills | the project root holds `shopify.theme.toml`, either preview default |
| `progress-series` | the rows of a ticket's `progress.md` in order — `write-technical-approach`, `develop-feature-or-fix`, `qa-feature-or-fix`, `pre-commit-review`, `commit`, `create-pull-request`, `write-steps-to-test` — and the skill that ticks each; a batch lists its tickets, then the same tail | a profile other than `none`, or `shopify.theme.toml` at the root |

**The profile** is decided by the start hook, once per session start; a `/clear` decides again. fe
takes the first answer in this order:

1. `FE_PROFILE`, when it holds one of the three words.
2. `scripts/project-profile.sh` on the project root. The script also reads `FE_PROFILE` from
   `.claude/domaine.env` or `~/.config/domaine/env`.
3. Detection by the same script: `snippets/@*.liquid`, `sections/core-*.liquid`,
   `blocks/core-*.liquid` or `src/entry/core/` ⇒ `foundation`; `layout/theme.liquid` ⇒ `theme`;
   else `none`.

A probe that fails or times out (5 s) gives `none` and says why in the marker. The hooks module
decides the same way once per session id for its own readers (the event log, `/fe-doctor`) and logs one
`profile` line.

**Subagents** get fe's share as added context at their start, through a second command hook,
`node hooks/conventions.cjs subagent` on `SubagentStart`: the main session's context does not reach a
subagent. The profile comes from this session's marker; without one the hook decides it. The share
depends on the agent type:

- base's readers and writer (`base:jira-reader`, `base:jira-writer`, `base:figma-reader`,
  `base:doc-reader`), Claude Code's `claude-code-guide` and `statusline-setup`, and a fork (it inherits
  the transcript) get nothing from fe.
- The read-only agents (`fe:theme-explorer`, `base:change-reviewer`, `base:bug-hunter`, `Explore`,
  `Plan`) get the root, the profile and the Foundation section.
- The drafters (`fe:stt-drafter`, `fe:pr-body-drafter`) get the root, the profile and store access — they confirm fixture handles on the store — but not the Foundation section: they write prose, not theme code.
- Every other agent also gets store access when it applies.

**base required:** at a session start fe looks for base's skills in the command list. If they are
missing, fe shows one toast and writes one `install` line:
`fe: needs the base plugin — claude plugin install base@domaine`.

## Doctor

`/fe-doctor` checks fe's side of the install. It prints one PASS / FAIL / SKIP / WARN row per check,
the counts, and the last 10 `fe.events` lines. `/base-doctor` checks base's side (slim, the MCP
servers).

| Row | Checks |
|---|---|
| `node` | Node 18 or newer |
| `manifest` | the manifest's version, the name `fe`, `base` in its `dependencies` |
| `scripts` | every `scripts/*.sh` but the sourced `_*.sh` keeps its exec bit and answers `--help` (`project-profile.sh` is probed by the `profile` row) |
| `base` | base installed (user scope or this project) and enabled — else `claude plugin install base@domaine`; FAIL when that install lacks `<base root>/scripts/review-scope.sh` (the PR review gate runs it), `skills/shopify/SKILL.md` or `references/shopify-recipes.md` (fe store work points at them) — update base |
| `shopify-cli` | `shopify version` answers; absent or failing only warns (the store scripts need it, the rest of fe does not) |
| `profile` | the word and how it was decided: `FE_PROFILE`, `project-profile.sh`, or a fallback to `none` (warns); in a session, the one the start hook delivered (its marker), else the hooks module's own decision |
| `store-config` | `shopify.theme.toml` and `.env` present at the project root — presence only, never a value; one missing warns; neither in a `none` project skips |
| `preview` | where develop and qa validate: `preview theme`, or `local dev server (FE_PREVIEW_DEFAULT=0)` — decided by the same `hooks/conventions.cjs` function as the start line |
| `event-log` | this session's `fe.jsonl`: its line count and newest `ts`; no file yet passes (a /clear's new session has none before its first line) |
| `base-live`, `slim-live` | what this session loaded: base's skills, slim's `mcp__slim__view` tool |

The first nine rows come from `scripts/doctor.cjs`. You can also run it by hand:
`node <fe plugin root>/scripts/doctor.cjs [--project <dir>] [--log-dir <dir>]`. It exits 1 when a row
fails. By hand, its `event-log` row reads the newest session folder unless `--log-dir` names one.
Each run writes one `doctor` line to `fe.events`.

## Event log on disk

fe writes its lines to `$HOME/.claude/domaine/log/<session-id>/fe.jsonl`. The file follows the
same contract as every Domaine plugin ([plugins/base/README.md](../base/README.md#event-log-on-disk)):

- **Line:** `{"ts":"…","plugin":"fe","version":"<fe's version>","session":"<id>","kind":"profile","agent":"main","text":"theme (project-profile.sh)"}`.
- **fe's lines:** `start` (`fe <version>`, first in every session's file, once), `install` (base is not
  loaded), `profile` (the word and how it was decided), `doctor` (a `/fe-doctor` run's counts). The
  same lines fill `fe.events` (oldest first, at most 200).
- **Writing:** fe rewrites the whole file after every line. The file keeps at most 2000 lines or
  256 KB and drops the oldest lines first. After a reload, the module continues from the file of the
  same session. A failed write never reaches the hook. The first failure in a session toasts
  `fe: event log not written: <reason>`.
- **Off:** `FE_EVENT_LOG=0` stops the file and the `fe.events` lines alike.
- **Clean-up:** fe never deletes; base sweeps old session folders.

band's Log pane (`/band-log`) shows fe's lines beside the lines of the other plugins, with `fe` in
its plugin column.

## Environment switches

Every switch fe reads has a row here. Set it in `~/.claude/settings.json` → `env`. The store scripts
also read their switches from `~/.config/domaine/env`. They read the tuning switches (`FE_PROFILE`,
`FE_GQL_PROBE_CACHE`, `FE_CPT_THROTTLE_WAITS`, `FE_CPT_OVERLAY_VERIFY_WAIT`,
`FE_THEME_JSON_VERIFY_WAIT`, `SHOPIFY_ADMIN_GQL_QUIET`) from the nearest `.claude/domaine.env` too.
The process environment wins.

| Variable | Default | Effect |
|---|---|---|
| `FE_PROFILE` | detected | `foundation`, `theme` or `none` (spaces around it trimmed) forces the project profile instead of detecting it, in the `hooks/conventions.cjs` command hook and the hooks module alike; any other value is ignored and the profile is detected |
| `FE_EVENT_LOG` | on | `0` keeps `fe.events` empty and writes no `fe.jsonl` |
| `FE_PREVIEW_DEFAULT` | on | `0` turns off the preview-theme default of `/fe:develop-feature-or-fix` and `/fe:qa-feature-or-fix`: they validate on the local dev server, which must then be running. Decided once by the `hooks/conventions.cjs` start hook (its `fe preview default:` line, toml checkouts only) and shown by the doctor's `preview` row; read from the process environment, else `~/.config/domaine/env` — never from the project `.claude/domaine.env` |
| `DOMAINE_LOG_DIR` | `~/.claude/domaine/log` | Where every Domaine plugin (slim, band, base, fe, qa, be, pm) writes its event log on disk: `<dir>/<session-id>/<plugin>.jsonl`, one JSON line per event. An absolute directory; the `<session-id>/` folder is still made under it. Without it and without `HOME` (a cloud session) no file is written. The `hooks/conventions.cjs` command hook writes its marker `conventions.fe.json` there too. |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | read, never set, by `scripts/doctor.cjs`: the Claude Code config directory whose `plugins/installed_plugins.json` (else the claude.ai-synced copy under `plugins/synced/`) and `settings.json` the `base` row reads; by the `hooks/conventions.cjs` command hook: the login file it labels in its marker (`<dir>/.claude.json`, or `~/.claude.json` for the default directory) |
| `TMPDIR` | `/tmp` | read, never set, by the `hooks/conventions.cjs` command hook: `<dir>/domaine-log/<session-id>/` is the spare folder of the marker where the log folder is missing or not writable |
| `CLAUDE_PLUGIN_ROOT` | set by Claude Code | read, never set, by the `hooks/conventions.cjs` command hook: fe's root, filled into the root line and the store-access paths (the script's own parent directory when unset) |
| `FE_GQL_PROBE_CACHE` | `21600` | seconds `shopify-admin-gql.sh` reuses its `shopify version` probe and its "`store execute` is unavailable for this store" fact; `0` re-probes on every call (right after a `shopify store auth`) |
| `FE_CPT_THROTTLE_WAITS` | `20 60` | pauses, in seconds, between `create-preview-theme.sh`'s push retries after Shopify answers `Throttled`; one retry per value, empty turns retrying off |
| `FE_CPT_OVERLAY_VERIFY` | `1` | `0` skips `create-preview-theme.sh`'s overlay read-back (`overlay=skipped`); with it, each overlaid `*.json` the theme silently dropped prints `warn=overlay_file_dropped` |
| `FE_CPT_DUPLICATE_TIMEOUT` | `300` | seconds `create-preview-theme.sh create --duplicate-of` waits for the copy to be listed ready before `error=duplicate_timeout` |
| `FE_CPT_DUPLICATE_POLL` | `5` | seconds between those `theme list` polls |
| `FE_CPT_OVERLAY_VERIFY_WAIT` | `2` | seconds before the overlay read-back's one re-pull when a file comes back missing |
| `FE_THEME_JSON_VERIFY` | `1` | `0` skips `theme-json.sh set`'s read-back verify (`verified=skipped`); with it, a write the theme does not serve exits 6 with `error=not_applied` |
| `FE_THEME_JSON_VERIFY_WAIT` | `2` | seconds `theme-json.sh set` waits before its first read-back retry; the second waits 2.5× that |
| `SHOPIFY_ADMIN_GQL_QUIET` | off | a non-`0` value shortens `shopify-admin-gql.sh`'s engine-fallback note to `note=engine=token` |
| `TOML_PATH` | `shopify.theme.toml` | the config `create-preview-theme.sh`, `theme-json.sh` and `shopify-admin-gql.sh` read (`store =`, the dev theme's `theme =`, the Theme Access token), and the file `create-preview-theme.sh`'s pin rewrites — point it at a copy when the real config must not change. In a toml with `[environments.*]` blocks every value comes from one block: `--env <name>` (`create-preview-theme.sh` only), else `SHOPIFY_FLAG_ENVIRONMENT`, else `dev`, else `development`, else the top-level keys |
| `SHOPIFY_CLI_THEME_TOKEN` | unset | Theme Access token for the `shopify` CLI: `create-preview-theme.sh`'s last resort after the toml's `password =` (and its only token for a store other than the toml's) — with none, the CLI's logged-in session authenticates (`auth=cli-session`); `theme-json.sh` (themecli engine) prefers it over the toml. It never sends a toml block's token to a `--store` that block does not name: another `[environments.*]` block naming that store supplies the token, and with none the CLI's logged-in session authenticates (`auth=cli-session … toml_env=<block>` on stderr, `token_source=session`) — as it does for any store with no token at all (no toml found, or a block without `password =`: `toml_store=-`). Never printed |
| `SHOPIFY_STORE` | unset | the store `theme-json.sh`, `shopify-admin-gql.sh` and `create-preview-theme.sh` use when `--store` is not passed, ahead of the toml's `store =`. A store other than the toml's refuses a plain `create-preview-theme.sh create` (`create --duplicate-of` is allowed) and the pin; `refresh` then pushes with `SHOPIFY_CLI_THEME_TOKEN`, else the CLI's logged-in session. For `theme-json.sh` it counts like `--store`: a store the resolved toml block does not name never gets that block's token — `SHOPIFY_CLI_THEME_TOKEN`, else a sibling block naming the store, else the CLI's logged-in session |
| `SHOPIFY_FLAG_ENVIRONMENT` | unset | read, never set, by fe: the Shopify CLI's own environment selector, taken by the three store scripts as the default `[environments.<name>]` block of `shopify.theme.toml`; a name no block carries is `error=env_not_found` |
| `SHOPIFY_ADMIN_TOKEN` | unset | Admin API access token for `shopify-admin-gql.sh`'s token engine, ahead of the `--env` dotenv file |
| `SHOPIFY_ADMIN_API_VERSION` | `2026-10` | the Admin API version `shopify-admin-gql.sh` requests when `--api-version` is not passed |

## Tests

- `claude plugin validate --strict plugins/fe` and `claude plugin test plugins/fe` (the kit tests in
  `plugins/fe/hooks/mods/tests/`), both run by `tests/mods-sim.sh` with every other plugin (local
  only: CI has no `claude`).
- `tests/hooks-sim.sh`, block "Domaine command hooks" (`DHfe*`) — `hooks/conventions.cjs` run as the host
  runs it, with `project-profile.sh` stubbed: the sections per profile and project files, the marker, the
  subagent shares, the text file.
- `tests/fe-scripts-sim.sh` — the store scripts, `worktree-theme.sh` and `project-profile.sh` against
  stub CLIs and synthetic configs.
- `tests/fe-doctor-sim.sh` — `scripts/doctor.cjs`'s rows on planted installs.
- `tests/helper-parity-sim.sh` — the helpers in `scripts/doctor.cjs` and `scripts/_shopify-common.sh`
  stay byte-identical to the other plugins' copies.
- `tests/team-refs-lint.sh` — every qualified name and cited path resolves, and no legacy plugin name
  is left. The same checker runs for every team plugin on base.
- `tests/base-qa-stores-sim.sh` — base's QA store registry, `plugins/base/scripts/qa-stores.cjs`, which
  `/fe:write-steps-to-test` names.

How the pieces fit: [ARCHITECTURE.md](ARCHITECTURE.md).

## Licence

MIT, as the repository ([LICENSE](../../LICENSE)).
