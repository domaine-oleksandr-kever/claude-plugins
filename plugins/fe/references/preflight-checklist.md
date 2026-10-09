# Preflight checklist — environment validation

Shared environment checklist for the Agentic Assisted Development workflows. `/fe:preflight-checks`
runs the full pass; `/fe:develop-feature-or-fix` and `/fe:qa-feature-or-fix` link the **Local dev
server** item as their browser-validation prerequisite.

## Required CLI tools

| Tool        | Validation command | Used by |
| ----------- | ------------------ | ------- |
| Shopify CLI | `shopify version`  | dev / preview |
| Node.js     | `node -v`          | build / scripts |
| npm         | `npm -v`           | build / scripts |
| Git         | `git --version`    | all |
| GitHub CLI  | `gh --version`     | `/fe:create-pull-request` |
| jq          | `jq --version`     | all three bundled runners — `shopify-admin-gql.sh`, `theme-json.sh`, `create-preview-theme.sh` |
| perl        | `perl -v`          | `theme-json.sh --strip-comments`, and `set`'s read-back verify |

Report version numbers; flag anything missing or below known team minimums. Two severities worth
getting right: **jq missing is a 🔴** — all three runners exit immediately with an `error=` line
naming jq, so store access and preview themes are dead; **perl
missing is a 🟡** — only `theme-json.sh get --strip-comments` hard-fails
(`error=strip_needs_perl`); everything else degrades and says so on the line, but on such a host a
`set`'s read-back cannot tell Shopify's re-stamped banner from a lost write, so confirming a `set`
is the developer's job. The version commands above are read-only (`/fe:preflight-checks`
pre-approves exactly these); any other shell command still needs the developer's go-ahead.

Shopify CLI **≥ 4.x** additionally provides `shopify store execute` — the preferred engine for
Admin GraphQL work (`metafield-metaobject-setup.md`) and for theme-JSON/customizer state
(`theme-customizer-state.md`): stored `shopify store auth`, no admin token in the repo. An older CLI is a 🟡, not a blocker — the bundled runner falls back to the
`SHOPIFY_ADMIN_TOKEN` path automatically.

## MCP servers

For each, confirm it is installed, connected, and authenticated — **report real outcomes, never
fabricate a green check**:

- **Figma MCP** — design extraction. **Either path counts** (`base:figma-reader` prefers the first):
  a remote/connector Figma server attached at user/project scope (tool names `mcp__figma__…`,
  no desktop app needed), or base's local `figma-dev-mode` bridge with the Figma desktop
  app open in Dev Mode. Report which of the two answered; the row's **severity** is decided in
  **Figma access** below, because a third path (the REST token) can carry the read when neither
  MCP is there — so neither MCP is never a 🔴 on its own.
- **Chrome DevTools MCP** — attaches to a running browser for in-browser validation.
- **Atlassian MCP** — Jira (and Confluence) auth; optionally verify read access with a known ticket key.
- **Notion MCP** — linked-doc ingestion (`reading-linked-docs.md`); the TA / develop / QA /
  steps-to-test workflows **stop** when a ticket links Notion docs and this MCP is missing —
  verify it responds with any lightweight read.
- **Shopify Dev MCP** — smoke-test with `learn_shopify_api` (`api: "liquid"`).

On failure, report the **specific** error + remediation (auth, MCP config, server disabled).

## Project skills & rules

- Project skills are present under `.claude/skills/` (and any documented sync locations).
- The repo's coding rules are available — in a `foundation` checkout (session line `fe project profile: foundation`) that includes the Foundation conventions. List anything missing and how to restore it.

## Local dev server

- Determine whether a theme/dev server is running — in a `foundation` checkout (`npm run dev` — Turbo:
  `shopify theme dev -e dev` + Vite assets — or `npm run theme:shopify` for preview only); in any other
  checkout the repo's own dev script when its `package.json` defines one, else `shopify theme dev`.
  This row only DETECTS a server — the start command with its flags is
  `<fe root>/references/session-theme.md` step 5.
- If not running, it must be started before any **in-browser validation** (develop / QA workflows).

## Jira attachments

Ticket screenshots and screen recordings — including the ones hanging off comments — reach the
workflows only when this checkout carries a per-developer **read-only** Atlassian API token
(`JIRA_EMAIL` + `JIRA_API_TOKEN` in the gitignored `.env`): the Atlassian MCP reads the ticket,
it has no tool for attachment bytes. One read-only probe; never `Read` the `.env` — the runner
consumes the values without exposing them:

