# Preflight checklist — environment validation

Shared environment checklist for the Agentic Assisted Development workflows. The `preflight-checks`
skill runs the full pass; `develop-feature-or-fix` and `qa-feature-or-fix` link the **Local dev
server** item as their browser-validation prerequisite.

## Required CLI tools

| Tool        | Validation command | Used by |
| ----------- | ------------------ | ------- |
| Shopify CLI | `shopify version`  | dev / preview |
| Node.js     | `node -v`          | build / scripts |
| npm         | `npm -v`           | build / scripts |
| Git         | `git --version`    | all |
| GitHub CLI  | `gh --version`     | `create-pull-request` |
| jq          | `jq --version`     | all three bundled runners — `shopify-admin-gql.sh`, `theme-json.sh`, `create-preview-theme.sh` |
| perl        | `perl -v`          | `theme-json.sh --strip-comments` |

Report version numbers; flag anything missing or below known team minimums. Two severities worth
getting right: **jq missing is a 🔴** — all three runners exit immediately with an `error=` line
naming jq (`error=jq_not_found` from the gql and theme-JSON runners, `error=jq not found on
PATH …` from `create-preview-theme.sh`), so store access and preview themes are dead; **perl
missing is a 🟡** — only `theme-json.sh get --strip-comments` hard-fails
(`error=strip_needs_perl`), while a `set` whose `--from` JSON carries `/*…*/` comments skips
validation with `note=json_validation_skipped` instead of refusing the push. The version
commands above are read-only (the
`preflight-checks` skill pre-approves exactly these); any other shell command still needs the
developer's go-ahead.

Shopify CLI **≥ 4.x** additionally provides `shopify store execute` — the preferred engine for
Admin GraphQL work (`metafield-metaobject-setup.md`) and for theme-JSON/customizer state
(`theme-customizer-state.md`): stored `shopify store auth`, no admin token in the repo. An older CLI is a 🟡, not a blocker — the bundled runner falls back to the
`SHOPIFY_ADMIN_TOKEN` path automatically.

## MCP servers

For each, confirm it is installed, connected, and authenticated — **report real outcomes, never
fabricate a green check**:

- **Figma MCP** — design extraction. **Either path counts** (`figma-reader` prefers the first):
  a remote/connector Figma server attached at user/project scope (tool names `mcp__figma__…`,
  no desktop app needed), or the plugin's local `figma-dev-mode` bridge with the Figma desktop
  app open in Dev Mode. 🔴 only when **neither** is reachable — a connector-only setup is 🟢.
- **Chrome DevTools MCP** — attaches to a running browser for in-browser validation.
- **Atlassian MCP** — Jira (and Confluence) auth; optionally verify read access with a known ticket key.
- **Notion MCP** — linked-doc ingestion (`reading-linked-docs.md`); the TA / develop / QA /
  steps-to-test workflows **stop** when a ticket links Notion docs and this MCP is missing —
  verify it responds with any lightweight read.
- **Shopify Dev MCP** — smoke-test with `learn_shopify_api` (`api: "liquid"`).

On failure, report the **specific** error + remediation (auth, MCP config, server disabled).

## Project skills & rules

- Project skills are present under `.claude/skills/` (and any documented sync locations).
- The repo's coding rules / Foundation conventions are available. List anything missing and how to restore it.

## Local dev server

- Determine whether a theme/dev server is running (`npm run dev` — Turbo: `shopify theme dev -e dev`
  + Vite assets — or `npm run theme:shopify` for preview only).
- If not running, it must be started before any **in-browser validation** (develop / QA workflows).

## Plugin update check

**Plugin root** = the plugin's own directory — this file is `<plugin root>/references/preflight-checklist.md`,
and every `<plugin root>/…` path below resolves the same way.

Two facts and one line of output: which version is installed, and whether a newer one is waiting.
This row is **advisory — never a blocker**: it does not gate Workflows 2–6, and a check that could
not run is 🟡 with the reason, never 🔴 and never a guess.

1. **Installed version** — `Read` a manifest from the plugin root and take its `version`:
   `<plugin root>/.claude-plugin/plugin.json`, or the per-host manifest where one exists
   (`.cursor-plugin/plugin.json`, `.codex-plugin/plugin.json`). All of them carry the same stamp —
   `doctor.cjs`'s `version-sync` row is what asserts that — so whichever is present is enough.
2. **Available version** — take the cheapest source the running host offers:

| Host | Where a newer version shows up | Update command to quote |
| --- | --- | --- |
| Claude Code | the marketplace checkout the host keeps for this marketplace (`plugins/fnd/.claude-plugin/plugin.json` inside it); the installed entry is in the host's `installed_plugins.json` | `/plugin marketplace update <marketplace>`, then `/reload-plugins` |
| Codex CLI | the clone the installer recorded in `~/.codex/.fnd-install-mode` (`repo=`) — the same repository the marketplace serves, so compare its commit to the remote exactly as below. **Never the plugin cache** (`…/plugins/cache/<marketplace>/fnd/<version>/`) | `codex plugin marketplace upgrade`, then a new session (and a fresh `/hooks` review when hook commands changed) |
| Cursor | live checkout: the install points at the clone, so the only newer thing is the git remote | `./scripts/install.sh --target cursor` in the clone, then a window reload for manifest / hook / MCP changes |
| OpenCode | live checkout, same as Cursor | `./scripts/install.sh --target opencode` in the clone, then a new session |

The Codex cache deserves its own warning, because it looks like an answer and is not: **only
installs write into it**, so its highest version directory can never exceed the installed one. Read
it and every session reports 🟢 "up to date" no matter what upstream shipped — a fabricated green.
After a rollback it fails the other way: a leftover higher directory announces an update that no
upgrade would install. It is a record of what was installed, never of what is available.