```bash
<base root>/scripts/jira-attachments.sh --check
```

- `ok=1 jira_user=… cloud_id=… ffmpeg=yes` → 🟢, naming the user it authenticated as.
- The same line with `ffmpeg=no` → 🟡 screen recordings are **skipped entirely** — with nothing to
  cut them into frames with there is nothing a model could look at, so the bytes are never
  downloaded (`brew install ffmpeg`); images are unaffected.
- exit 3 `error=no_jira_credentials` → 🟡 no token: ticket images stay invisible; setup walk-through
  in `<base root>/references/jira-attachments.md` (the script's `hint=` line carries the short form).
- exit 4 `error=jira_auth_rejected` → 🟡 the token was rejected — expired, or not the scoped
  read-only kind the gateway accepts; regenerate per that same reference.

Never 🔴: every workflow still reads the ticket and its comments without the token, and reports the
missing media once.

## Figma access

`base:figma-reader` reads a node through the **first source that answers**: the connector MCP → the
local `figma-dev-mode` bridge → the **REST API** with a per-developer personal access token
(`FIGMA_TOKEN` in the gitignored `.env`). This row says which of the three this machine has. The
first two are the MCP rows above; the third is one read-only probe, and never `Read` the `.env` —
the runner consumes the value without exposing it:

```bash
<base root>/scripts/figma-rest.sh --check
```

- **Either MCP answered** → 🟢, naming which one. `ok=1 figma_user=… token_source=env|file` on top
  of that is worth reporting too: it is the fallback that keeps designs readable when the desktop
  app is closed.
- **No MCP, but `ok=1 figma_user=…`** → 🟡 REST only: designs are read through the token path
  (`source: rest` in the reader's return), no desktop app needed. Nothing is blocked.
- exit 3 `error=no_figma_token` → no token. 🟡 when an MCP answered; **🔴 when none of the three
  did** — designs cannot be read at all. Quote the script's `hint=` line; the setup walk-through is
  `<base root>/references/figma-rest.md`.
- exit 4 `error=token_rejected` → the token was rejected — expired, revoked, or missing the
  read-only scopes; same severity rule as the line above, regenerate per that same reference.

Report `BASE_FIGMA_SOURCE` whenever it is set (`auto` default; `mcp` forbids the token path, `rest`
skips the MCP rungs) — a forced rung explains a row the machine could otherwise serve.

## Plugin update check

**`<fe root>`** / **`<base root>`** = the paths on the session context's `fe plugin root:` /
`base plugin root:` lines (`${CLAUDE_PLUGIN_ROOT}` is empty in the Bash tool's shell).

Two facts and one line of output per plugin (fe, and base under it): which version is installed,
and whether a newer one is waiting. This row is **advisory — never a blocker**: it does not gate
Workflows 2–6, and a check that could not run is 🟡 with the reason, never 🔴 and never a guess.

1. **Installed version** — `Read` `<fe root>/.claude-plugin/plugin.json` and
   `<base root>/.claude-plugin/plugin.json` and take each `version`.
2. **Available version** — the marketplace checkout Claude Code keeps for this marketplace
   (`plugins/fe/.claude-plugin/plugin.json` and `plugins/base/.claude-plugin/plugin.json` inside it;
   the installed entries are in Claude Code's `installed_plugins.json`). Read it, never write it.
   Update command to quote: `/plugin marketplace update <marketplace>`, then `/reload-plugins`.

Rules that keep this row honest and cheap:

- **Read-only, always.** `Read` is the whole budget: never `git fetch`, never `git pull`, never
  write into the marketplace checkout.
- **Fail silent.** Metadata that is not where this section says it is (Claude Code changed its
  layout) → 🟡 with that reason. An update check that cannot run is not an environment failure.
- Report exactly one line per plugin: 🟢 `plugin fe <version> — up to date`, 🟡
  `update available: <installed> → <available> — /plugin marketplace update <marketplace>`, or 🟡
  `update check skipped: <reason>`.
- An available update is also context for every other finding: stale plugin content explains itself,
  so update first before filing anything against the plugin. `/fe-doctor` and `/base-doctor` check
  the install itself.

## Report format

Summary table grouped by **IDE/workspace · MCP servers · CLI tools · project skills & rules · local
dev server · Jira attachments · Figma access · plugin update**, status per row as **🟢 Pass / 🔴 Fail / 🟡 Warning**
(exact values), with version or connection detail. List blockers + remediation separately — the
plugin-update rows are advisory and never enter the blocker list.