So for every host whose answer lives in a clone — Cursor, OpenCode, and Codex through the clone its
installer recorded — compare commits instead of versions. One read-only network call, written with
the repository URL rather than `origin`, because in the developer's workspace `origin` is the client
repo:

```bash
timeout 8 git ls-remote https://github.com/domaine-oleksandr-kever/claude-plugins.git HEAD
```

`timeout` is not on every machine (Linux has it; macOS ships without it) — where it is missing, run
the same command bare:

```bash
git ls-remote https://github.com/domaine-oleksandr-kever/claude-plugins.git HEAD
```

Bare is the unbounded form: git has no connect-timeout setting, so a network that black-holes
github.com (VPN, captive portal) leaves it hanging on the OS TCP timeout — about 75 seconds. That
wait is the whole downside of this advisory row, so **never run it twice**: one non-answer, whatever
the reason, is the 🟡 fail-silent case below.

The clone is where the installer's record points: `<host root>/.fnd-install-mode` carries a `repo=`
line (the checkout) and a `mode=` line. **`mode=copy` has no clone** — the files were copied and do
not follow a `git pull` at all → 🟡 "copy install: re-run the installer to refresh". No record at
all (a host installed from the marketplace only, never through `install.sh`) → 🟡 "no clone
recorded; run the host's update command to find out". The clone's own commit comes from files, not
commands: `Read` `<clone>/.git/HEAD`, then the ref it names (`<clone>/.git/refs/heads/<branch>`, or
that branch's line in `<clone>/.git/packed-refs` when the loose ref is absent). Same sha → up to
date. Different → the clone is behind or diverged: say "newer commits available" and quote the
update command. Claim `X → Y` **only** when two version numbers are actually in hand — a commit
difference is not a version number: on this path the pair exists only when the clone sits at the
remote's `HEAD` and its `plugins/fnd/.claude-plugin/plugin.json` names a version above the installed
one.

Rules that keep this row honest and cheap:

- **Read-only, always.** Never `git fetch`, never `git pull`, never write into any clone. `Read`
  and `git ls-remote` are the whole budget.
- **Fail silent.** No network, a non-zero `git ls-remote`, or host metadata that is not where this
  table says it is (the host changed its layout) → 🟡 with that reason. An update check that cannot
  run is not an environment failure.
- **A clone on a feature branch is not "behind".** Remote `HEAD` is the default branch, so a clone
  checked out elsewhere → 🟡 "clone on branch `<name>`; remote HEAD is a different line of work".
- Report exactly one line: 🟢 `plugin fnd <version> — up to date`, 🟡
  `update available: <installed> → <available> — <the running host's update command>`, or 🟡
  `update check skipped: <reason>`.
- An available update is also context for every other finding: stale plugin content explains itself,
  so update first before filing anything against the plugin.

## Model pins

Only two hosts pin versioned model ids: **Cursor** and **Codex**. Claude Code's agents pin aliases
that do not churn, and OpenCode deliberately pins nothing so local providers work — on those two
hosts report the row as 🟢 `n/a — this host pins no versioned ids` and move on. The full map is
`<plugin root>/references/host-model-map.md`.

Where the pins live: `<plugin root>/agents-cursor/*.md` frontmatter `model:` on Cursor;
`<plugin root>/agents-codex/*.toml` `model` / `model_reasoning_effort` on Codex — there, read the
copies the installer linked into the host's own agents directory where they exist, since those are
what the host loads. Not linked at all → 🟡 "subagents not linked — nothing to validate"
(`doctor.cjs --target codex` is the row that reports the linking itself).

Two halves, reported as one row:

1. **Structural** — always runnable. Every generated agent file for this host carries a pin, and
   every pinned id appears in `host-model-map.md`. A missing `model` means that agent silently
   inherits the session model and its guidelines row stops being enforced; an id that is not in the
   map means a generated file was hand-edited. Either is 🔴, and the fix is to regenerate
   (`<plugin root>/scripts/gen-host-adapters.cjs`), never to edit the generated file.
2. **Resolution** — best effort. Does the host still accept each distinct id? Use only a documented
   model-listing mechanism of the running host — a listing subcommand of its CLI, or the model
   picker as reported by the developer. Those commands are outside this skill's pre-approved
   allow-list, so ask before running one. **No listing mechanism available from this session, or any
   doubt that the command exists on this host version → 🟡 SKIP with that reason.** Never infer that
   a pin is fine because some agent ran, never spawn an agent to test one, and never invent a
   listing command or a model list: a fabricated "resolves" is worse than a skip.

When a pin is genuinely stale — the host lists its models and one pinned id is not among them, or
rejects it by name:

- **Update available (from the row above)** → update first and re-run; the pin may already be fixed
  upstream.
- **Already on the latest version** → this is a plugin content defect, not an environment gap.
  Offer the fnd report-plugin-issue skill (on Claude Code, `/fnd:report-plugin-issue`) with a
  sanitized report: host, host version, the pinned id, the agent file it came from, and the host's
  exact error text. Offer only — never file automatically.
- Do not hand-edit the generated agent as a local workaround: it is regenerated output, and the fix
  belongs in the generator's tier table.

## Report format

Summary table grouped by **IDE/workspace · MCP servers · CLI tools · project skills & rules · local
dev server · plugin update · model pins**, status per row as **🟢 Pass / 🔴 Fail / 🟡 Warning**
(exact values), with version or connection detail. List blockers + remediation separately — the
plugin-update and model-pin rows are advisory and never enter the blocker list, with one exception:
a 🔴 structural model-pin finding is a plugin defect worth naming there.
