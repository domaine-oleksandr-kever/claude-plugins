# Domaine Claude Code plugins

This repo is a plugin marketplace for Domaine's agentic development on Shopify. The marketplace
name is `domaine`. It holds these plugins:

| Plugin | What it does |
|---|---|
| `slim` | Compresses large tool results (MCP, Bash, Read, WebFetch, …) before the model reads them. Adds a `lookup` tool that answers one question about a page, a command or a file. Where fnd is still installed, slim stands down on what fnd already slimmed. |
| `band` | Draws the status band, the Progress pane and the event log pane from what base (or fnd) and slim publish. While it is installed, fnd's own band stands down. |
| `base` | The shared layer: Jira, Figma and doc readers, the Jira writer, review agents, the task workspace, guards, conventions, shared MCP servers. Requires slim. |
| `fe` | The frontend team: Shopify theme skills (TA → develop → QA → PR, translations, preview themes). |
| `qa` | The QA team: QA preflight and read-only store access. |
| `be` | The backend team: Shopify app and extension skills. |
| `pm` | The PM team: estimator, merchant brief, solutions engineering, vendor evaluation. |
| `fnd` | Legacy all-in-one plugin. Frozen — see [fnd is frozen](#fnd-is-frozen). |

## Quick install (Claude Code)

Pick one of the three ways. Each one installs slim, band and base, then the team plugins you name.

### A. One command in a terminal

This needs the `claude` CLI on PATH (`claude --version` answers). Each block below is one line.
Press its copy button, paste it into Terminal, press Enter.

Frontend team (slim, band, base, fe):

```bash
curl -fsSL https://raw.githubusercontent.com/domaine-oleksandr-kever/claude-plugins/main/scripts/bootstrap.sh | bash -s -- --targets claude --plugins slim,band,base,fe --yes
```

QA team (slim, band, base, qa):

```bash
curl -fsSL https://raw.githubusercontent.com/domaine-oleksandr-kever/claude-plugins/main/scripts/bootstrap.sh | bash -s -- --targets claude --plugins slim,band,base,qa --yes
```

Backend team (slim, band, base, be):

```bash
curl -fsSL https://raw.githubusercontent.com/domaine-oleksandr-kever/claude-plugins/main/scripts/bootstrap.sh | bash -s -- --targets claude --plugins slim,band,base,be --yes
```

PM team (slim, band, base, pm):

```bash
curl -fsSL https://raw.githubusercontent.com/domaine-oleksandr-kever/claude-plugins/main/scripts/bootstrap.sh | bash -s -- --targets claude --plugins slim,band,base,pm --yes
```

Everything:

```bash
curl -fsSL https://raw.githubusercontent.com/domaine-oleksandr-kever/claude-plugins/main/scripts/bootstrap.sh | bash -s -- --targets claude --plugins slim,band,base,fe,qa,be,pm --yes
```

The command adds the `domaine` marketplace, installs the plugins in dependency order and prints a
summary. Run the same line again later to update. Then restart Claude Code, or run `/reload-plugins`
in an open session, and run `/base-doctor` plus your team's doctor (`/fe-doctor`, `/qa-doctor`,
`/be-doctor`, `/pm-doctor`).

If the legacy fnd plugin is installed and enabled, the command warns and removes it first (`--yes`
agrees to that; without `--yes` it asks `[y/N]`). One case it cannot remove: an fnd synced from your
claude.ai account. Then the summary stops and tells you to remove it in claude.ai first, or to ask
the account owner. See [fnd is frozen](#fnd-is-frozen).

### B. No terminal: paste into a Claude Code session

This works in the desktop app's Code tab and in the CLI alike. Paste these lines into the prompt,
one at a time, and skip the team plugins you do not need:

```text
# Moving from fnd? Remove it first; it never runs with base or a team plugin.
/plugin uninstall fnd@domaine

# 1. Add the marketplace (confirm the trust prompt)
/plugin marketplace add domaine-oleksandr-kever/claude-plugins

# 2. Install the core plugins, in this order
/plugin install slim@domaine
/plugin install band@domaine
/plugin install base@domaine

# 3. Install the team plugins you need
/plugin install fe@domaine
/plugin install qa@domaine
/plugin install be@domaine
/plugin install pm@domaine

# 4. Activate the plugins without a restart
/reload-plugins

# 5. Check the install: base's doctor, then the doctor of each team plugin you installed
/base-doctor
/fe-doctor
/qa-doctor
/be-doctor
/pm-doctor
```

### C. Desktop app and claude.ai

- **Desktop app.** It reads the same `~/.claude` as the CLI. So way A in Terminal installs the
  plugins for the desktop app too; restart the app afterwards. Way B works inside its Code tab.
- **claude.ai (web and cloud sessions).** You install nothing. The account owner enables the
  plugins in claude.ai, and they arrive in every session as synced plugins. Ask the owner.

Notes:

1. Install slim, band and base before the team plugins. base requires slim. Way A keeps this order
   whatever order you name the plugins in.
2. The team plugins do not require each other. Install only the ones you need.
3. Do not install fnd with base or a team plugin. They ship the same agents, skills and MCP
   servers. To move from fnd, follow [fnd is frozen](#fnd-is-frozen).
4. slim, band, base and the team plugins run on Claude Code only. On Cursor, Codex CLI and
   OpenCode, use fnd ([Install — four hosts](#install--four-hosts)).

Each plugin has its own README: [slim](plugins/slim/README.md), [band](plugins/band/README.md),
[base](plugins/base/README.md), [fe](plugins/fe/README.md), [qa](plugins/qa/README.md),
[be](plugins/be/README.md), [pm](plugins/pm/README.md). `tests/` covers all eight plugins, and
`tests/mods-sim.sh` validates and tests every `plugins/*/hooks/hooks.json` module. The rest of this
file describes fnd and the repo.

## fnd is frozen

fnd is frozen at 0.135.0 since 2026-10-08. It is supported until 2027-06-30. In that time, a
blocking bug gets a fix on request: file it with `/fnd:report-plugin-issue`. fnd gets no new
features and no rewrites. After 2027-06-30, nobody fixes fnd, and its marketplace entry can go.

On Claude Code, a new install is slim + band + base, then the team plugins you need: fe, qa, be, pm
([plugins/base/README.md](plugins/base/README.md), [plugins/fe/README.md](plugins/fe/README.md)).
fnd never runs together with base or a team plugin, because they ship the same agents, skills and
MCP servers. To move an fnd install to the new set, do these steps:

1. Run `/plugin uninstall fnd@domaine`. If `/plugin` or `claude plugin list` also shows an fnd
   synced from claude.ai, remove it from your claude.ai account too. That copy loads as soon as
   fnd@domaine is gone. If a repository's `.claude/settings.json` enables fnd, also set
   `"fnd@domaine": false` in its `.claude/settings.local.json` ([Team rollout](#team-rollout)).
2. Run `/plugin install slim@domaine`, `/plugin install band@domaine`, `/plugin install base@domaine`,
   in this order. Then install the team plugins you need (`/plugin install fe@domaine`, and `qa`,
   `be`, `pm` the same way).
3. Run `/reload-plugins`. Then run `/base-doctor` and the doctor of each installed team plugin
   (`/fe-doctor`, `/qa-doctor`, `/be-doctor`, `/pm-doctor`).
4. Rename the `FND_*` keys you set:
   - fe's keys become `FE_*` (the list is in
     [plugins/fe/README.md → Install](plugins/fe/README.md#install)).
   - base's keys become `BASE_*`
     ([plugins/base/README.md → Environment switches](plugins/base/README.md#environment-switches)).
   - `FND_BAND_COST` becomes `BAND_COST`.
   - `FND_EVENT_LOG` becomes one `<PLUGIN>_EVENT_LOG` per plugin (`SLIM_`, `BAND_`, `BASE_`, `FE_`).
   - slim's and band's own switches are in [plugins/slim/README.md](plugins/slim/README.md) and
     [plugins/band/README.md](plugins/band/README.md).
   - Any other `FND_*` key has no successor. You can remove it.

On Cursor, Codex CLI and OpenCode, keep fnd. slim, band, base and the team plugins (fe, qa, be,
pm) run on Claude Code only, so nothing replaces fnd on those hosts.

## What's inside

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) shows how the parts fit together: hosts, adapters,
hooks, the compression pipeline and the ship pipeline. It uses Mermaid, which GitHub renders.

This repo is a **marketplace** (a catalog of plugins). Each of its **plugins** is in its own
subfolder under `plugins/`:

```
.
├── .claude-plugin/
│   └── marketplace.json         # marketplace catalog (lists the plugins)
├── plugins/
│   ├── slim/                     # the tool-result compression proxy (Claude Code only;
│   │                             #   plugins/slim/README.md)
│   ├── band/                     # the status band, Log and Progress panes (Claude Code only;
│   │                             #   plugins/band/README.md)
│   ├── base/                     # the shared plugin: readers, writer, reviewers, workspace, guards
│   │                             #   (Claude Code only; plugins/base/README.md)
│   ├── fe/                       # the frontend team plugin on top of base (Claude Code only;
│   │                             #   plugins/fe/README.md)
│   ├── qa/                       # the QA team plugin on top of base (Claude Code only;
│   │                             #   plugins/qa/README.md)
│   ├── be/                       # the backend team plugin on top of base (Claude Code only;
│   │                             #   plugins/be/README.md)
│   ├── pm/                       # the project-management plugin on top of base (Claude Code
│   │                             #   only; plugins/pm/README.md)
│   └── fnd/                      # the Foundation plugin (self-contained)
│       ├── .claude-plugin/
│       │   └── plugin.json       # plugin manifest (+ bundled mcpServers) — canonical
│       ├── .cursor-plugin/plugin.json   # Cursor manifest (same version stamp)
│       ├── .codex-plugin/plugin.json    # Codex CLI manifest (same version stamp)
│       ├── skills/               # 18 workflow skills (see table below)
│       │   ├── develop-feature-or-fix/SKILL.md
│       │   └── ...
│       ├── agents/               # subagents the skills delegate to
│       │   ├── change-reviewer.md   #  reviews a diff (hygiene + conformance)
│       │   ├── bug-hunter.md        #  adversarial bug hunt on a diff (correctness)
│       │   ├── jira-reader.md       #  reads a ticket → structured fields
│       │   ├── jira-writer.md       #  writes one approved field (ADF) / comment (md) → Jira
│       │   ├── figma-reader.md      #  reads one Figma frame → build spec
│       │   ├── doc-reader.md        #  reads one linked doc (Notion/Confluence/web) → extract
│       │   └── theme-explorer.md    #  scouts the theme → impact map
│       ├── hooks/                # injected conventions + git guards + context monitor
│       │   ├── mods/             #  Claude Code hooks module: guard, slim, pasted JSON, task resolver; status band
│       │   │                     #    and panes only while the band plugin is not installed
│       │   ├── comment-discipline.md
│       │   ├── lean-code.md      #  "lazy senior dev" ladder (FND_LEAN=0 to disable)
│       │   ├── writing-style.md  #  how-to-explain convention, ASD-STE100-style (FND_STE=0 to disable)
│       │   ├── mcp-whale-claude.md #  short whale convention Claude Code gets instead of mcp-whale.md
│       │   ├── session-start.sh         # SessionStart composer both shell wirings spawn
│       │   ├── subagent-conventions.sh  # outside-content rail → every subagent; the above → code-writing ones
│       │   ├── no-verify-bypass.sh      # PreToolUse guard: no hook-bypassing commits
│       │   ├── spill-access.sh          # PreToolUse recorder: which tool read an MCP spill
│       │   └── ...               # see "Hooks" below for the full set
│       ├── types/index.d.ts      # the hooks module's state contract (plugin.json "types")
│       ├── scripts/              # bundled runners the skills call
│       │   ├── shopify-admin-gql.sh #  Admin GraphQL (store execute → token)
│       │   ├── theme-json.sh        #  theme JSON / customizer state
│       │   ├── jira-attachments.sh  #  Jira attachments → task workspace (read-only token; videos → frames)
│       │   ├── external-screenshots.sh #  screenshots a ticket LINKS (prnt.sc, imgur, …) → the same dir, allow-listed hosts only
│       │   ├── figma-rest.sh        #  one Figma node via the REST API (FIGMA_TOKEN) when no Figma MCP answers
│       │   ├── figma-node-slim.cjs  #  that REST node tree → compact markdown build tree
│       │   ├── _shopify-common.sh   #  sourced by the theme scripts + the two token runners (never run directly)
│       │   ├── gen-host-adapters.cjs #  writes every generated dir below
│       │   ├── doctor.cjs           #  static install verification, any host
│       │   └── ...
│       ├── references/           # shared docs the skills read
│       │   ├── jira-custom-fields.md
│       │   ├── review-flow.md    #  shared contract for the review/marker flow
│       │   ├── host-model-map.md #  GENERATED — tier → model, per host
│       │   └── ...
│       ├── rules/                # Cursor rule bundle (vendored foundation .mdc + fnd rules,
│       │                         #   the fnd-* session conventions GENERATED from hooks/)
│       ├── agents-cursor/        # GENERATED per-host agent variants — never hand-edit;
│       ├── agents-codex/         #   change agents/ (or the generator) and re-run
│       ├── agents-opencode/      #   scripts/gen-host-adapters.cjs
│       ├── commands-opencode/    # GENERATED /name shims (OpenCode invokes skills by model only)
│       ├── mcp.json              # GENERATED Cursor MCP config (+ mcp.pruned.json profile)
│       ├── mcp-codex.json        # GENERATED Codex MCP config (not `.mcp.json` — that
│       │                         #   name is a Claude Code plugin component)
│       └── opencode/             # OpenCode adapter + GENERATED model-profile examples
│                                 #   and mcp-fragment.json
├── scripts/
│   ├── bootstrap.sh              # one-command clone + per-host install / update / uninstall
│   └── install.sh                # Cursor / OpenCode / Codex-subagent installer
├── docs/                         # per-host quickstarts (install · update · what differs)
│   ├── README.cursor.md
│   ├── README.codex.md
│   └── README.opencode.md
├── tests/                        # committed test suites for the hooks + scripts
│   ├── no-verify-bypass-matrix.sh   #  FP/FN contract of the two commit guards
│   ├── hooks-sim.sh                 #  SessionStart / monitor-gate / context-stats sims
│   ├── scripts-sim.sh               #  runner + theme-json + converter-caller sims
│   ├── jira-attachments-sim.sh      #  jira-attachments.sh: creds, gateway, downloads, transient video frames
│   ├── external-screenshots-sim.sh  #  external-screenshots.sh: host allow-list, og:image, caps, downscale, cache
│   ├── figma-rest-sim.sh            #  figma-rest.sh: url parsing, token, degradation, out-dir gate
│   ├── figma-node-slim-fixtures.mjs #  REST node tree → build tree: lossless folds, size gate
│   ├── bootstrap-sim.sh             #  bootstrap: arg gates, clone, pty picker, uninstall
│   ├── adf-md-fixtures.mjs          #  ADF ↔ markdown converter fixtures
│   ├── json-slim-fixtures.mjs       #  mcp-slim pipeline + CLI + hook fixtures
│   ├── slim-engines.mjs             #  slim's engine library as pure functions + its contract
│   ├── html-slim-fixtures.mjs       #  slim's HTML engine
│   ├── slim-fixtures.mjs            #  slim's delivery: every channel end to end
│   ├── mods-sim.sh                  #  hooks module: validate --strict + plugin test (SKIP without claude)
│   ├── readme-checks.sh             #  README/docs: commands, paths, links, version markers
│   ├── fixtures/                    #  real captured payloads (secrets scrubbed)
│   └── parity/                      #  upstream-port parity fixtures + license NOTICE
├── CLAUDE.md                     # repo conventions (AGENTS.md is a symlink to it — the name Codex reads)
├── LICENSE
└── README.md
```

To add another plugin, create `plugins/<name>/` with its own `.claude-plugin/plugin.json`.
Then add an entry to `marketplace.json` → `plugins[]`.

> **Note on rules.** This plugin does **not** ship project coding conventions (`css-conventions`,
> `liquid-conventions`, `protected-core`, …). They live in the target repo under
> `.claude/rules/*.md`. The host attaches them automatically by their `paths:` globs when you
> edit matching files. The skills only say "follow the repo's coding rules", and the project
> supplies the rules. See [Skills + project rules](#how-global-skills-use-project-rules).

## Skills

| Skill | Invoke |
|-------|--------|
| `write-technical-approach`        | `/fnd:write-technical-approach` |
| `develop-feature-or-fix`          | `/fnd:develop-feature-or-fix` |
| `qa-feature-or-fix`               | `/fnd:qa-feature-or-fix` |
| `qa-preflight`                    | `/fnd:qa-preflight` |
| `write-steps-to-test`             | `/fnd:write-steps-to-test` |
| `create-pull-request`             | `/fnd:create-pull-request` |
| `ship`                            | `/fnd:ship` |
| `preview-theme`                   | `/fnd:preview-theme` |
| `worktree`                        | `/fnd:worktree` |
| `pre-commit-review`               | `/fnd:pre-commit-review` |
| `commit`                          | `/fnd:commit` |
| `preflight-checks`                | `/fnd:preflight-checks` |
| `save-task-context`               | `/fnd:save-task-context` |
| `fix-accessibility-issue`         | `/fnd:fix-accessibility-issue` |
| `get-breaking-changes`            | `/fnd:get-breaking-changes` |
| `fix-breaking-changes`            | `/fnd:fix-breaking-changes` |
| `update-translations`             | `/fnd:update-translations` |
| `report-plugin-issue`             | `/fnd:report-plugin-issue` |
| `smoke-test`                      | `/fnd:smoke-test` |

Skills are also **auto-invoked**. Claude reads the `description` of each skill and runs the
matching one when your request fits it. You do not have to type the slash command.

The `Invoke` column shows the Claude Code form. Cursor uses `/<name>`, and Codex CLI uses
`$<name>`. OpenCode invokes a skill by description (its native `skill` tool) or by `/<name>`
through the generated command shims. Auto-invocation by description works on all four hosts.

## Install — four hosts

The same plugin content runs on **Claude Code** (canonical), **Cursor**, **OpenAI Codex CLI**
and **OpenCode**. Every route ends the same way. The installer (or `/plugin install`) gives you
a checkout. `doctor.cjs` tells you whether the host will load it. One `smoke-test` run in a live
session checks the layers that a script cannot reach.

The table gives a one-line summary per host. The **Details** column links the full numbered
walkthrough for that host. The walkthrough starts before the host CLI is installed
(prerequisites, sign-in, which branch to check out) and goes through every config paste to the
smoke test. For a first install, open the doc for your host and follow it from top to bottom.
The sections below the table tell the same story in short form, for someone who did it before.

**Supported platforms.** The plugin runs on macOS and Linux, and on Windows only in WSL. The `.sh`
hooks, the guard scripts and the theme scripts need a POSIX shell (bash >= 3.2, `git`, `jq`). So
run the plugin inside WSL and point the host there. On a native Windows run, one `doctor.cjs` row
tells you this. The Node parts (the ADF converters, `json-slim`) need only Node and run anywhere.

**Fast path — one command.** On a clean machine, `scripts/bootstrap.sh` clones the repo and asks
which hosts to install for. Then it runs `install.sh` for each host and prints the manual steps
that remain. If the machine has the `claude` CLI, the Claude Code target adds the marketplace and
installs the plugins itself. Without the CLI, it prints the slash commands to run in a session.
Run it with:

```bash
curl -fsSL https://raw.githubusercontent.com/domaine-oleksandr-kever/claude-plugins/main/scripts/bootstrap.sh | bash
```

It clones into `~/tools/claude-plugins` and asks you to pick the hosts. `--dir <path>` puts the
clone in a different place. `--copy` tells `install.sh` to copy the plugin instead of linking it
with symlinks. A run that cannot prompt (CI, or output piped to a file) needs the hosts named on
the command line: `… | bash -s -- --targets cursor,opencode --yes`.

**Update** — to update, run the script again from the clone. `install.sh` pulls ff-only and
relinks. A `--copy` install refreshes only on such a run, and only if you give `--copy` **again**.
bootstrap does not remember the mode, so an update without `--copy` changes the install to symlinks:

```bash
./scripts/bootstrap.sh --targets cursor,opencode --yes
```

**Uninstall** — also from the clone:

```bash
./scripts/bootstrap.sh --targets cursor,opencode --uninstall
```

This removes only what `install.sh` created, and it keeps the clone. The per-host walkthroughs
below stay the full story. The fast path does the same steps, so you do not type them.

| Host | Install | Verify | Details |
|---|---|---|---|
| Claude Code | `/plugin marketplace add …` + `/plugin install` slim, band, base and the team plugins you need (fe, qa, be, pm) (legacy: `/plugin install fnd@domaine`), or `scripts/bootstrap.sh --targets claude` | `/base-doctor` + each team plugin's doctor (`/fe-doctor`, `/qa-doctor`, `/be-doctor`, `/pm-doctor`) (legacy: `/fnd:smoke-test`) | below |
| Cursor | Customize → Plugins → **Add Marketplace** (dev channel: `./scripts/install.sh --target cursor`; a Cursor bug currently ignores subagent model pins on every route — see the doc) | `/smoke-test` | [docs/README.cursor.md](docs/README.cursor.md) |
| Codex CLI | `codex plugin marketplace add …` **plus** `./scripts/install.sh --target codex` (subagents; Codex reads roles from `~/.codex/agents`, never from the plugin cache) | `$smoke-test` | [docs/README.codex.md](docs/README.codex.md) |
| OpenCode | `./scripts/install.sh --target opencode` | `/smoke-test` (command shim) | [docs/README.opencode.md](docs/README.opencode.md) |

`smoke-test` is a **run-once post-install check**. You do not run it in every session. It does
these steps:

1. It runs the doctor from inside the session.
2. It makes one cheap read-only call to each configured MCP server.
3. It starts one subagent.
4. It tries a `--no-verify` commit in a scratch repo and expects the host to block it.
5. It reports a pass/fail matrix with the fix for each failure.

`preflight-checks` is the check that you run again for each project.

`install.sh` takes `--plugin <name>` (default `fnd`). `slim`, `band`, `base`, `fe`, `qa`, `be` and
`pm` run on Claude Code only. They ship no Cursor, Codex or OpenCode adapter. So `install.sh --plugin slim`,
`install.sh --plugin band`, `install.sh --plugin base` and `install.sh --plugin fe` (and `qa`, `be`,
`pm`) exit 2 and point at `/plugin marketplace add …` + `/plugin install <name>@domaine`.

`scripts/install.sh --prune-cache [--plugin <name>]` removes Claude Code's stale cached versions of
each `<name>@domaine` (all recorded plugins by default) under
`${CLAUDE_CONFIG_DIR:-~/.claude}/plugins/cache/domaine/`. It keeps every version the install record
names and any version a live session holds (`.in_use/<pid>`), and prints
`<name> pruned=<versions>[ in_use=<versions>]`. Run it after `claude plugin install|update`.

### Claude Code — from the published Git marketplace (team use)

```text
# 1. Add the marketplace (you'll get a trust prompt — confirm it)
/plugin marketplace add domaine-oleksandr-kever/claude-plugins

# 2. Install the plugins from it, each dependency before what requires it
/plugin install slim@domaine
/plugin install band@domaine
/plugin install base@domaine
#    then the team plugins you need: fe, qa, be, pm
/plugin install fe@domaine
/plugin install qa@domaine
/plugin install be@domaine
/plugin install pm@domaine

# 3. Activate without restarting the session
/reload-plugins

# 4. Check the install, in a session: base's doctor, then each installed team plugin's
/base-doctor
/fe-doctor
/qa-doctor
/be-doctor
/pm-doctor
```

This is the set for new installs: slim + band + base, then the team plugins you need (fe, qa, be,
pm). The team plugins install side by side, and none of them requires another. fnd is legacy and
never runs with base or a team plugin. An existing fnd install keeps `/plugin install fnd@domaine`
and `/fnd:smoke-test` ([Which plugins to install](#which-plugins-to-install)). To move from fnd,
run `/plugin uninstall fnd@domaine` first. [fnd is frozen](#fnd-is-frozen) gives all the steps.

`/plugin marketplace add` shows a **trust dialog** the first time. The reason is that a
marketplace can ship hooks, commands and MCP servers that run on your machine. Review the source,
then confirm to add it to your trusted marketplaces. An admin can make it trusted for a whole team,
so that nobody has to confirm. To do this, the admin declares it in managed settings under
`extraKnownMarketplaces`.

`/plugin install slim@domaine` installs slim, which runs on Claude Code only. slim compresses large
tool results: MCP, Bash, Read, WebFetch, WebSearch, Grep, Glob and Agent. It also compresses data
pasted into a prompt and @-mentioned data files. It adds a `lookup` and a `view` tool.
[plugins/slim/README.md](plugins/slim/README.md) describes it and holds slim's complete switch table.

`/plugin install band@domaine` installs band, which runs on Claude Code only
([plugins/band/README.md](plugins/band/README.md)). band draws the status band above the prompt,
the event log pane and the Progress pane. Update fnd first. fnd 0.134.0 and earlier releases do not
yield to band and still draw their own band. Only one plugin's band can show above the prompt, so
the load order decides which one shows. fnd's `FND_BAND_COST` does not carry over. To keep the cost
segment, set `BAND_COST=1` in `~/.claude/settings.json` → `env`.

`/plugin install base@domaine` installs base, which runs on Claude Code only
([plugins/base/README.md](plugins/base/README.md)). base is the shared plugin that replaces fnd
together with a team plugin. It requires slim, and it never runs with fnd. So uninstall fnd first
(`/plugin uninstall fnd@domaine`). `/base-doctor` checks base from inside the session.

`/plugin install fe@domaine` installs fe, the frontend team plugin, which runs on Claude Code only
([plugins/fe/README.md](plugins/fe/README.md)). fe gives the Shopify theme skills, the
`fe:theme-explorer` agent, the project profile and store access. It requires base, and slim
through base, and it never runs with fnd. `/fe-doctor` checks it from inside the session.

Three more team plugins install the same way:

- `/plugin install qa@domaine` installs qa, the QA team plugin. It gives `/qa:preflight` and the
  read-only store-access posture ([plugins/qa/README.md](plugins/qa/README.md)).
- `/plugin install be@domaine` installs be, the backend team plugin. It gives `/be:app-scope`,
  `/be:shopify-resources` and `/be:platform-limitations` ([plugins/be/README.md](plugins/be/README.md)).
- `/plugin install pm@domaine` installs pm, the project-management plugin. It gives the project
  estimator, the estimator review, the merchant brief, solutions engineering and vendor evaluation
  ([plugins/pm/README.md](plugins/pm/README.md)).

Each of these three runs on Claude Code only and requires base (and slim through base). None of
them runs with fnd. Each has its own doctor: `/qa-doctor`, `/be-doctor`, `/pm-doctor`.

`scripts/bootstrap.sh --targets claude` does the same from a shell when the `claude` CLI is on PATH:

1. It runs `claude plugin marketplace add domaine-oleksandr-kever/claude-plugins`. If the
   marketplace is already there, it runs `claude plugin marketplace update domaine` instead.
2. It runs `claude plugin install <name>@domaine` for each plugin in the order above. For a plugin
   already installed at user scope, it runs `claude plugin update` instead.
3. The first failed install stops the rest, and the summary names that install.
4. Then restart Claude Code, or run `/reload-plugins` in an open session, and run the doctors.

The default set is slim, band, base and fe. `--plugins` names a different set, such as
`--plugins slim,band,base,qa,pm`. The install order stays as above, whatever order the list gives.
To update, run the script again. `--plugins fnd` installs the legacy fnd instead.

bootstrap refuses an install that names fnd together with base or a team plugin. On a machine where
fnd is installed and enabled at user scope, it warns and removes fnd first: `--yes` agrees to that,
a terminal is asked `[y/N]`, and a run with neither refuses and names the steps. An fnd synced from
claude.ai, a managed one, or a project or local copy is never removed by bootstrap: the install
stops and the summary names the steps. The reverse (fnd beside an enabled base or team plugin) is
refused the same way. When bootstrap cannot read `claude plugin list --json`, it skips that check
and writes a WARN in the summary. `--uninstall` runs `claude plugin uninstall` for each
plugin, dependents first, and keeps the marketplace. Without the CLI, bootstrap prints the block
above instead.

### Which plugins to install

fnd is frozen at 0.135.0 and supported until 2027-06-30, for blocking bugs only
([fnd is frozen](#fnd-is-frozen)). New installs are slim + band + base, then the team plugins you
need. fnd never runs together with base or a team plugin, because they ship the same agents,
skills and MCP servers.

| Plugin | For | Requires | Hosts |
|---|---|---|---|
| slim | everyone: large tool results compressed, the `lookup` and `view` tools | nothing | Claude Code only |
| band | everyone: the status band, the Log and Progress panes | nothing | Claude Code only |
| base | everyone on the new set: readers, writer, reviewers, workspace, guards, MCP servers | slim | Claude Code only |
| fe | the frontend team: Shopify theme work, from TA to PR | base | Claude Code only |
| qa | the QA team: `/qa:preflight`, the read-only store-access posture | base | Claude Code only |
| be | the backend team: app scope, Shopify resources, platform limitations | base | Claude Code only |
| pm | project management: estimates, merchant briefs, solutions engineering, vendor evaluation | base | Claude Code only |

The team plugins install side by side, and none of them requires another. The next table shows
the fnd side.

fnd works alone. slim and band add to it, and they also load without it. slim and band are only
Claude Code mods, so on Cursor, Codex and OpenCode only fnd applies.

| Installed | Status band | Event log pane | Progress pane | Classic context monitor | MCP compression |
|---|---|---|---|---|---|
| fnd | fnd draws it (`statusBand: false` hides it) | `/fnd-log`: fnd's lines | `/fnd-progress` | silent while fnd's module writes the session marker | fnd |
| fnd + slim | fnd draws it | `/fnd-log`: fnd's and slim's lines (fnd's compression lines read `fnd-slim`) | `/fnd-progress` | silent, as above | fnd, or slim with `FND_COMPRESSION=proxy` |
| fnd + slim + band | band draws it, fnd stands down; band's `disabled: true` hides it | `/band-log`: band's, fnd's and slim's lines | `/band-progress`; pin with `/fnd-progress <KEY>` | silent wherever band is loaded, drawn or not (a cloud session or `claude -p` too); speaks again under band's `disabled: true` | fnd, or slim with `FND_COMPRESSION=proxy` |
| band alone | band draws the figures and buttons; no digest, no Progress button | `/band-log`: band's lines (session, model, compact, rate) | none (`/band-progress` says no plugin publishes a checklist) | not installed (it is fnd's) | none |

fnd + band without slim works like the third row, but fnd compresses. Under band, `/fnd-log` and
`/fnd-progress` reply with a pointer to the band commands. fnd decides this once per process. If
you run `/plugin disable band` or `/plugin uninstall band` mid-session, fnd still stands down and
points at the band commands until the next session.

On the base side, band draws the task that base publishes. band also merges the lines of base and
the team plugins (fe, qa, be, pm) into `/band-log`. To pin a task, run `/base-progress <KEY>`.
band reads `base.progress` before `fnd.progress`.

### Claude Code — local development (from this folder on disk)

```text
/plugin marketplace add /path/to/claude-plugins
/plugin install fnd@domaine
/reload-plugins
```

The host reads edits to skill files in a local marketplace in the next session, or after
`/reload-plugins`. See [Updating](#updating).

### Cursor

To **use** the plugin, you do not need a clone. In Cursor, open
**Customize → Plugins → Add Marketplace** and give this repo's URL. Then click **Add** on the **fnd** card. Cursor installs
into its own cache and follows GitHub for updates (live-verified 2026-08-22). To **develop** the
plugin, or to run unpushed work, use a clone:

```bash
git clone https://github.com/domaine-oleksandr-kever/claude-plugins.git
cd claude-plugins
./scripts/install.sh --target cursor      # symlinks ~/.cursor/plugins/local/fnd
```

The installer pulls, links, and runs `doctor.cjs --target cursor` at the end. Read those rows.
On either route, reload the Cursor window (*Developer: Reload Window*), so that the manifest,
hooks and `mcp.json` load. Then run `/smoke-test` once in a chat.
[docs/README.cursor.md](docs/README.cursor.md) gives the full walkthrough, the update path and
the differences on this host.

### Codex CLI

Codex needs two channels, and both are required. The marketplace install carries skills, hooks
and MCP. The installer links the TOML subagents into `~/.codex/agents/`. Codex reads custom roles
only from there, never from the plugin cache (measured 2026-09-08, CLI 0.153.4). The plugin
manifest format has no key for agents.

```text
codex plugin marketplace add domaine-oleksandr-kever/claude-plugins
/plugins                                  # → install fnd
```

Then run the installer from a clone of this repo. Keep the clone, because the links point into it:

```bash
./scripts/install.sh --target codex       # link the subagents into ~/.codex/agents
```

The install cannot do the next steps for you:

1. Set `[features] hooks = true` in `~/.codex/config.toml`.
2. Do the trust review in `/hooks`. Codex asks for it again for each new content hash.
3. Start a new session and run `$smoke-test` once. Codex invokes skills with `$`.

[docs/README.codex.md](docs/README.codex.md) gives the full walkthrough. It also tells what makes
Codex ask for the trust review again.

### OpenCode

From a clone of this repo:

```bash
./scripts/install.sh --target opencode    # skills, agents, commands, plugin adapter
```

The installer links into `~/.config/opencode/` and runs `doctor.cjs --target opencode`. Then do
these steps yourself:

1. Paste two fragments into your own `opencode.json`: the `mcp` block from
   `plugins/fnd/opencode/mcp-fragment.json` and the `permission.bash` backstop from
   `plugins/fnd/opencode/permission-fragment.example.json`.
2. Start a new session and run `/smoke-test` once (the command shim).

[docs/README.opencode.md](docs/README.opencode.md) gives the details, including the optional
model-profile fragments.

### Verifying any install

`install.sh` runs the doctor for you at the end of every run. When an install stops working, run
the doctor again on its own:

```bash
node plugins/fnd/scripts/doctor.cjs --target <cursor|codex|opencode>
```

The doctor checks these points before any session:

- the install mode and the symlink targets;
- that all three manifests carry the **same** version stamp;
- that the generated dirs still match the generator;
- that the hook scripts are executable.

Together, these catch the failures where the clone succeeded but the host will never load it.
`smoke-test` then covers what a script cannot reach.

**Proving the hooks on a host.** The doctor tells you whether the host *will* load the plugin.
`FND_HOST_TRACE` tells you whether the hooks actually *fired* and what each hook decided. This
proof comes from a log, not from a model that reports on itself. To use it, do these steps:

1. Turn it on globally with `node plugins/fnd/scripts/domaine-env.cjs set FND_HOST_TRACE=1`
   (a global-only switch).
2. Open a new session on the host.
3. Run one throwaway `git commit --no-verify` in a scratch repo, and make one MCP call.
4. Read the log back:

```bash
node plugins/fnd/scripts/doctor.cjs --trace --since 2h
node plugins/fnd/scripts/doctor.cjs --report --since 7d   # the compression statistics, same log root
```

The output has one row per `event/hook` and one column per host. Each cell shows a count and its
decision breakdown. The commit-guard row must carry a `deny`. A hook that is silent there did not
run. `smoke-test` row 8 runs exactly this from inside a session.

`--report` is the other half of the proof. It shows what the compression hook actually saved, per
tool and per project. `json-slim.cjs --report` renders it from the `FND_MCP_SLIM_DEBUG` log in the
same root. You can combine the two flags.

### Cloud sandboxes — egress allowlist

A sandboxed host (Claude Code cloud environments, Cowork cloud sessions) runs the bundled scripts
behind an **egress allowlist**. A host that is not on the list shows up as a network error, not
as a missing feature. Allow these hosts:

| Host | Needed by |
|---|---|
| `api.figma.com` | `figma-rest.sh` — the node tree and the variables |
| `figma-alpha-api.s3.us-west-2.amazonaws.com` | the same script's renders and asset exports — Figma answers those with a pre-signed S3 url, so without this host the tree arrives and every image comes back `kind=image status=failed` |
| `api.atlassian.com` plus your `<site>.atlassian.net` | `jira-attachments.sh` — the gateway every authenticated call goes to, and the one unauthenticated `tenant_info` lookup on the site itself |
| `prnt.sc`, `prntscr.com`, `img.lightshot.app`, `imgur.com`, `i.imgur.com`, `gyazo.com`, `i.gyazo.com`, `share.cleanshot.com`, `snipboard.io` | `external-screenshots.sh` — the screenshot pages a ticket links and the CDNs their `og:image` points at; the script never fetches any other host |
| the store's `<store>.myshopify.com` | `shopify-admin-gql.sh`, `theme-json.sh` and the preview-theme scripts |
| `shopify.dev` | be's `shopify-docs.cjs` — the docs search on a host with no Shopify Dev MCP wiring |

**MCP traffic needs none of it.** The host reaches a connector server through Anthropic's
infrastructure, not through the container's egress. So the Figma, Atlassian and Shopify MCPs
keep answering in a sandbox where the REST fallbacks cannot.

**The global env file does not travel.** The scripts read `~/.config/domaine/env` inside the
container's own `$HOME`, and nothing copies a workstation's file into it. So set a
**global-only** switch (`FND_HOST_TRACE`, `FND_FIGMA_SOURCE`, the compression and guard gates)
as an environment variable of the cloud environment itself. The project file
`<repo>/.claude/domaine.env` comes with the checkout and keeps working unchanged.

### What's different per host

The content is identical on all hosts, but the wiring is not. Read each column against Claude
Code, the baseline. Nothing about Claude Code changed in the port. The per-host doc of each row
gives that row in full:

| | Cursor | Codex CLI | OpenCode |
|---|---|---|---|
| Session statics | always-applied `rules/*.mdc` | `SessionStart` hook, as on Claude Code | your `instructions` config / `AGENTS.md` |
| MCP result handling | **observe-only** — `afterMCPExecution` exposes no rewrite field, so nothing is compressed, stubbed or spilled (the shim logs `skip`) | replacement through the PostToolUse **block** channel (compress **and** spill-and-stub), reason capped at 16 KB; over-cap ⇒ stub, non-text block ⇒ `additionalContext` | in-place rewrite (compress **and** spill-and-stub) |
| MCP servers | all 6; `mcp.pruned.json` if the ~40-tool cap bites | all 6, no documented cap | all 6, pasted from `mcp-fragment.json` |
| Guard hooks | `beforeShellExecution` + `beforeMCPExecution`, deny + reason | `PreToolUse`; needs `[features] hooks` + `/hooks` trust; **absent on Windows** | `tool.execute.before` throw + `permission.bash` backstop, no MCP-level guard |
| Subagents | 1 level → hoisted ship shape | hoisted, genuinely concurrent | hoisted unless `subagent_depth` raised |
| Models | pinned per the Domaine guidelines | pinned (PROPOSED map, sign-off pending) | **no pins** — session model; optional profile fragment |
| Skill invocation | `/name` | `$name` | model-invoked + `/name` shims |
| Mods (fnd's module; the slim and band plugins) | none — the manifest names `hooks/hooks-cursor.json` | none — the manifest names `hooks/hooks-codex.json` | none — only `opencode/fnd-plugin.js` loads |

Three losses apply on all three hosts:

- There is no adversarial verify fan-out.
- There is no per-phase workflow telemetry.
- The context-usage monitor does nothing where the host gives a prompt hook no transcript
  (Cursor, OpenCode).

`plugins/fnd/references/host-orchestration.md` is the single home of the hoisted fallback.
`plugins/fnd/references/pipeline-phases.md` → Orchestration is the branch point.

### Host verification status — Cursor, Codex CLI and OpenCode are **unverified**

This status is frozen since 2026-09-07, by decision. The team works in Claude Code daily, and it
is the only host where we live-verify every release. The other three columns ship the same
content and wiring as at their last measurement. **No release since then has had a smoke test on
them in an interactive session.**

These facts *are* proven, from disk and not from a model that reports on itself:

- The hook layer fires on all four hosts (`FND_HOST_TRACE` matrix, 2026-09-06).
- A headless `cursor-agent` run accepted the Cursor deny path and both key spellings (2026-09-06).
- We ran the Codex and OpenCode install routes live once in August: the Codex marketplace add
  and the OpenCode installer, plus both host-trace columns.

Nobody has recorded a full `smoke-test` session on any of the three. These known gaps stay open
with the freeze:

- **Cursor** — `afterMCPExecution` is observe-only. The host documents no output-rewrite field
  for that event, so nothing is compressed, stubbed or spilled there (the shim logs `skip`).
  Injection of the `subagentStart` conventions is unconfirmed, because no headless run started a
  subagent. A Cursor bug with no fix date drops subagent model pins (see `docs/README.cursor.md`).
- **Codex CLI** — hooks need `[features] hooks` plus a `/hooks` trust, and some updates lose that
  trust. The model map is PROPOSED, and its sign-off is pending.
- **OpenCode** — there is no MCP-level guard and no verified MCP payload shape. Screenshots have
  no guard.

Treat those columns as best-effort. Install, run `doctor.cjs`, then run the `smoke-test` skill.
File what breaks with `/fnd:report-plugin-issue`. To verify a host again is separate work that we
must decide on: one live session per host, plus the fixes it finds. It is not part of the release
cycle. The per-host docs carry the same notice at the top.

### Marketplace posture

- **Claude Code** — the git marketplace in `.claude-plugin/marketplace.json`, unchanged. The team
  installs this way today.
- **Codex CLI** — this repo *is* a Codex marketplace. `codex plugin marketplace add <repo>` reads
  the same `.claude-plugin/marketplace.json` as a legacy-compatible location. So we publish
  nothing separate.
- **Cursor** — this repo imports as a Cursor marketplace (Customize → Add Marketplace;
  live-verified 2026-08-22, installs into `~/.cursor/plugins/cache/…`). The repo commits a root
  `.cursor-plugin/marketplace.json` with the same identity as the Claude one. The local-symlink
  route (`~/.cursor/plugins/local/fnd`) stays as the development channel.
- **OpenCode** — OpenCode has no marketplace primitive, so `install.sh` is the whole distribution
  channel.

### Plugin layer vs project layer

The plugin installs **once, in user space, and works in any project**. A project's own skills,
rules and agents sit on top of it. The two layers are **additive** on every host: a project
layer never disables the plugin, and the plugin never blocks project content. Three rules keep
this true:

1. **Plugin content self-gates.** Bundled rules stay glob-scoped or detection-gated. So in a
   non-Shopify project, the plugin stays silent and gives no theme guidance.
2. **Don't reuse fnd names project-side.** Claude Code puts skills in a namespace (`fnd:*`). The
   other hosts have no namespace, so a project skill or agent with the same name is ambiguous.
3. **Hook wiring lives in exactly one layer — the plugin.** All layers fire on every host. So if a
   project declares an fnd hook again, the hook runs twice; it does not override.

Conflicting *prose* is a docs problem, and no mechanism solves it. No host gives hard precedence
between layers. So keep plugin rules generic to Foundation, and let projects own their changes.

### Managing it on Claude Code

```text
/plugin disable fnd@domaine    # keep installed, turn off
/plugin enable  fnd@domaine
/plugin uninstall fnd@domaine  # remove the plugin
/plugin marketplace remove domaine    # remove the marketplace
```

You can do the same from a shell, outside a session. To apply the change, restart Claude Code, or
run `/reload-plugins` in an open session:

```bash
claude plugin disable fnd@domaine
claude plugin enable fnd@domaine
claude plugin uninstall fnd@domaine
claude plugin marketplace remove domaine
```

### Recommended Claude Code settings (copy-paste)

Two files give two scopes. Both are plain JSON, and every value inside `"env"` is a **string**:

- **`~/.claude/settings.json`** — your file, for all projects. The CLI and the desktop app's
  **Code tab** read the same files, so one edit covers both.
- **`<repo>/.claude/settings.local.json`** — this project only, and gitignored by convention.
  Put anything that names a path inside the repo here.

Paste this into the user file. If you already have an `"env"` block, merge the keys into it. Or
ask Claude Code to add these keys to `~/.claude/settings.json`, because it can edit its own
settings:

```json
{
  "env": {
    "MAX_MCP_OUTPUT_TOKENS": "50000",
    "FND_MCP_SLIM_DEBUG": "1"
  }
}
```

- `MAX_MCP_OUTPUT_TOKENS` — **optional, and your call.** The platform default is 25000 tokens.
  Above it, Claude Code spills the result to a file instead of giving it to the model, so the fnd
  compressor never sees it. A higher value sends bigger results through `mcp-slim` first. This is
  safe with the spill-and-stub guard in place. This decision is best made after a week of
  `json-slim --report` data.
- `FND_MCP_SLIM_DEBUG` — **optional diagnostics** (one JSONL line per compression). Use it
  together with `FND_MCP_SLIM_DIR`, which names a directory. Put that pair in the project file,
  `<repo>/.claude/settings.local.json`, not here:

```json
{
  "env": {
    "FND_MCP_SLIM_DEBUG": "1",
    "FND_MCP_SLIM_DIR": "/absolute/path/to/repo/.claude/fnd-tmp"
  }
}
```

Every `FND_*` switch also works from the Domaine env files.
[Environment switches](#environment-switches) is the single place that tells what each one means.

### Team rollout

Two routes install the new set for a whole team, so that nobody types `/plugin`. Both routes keep
fnd off.

**Settings route.** Merge these two keys into `~/.claude/settings.json`. Or merge them into a
repository's `.claude/settings.json`, so that everyone who opens that repository gets them. This
example is for the whole team, with every team plugin on:

```json
{
  "extraKnownMarketplaces": {
    "domaine": {
      "source": { "source": "github", "repo": "domaine-oleksandr-kever/claude-plugins" },
      "autoUpdate": true
    }
  },
  "enabledPlugins": {
    "slim@domaine": true,
    "band@domaine": true,
    "base@domaine": true,
    "fe@domaine": true,
    "qa@domaine": true,
    "be@domaine": true,
    "pm@domaine": true,
    "fnd@domaine": false
  }
}
```

- For one team, keep slim, band and base and enable only the team plugins it needs: fe, qa, be, pm.
- The key `domaine` is the marketplace's own `name` in `.claude-plugin/marketplace.json`.
- In a repository's `.claude/settings.json`, Claude Code registers the marketplace only after the
  workspace trust dialog for that folder. Never commit the file to a client theme repository
  without the client's agreement.
- Project settings outrank user settings. So `"fnd@domaine": false` in `~/.claude/settings.json`
  does not turn off an fnd that a repository's `.claude/settings.json` enables. Set it in that
  repository's `.claude/settings.local.json` instead.
- Auto-update is off by default for a third-party marketplace. `"autoUpdate": true` turns it on.
  The update runs in the background up to ten minutes after the first message of a session. It
  applies on the next launch. `DISABLE_AUTOUPDATER=1` or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`
  turns it off, unless `FORCE_AUTOUPDATE_PLUGINS=1` is also set. An update needs a new manifest
  `version`, and every release of this marketplace bumps it.

**Corporate route.** An admin puts the same keys in managed settings. There, `enabledPlugins`
`true` force-enables a plugin at every scope, and a user cannot turn it off. `false` blocks the
plugin at every scope and hides it. Claude Code registers the marketplace and installs the
plugins at the start of each user's next session, with no trust prompt.
`docs/managed-settings.example.json` is a ready policy: the two keys, a marketplace allowlist and
a trust message. There are three ways to deliver it:

- **Server-managed settings**: claude.ai → Organization settings → Claude Code → Managed settings,
  on Claude for Teams or Enterprise. An Owner or Primary Owner edits it. Claude Code fetches it at
  startup and every hour. It does not reach a user who runs through Bedrock, Vertex or Foundry, a
  non-default `ANTHROPIC_BASE_URL` or `apiKeyHelper`, or a Cowork session.
- **Endpoint file**: macOS `/Library/Application Support/ClaudeCode/managed-settings.json`, Linux
  and WSL `/etc/claude-code/managed-settings.json`, Windows
  `C:\Program Files\ClaudeCode\managed-settings.json`. It works on any plan. A file that is not
  valid JSON stops Claude Code from starting, so parse it before you deploy it.
- **MDM**: the macOS profile domain `com.anthropic.claudecode`, or the Windows `REG_SZ` value
  `HKLM\SOFTWARE\Policies\ClaudeCode\Settings`. Templates:
  [github.com/anthropics/claude-code/tree/main/examples/mdm](https://github.com/anthropics/claude-code/tree/main/examples/mdm).

The first source that delivers a policy key wins, in the order server, MDM, file.
`"managedSourcesBehavior": "merge"` (Claude Code 2.1.242 or later), set in the highest source,
combines them. Three managed-only keys complete the policy:

- `strictKnownMarketplaces`: the marketplaces a user may add. `{ "source": "github", "repo":
  "domaine-oleksandr-kever/*" }` admits every repository of that owner (Claude Code 2.1.223 or
  later). An allowlist blocks every marketplace it does not name, also the official Anthropic one.
  So the example names that one too. An allowlist without a `{ "source": "skills-dir" }` entry
  also stops skills-directory plugins. Such a plugin is a folder with a `.claude-plugin/plugin.json`
  under `~/.claude/skills/` or a project's `.claude/skills/`. So the example keeps that entry. An
  allowlist registers nothing; `extraKnownMarketplaces` does that.
- `blockedMarketplaces`: the marketplaces no user may add or install from.
- `pluginTrustMessage`: your text, added to the trust warning before an install.

Desktop local sessions read managed settings like the CLI. Cloud sessions read only server-managed
settings. A Cowork session on the user's machine reads the device policy (MDM or file), never
the admin console. A Cowork session in a full VM sandbox (`requireCoworkFullVmSandbox`) or a remote
Cowork session reads neither, so this policy does not reach it.

A team still on fnd sets `"fnd@domaine": true, "base@domaine": false, "fe@domaine": false,
"qa@domaine": false, "be@domaine": false, "pm@domaine": false`. A missing key turns nothing off.
In managed settings, the `false` keys also block and hide base and the team plugins. Never
enable fnd beside base or a team plugin.

## Updating

No host updates silently on push. No host gives a **proactive "new version available"
notification**. Two models cover all four hosts:

**Version-cache hosts — Claude Code and Codex.** The host clones from the git remote into a
cache with one entry per version. So to update, you run an explicit command and start a new
session:

```text
/plugin marketplace update domaine       # Claude Code, then /reload-plugins
codex plugin marketplace upgrade         # Codex, then a new session
```

- On Claude Code with **auto-update on**, the pull happens at startup, and the host asks you to
  run `/reload-plugins`. Turn it on or off per marketplace in `/plugin` → Marketplaces.
  Third-party marketplaces default to **off**, so use the command above.
- **Unpushed commits are invisible** on both hosts. They pull from the remote, never from your
  local folder. Push first, then update.
- The `version` field controls the update. If the version did not change, the host can show
  "nothing to update". `bump-version.cjs` (below) stamps every copy of it in one run.
- **Codex re-asks for hook trust** after any update that changes a hook command or its content,
  because the trust is per content hash. Until you approve again in `/hooks`, the guard layer
  does nothing.

**Live-checkout hosts — Cursor and OpenCode** (and the Codex subagent half). The install points
at your clone. So to update, run the installer again. It pulls and relinks in one pass:

```bash
./scripts/install.sh --target <cursor|opencode|codex> [--plugin <name>]   # --plugin defaults to fnd; slim, band, base, fe, qa, be and pm are Claude Code only
```

- Skills, references, agents and scripts apply on the **next read**. Changes to the manifest,
  hook wiring, MCP and rules need a **window reload** (Cursor) or a **new session** (OpenCode).
- There is no "reinstall". If a rename or deletion upstream removed an entry, the same run that
  pulled the change also prunes the entry.
- **`--copy` installs do not follow `git pull`**. To refresh one, run the installer again. The
  install report tells which mode is active. `doctor.cjs` fails a copy install whose recorded
  version is different from the checkout's version.

The two models work on one machine without conflict, because they read from different sources.

Nothing tells you that an update exists, so `preflight-checks` gives the reminder. It compares
the installed version with the version the host could install. On Cursor and Codex, it also
checks that the model ids pinned in that host's generated agents still resolve. Both rows are
advisory and never stop a workflow.

## Releasing — one command stamps every version

Current release: **fnd v0.135.0**.

Several per-host packaging files carry a copy of the version. If one stamp drifts, a host can
read it as "nothing to update". One script owns all of them. Run it instead of editing any
manifest by hand:

```bash
node scripts/bump-version.cjs minor --plugin fnd       # or major | patch | 0.60.0
node scripts/bump-version.cjs 0.60.0 --plugin fnd --dry-run   # report, write nothing
node scripts/bump-version.cjs 0.2.0 --plugin base      # another plugin in the monorepo
```

`--plugin` is required. A run without it exits 1 with the usage. The reason is that every
marketplace plugin auto-updates on its own version, and a guessed plugin would ship a release
that nobody meant. fnd's own copy, `plugins/fnd/scripts/bump-version.cjs`, still defaults to
`fnd`. The table below lists fnd's targets.

For any other plugin, the script stamps `plugins/<name>/.claude-plugin/plugin.json`. This file
is required and canonical. If it is missing, the run exits 1 as an unknown plugin and lists the
plugins that are present. The script also stamps these optional targets when they exist:
`plugins/<name>/.cursor-plugin/plugin.json`, `plugins/<name>/.codex-plugin/plugin.json`, and the
`<name> v<semver>` marker in `README.md` and `plugins/<name>/README.md`. It never touches fnd's
stamps.

The script stamps all or nothing: a failure on any target writes nothing. The fnd targets are:

| Target | What is stamped |
|---|---|
| `plugins/fnd/.claude-plugin/plugin.json` | `version` — canonical, the base for `major`/`minor`/`patch` |
| `plugins/fnd/.cursor-plugin/plugin.json` | `version` |
| `plugins/fnd/.codex-plugin/plugin.json` | `version` |
| `README.md` | the markers `fnd v<semver>` and a double-quoted `FND_VERSION=` assignment |
| `scripts/install.sh` | every double-quoted `FND_VERSION=` assignment |

The script recognizes only those two literal marker forms. It silently skips a version written
in any other way (`fnd 0.60.0`, `version: 0.60.0`), forever. So when you add a version string to
the docs, use one of these forms exactly. For the same reason, `docs/README.*.md` are
**version-free** by design. They are not stamped targets, so a version literal there would drift
on the next release (`tests/readme-checks.sh` fails such a literal). There is also a reverse
effect. Every quoted `FND_VERSION=` assignment in a stamped file becomes a constant. So assign a
shell variable of that name without quotes.

Then verify the packaging before you commit:

```bash
node plugins/fnd/scripts/doctor.cjs      # manifests present, versions equal, hooks runnable
bash tests/layout-assertions.sh
bash tests/readme-checks.sh              # install commands, referenced paths, links, stamps
bash tests/mods-sim.sh                   # every plugin's hooks module: validate --strict + kit tests (local only; SKIP without claude)
node tests/slim-fixtures.mjs             # slim's core on the real fixtures
```

## How global skills use project rules

A common question: *if the plugin is installed globally, do its skills still use the project's
rules?*

**Yes.** The skills do **not** hardcode paths to the rule files. Their prose refers to "the
repo's coding rules". The **project context** loads the actual rules, not the skill:

- The plugin (global) gives the **workflow**: the steps of each skill.
- The target repo's `.claude/rules/*.md` give the **conventions**. Claude Code attaches each rule
  automatically when you touch a file that matches its `paths:` glob (e.g. `css-conventions` when
  you edit a `*.css`).

So when you run a skill inside `elc-theme`, you get both: the global workflow and the project's
native rules. In a repo without those rules, the same skill follows general best practices. The
bundled `references/` docs (Jira field IDs, TA format) travel **with the plugin**. The skills read
them through `${CLAUDE_PLUGIN_ROOT}`, so they always resolve, whatever the install scope.

## Concepts: commands vs skills vs agents

### Commands vs skills

Both are Markdown files with frontmatter. They differ in **who triggers them** and **where they
run**:

| | **Command** (`commands/*.md`) | **Skill** (`skills/<name>/SKILL.md`) |
|---|---|---|
| Trigger | **You** type `/name` explicitly | **You** type `/name` **or Claude auto-invokes** it by matching `description` |
| Best for | A fixed action you run on demand | A capability Claude should reach for when the task fits |
| Extra files | Single `.md` | A folder — can bundle `REFERENCE.md`, `scripts/`, etc. |
| Runs in | The main conversation | The main conversation |

Rule of thumb: if you want Claude to *decide* when to use it, write a **skill**. A skill has a
`description` that Claude can find, and it can carry supporting files. If you only start it
manually, a **command** is the lighter option. This plugin ships skills, because Claude should
select the Foundation steps on its own.

### Agents (subagents)

An **agent** is a separate Claude instance with its own context window, its own system prompt
and its own restricted toolset. The main conversation **delegates a self-contained task** to it.
The agent works in isolation and returns only its final result. Use agents for two purposes:
(a) to keep heavy or noisy work out of the main context; (b) to run focused, read-only analysis
with a tailored prompt.

A plugin ships agents as `agents/<name>.md`:

```markdown
---
name: change-reviewer
description: Reviews the branch's changed files (Liquid / TS / CSS) against Foundation conventions. Invoke before a commit or PR to catch core-file violations, stale comments, and schema mistakes.
model: opus
effort: medium
tools: Read, Grep, Glob, Bash
---

You are a Shopify theme reviewer for the Foundation codebase.

Given a set of changed files, check them against Foundation conventions:
- Never modify `src/entry/core/*` or `blocks/core-*.liquid` directly — flag any direct edits.
- Verify snippet params have LiquidDoc + defaults.
- Verify schemas are authored in `schemas/` (TS), not hand-edited in compiled output.

Return a concise findings list grouped by file, each with severity and a fix.
Your final message IS the result handed back — return data, not chatter.
```

**How it's used:**

- **Auto-delegation** — when your request matches the agent's `description` ("review my
  changes"), Claude starts the agent automatically.
- **Explicit** — ask directly: *"use the change-reviewer agent on my staged changes."*
- **Isolation** — here the agent can only use `Read/Grep/Glob/Bash` (no `Write`). So it analyzes
  without touching files. If an agent must edit files in parallel with the main session, add
  `isolation: worktree`, so that the two do not collide.

Agents differ from skills. A **skill** runs inline in the main conversation and steers *your*
Claude. An **agent** is a *separate* Claude with its own context, to which you give a task. Agents
are ideal for parallel, sandboxed or token-heavy subtasks.

**Shipped agents.** This plugin ships six subagents that are read-only toward their sources
(`doc-reader` writes only its own workspace extract). It also ships the write-side `jira-writer`.
All of them keep heavy or noisy work out of the main context:

- **`change-reviewer`** — reviews a diff for stale comments, refactors and conformance to the
  project rules. On large diffs, the review flow starts one agent per file group. Its Foundation
  core rules (`protected-core`: `src/entry/core/*` a blocker, the Liquid core a hand-sync
  warning) apply only when the brief's `profile:` says `foundation`. On a plain Shopify theme, it
  reports only the project's own rules.
- **`bug-hunter`** — an adversarial correctness review of a diff. It reads the base classes,
  event listeners and sibling paths that the change interacts with. It returns verified findings,
  each with a concrete failure scenario (races, merchant-invariant bypasses, state divergence).
  It runs in parallel with `change-reviewer` (pre-commit), as the PR backstop, and together with
  live QA in the ship pipeline.
- **`jira-reader`** — fetches a Jira ticket through the Atlassian MCP: fields, comments and
  attachments. It returns them as clean structured data and keeps the raw ADF and the downloaded
  bytes out of context (see "Jira comments + attachments").
- **`jira-writer`** — the write-side mirror. It writes one **approved** value with a single
  call: a rich-text custom field through `editJiraIssue`, or a comment through
  `addCommentToJiraIssue` (`contentFormat: "adf"`). It converts the markdown to ADF first. So the
  large payload stays in its disposable context, not in the main loop. Writer skills delegate to
  it **after** the ✋ approval. The gate stays in the skill, and the agent never authorizes.
- **`figma-reader`** — reads **one** Figma frame and returns a compact build spec. It picks its
  source itself, in a fixed order: the remote/connector Figma MCP → the local Dev Mode bridge →
  the **REST API** with the repo's own `FIGMA_TOKEN`. So a closed desktop app or an unattached
  connector no longer stops a design read. The return names the rung (the source step) that
  answered: `source: mcp-connector | mcp-desktop | rest`. On the REST rung, the payloads go to
  the workspace `tmp/figma/`, and `scripts/figma-node-slim.cjs` turns them into a compact build
  tree. No raw node JSON ever enters the context. If no source is reachable and there is no
  token, it writes one hint line in `needs_clarification` and never guesses
  (`plugins/fnd/references/figma-rest.md`). When a ticket has several URLs, the skill starts
  **one per URL, in parallel**.
- **`doc-reader`** — reads **one** linked doc (Notion with its sub-pages, Confluence, or any web
  URL). It returns a task-focused extract and saves it to the workspace `doc-<slug>-<hash>.md`
  itself. The skill starts **one per link, in parallel**, and the raw pages never enter the main
  context (`references/reading-linked-docs.md`).
- **`theme-explorer`** — a planning scout. It reads the project's `.claude/rules` and the theme
  layout, and returns an impact map (relevant files, patterns, new files, rule constraints). It
  covers breadth; the main loop reads the load-bearing files itself. Like `change-reviewer`, its
  brief carries the checkout's `profile:`, so the Foundation core rules do not apply to a plain
  Shopify theme.

In `develop-feature-or-fix`, these agents run **in parallel** during Phase 1 when the task scope
is already clear. They read the ticket, the design and the codebase at the same time. The block
above is approximately the definition of `change-reviewer`.

## Review flow (pre-commit / commit / PR)

`pre-commit-review`, `commit`, and `create-pull-request` share one review contract
(`references/review-flow.md`):

- **Split by files, not checks.** Mechanical checks (Jira task numbers, untracked referenced
  files) run inline. The judgement checks (stale comments, refactors, conformance to the project
  rules) go to the `change-reviewer` agent. A small diff gets one agent; a large diff gets one
  per file group, in parallel. The review reads each file once.
- **Correctness pass.** When the diff touches JS/TS logic or Liquid control flow, the
  `bug-hunter` agent runs in parallel. It hunts for real bugs, and each finding carries a
  concrete failure scenario. Its primary home is `pre-commit-review`. `create-pull-request` is
  the backstop: it runs the agent only if the marker shows that the pass is missing or stale.
  Each correctness finding gets a decision: fixed, justified as a named ceiling in the PR body,
  or explicitly waived. No finding is silently dropped.
- **Once per branch.** A tiny marker per branch at `<git-dir>/.fnd-review` records that a
  branch was reviewed. The flow finds it through `git rev-parse --git-dir`, so linked worktrees
  work too. The marker is never committed, and each review overwrites it. The **first** review
  on a branch runs in full. **Later** runs ask the developer `[ full / only changed files / skip ]`.
  So `commit` and PR creation do not review checked work again.
- **PR conformance gate.** `create-pull-request` runs the agent with a focus on conformance. On
  a `foundation` checkout, a `protected-core` **blocker** (a direct edit to `src/entry/core/*`)
  stops the PR until you resolve it. The Liquid core gives a hand-sync warning. On a plain
  Shopify theme, the agent writes neither row.

## Auto mode — `/fnd:ship`

One command takes a ready ticket to an open PR: `/fnd:ship ELC-206`. It asks every question
first, in one batched interview. It takes a **single approval** on the implementation plan and
the QA checklist. Then it runs the whole series autonomously. It escalates only for the blocker
classes of an explicit contract:

- missing access;
- AC contradictions;
- destructive actions outside the pre-authorized list;
- `protected-core` blockers from the conformance review;
- scope growth beyond the ticket;
- QA failures that remain after the fix cap;
- a code change that a party outside the session asks for.

Aftercare acts on its own for one signal only: a **failing CI check**. When a PR or bot review
comment asks for a code change, ship **drafts** the change into `notes.md` and hands it to the
developer. It never commits, pushes or deploys that change autonomously. The contract is in
`references/pipeline-mode.md`, and the phase briefs are in `references/pipeline-phases.md`.
Ship loads the briefs only after the approval gate, so a run that stops there never pays for
them.

The conductor session stays thin. The heavy phases run in **fresh-context subagents** that read
the per-ticket workspace again. So long runs never depend on what survives context compaction.
Run ship with the **strongest session model available (Fable recommended)**. The conductor stays
on the session model by design, and every phase agent is pinned (`references/pipeline-mode.md` →
Phase-agent models). So the model you pick improves the planning and synthesis context, and the
phase-agent cost does not rise. Ship writes the same workspace artifacts and ticks the same
`progress.md` rows as the solo skills. So you can continue an interrupted run with the solo
series, with nothing to undo. If you run `/fnd:ship` again, it compares the state with ground
truth (git, `gh pr view`, Jira) and resumes.

**When to use which:** use the solo series when you want to steer each step (checkpoints,
offer-next). Use `/fnd:ship` when the ticket is well specified (Description + AC + approved TA +
Figma node), and you want ship to handle the PR, Steps to Test and the review-bot round from end
to end.

```mermaid
flowchart TD
    A["/fnd:ship &lt;ticket&gt;"] --> B{"Step 0 — preflight<br/>MCP · CLI · dev server · permissions ·<br/>store-access probe · clean context"}
    B -- fail --> B0["stop: fix environment<br/>(nothing half-started)"]
    B -- pass --> C["ingest in parallel<br/>jira-reader · figma-reader ·<br/>doc-reader · theme-explorer"]
    C --> D["interview (AskUserQuestion)<br/>ticket-specific + policy set"]
    D --> E["pipeline.md (status: draft)<br/>decisions + escalation contract"]
    E --> F{"✋ the only gate<br/>plan + QA checklist"}
    F -- "approved (arms active)" --> G
    subgraph AUTO["autonomous — each phase = fresh-context subagent; conductor keeps decisions + reports only"]
        G["implement<br/>(plan-driven)"] --> H["qa — extend + run the checklist<br/>break-it + parallel bug-hunter"]
        H -- "blocking fail · cap 2" --> G
        H -- pass --> I["finalize<br/>review checks → commit"]
        I --> K["create PR<br/>+ preview theme"]
        K --> L["write steps to test<br/>(fills the bot wait)"]
        L --> M{"PR aftercare<br/>CI checks · bot feedback"}
        M -- "findings · cap 2" --> N["CI check fails → fix → refresh preview →<br/>verify → commit + push;<br/>comment-driven change → draft in notes.md →<br/>reply + resolve, hand to developer"]
        N --> M
    end
    M -- "clean / timebox" --> O["Jira hand-off comment<br/>clickable PR link · edge cases ·<br/>why-nots · open questions"]
    O --> P["final report<br/>pipeline.md → done"]
    AUTO -. "blocker classes only" .-> Q(["escalate via AskUserQuestion<br/>answer → continue"])
```

## Parallel ship via git worktree

A ship run owns the repo it starts in: a dirty tree, the dev server on port 9292, and the
`theme =` line in `shopify.theme.toml` that the session-theme pin rewrites. It also owns the
session for the whole run. `plugins/fnd/scripts/worktree-setup.sh` moves the run into a
**linked git worktree** (shared `.git`, no clone, instant setup). So the main checkout and the
main session stay free for other work:

```text
worktree-setup.sh <WORK-ID> [<base-branch>]     # default base: develop
worktree-setup.sh --remove <WORK-ID> [--force]
```

`<WORK-ID>` is a Jira ticket key (`ELC-206`) **or** a kebab-case slug (`header-refactor`). It is
the same work-id that the task workspace uses, because not every worktree belongs to a ticket.

Create mode does the whole setup in one pass:

- **The worktree.** It creates the worktree as a **sibling** directory (`../<repo>-<WORK-ID>`)
  on branch `feat/<WORK-ID>` off `origin/<base>`. If no remote-tracking ref exists, it uses a
  local `<base>`. If a local or remote branch of that name exists, it checks that branch out and
  never makes a duplicate.
- **Dependencies.** It runs `npm ci` when the repo has a `package.json`.
- **`shopify.theme.toml`.** It **copies** this gitignored config, which a fresh checkout cannot
  have. So the session preview theme id that the pin step writes later goes into the worktree,
  and the main checkout's dev environment stays as it is. If the source checkout already had a
  pin, the copy undoes it (`toml_unpinned=yes`). So this stream starts from the shared dev theme
  and does not inherit the preview of another stream.
- **`.env`.** It **copies** this gitignored file too. Without it, every Admin API read from the
  worktree would fail on a missing token.
- **`.claude/tasks`.** It **symlinks** the worktree's `.claude/tasks` to the main repo's. So the
  two checkouts share the task workspace, and the workspace survives the removal of the worktree.
  The link is git-excluded, so it never reaches a commit.
- **`.claude/settings.local.json`.** It copies this file and does not share it, because two
  sessions that approve permissions into one file would race.
- **The dev port.** It picks a free dev port from 9293 upward and records it as a `dev-port:`
  line in the shared workspace, where the ship session finds it. A port counts as taken when
  something listens on it **or** the workspace of another work-id already recorded it. The
  reason is that the dev servers start only later, by hand, in the new sessions. The script
  writes the line right after it registers the worktree, before `npm ci`. So a parallel setup
  that starts during the install already sees the claim.

A second run for the same work-id is idempotent: for an existing worktree, it only prints the
hand-off block again.

Its own port gives half of the isolation. Its own **session preview theme** gives the other
half. The setup offers that theme once, and the dev server, QA and the PR table all use it.
Without it, both sessions would sync their branches into the single theme id that the copied
`shopify.theme.toml` names, and each would overwrite the other's preview. See
[Session preview theme](#session-preview-theme). A theme per stream does not raise the
≈2-runs-per-store ceiling below, because Shopify's rate limit is per store + token, not per theme.

`--remove` refuses a dirty worktree or a detached HEAD unless you pass `--force`. In the detached
case, it prints the HEAD sha for recovery. By design, it touches neither the shared task
workspace nor the preview theme (`create-preview-theme.sh` reaps its own orphans).

`/fnd:worktree` is the thin skill in front of all this. It gets the work-id from your message or
the conversation, runs the script, and relays its output verbatim.

The launch flow has three steps. Only the first step happens in your current session:

```text
# 1. in the main checkout — the hand-off block it prints includes
#    the session theme id and the dev-server line, ready to paste
/fnd:worktree ELC-206

# 2. a NEW terminal
cd ../my-theme-ELC-206 && claude

# 3. inside that session
/fnd:ship ELC-206
npm run dev -- --theme <session-theme-id> --port 9293   # from step 1's hand-off
```

Step 2 is only an example. Paste the `cd` line that the script prints (an absolute, quoted
path), and do not type it again. The dev-server line is the line from the hand-off of step 1,
with the id and port filled in. In a `foundation` checkout, the hand-off prints the `npm run dev`
form above. In any other checkout, it prints `shopify theme dev`. It uses the same
`scripts/project-profile.sh` probe as the session's `fnd project profile:` line. If the probe
cannot be read, it falls back to the `npm run dev` form. Without `--theme`, the server syncs the
branch into the shared dev theme that the copied config still names.

A session cannot move itself into another directory, so you open the second terminal yourself.
Nothing starts automatically. `/fnd:ship` knows about the split. When it starts **in a
worktree**, it says nothing. When it starts **in the main checkout**, it offers the isolation
once. It can run the setup script for you and then stop, so that you can move over. If you say
"no", it accepts that.

**How many at once:**

- **≈2 ships per store.** Shopify's theme rate limit is per store + token. A running
  `shopify theme dev` uses the same budget as every preview-theme push, and this contention
  causes half-broken previews. Two concurrent runs on one store is the practical cap. It helps to
  stagger the preview-theme phase rather than start both runs in the same minute. Nothing new guards this.
  The preview script's throttle retries and its reap of created-theme orphans stay the
  mitigation, and they already run.
- **Different stores don't contend.** There, only your machine limits the parallelism.
- **Usage limits are shared.** Every parallel session bills the same Claude subscription. So N
  ships use up the plan's limit ≈N× as fast. Worktrees give isolation, not extra quota.

## Session preview theme

Each work stream gets one theme. `shopify theme dev -e dev` targets the theme id in
`shopify.theme.toml`, which is shared config. So two sessions on one repo push two branches
into the *same* remote theme, and each overwrites the other's preview. For this reason,
`/fnd:ship` and `/fnd:worktree` ask once, at the start, which theme the stream owns. You can
create one now (`create --name "[ELC-206] Kever | Domaine" --reuse`, the same naming convention
as the PR table). Or you can give an existing theme id.

The skill **pins** the answer into that session's `shopify.theme.toml`. It also records it as a
`session-theme: <id>` line in the `notes.md` of the shared task workspace, next to the
`dev-port:` line. A later `/fnd:ship` or `/fnd:worktree` finds that line and stops asking. It
silently runs `pin --theme <id>` again, so that its current checkout is pinned too. The reason
is that checkouts share the workspace, so a recorded id is not always a pinned one. A second pin
of the same id changes no byte.

From then on, everything targets that one theme:

- The start command that the skills give you becomes `npm run dev -- --theme <id> [--port <N>]`
  in a `foundation` checkout. In any other checkout, it is
  `shopify theme dev --theme <id> [--port <N>]`, or the repo's own dev script when its
  `package.json` defines one. The explicit flag *and* the pinned toml both apply, for double
  safety.
- The qa phase **refreshes** the session theme for its `preview-theme` rows and does not build
  a second one.
- `create-pull-request` puts the theme in the theme-preview table and does not create one
  automatically. A recorded session theme now outranks auto-creation in the "Args win"
  precedence.

`create-preview-theme.sh` does the pinning. Both forms validate the id against the store and
refuse the **live** theme. When the store listing is unavailable, the behavior depends on the
command:

- The standalone `pin` refuses (`error=theme_unverifiable`) and leaves the config unchanged. A
  pin persists, so the script never applies it unvetted. Retry later.
- A fresh `create --pin-toml` proceeds.
- `refresh --pin-toml` proceeds only for a recorded session theme or with `--allow-unverified`.
- `--reuse --pin-toml` proceeds only with `--allow-unverified`.

A pin that proceeds this way carries the flag `warn=pin_unvetted`:

```text
create-preview-theme.sh pin --theme <ID> [--env <name>]           # pin only, no push
create-preview-theme.sh create --name "<NAME>" --reuse --pin-toml
create-preview-theme.sh refresh --theme <ID> --pin-toml
```

Under that outage (a silent listing, or a listing that names no theme at all), `refresh` proceeds
only for an id that a workspace under `.claude/tasks` records as `session-theme:`. The script
refuses any other id, and every `create --reuse` (a name lookup has no such exemption), with
`error=refresh_unverifiable` / `error=reuse_unverifiable`. A developer can pass
`--allow-unverified` to override these two refusals. It overrides only these two, never the
live-theme guard and never the dev-theme guard. The pipeline never passes it.

The dev-theme guard is the other refusal of the script. It refuses a `refresh` / `--reuse` whose
target is an id that the toml names as the shared dev theme (`error=dev_theme_write_refused`).
Such an id is the settings source of the toml (unless pinned by hand) or an id that a pin
superseded. The guard does not refuse when a workspace records that id as a session theme. Its
only override is `--allow-dev-theme`, for developers only. Both overrides are command flags, not
environment switches.

The rewrite is **scoped to one environment block**, because the Shopify CLI reads this file that
way. `shopify theme dev -e dev` resolves `theme =` inside `[environments.dev]`, not the first one
in the file. The run writes to the same block from which it READ its store, dev theme id and
token. This single resolution means that a preview can never go to the store of one environment
and its pin into another. The resolution order is:

1. `--env <name>`;
2. `$SHOPIFY_FLAG_ENVIRONMENT`, the CLI's own selector. An exported value redirects the write as
   much as the read, `[environments.production]` included;
3. the block named `dev`;
4. the block named `development`.

The match is by name only. If none of these is present, the script refuses even a lone block
under any other name (`error=ambiguous_env`) and does not guess. To write a preview id over
`[environments.production]` without a request would lose that theme's id and leave the dev
server unpinned. A toml with no `[environments.*]` blocks, but with uncommented top-level
`theme =` / `store =` keys, gets the pin at the top level (reported as `pin_env=-`). The script
never touches the blocks that it does not target.

Inside the chosen block, the first uncommented `theme =` line takes the session id. The script
keeps the value that it replaced right above it, on a commented `# … # fnd:superseded` line, and
reports it as `superseded_theme_id=`. This file is gitignored, so without this line nothing would
record an overwritten dev theme id. The script also does these steps:

- It comments out duplicate `theme =` lines in the same block and keeps their values. It reports
  their count as `commented_dupes=`.
- To a block with no `theme =` line, it appends one with the tag `# fnd:session-theme`. The
  session owns that line, so a later pin only replaces its value, and an unpin deletes it.
- A second pin of the same id leaves the file byte-identical.
- Nothing else changes, also not the `password =` Theme Access token. The script never prints or
  returns that token.
- On `create` / `refresh`, the pin runs last, after the push succeeded. The script vets the id
  again before it writes it. If the pin fails, the script reports `pin=failed`. It does not lose
  the id of a theme that now exists on the store.

Two consequences are important. First, `create` takes the **customizer settings** from the theme
that the toml points at; the code always comes from your branch. So after the session theme is
pinned, a later `create` reads its settings from the session theme itself, not from the shared
dev theme. For this reason, the flow creates once and **refreshes** from then on. A refresh
pushes only code and does not change the settings.

Second, a new worktree starts **unpinned** by design. `worktree-setup.sh` copies the config of
the source checkout and reverts every pin that it finds there, in both shapes. It restores the
`fnd:superseded` markers and deletes the `fnd:session-theme` lines (`toml_unpinned=yes`). `=no`
means that the source was never pinned, unless `warn=toml_unpin_failed` says that the revert
failed. So a second work stream inherits the shared dev theme and not the in-progress preview of
the first stream. A hand-written theme id for which `pin` reported `pin=unchanged` carries no tag,
and the script does not revert it.

To restore a pin by hand, do the same edit. Uncomment the `# … # fnd:superseded` line and remove
the pinned line below it. Delete an appended line with the tag `# fnd:session-theme`. Pin and
unpin are in one file, `plugins/fnd/scripts/session-theme.sh`. So the writer and the reverter of
that grammar cannot disagree.

## Bundled MCP servers

The plugin declares the MCP servers that the skills and agents use (`plugin.json` →
`mcpServers`): `atlassian` (Jira), `figma-dev-mode`, `shopify-dev-mcp`,
`chrome-devtools-mcp`, `playwright`, `notion-mcp`.

- **Install the plugin at user (global) scope**, and these servers are available in **every**
  project. You do not need a `.mcp.json` in each repo.
- **Authentication is per user and cached** (keychain). Authenticate Atlassian / Notion **once**
  through `/mcp`. The sign-in persists across projects and sessions, so you do not authenticate
  again when you switch repos.
- `playwright` starts with `--output-dir .claude/fnd-tmp/playwright`. The path is relative to
  the project, where the host starts the server. Everything that it writes without a given path
  goes there: a `browser_take_screenshot` with no `filename`, the `.yml` snapshot dumps, console
  logs, session and trace files. Without the flag, these files would go to
  `<cwd>/.playwright-mcp/` as untracked litter in the checkout.
  - The `mcp-slim` TTL sweep prunes that directory on the same clock as the spills
    (`FND_MCP_SLIM_TTL`). When the directory exists, the sweep also stamps `/.claude/fnd-tmp/`
    into the repo's `.git/info/exclude`, unless git already ignores it. This stamp is local, so
    your tracked `.gitignore` does not change.
  - For this to work, two working directories must name the same place. The server resolves the
    relative flag against its **spawn** cwd, and the sweep uses the cwd of the hook **event**.
    Every host starts the server in the project dir (live evidence: one output dir per checkout,
    worktrees included).
  - The one exception is a move into a worktree mid-session. The running server keeps writing into
    the checkout where it started, and the next session of that checkout sweeps it. The exclude
    stamp goes into the common git dir, so both worktrees hide the directory.
- `figma-dev-mode` is the local Dev Mode SSE server. It works whenever the Figma desktop app is
  open in Dev Mode (no auth). It is **one rung of three** (one step of the source ladder), not
  the only path. `figma-reader` prefers a remote/connector Figma server (`mcp__figma__…`,
  URL-driven, no desktop app) when one is attached at user or project scope. When neither MCP
  answers, it falls back to the Figma **REST API** with a per-developer `FIGMA_TOKEN` from the
  repo's gitignored `.env`. So any one of the three alone is enough. `FND_FIGMA_SOURCE` forces a
  rung. `plugins/fnd/references/figma-rest.md` describes the token setup, the degradation and the
  compactor.
- If you already configured any of these servers at user or project scope, that scope wins. The
  host ignores the plugin's declaration, with no harm.

> OAuth servers need a browser sign-in, so they are not available in headless or
> non-interactive runs.

### The same list on the other hosts

`plugin.json` → `mcpServers` is the **only** server list that people edit by hand. Each other
host reads a generated translation of it. `scripts/gen-host-adapters.cjs` writes these files, and
the repo commits them with the other generated adapters. Never edit one by hand. Add the server
to `plugin.json` and run the generator again:

| File | Host | Shape |
|---|---|---|
| `plugins/fnd/mcp.json` | Cursor | auto-discovered at the plugin root; `type: "stdio"` spelled out |
| `plugins/fnd/mcp.pruned.json` | Cursor | the priority profile below — a reference file, not loaded |
| `plugins/fnd/mcp-codex.json` | Codex CLI | `mcpServers`, carried as-is except the SSE→streamable-HTTP rewrite for `figma-dev-mode`; the manifest points at it. Deliberately **not** `.mcp.json`: Claude Code reads that name as a plugin MCP component, so a Codex-only edit would change what Claude Code loads |
| `plugins/fnd/opencode/mcp-fragment.json` | OpenCode | argv-array `command`, `environment`, `type: local\|remote` — paste the `mcp` block into your own `opencode.json` |

**Cursor tool cap.** Community reports say that Cursor stops exposing tools past ~40 across all
connected servers. The six bundled servers have roughly three times that number. `mcp.json` still
ships all six. Nobody measured the cap on this host, and a cap that we have not seen is no reason
to give you a smaller plugin. If you do hit it, fall back to the priority list in
`mcp.pruned.json`:

1. **atlassian** (every workflow starts at a ticket);
2. **shopify-dev-mcp** (five tools for the whole Shopify docs + validator surface);
3. **chrome-devtools-mcp** (one browser stack, picked over `playwright` for
   console/network/performance access);
4. **figma-dev-mode**.

The list drops `playwright` and `notion-mcp`. To apply it, toggle each server in
**Cursor Settings → MCP**. Nothing in the checkout changes. To enable a dropped server again, toggle it
back. You can also overwrite `mcp.json` with the pruned copy, but that is deliberate local drift.
`doctor.cjs` and `gen-host-adapters.cjs --check` both report it, and the next generator run undoes
it. To change the cut for everyone, move `CURSOR_KEEP_RANKS` in the generator and run it again.

Codex and OpenCode document no tool-count limit, so both get the full list. The Figma **SSE**
transport works on Codex and is still an open issue on OpenCode. Codex ships no SSE client
(measured 2026-08-23). It drives every remote url through its streamable-HTTP client, so an
`/sse` endpoint answers 404 at initialize. So `mcp-codex.json` points `figma-dev-mode` at the
streamable `/mcp` path of the same server. The per-user fallback is
`codex mcp add figma-dev-mode --url http://127.0.0.1:3845/mcp`. OpenCode still gets a plain
`remote` url, and its own file says so.

## Live store access

Skills that need real store data call two bundled runners (`plugins/fnd/scripts/`):

- `shopify-admin-gql.sh` runs Admin GraphQL. It uses `shopify store execute` on CLI ≥ 4.x with a
  stored `shopify store auth`. Otherwise it falls back to `SHOPIFY_ADMIN_TOKEN` from the
  project's gitignored `.env`.
- `theme-json.sh` reads and writes a theme's JSON content layer (the customizer state). It always
  refuses writes to the live theme. It reads every write back before it reports success
  (`FND_THEME_JSON_VERIFY`). When Admin API credentials are absent, it falls back to the
  project's Theme Access token.

A session-start hook tells Claude that these runners exist. So Claude inspects the real store
state whenever that answers a question, also for research and debugging, not only for AC
verification. Details: `plugins/fnd/references/metafield-metaobject-setup.md` and
`plugins/fnd/references/theme-customizer-state.md`.

## QA preflight — the store registry

`/fnd:qa-preflight` is the entry point for the QA engineer, before hands-on testing. It takes
one or more ticket keys and does these steps:

1. It reads the tickets and finds the PR.
2. It asks the QA engineer which theme they test on, per store. The options are: the live theme;
   the theme that the ticket names (Steps to Test starts with it), when that link is not clearly
   the developer's PR preview; their own saved theme; or a preview link that they paste. The skill
   never offers or opens the PR's theme, because that theme can be gone when QA looks.
3. It unlocks the storefront in the browser and proves that `Shopify.theme` is that one theme.
   The run examines only this theme. If the theme does not carry the change, the run goes back to
   the engineer's choice. It does not hunt for a theme that carries the change.
4. It pre-runs the Steps to Test plus each AC at desktop (`1440x900`) and mobile (`375x812`),
   with a screenshot for each. From the Steps to Test, it runs the numbered steps that carry an
   expectation, and each edge case. The setup and data of item 2 become Needs-data recipes for the
   engineer; the run never performs them. It reads both field shapes: the numbered list of new
   tickets and the headed scenarios of older tickets.
5. It writes the brief in Domaine's Jira house style. The brief has a copy-paste block for the
   ticket plus preflight notes for agents only. The for-human-eyes rows of those notes carry the
   absolute page URLs that the run opened, one per page.

Sometimes the Steps to Test name a product or collection as an example (`e.g. /products/…`, with
its properties), and the QA store does not have it. This is not a Needs-data row. The run finds a
stand-in with the same stated properties, from the storefront's product JSON or from an Admin API
read when the repo has credentials. It tests on the stand-in and names the swap in Observations.

The skill is read-only toward Jira, Admin and the storefront. To post the block as a comment, it
needs an explicit yes.

Store facts come from a per-developer registry at `~/.config/domaine/qa-stores.json` (dir
`0700`, file `0600`). `plugins/fnd/scripts/qa-stores.cjs` manages it with these commands:
`list [--json]`, `get <store>`, `find <text>`, `set <domain> [--alias …] [--password …]
[--theme <id>[:<label>]] [--default-theme <id>] [--note …]`, `unset <store>` and `path`.

- A `<store>` selector is the exact domain or the exact alias, case-insensitive. The domain can
  have any URL shape; the script drops the scheme, userinfo, port and path.
- `set` takes only a host. It refuses an alias that another store already has. It runs its
  read-modify-write under a lock file, so two parallel runs cannot lose each other's store.
- `--password ''` records an open storefront: it removes the field.
- The exit codes are `0` ok · `1` no such store or an ambiguous alias · `2` usage · `3`
  unreadable, unlockable or corrupt registry (never overwritten).

For a store that is not in the registry, the skill asks one round of questions: domain, password,
theme id, plus an optional alias and notes. Then the skill runs the `set` line itself and records
that id as the engineer's saved theme. That one line is the only command of the run that can
contain a password. Passwords never leave that file. `get` is the only command that prints one.
The skill types it directly into the storefront's password form, never into the brief, the chat,
Jira, a workspace file or a screenshot frame. Detail: `plugins/fnd/skills/qa-preflight/REFERENCE.md`.

## Jira comments + attachments

`jira-reader` reads a ticket's **comments** on every run, because the QA verdicts,
clarifications and reopen reasons are there. It saves them in full to the workspace's
`comments.md` and returns one line for each.

- That read asks the MCP for `responseContentFormat: "adf"`. Without it, the bodies arrive as
  markdown strings, and their images are `blob:` links with an empty alt text.
- The reader decodes the response with `adf-to-md.cjs <file> --comments`. This unwraps the MCP's
  `{"issues":{"nodes":[…]}}` envelope. It renders each inline image as a markdown image
  reference: the target is `jira-media:<id>`, and the label is the attachment's filename. That
  filename joins the image to the attachment rows.

The **attachments** need a second route. The Atlassian MCP returns their metadata, but no tool
of it returns the bytes. So the reader runs the bundled `plugins/fnd/scripts/jira-attachments.sh`,
which downloads every image into `.claude/tasks/<KEY>/tmp/attachments/`.

- A **video does not stay**. The script downloads it and cuts it with `ffmpeg` into 8–24
  timecoded PNG frames beside it (`<file>.frames/05-00m20s.png`). It samples the frames at bin
  centres, so the end of the recording is covered too. Then it deletes the video. A model can look
  at the frames but not at tens of megabytes of video. The video's row comes back with an empty
  `path` and a frames dir.
- If `ffmpeg` is not on PATH, the script skips screen recordings, and the images are not
  affected. `--keep-video` / `--no-frames` keep the file when you want the file itself.
- The bytes never reach a commit. Under `.claude/tasks/`, the script stamps the repo's
  `info/exclude` line itself. It refuses any other `--out` that git would track, before it sends a
  single request.
- The reader never `Read`s those files itself. It returns their paths, and the caller opens the
  files that the task needs.

The download authenticates as the developer with a **scoped read-only** Atlassian API token
(`JIRA_EMAIL` + `JIRA_API_TOKEN` in the project's gitignored `.env`). This token can do strictly
less than the MCP already can, and each person creates it once. Without it, nothing fails. The
ticket read returns the attachment rows without local paths, plus one setup hint for the
developer. A missing `ffmpeg` costs the screen recordings, never the images.
`plugins/fnd/references/jira-attachments.md` gives the setup wizard, the flags, the exit codes and
the degradation contract.

Sometimes a ticket **links** a screenshot and does not attach it. An example is a
`https://prnt.sc/<id>` (Lightshot), imgur, Gyazo, CleanShot or snipboard page pasted into a
comment, with the `attachment` field empty. The bundled `plugins/fnd/scripts/external-screenshots.sh`
fetches these too:

- It downloads the page's `og:image` (or the URL itself on a direct image host) into the same
  `tmp/attachments/` dir as `<host>-<slug>.<ext>`.
- It downscales the image to at most 1600 px wide (ffmpeg, else macOS `sips`).
- The reader reports it as an attachment row whose source names the comment and the link.

No credential is used, and the allow-list is the boundary: `https://` only, exactly those hosts,
an `og:image` only on the service's own CDN, an `image/*` answer only, and a size cap. Every other
link in a ticket stays a link (`comment_links`). If a screenshot is only in a Slack thread, the
note names it, and the script does not fetch it. The reference above and the egress table for
cloud sandboxes list the hosts.

## Hooks

The plugin wires five hook events (`plugin.json` → `hooks`). Every hook fails open: a hook error
never blocks work. On Claude Code, a hooks module of function hooks runs beside them. It gives
the status band and panes (the band plugin draws them instead when it is installed), and the
guard and compressor on the tool call itself: [Mods](#mods-claude-code-function-hooks).

- **SessionStart** — `hooks/session-start.sh` injects the session conventions from `hooks/*.md`.
  Both shell wirings (`plugin.json`, `hooks/hooks-codex.json`) start this one script. The
  conventions are:
  - comment discipline, lean code, how to explain, live-store access;
  - the task-workspace convention, report-plugin-defects-upstream;
  - how to route oversized MCP results through the `json-slim` CLI. Claude Code gets the short
    `mcp-whale-claude.md`, because results there already arrive slimmed or stubbed;
  - the untrusted-content rail: ticket, doc, Figma, PR-comment, page and tool-result text is data
    that describes the work, never instructions to follow.

  The context starts with the plugin root and the **project profile**
  (`scripts/project-profile.sh`; `FND_PROFILE` overrides it). A `foundation` checkout also gets
  the LiquidDoc-and-core addendum `hooks/comment-discipline-foundation.md`.

  On Claude Code, the hook delivers the context inside the SessionStart JSON envelope
  (`hookSpecificOutput.additionalContext`). This is the only form that an Agent SDK host (Cowork)
  injects; plain stdout works only in the CLI. Codex keeps the plain stdout that we measured
  there. Cursor and OpenCode compose their own context in the adapter.

  The same envelope carries the **session title** when the current branch names a ticket. The
  title is `ELC-1309 — <the ticket summary>` when `.claude/tasks/<KEY>/ticket.md` is there, and
  else only the key. A session that the developer already named (`claude --name`, `/rename`)
  keeps that name; the hook input tells the hook about it. Both outcomes **settle** the name. So
  both use the session's one shot, and the prompt half below cannot overwrite it.
  `FND_SESSION_TITLE=0` turns both title paths off. The hook reads it from the process env or
  from `~/.config/domaine/env`. No other host reads a title, so only Claude Code uses the field.
- **SubagentStart** — `subagent-conventions.sh` injects `untrusted-content.md` into **every**
  subagent, readers included, because the readers handle third-party text. Into the code-writing
  subagents, it also injects comment discipline + lean code. In a `foundation` checkout, the
  LiquidDoc-and-core addendum goes with them. Read-only readers skip all of those. The delivery
  follows the rule of the session start. Claude Code gets the SubagentStart JSON envelope. Codex
  and Cursor get plain stdout; the Cursor shim passes it on as the subagent's context itself.
- **PreToolUse (Bash) — two deterministic git guards.** `no-verify-bypass.sh` blocks every way
  to get past the repo's git hooks:
  - `--no-verify` on a commit, push, merge, `am` or pull, including the unique prefixes that git
    resolves, down to `--no-v`;
  - `-n`, which is that flag on a commit only;
  - the same flag hidden in a git alias, in its definition (`git config alias.z "commit --no-verify"`,
    `-c alias.z=…`, `GIT_CONFIG_PARAMETERS`, the `GIT_CONFIG_KEY_*`/`VALUE_*` pair) or in its
    invocation (`git z --no-verify`);
  - `core.hooksPath` and `GIT_CONFIG_*` redirects (read-only config *reads* stay allowed);
  - disabling the hook files themselves: `rm` / `mv` / `chmod -x` / truncate / in-place edit /
    redirect / copying onto one (`cp`, `rsync`, `dd of=`);
  - `HUSKY=0`.

  `tests/no-verify-bypass-matrix.sh` holds its FP/FN contract. `no-ai-attribution.sh` blocks
  AI-attribution trailers in commit messages.
- **PreToolUse (the browser tools that take a file path) — scratch-path guard.**
  `scratch-path-guard.cjs` judges these paths: the path of a `take_screenshot` /
  `browser_take_screenshot`, of a chrome-devtools `take_snapshot` (`filePath`) or
  `get_network_request` (`requestFilePath` / `responseFilePath`), and the script that a playwright
  `browser_run_code_unsafe` loads (`filename`). It **denies** two kinds of path:
  - A path that resolves **outside** the project: the host's scratchpad, or another checkout.
    Both servers accept only files inside this project (chrome-devtools also accepts its OS temp
    dir, which passes). So the call would fail anyway.
  - A path inside the project working tree but outside a leading `.claude/`. This is the untracked
    QA litter that `references/task-workspace.md` already forbids in prose.

  The deny reason gives the model the **absolute** path to use instead:
  `<project>/.claude/tasks/<work-id>/tmp/<name>`, or `<project>/.claude/tmp/<name>` with no
  ticket. Both stay inside the project, as the playwright server requires for any file that it
  writes. The guard **creates** these directories when it denies, because nothing else does, and
  else the retry would fail with ENOENT. The path must be absolute, because the playwright server
  resolves a *relative* filename against its own output dir, not the project. So a relative fix
  would land inside the same directory that the deny was about.

  The server decides the verdict:
  - The **bundled** `playwright` passes with a bare `filename` and with **no** `filename` at all.
    The manifest pins its `--output-dir` to `.claude/fnd-tmp/playwright`, a swept directory that
    git never sees.
  - Any other spelling of the tool (a per-user `claude mcp add playwright`, and the unprefixed
    names on Codex and Cursor) can be a server with the default `<cwd>/.playwright-mcp`. So the
    guard judges it as such a server. It denies a relative filename, and also a call with no
    `filename`, because that call does not skip the write.
  - chrome-devtools without a path returns the image / snapshot / body inline and passes.
  - `browser_run_code_unsafe` with inline `code` or an in-tree script passes; it reads the file
    and writes none.
  - Anything under a leading `.claude/` passes too.
  - An in-project `tmp/` does **not** pass. A theme checkout neither ships nor gitignores one, so
    it would only be the next place for the litter.

  The project root is the session's project dir (`CLAUDE_PROJECT_DIR`, else the checkout that
  holds the cwd's `.claude/`). In a git worktree, the guard denies a path into the symlinked
  `.claude/tasks` or into the main checkout, and the fix is `<worktree>/.claude/tmp/<work-id>/<name>`.
  `FND_SCRATCH_GUARD=0` disables the guard. It is wired on Claude Code, Codex and Cursor
  (`beforeMCPExecution`). OpenCode's tool hook has no verified MCP payload shape, so screenshots
  have no guard there.
- **PreToolUse (Bash / Read / Grep) — spill-access recorder.** `spill-access.sh` records in the
  compressor's own debug log that a tool touched one of the two MCP spill families. A spill (a
  large result saved to a file) is either our `fnd-mcp-slim-<hash>.json`, or any file under the
  platform's own `tool-results/` directory. Those names are opaque, and the `OVERFLOW_PATH` of
  `mcp-slim.cjs` is the single source of truth for the shape.
  - It writes one `entry:"access"` JSONL line per distinct path that is a file on disk. It takes at
    most 8 per call, from the first 16 KB of the unescaped tool_input slice.
  - The line names which reader got there: `jq` / `grep` / `shell` / `node` / `Read` / `Grep` /
    `other`, or `named` for a command that only touched the NAME (`rm`, `mv`, `ls`, `echo` …).
  - It is **measurement only**. It never blocks, prints nothing, and changes no tool input.
  - Without it, `--report` called a whale (an oversized result) *missed* when the agent recovered
    it with three targeted `jq` queries instead of a `json-slim` run. That was the right move,
    but the report counted it as a gap.
  - It writes only while `FND_MCP_SLIM_DEBUG` is on. `FND_SPILL_ACCESS=0` disables it fully. It is
    POSIX sh + grep (no node), because it fires on every Bash / Read / Grep call.
- **UserPromptSubmit** — one node process (`user-prompt.cjs`) runs three halves, each with its
  own gate. A block from the guard wins over everything else.
  - `context-stats.cjs` monitors the context-window usage. Past a threshold, it warns and
    recommends `/compact`. Its numbers come from the usage record of the last answer, because
    hooks see neither `/context` nor the active model. So for a `/model` switch or a compaction
    that no answer followed yet, it reads the command's own transcript record instead:
    `claude-opus-5 → Fable 5.1`, `≥14.6k/1M after /compact (was 147.9k)`. Set its knobs like
    `FND_LEAN`, in `settings.json` → `env`. `FND_CTX_MONITOR=0` turns it off. `FND_CTX_WARN` sets
    the warn threshold in % (default 40). `FND_CTX_WINDOW` overrides the assumed window size
    (e.g. for 1M-token sessions).
  - `prompt-json-guard.cjs` keeps a large pasted JSON blob out of the conversation. It **blocks**
    a prompt over ~10 KB that carries a parseable JSON blob over ~8 KB. The host erases the
    prompt, so it never reaches the model. The guard spills the blob to a file (the active task
    workspace `tmp/`, else a private temp file) and shows the developer that path for the next
    prompt. So the model reads the JSON with jq/Read when needed, and the JSON does not sit in
    context every turn. `FND_PROMPT_JSON=0` disables it. On Claude Code, the hooks module
    rewrites the prompt in place and does not block it (see
    [Pasted JSON on the prompt](#pasted-json-on-the-prompt)). The block stays the fallback, and
    it is the behaviour on Codex and Cursor (OpenCode rewrites with a handle, see
    `FND_PROMPT_JSON`).
  - `session-title.cjs` names the session after the ticket, **once**. The first prompt of the
    session that carries a **corroborated** key sets `sessionTitle` to `<KEY> — <summary>` (from
    `.claude/tasks/<KEY>/ticket.md`) or to `<KEY>`. A per-session marker file stops a second
    run, or any later prompt, from changing the title. A key is corroborated when it arrived as a
    Jira `/browse/<KEY>` URL, or when this checkout already has a `.claude/tasks/` workspace for
    the same project. The key shape alone is no evidence (`UTF-8`, `SHA-256`, `ISO-8601` and
    `AES-256` all match it), and a wrong title would use the one shot that the real ticket needs.
    The title goes inside the monitor's object when both speak, and alone when the monitor is
    silent. A blocked prompt sets no title and uses no shot. This half runs on Claude Code only;
    its gate checks the host, because this file also runs on Codex. `FND_SESSION_TITLE=0`
    disables it. Session titles are verified on the CLI. In the desktop app's Code tab and in
    Cowork, they should work but are unverified.
  - **PostToolUse (`mcp__.*`)** — `mcp-slim.cjs` compresses large MCP tool results before they
    enter context (`scripts/json-slim.cjs`: ADF→markdown, noise-drop, long-string truncate,
    same-shape-array crush). Results ≤ 4 KB and error envelopes (`isError` / `errors[]`) pass
    through unchanged. The hook spills the original to a file and refers to it with a
    `<<full=…>>` handle, so nothing is lost.

    **The compression line.** When the hook actually **changes** the delivered result, it says so
    in the session, on one line above that handle (inside the stub, on its second line):
    `fnd-mcp-slim: compressed 118,203 B → 29,412 B (−75.1%)`. The decision word is `compressed` or
    `stub`. The figures compare the result that the hook got with the value that it emitted, that
    line and the handle included.
    - That copy is *inside* the tool result, and the desktop app collapses tool results. So the
      same line also goes **out of band** as the hook's `systemMessage`. This is one surface on
      every host. The **terminal CLI** prints it inline. The **desktop app** shows it under its
      collapsible "Claude Code notice". Cowork, cloud and the SDK get the same field.
    - The hook tells the model nothing, anywhere. It never asks the model to print or repeat the
      figure, because a standing "repeat this verbatim" is exactly the shape of an injected tool
      result.
    - The field is Claude Code only. The Codex and Cursor adapters read this output again against
      their own channels and byte budgets, so the extra field never reaches them. It also does not
      reach a subagent. A reader that calls the MCP tool in its own context cannot say anything to
      the developer, so there the hook writes only the in-body line. Claude Code files a
      subagent's transcript under `<session>/subagents/`, and this tells the two cases apart.
    - A passthrough says nothing, because nothing changed. This is not a new switch: there is
      nothing to turn on, and `FND_MCP_SLIM=0` silences it with the compressor.

    **Spills and the TTL sweep.** An mtime TTL (`FND_MCP_SLIM_TTL`) sweeps stale spills. The output
    dir of the bundled playwright server (`.claude/fnd-tmp/playwright`, in the project) uses the
    same clock. So QA screenshots and snapshot dumps expire and do not pile up. `FND_MCP_SLIM=0`
    disables the hook. `FND_MCP_SLIM_DIR` sets the spill directory.

    **Results over the platform limit.** A result **over** the platform limit
    (`MAX_MCP_OUTPUT_TOKENS`, ~25k tokens) bypasses this hook. Claude Code spills it to a file and
    gives the path. The session convention and the reader agents send that file through the same
    compressor when needed (`node scripts/json-slim.cjs <path> --stats`).
    - The reader recipes pass `--stats` on every run. Its stderr line is
      `json-slim: <in> → <out> bytes (<pct>% reduction)`. A log or JSONL run prints the same line,
      because `log-slim` is reached through this CLI. The readers return that line **verbatim** as
      their `compression:` field and write it into the frontmatter of the workspace file. So the
      figure survives a `/compact`.
    - A reader runs in its own context, so a second hook carries that field out:
      **PostToolUse on the subagent-spawn tool** (`^(Agent|Task)$` → `hooks/reader-compression.cjs`).
      It reads the reader's return and relays the figure on the same surface as above, with the
      measuring agent as a prefix (`fnd:jira-reader → fnd-mcp-slim: …`).
    - It fires on **every** reader spawn, also on the ad-hoc ones that no skill drives, for example
      a pasted ticket key that starts `jira-reader` by itself. The old skill-level relay could not
      do this. The skills no longer say anything about `compression` at all.
    - A BACKGROUND spawn is the host's default. It answers the tool with launch metadata only and
      delivers the return later as a `<task-notification>` prompt, which fires UserPromptSubmit
      instead. So the second half of the relay runs in `hooks/user-prompt.cjs`
      (`hooks/reader-notification.cjs`). It reads the same field from that prompt. It proves the
      agent's identity from the host's own `agent-<id>.meta.json` beside the session transcript
      (no file → no relay).
    - Both halves share one judgement (`hooks/compression-notice.cjs`). These cases give nothing,
      with exit 0, always: a `none`/absent field; a value that does not parse fully as one of
      those printed lines; an agent that is not one of the three readers; an event that it cannot
      parse. `FND_READER_COMPRESSION=0` disables both halves.
    - `figma-node-slim --stats` does the same for a Figma REST tree. `--stats` stays OFF for a
      narrowing `--jq` run, because that run measures a sub-path, not a compression.
    - If that file is not JSON, or holds an error envelope (never compressed) that is too big to
      print inline, the CLI gives the path back and does not print it again. Then the caller reads
      the file directly. A smaller error envelope prints. A narrowing `--jq` always prints, because
      the file path does not answer a sub-value.

    **Fenced payloads.** Some tools **wrap a payload in a markdown fence**: a prose preamble + ```` ```json ````
    … ```` ``` ```` (e.g. chrome-devtools `evaluate_script`). The CLI unwraps it first when the
    fenced body is the dominant content (≥ 80 % of bytes). It runs the body through
    the pipeline again and keeps the preamble on top. A real doc with a small code block stays
    below that bar and passes through byte-identical.

    **Content-block envelopes.** A spilled MCP result keeps its **content-block envelope**
    (`[{"type":"text","text":"<the payload, JSON-encoded>"}]`). This is a one-element array with a
    single escaped string, and no pipeline stage and no `--jq` walk can go into it.
    - The CLI unwraps a **pure, single-block** text envelope whose inner payload is JSON. It slims
      that payload and prints the INNER body, with one stderr line that says so. If the inner
      payload does not slim, the CLI declines and gives the whole original.
    - It does not unwrap a block that carries `_meta` / `structuredContent` / `annotations`,
      because unwrapping would drop those fields. It also does not unwrap a MULTI-block envelope,
      because its blocks are independent results, not one document.
    - `--jq` walks the envelope FIRST (`--jq 0` / `--jq 0.text` still resolve to the block). Only
      when the first segment misses does it run the whole EXPRESSION again inside the payload. So
      `--jq '.fields | keys'` on a spilled envelope lists the payload's field names. A miss at both
      levels reports the payload's keys, not `length: 1`. `--jq .` (identity) still prints the
      document that it got.
    - A JSONL payload inside an envelope gets a profile like any JSONL, against a spill of the
      unwrapped body. The line recipes must address rows that really exist as lines.

    **JSONL files.** The CLI handles a **JSONL** file (one JSON object per line, e.g. a Shopify
    bulk-operation dump) separately. It never compresses it and never prints its rows.
    - At ANY size, it returns a **PROFILE**: row + parse-failure counts, per-key
      `{present, null, type, distinct}`, and head/tail/reservoir sample rows. When the value set of
      a key hits the retention cap, it adds `distinctCapped`, so read `distinct` as a minimum.
    - The profile also gives guidance to query the ORIGINAL file by line: a `readline` filter (the
      sample rows show the shape for it) or `sed -n '<N>p'` / `grep`.
    - The `readline` template comes with the **first** profile of a given file per session. A
      repeat profile of the same file keeps the file, the row count, any fence offset and the
      `sed`/`grep` forms, but drops the template (`FND_WHALE_GUIDE`).
    - Never raw-`Read` a big JSONL. A sampled subset cannot answer analytical questions whose
      answers are in rows that the sample skips.
    - Some files have a new key name on every row (an id-keyed map dumped one row per line). On
      such a file, the profiler stops tracking new keys past a build cap and says so:
      `keysCapped: true`. It then returns the dropped-key count as `keysTruncatedAtLeast` (a FLOOR)
      instead of the exact `keysTruncated`.
    - Files ≤ 8 MB get a profile of the parsed rows. Larger files stream through `readline` and
      never load whole. The PROFILE is the same in both cases.
    - `--jq <jq-path>` extracts a single value from a ≤ 8 MB JSONL. On a larger file, the CLI
      refuses it, because it would read the whole file again. The two spellings that select the
      whole file (`--jq .`, `--jq '.[]'`) give a PROFILE, like a plain run.

    **The `--jq` grammar.** `--jq` accepts a **small jq subset**, which the CLI evaluates itself,
    with no jq dependency:
    - dot paths (`products.0.title`; a leading `.` and `[N]` indices mean the same thing —
      `.products[0].title`);
    - `[]` iteration at any segment (`.a[].b`, flattened across nesting; an object iterates to its
      values);
    - `,` multi-select. jq emits one document per term, but this CLI has one stdout. So the terms
      come back as ONE array, with `null` in a missed slot;
    - the filters `| keys` (sorted names / `0..n-1`) and `| length`.

    Quote the expression as ONE argument. The shell splits an unquoted `,`, and the CLI refuses
    the empty slot that remains (`.a,`); it does not read it as "everything".
    - Anything else is a **usage error**: `select`/`map`/any function call, `?`, `//`, `..`, quoted
      keys, slices, literals, comparisons. The result is empty stdout, one stderr line that names
      the bad token and the supported grammar, and exit **2**. The CLI reads and spills nothing.
      For the rest, pipe a supported path into real `jq`.
    - An unrecognized argument writes `json-slim: unknown option <token>` on stderr and exits **2**.
      The CLI reads nothing and prints nothing. So a typo (`--jqq`, `--notables`) can never run as
      a plain compression or count as the input path.
    - `--help` (or `-h`) prints the supported grammar on stdout and exits **0**. It reads neither
      stdin nor a file. It is not a run, so it writes no debug line and never shows in `--report`.
    - A path that does not resolve still prints `null` on stdout. But stderr names the failing
      segment and what WAS addressable there
      (`--jq: 'produtcs' not found at top level; keys: products`). A value that is really `null`
      stays silent. If EVERY element of an iteration missed, stderr says so once
      (`'creted' not found at 'comments[]'`) and does not print a silent column of nulls.

    **Other formats.**
    - **Log-shaped text** (build/test output, console spam, stack traces) gets compression by
      signal selection. The CLI keeps errors, stack-trace heads and summary lines. It dedupes
      repeated INFO/WARN spam as `×N`. It drops everything else into a `[N lines omitted: …]`
      trailer (on a file, the CLI names the original on disk for recovery). Prose, markdown and
      XML fall below the threshold of the log detector and pass through unchanged.
    - A **Figma design-context** payload (dev-mode `get_design_context`, generated React/Tailwind
      JSX) gets a lossless compaction. Repeated `className` strings move to a legend on top
      (`class=C17` at the use sites). `data-node-id` attributes become `#n17` refs. Their full-id
      map is spilled to its own file, so the ids stay usable for later Figma calls. Identical
      repeated sibling subtrees fold to one exemplar, plus a list of what differed per repeat
      (~77 % on a real 211 KB section — 219 KB as the captured envelope → 77.3 %). The original is
      in the spill. Generic HTML/XML/Liquid never matches the detector.
    - A **non-JSONL** JSON document keeps the normal slim behavior, plus a guard. If its slimmed
      body is still larger than ~48 KB, the CLI spills it to a `fnd-slim-out-*` file. It gives back
      a one-line summary + the first element + both paths (`--jq <jq-path>` to narrow), and never
      prints the body inline.

    **Spill-and-stub.** Some results the pipeline **cannot** shrink under ~32 KB: incompressible
    text/HTML, JSON that is already minimal, or a compressed body that is still huge. The hook does
    not give such a result to the model raw. It **spills and stubs** it: it replaces the result with
    a ~1 KB note (a stub). The stub names the file, its format and shape, and the
    `node scripts/json-slim.cjs <path>` line to run on it. This is the same contract that the
    session convention states for whales that the platform spilled. The spill holds the payload
    itself, so that command really works on it.
    - Some content arrays have blocks that carry more than `type`/`text` (an `annotations` or
      per-block `_meta` cursor). One stub cannot replace such an array without losing those fields.
      So the hook **replaces each over-limit block on its own**. The array keeps its length, every
      block keeps its own fields, and each replacement names the spill that holds *that block's*
      text. A block in that array that came back *compressed* and under the threshold keeps its
      own `full=` handle. So nothing in the array reaches context lossy without a copy on disk.
    - These are never stubbed and pass through as before:
      - error results, including an error envelope anywhere in a content array, at any size;
      - anything with **binary** bytes: an image, audio or embedded-resource block, or any block
        *not* typed `text` that carries a `data`/`blob` string. A screenshot must still render, and
        a text spill would not hold it. A `type:"text"` block with an unrelated `data` sibling is
        still text and still gets a stub;
      - the platform's own overflow notices;
      - shapes that the compressor did not understand;
      - a failed spill.
    - `FND_MCP_SLIM_STUB=0` turns the guard off. `FND_MCP_SLIM_STUB_BYTES` moves the threshold
      (never below the stub's own size).
    - The whole flow also runs under a wall-clock ceiling (`FND_MCP_SLIM_BUDGET_MS`, default 5 s).
      When it expires, the hook gives the ORIGINAL back, never a half-transformed value, and it does
      this **per block**. In a content array, the blocks that were already slimmed keep their
      compression *and* their recovery handle, and the rest go verbatim. The log line says
      `compressed` plus `budget_partial: true`. Only a whole-result expiry (a single text payload,
      or an array where nothing got through) logs `budget-exceeded`. Above the stub threshold, the
      hook stubs that bail like any other whale, unless it is an overflow notice.
    - With this guard in place, you can safely raise `MAX_MCP_OUTPUT_TOKENS` in your own
      `settings.json` `env`, so that bigger results reach this hook instead of the platform's file
      spill. But it stays *your* decision, ideally after a week of `--report` data.

    **Why wasn't a result compressed?** Set `FND_MCP_SLIM_DEBUG=1`, run again, and read
    `<FND_MCP_SLIM_DIR>/fnd-mcp-slim-debug.log`. Each call writes one JSONL line with the
    `decision` (`compressed` / `stubbed` / `passthrough`). On a passthrough, the line also has the
    `reason`:
    - `error-shape`, `non-json`, `unrecognized-shape`, `no-gain`;
    - `marker-overhead`: the gain was smaller than the `full=` recovery handle, so the hook gave
      the original back;
    - `budget-exceeded`: the wall-clock ceiling above;
    - `platform-overflow`: the platform's own over-limit notice. Its `spill` field holds the file
      where the platform saved the whale;
    - `size-gate`: a result under the 4 KB gate. This is *sub-gate noise*, three quarters of the
      lines of a real week. So the log records it only at `FND_MCP_SLIM_DEBUG=2`, the everything
      level.

    `no-gain` is the most common reason. It means that the pipeline ran and produced byte-identical
    output. This happens most often on a uniform array of **unique entities**: the same keys on
    every row, distinct ids / handles / URLs / titles per row, no error row, no low-cardinality
    status column, no numeric outlier or change-point.
    - The pipeline refuses to sample such an array *by design* (`unique_entities_no_signal`, the
      same gate as in the upstream crusher). Every row that a 15-row sample dropped would be unique
      content, so the sample would misrepresent the result. Nothing else is compressible without a
      new encoding of the table.
    - The same shape *does* crush when a signal appears (an error row, a status enum, a numeric
      column with an outlier). For this reason, one dump can report 0 % and its next page 99 %.
    - Above `FND_MCP_SLIM_STUB_BYTES`, the spill-and-stub guard protects context here. A second
      whole-file run would only print the same bytes back. So that stub names the narrowing
      command (`--jq <jq-path>`), not a bare second run. Below the threshold, the full result
      arrives, and `--jq` narrows it.

    On a `stubbed` line, the `reason` names the branch that the stub replaced: `non-json`,
    `no-gain`, `weak-gain` (a compression that stayed over the threshold) or `budget-exceeded`. On
    Codex only, it can name the delivery ceiling that forced a stub: `block-cap`, a compressed body
    past the block-reason cap, stubbed so that the whale still travels through that channel.

    **Spill files in the log.** Lines that wrote files also list them in `spills`. These are the
    call's own `full=` copy plus the crush / node-id-map spills written inside it. On a CLI run,
    they are also Gate A's `fnd-slim-out-*` body. For a **stdin** run that came back lossy, they
    include the copy of the original that the CLI spilled and named on stderr (a file run gives
    the file itself back instead). When the list is capped at 8, the line has `spills_n`. A line
    with **no** `spills` key left nothing on disk.
    - In the **hook**, every branch that *discards* the compressed body (a stub, a `no-gain` or
      `marker-overhead` passthrough) also deletes the spills that it created for that body. Nothing
      names them any more. The hook also removes them from `spills`, so the list holds only files
      that are still on disk. The hook leaves a spill that already existed, because the live handle
      of an earlier call can name it.
    - A CLI run does no such cleanup. Files that a declined branch left (a crush spill written
      before the run fell back to a passthrough) wait for the TTL sweep.
    - Spill filenames are content hashes. So the same payload that passes twice reuses one file
      and does not add another.
    - Each line also records the `lvl` at which it was collected (see `FND_MCP_SLIM_DEBUG`).

    **What did it all add up to?** `node scripts/json-slim.cjs --report [logfile] [--since <ISO>]`
    (default: the log above) prints:
    - totals, and counts per decision/reason/stage;
    - the top hook tools by bytes saved. CLI runs are keyed by file path, not tool name, and get one
      aggregate line. In that line, the whole-file runs that reduced *nothing* count separately,
      because they read a file into context for no gain. A `jq-unsupported` or `unknown-flag`
      refusal is not one of them, because neither read a body at all. The report excludes a `--jq`
      run, because it answered a sub-path;
    - per-project subtotals;
    - how many DISTINCT spill files the window left. The report dedupes paths across events, so the
      content-hash reuse above shows up as one file, not one per call;
    - the **missed whales**: `platform-overflow` results that **no tool ever opened**.

    That last number used to mean "no later `json-slim` run". So it called a whale missed whenever
    the agent recovered it in the sensible way: three targeted `jq` queries straight on the 236 KB
    spill. The `spill-access` hook above records those reads as `entry:"access"` lines. `--report`
    pairs them with the overflow / stub that they follow, exactly as it pairs a CLI run: same path
    or basename, not earlier. So a read by ANY tool counts as the recovery.
    - This evidence has two limits, both by construction. First, the hook writes the line on
      **PreToolUse**, so it records the read that was *attempted*. A call that the user denies, or
      one that fails, still counts as a read. Second, the report deliberately does **not** pair a
      command that only NAMES the spill (`rm`, `mv`, `ls`, `echo` — recorded as `via: named`). So a
      cleanup after the session cannot clear the misses of a session.
    - Access lines are **not** compression events. They carry no bytes. The report excludes them
      from the totals, the decision / reason / stage counts, the per-tool and per-project
      aggregates, the CLI-run line and the spill-file inventory. The `log:` header counts the whole
      window and says how many of its events are spill reads.
    - Access lines get two lines of their own instead: `spill reads (access hook): N (via: …)`
      and, when a whale was recovered,
      `whale recoveries via: json-slim N · jq N · Read N …` (each whale counted once per distinct
      reader). A log with no access lines reports exactly the same numbers as before.

    Results that were **stubbed** (above) get their own line and count as bytes saved, never as
    missed whales. The report also names a stub whose follow-up run gained nothing.
    - The report labels totals collected at level 1 as such. The sub-gate lines are missing from
      them, which makes the % too high. It flags a log that spans a switch between levels as not
      comparable and does not average it. Missed whales, stubs and stage counts are complete at
      every level.
    - A `non-json` line also carries a `format` tag (`html` / `xml` / `broken-json` / `text`). So
      you can see WHAT got past the JSON-only pipeline (`grep '"format":"xml"' fnd-mcp-slim-debug.log`).
    - Every line carries a `project` tag, because all projects of a user share the log
      (`grep '"project":"my-repo"'`). The tag is the nearest `.git` ancestor of the call's own cwd,
      else `CLAUDE_PROJECT_DIR`, else the basename of that cwd. The `.git` walk comes first, because
      Claude Code exports `CLAUDE_PROJECT_DIR` to hooks but not to the Bash tool. So it is the one
      rule that both the hook and the CLI can follow. A CLI run from a scratch dir outside any repo
      still tags that dir.

    *Coexistence:* if you also run [`squeez`](https://github.com/claudioemmanuel/squeez), both its
    PostToolUse hook and `mcp-slim` fire on `mcp__*` results. Expect them to stack.
  - **Compression backend (Claude Code only)** — `FND_COMPRESSION` picks who compresses MCP results.
    `builtin` (the default) is everything above. `proxy` gives the job to the separate
    [slim plugin](plugins/slim/README.md). Under `proxy`:
    - the `mcp-slim` wiring exits before node;
    - the hooks module passes MCP results through unchanged while slim's `slim.info` state lists
      its MCP channel;
    - the session context drops the oversized-results block when slim is installed and enabled;
    - the scratch-file sweep still runs once per session.

    If slim is missing, disabled, older than 0.3.0 or has `SLIM_MCP=0`, the module keeps
    compressing every MCP result and says so once per session. This applies to MCP only: under
    `proxy`, neither plugin covers a local JSON dump read below Read's token cap.
    `doctor --target claude` reports the backend (`compression-backend`) and warns on each of those
    mismatches. In both modes, the Log pane (`/band-log` with band, `/fnd-log` without) shows slim's
    events next to fnd's, and fnd's own compression lines then read `fnd-slim`. Under `builtin` with
    slim installed too, a result that the host cut at its token limit can still reach the model with
    slim's label and not fnd's. This depends on which plugin's module sits beneath.

### Environment switches

This is the single home for every knob (switch) that the plugin reads, on every host. Add every
new switch to this table. When a switch does not mean the same thing on every host, give its
per-host behavior. Host variables that the plugin only *reads* are at the bottom of the table.
[Recommended Claude Code settings](#recommended-claude-code-settings-copy-paste) gives the
recommended values for Claude Code's own `settings.json` (`MAX_MCP_OUTPUT_TOKENS`,
`FND_MCP_SLIM_DEBUG`) in a file that you can paste.

**Where to set them.** Two **Domaine env files** work identically on all four hosts. Every fnd
entry point (Node hooks, the `json-slim` CLI, the two Shopify shell scripts, the OpenCode plugin)
reads them first. So a Cursor started from the GUI no longer needs `launchctl` workarounds:

- global — `~/.config/domaine/env` (Windows: `%APPDATA%\domaine\env`; `$XDG_CONFIG_HOME` honored)
- per-project — `<repo>/.claude/domaine.env` (found by walking up from the working directory)

Precedence is **process env > project file > global file > default**. The files never override a
value that is already in the real environment. So Claude Code's `settings.json` → `"env": { … }`
(global or per-project) keeps working and keeps winning. One key is the exception:
`FND_COMPRESSION`. The plugin reads it only from the session environment, because its wiring
gate decides in plain shell before any file loads. So `domaine-env set` refuses it, and `list`
never shows a file value for it as live.

The file format is a strict `KEY=VALUE` subset: one pair per line, `#` full-line comments, and the
value is everything after the first `=`. There is no quoting and no `$VAR` expansion. The plugin
reads only `FND_*` keys (plus `SHOPIFY_ADMIN_GQL_QUIET`). So the file can never smuggle `PATH` or
`NODE_OPTIONS` into a hook.

**The project layer carries tuning keys only.** A client repository can commit a
`<repo>/.claude/domaine.env` file. So the plugin reads exactly these fourteen switches from it:
`FND_LEAN`, `FND_STE`, `FND_PROFILE`, `FND_CTX_MONITOR`, `FND_CTX_WARN`, `FND_CTX_WINDOW`,
`FND_MCP_SLIM_DEBUG`, `FND_WHALE_GUIDE`, `FND_NOGAIN_MEMO`, `FND_GQL_PROBE_CACHE`,
`FND_CPT_THROTTLE_WAITS`, `FND_CPT_OVERLAY_VERIFY_WAIT`, `FND_THEME_JSON_VERIFY_WAIT` and
`SHOPIFY_ADMIN_GQL_QUIET`. Every other switch is **global-only**: the compression, spill, guard
and read-back-verify gates, and any later switch until this list names it. A global-only switch
comes from the shell or `~/.config/domaine/env`. The plugin ignores a copy of it in a project
file: `domaine-env list` shows it as `project (ignored: global-only switch)`, and
`set --project` refuses to write one.

Edit the files by hand or through the CLI:

```bash
node plugins/fnd/scripts/domaine-env.cjs list                            # switches, values, which source won
node plugins/fnd/scripts/domaine-env.cjs set FND_MCP_SLIM_DEBUG=1        # global
node plugins/fnd/scripts/domaine-env.cjs set FND_MCP_SLIM_DEBUG=1 --project   # this repo only
node plugins/fnd/scripts/domaine-env.cjs unset FND_MCP_SLIM_DEBUG        # and: path [--project]
```

You never install the CLI on its own. It ships inside the plugin (bare Node, no dependencies) and
lives where the plugin lives: the clone, or the host's plugin cache. The intended route is to
**ask the agent in a session**. Say "enable mcp-slim debug for this project" or "turn off the
prompt-JSON guard globally". The session runs the matching `set`/`unset` against the script under
its own plugin root, so you do not have to remember a path. A manual run from the plugin directory
works exactly the same.

There are two caveats:

1. The shell fast-gates in the hook wirings (the `[ "$FND_MCP_SLIM" = "0" ] && exit`
   short-circuits) see only the real process env. A `0` in the global file still disables the
   feature, because the Node side checks again after it loads the files. But the gate no longer
   skips the node spawn.
2. The session gates of `FND_LEAN` and `FND_STE` are pure shell (`hooks/session-start.sh`, the
   composer that `cat`s the statics for the two shell wirings). So where a hook gates these two
   switches, they come only from the process env. On Cursor, our sessionStart hook also gives the
   file values back to the host. The host then feeds them to every later hook of the session,
   shell gates included.

Hooks never read a project's `.env` file on any host.

Eleven switches do not mean the same thing on every host: `FND_LEAN`, `FND_STE`, `FND_PROFILE`,
`FND_CTX_MONITOR`, `FND_MCP_SLIM`, `FND_COMPRESSION`, `FND_MCP_SLIM_DEBUG`, `FND_MCP_SLIM_STUB`,
`FND_PROMPT_JSON`, `FND_SCRATCH_GUARD` and `FND_SPILL_ACCESS`. Each of those rows carries a
**Host divergence:** note. Every other switch behaves identically everywhere, because the same
single copy of the reading script runs on all four hosts.

| Variable | Default | Effect |
|---|---|---|
| `FND_LEAN` | `1` | `0` disables the lean-code session convention. Hook-gated, so it applies where the convention arrives through a hook (Claude Code and Codex at session start; every host's subagent conventions on Claude Code, Cursor and Codex). **Host divergence:** on Cursor the SESSION copy ships as an always-applied rule instead — turn `rules/fnd-lean-code.mdc` off there — and on OpenCode the statics live in your own `instructions` config, which this switch cannot reach; either way, "normal mode" in the session still works |
| `FND_STE` | `1` | `0` disables the how-to-explain session convention (`hooks/writing-style.md`). Hook-gated, so it applies where the convention arrives through a hook (Claude Code and Codex at session start; subagents never get it). **Host divergence:** on Cursor it ships as an always-applied rule instead — turn `rules/fnd-writing-style.mdc` off there — and on OpenCode the statics live in your own `instructions` config, which this switch cannot reach; either way, "normal writing" in the session still works |
| `FND_PROFILE` | auto | overrides the **project profile** — `foundation` / `theme` / `none`, detected by `scripts/project-profile.sh` from the checkout itself (`snippets/@*.liquid`, `sections/core-*.liquid`, `blocks/core-*.liquid` or `src/entry/core/` ⇒ `foundation`; else `layout/theme.liquid` ⇒ `theme`; else `none`), walking up from the session's directory and stopping at the repo boundary — the level that holds `.git` — so a hook running in a subdirectory answers about its own checkout and never about a parent repo. Every host prints the answer as `fnd project profile: <value>` right under the plugin-root line, and `foundation` adds one block to the session: `hooks/comment-discipline-foundation.md` (LiquidDoc on every snippet param; `src/entry/core/*` is protected — extend or compose it; the Liquid core may be edited but has to be hand-synced from the foundation repo) — plus the same block for code-writing subagents. Bundled scripts read the same answer where a Foundation-only command would otherwise be handed to a plain theme: `scripts/worktree-setup.sh` prints `npm run dev -- --theme …` in the worktree hand-off only on `foundation`, and `shopify theme dev --theme …` everywhere else. The three values are matched exactly, lowercase; an exported-but-EMPTY value still counts as set, so it shadows both env files and lands on detection; anything else falls back to detection, silently in a session (run `scripts/project-profile.sh` by hand to see the warning). **Host divergence:** on Cursor the comment-discipline convention is an always-applied rule and of that material only this addendum is detection-gated, injected by `hooks/cursor-shim.cjs`; on OpenCode both the profile line and the addendum ride the adapter's once-per-session `chat.message` injection, since the statics live in your own `instructions` config |
| `FND_CTX_MONITOR` | `1` | `0` disables the context-usage monitor; node still spawns for the prompt-JSON guard, the session title and the background reader relay unless `FND_PROMPT_JSON=0`, `FND_SESSION_TITLE=0` and `FND_READER_COMPRESSION=0` too (the four halves share one UserPromptSubmit process). **Host divergence:** the monitor reads the session transcript, which only Claude Code and Codex hand a hook — on Cursor (`beforeSubmitPrompt`) and OpenCode (`chat.message`) there is no transcript path, so the monitor is inert there whatever this is set to, and the switch only governs the prompt-JSON half. **Mod (Claude Code):** while a session marker is fresh the monitor is silent whatever this is set to, and its warn-level `additionalContext` goes with it, so the model gets no context nudge there and the band's colours and Compact button are the developer's cue. The marker is written by the band plugin while it draws the band, or by fnd's [hooks module](#mods-claude-code-function-hooks) when band is not installed (whatever `statusBand` says); with band installed and its `disabled` option on, nobody writes it and the monitor speaks again. On Cursor, Codex and OpenCode this stays the switch |
| `FND_CTX_WARN` | `40` | context warn threshold, % of the window |
| `FND_CTX_WINDOW` | auto | override the assumed context window size (tokens). Auto = the Claude model family on Claude Code (200000 when the model is unrecognized) and the window the rollout states on Codex — where, if it states none, the monitor stays silent rather than guess |
| `FND_MCP_SLIM` | `1` | `0` disables the MCP result **compression** (PostToolUse `mcp-slim` hook) — node never spawns. Where it does spawn anyway — a `0` set in the global `~/.config/domaine/env`, which the wiring's shell gate cannot see (this switch is global-only: a project `.claude/domaine.env` cannot set it at all) — the hook emits nothing but still runs its exit-time TTL sweep: hygiene is not compression, and nobody who silenced the compressor asked for a spill dir and a checkout that fill up. `FND_MCP_SLIM_TTL` is the switch that governs the sweep. **Host divergence:** Claude Code and OpenCode rewrite the result in place, so compression AND spill-and-stub both land. Cursor is observe-only: `afterMCPExecution` exposes no rewrite field, so nothing is compressed, stubbed or spilled there whatever this is set to — with the default the shim logs `skip`, and with `0` the wiring gate exits before node, so not even that line is written (see [Known gaps](#host-verification-status--cursor-codex-cli-and-opencode-are-unverified) and `docs/README.cursor.md`). On Codex both halves land through the one channel that host's `PostToolUse` can replace a result with: `hooks/codex-mcp-shim.cjs` returns the compressed body — or the stub — as a `block` `reason`, behind a header saying the call SUCCEEDED and must not be retried, since Codex frames a block to the model as `Script failed` / `Script error:`. That reason is capped (`BLOCK_REASON_BYTES` in the shim, 10000 — Codex truncates a longer hook output, measured at 2,500 host tokens of 4 bytes each), so a compressed body over the cap is spilled-and-stubbed instead (`block-cap`), and a result carrying a non-text block falls back to the old path: the stub rides as `additionalContext`, a compressed body is dropped (`docs/README.codex.md`). **Mod (Claude Code):** `0` also turns off the [hooks module](#mods-claude-code-function-hooks)'s slimming: no over-limit expansion and no savings toast. The module reads only the session's environment (shell, `settings.json` → `env`); a `0` that lives only in `~/.config/domaine/env` is seen by the `mcp-slim.cjs` the module spawns, which then emits nothing, so the host's notice stands and the effect is the same one spawn later. To hand MCP compression to the separate slim plugin, set `FND_COMPRESSION=proxy` instead (see [plugins/slim/README.md](plugins/slim/README.md)). |
| `FND_COMPRESSION` | `builtin` | Who compresses MCP results on Claude Code. `builtin`: fnd does (the PostToolUse `mcp-slim` hook and the hooks module). `proxy`: fnd hands compression to the separate [slim plugin](plugins/slim/README.md) — the `mcp-slim` wiring exits before node, the hooks module passes results through untouched while slim's `slim.info` state lists its MCP channel, and session context drops the oversized-results block once slim is installed and not disabled (the plugin-root line stays); fnd's scratch-file sweep still runs once per session. With `proxy` but slim missing, disabled, older than 0.3.0 or with `SLIM_MCP=0`, the module keeps compressing every MCP result itself and says so once per session (a toast on the main conversation, a `/fnd-log` line); `doctor --target claude` warns. Any other value means `builtin`. Set it in `settings.json` → `env`: it is read from the session environment only, so `domaine-env set` refuses it and a value in `~/.config/domaine/env` is ignored. **Host divergence:** Claude Code only — Codex, Cursor and OpenCode ignore it and keep fnd's compression. |
| `FND_MCP_SLIM_DIR` | `os.tmpdir()` | directory where `json-slim` and the `mcp-slim` hook spill offloaded rows / the original result (the `full=<path>` handle) |
| `FND_MCP_SLIM_TTL` | `24` | hours a file survives before the exit-time sweep prunes it (by mtime, so `full=` handles outlive same-day resume). Two directories ride this clock: the spill dir, and the bundled playwright server's project output dir `.claude/fnd-tmp/playwright` — pruned recursively, files only, with directories left standing since a live browser session may own one. The sweep runs even with `FND_MCP_SLIM=0` (that switch turns off compression, not hygiene). `0` disables both prunes — but not the `/.claude/fnd-tmp/` line in `.git/info/exclude`, which the scratch-path guard stamps itself on the first bundled screenshot it allows. Any invalid value falls back to `24` |
| `FND_MCP_SLIM_DEBUG` | off | opt-in: append one JSONL trace line per `mcp-slim` / `json-slim` invocation to `<FND_MCP_SLIM_DIR>/fnd-mcp-slim-debug.log` (project, `lvl`, decision, reason, `format` on non-json, `narrowed` on a `--jq` CLI run, `guide` (`full`/`reminder`) on a JSONL profile, `budget_partial` on a mid-array wall-clock expiry, `delivery`/`delivered` + `host` on a host whose adapter decides what can be delivered (see below), bytes, %, stages, `spills` — never any payload); rotates one generation at ~5 MB. `1` (or `true`/`yes`/`on`) = **key events**: everything except the sub-gate `size-gate` lines for results under the 4 KB gate, which were ~76 % of a real week's log. `2` (any integer ≥ 2) = **everything**, sub-gate lines included. Unset / `0` / `false` / an unrecognized value ⇒ no file written. The level rides on each line as `lvl`, so `--report` can say which of its numbers cover a partial event set — a `1` window's totals % is not comparable with a `2` window's. **Host divergence:** where the host adapter decides delivery (Codex), the shrunk lines also carry what was DELIVERED — `delivery` (`replace` = the body or stub went back as the block reason, `discard` = the compressed body was dropped, `additional` = a stub rode back beside the raw result) plus `delivered`, the bytes of that stub — and `--report` credits a `replace` as the saving it is while counting the other two as 0 saved (and, for `additional`, as context ADDED), with a `delivery:` line naming the split whenever any event took a fallback |
| `FND_MCP_SLIM_STUB` | `1` | `0` disables the spill-and-stub guard: a result the compressor cannot bring under the threshold is then handed to the model raw again, instead of as a ~1 KB stub + spill. **Host divergence:** on Codex the stub is also what an over-cap compressed body degrades to (the block reason cannot carry a longer one), so `0` costs more there: the whale lands raw AND that compression is dropped rather than stubbed, with nothing said about the spill holding either. On Cursor there is no stub at all: `afterMCPExecution` is observe-only, so neither half of `mcp-slim` lands and this switch changes nothing there |
| `FND_MCP_SLIM_STUB_BYTES` | `32768` | bytes above which the `mcp-slim` hook spills-and-stubs instead of passing a whale through (also applies to a compressed body that is still this large); any invalid value falls back to `32768`, never to `0`, and any value below the stub's own ~1.2 KB is raised to it (a smaller gate could emit a stub bigger than the text it replaces). The [hooks module](#mods-claude-code-function-hooks) reads it from the session's environment to tell the hook's own output from payload before it toasts a figure; a value set only in `~/.config/domaine/env` leaves the module at `32768`, which can cost a toast, never a result. |
| `FND_MCP_SLIM_BUDGET_MS` | `5000` | wall-clock ceiling for one `mcp-slim` compression run (shared across every block of a result). An expiry hands the ORIGINAL back — per block, so a partly-slimmed content array is logged `compressed` + `budget_partial`, and a whole-result expiry `budget-exceeded` (stubbed above the stub threshold); `0` disables the ceiling; a negative value is a ceiling already expired when the run starts (every block hands its original back — the deterministic form of a tiny budget, for diagnostics); any invalid value falls back to `5000`, never to `0`. The default is ~22× a 1 MB-class payload on this pipeline and well inside Claude Code's PostToolUse timeout — headroom, not a guarantee: a genuinely huge result (tens of MB, or several fat blocks sharing the one deadline) can still reach it, and is then handed back uncompressed rather than half-compressed |
| `FND_WHALE_GUIDE` | `1` | `0` (or `false`/`no`/`off`) disables the one-shot rule for `json-slim`'s whale-recovery guidance: the full block (readline filter template + `sed`/`grep` single-row hints) is then printed after every profile instead of only the FIRST profile of a given file per session. With the default, later profiles of the same file carry a one-line reminder that stays self-sufficient — the file, the row count, any fence offset, the `sed`/`grep` single-row forms and this switch — dropping only the readline template (the reader of a repeat may be a subagent, or a context that was compacted since). The suppression state is a dotfile per session × **resolved** file path under `FND_MCP_SLIM_DIR`, expires after 2 h, and is pruned by the same sweep as the spills (so `FND_MCP_SLIM_TTL=0`, which disables that sweep, leaves the small per-file **state files** in place); a new file path, a missing, unreadable or future-dated state file always yields the full block. The profile itself is never affected, and each profile's debug line records which variant it printed (`guide: full` / `reminder`) |
| `FND_NOGAIN_MEMO` | `1` | `0` (or `false`/`no`/`off`) disables `json-slim`'s per-file no-gain memo. With the default, a **file** run that printed its body back unchanged (a deliberate decline, now also stated on stderr) is remembered — per session × **resolved** file path, for 2 h, invalidated as soon as the file's size or mtime change — and a repeat run on that file answers with a one-line refusal naming the recovery instead of re-printing the body; the field pattern it removes is "decline → immediate re-run", where a 0 % result reads as a failed attempt. Only declines of at least 4 KB are remembered (below that a refusal saves nothing). The state is dotfiles under `FND_MCP_SLIM_DIR`, swept with the spills (so `FND_MCP_SLIM_TTL=0` leaves them in place); a missing, unreadable, corrupt or future-dated state file always yields the normal run. The same switch also governs the second refusal, which needs no memo: `fnd-slim-out-*` files — `json-slim`'s own Gate-A output spills, already slimmed — are answered the same way (only below the 8 MB stream gate; past it the big-document guidance is the useful answer). Neither refusal ever applies to a run whose answer it cannot stand for: a narrowing `--jq <jq-path>` (the documented recovery after a decline) bypasses both. `--stats` does **not** — the reader recipes pass it on every run, so a bypass would disarm the memo for exactly those callers; a refusal answers it with the measurement instead, printing the body-free notice on stdout and `json-slim: <bytes> → <bytes> bytes (0.0% reduction) [declined earlier this session]` (or `[already json-slim output]`) on stderr. The stderr decline notice is NOT governed by this switch: it rides on every file run that printed the file's own bytes back unchanged. Both refusals log `already-slim-out` / `no-gain-memo` and are counted on `--report`'s `cli runs:` line |
| `FND_PROMPT_JSON` | `1` | `0` disables the prompt-JSON guard (UserPromptSubmit `prompt-json-guard` half); node still spawns for the context monitor, the session title and the background reader relay unless `FND_CTX_MONITOR=0`, `FND_SESSION_TITLE=0` and `FND_READER_COMPRESSION=0` too — only with all four at `0` does no node process run at all. Those clauses are in the Claude Code and Codex wirings alike, because the two carry the same command verbatim; on Codex the title and reader-relay halves are inert (both gated on `FND_HOST=claude`), so a Codex user who wants the old two-switch economy sets `FND_SESSION_TITLE=0` and `FND_READER_COMPRESSION=0` with the other two. Cursor's `beforeSubmitPrompt` runs its own shim, which has no title half, so there the two-switch short-circuit is unchanged. **Host divergence:** on OpenCode nothing can erase a message, so a blocking verdict **rewrites** the prompt instead — every blob the guard spilled is replaced in place by its `full=` handle, which offloads the paste exactly as elsewhere. **Mod (Claude Code):** `0` also turns off the [hooks module](#mods-claude-code-function-hooks)'s rewrite. The module reads only the session's environment (shell, `settings.json` → `env`); a `0` that lives only in `~/.config/domaine/env` is seen by the `prompt-json-guard.cjs --from-mod` the module spawns, which then prints nothing, so the effect is the same one spawn later. Confirmed live on the desktop app's Code tab too. |
| `FND_BAND_COST` | off | `1` (or `true`/`yes`/`on`) adds the session-cost segment to the status band fnd draws (`cost $12.40`, `💰 $12.40` on the desktop): the `/cost` total at API prices, a measure of work on a subscription. Read once at session start through the hooks module's `$.env`, so set it where Claude Code's own environment is built — the `env` block of `~/.claude/settings.json` reaches the terminal and the desktop app alike. Ignored while the band plugin is loaded; band reads `BAND_COST`. **Host divergence: Claude Code only** (the band is a mod). |
| `FND_EVENT_LOG` | `1` | `0` stops the hooks module recording fnd's own events in the event log (the `Log` pane: `/band-log` with the band plugin, `/fnd-log` without); with nothing else recorded the pane reads `no events yet`. With band, the `session`, `model`, `compact` and `rate` lines are band's and `BAND_EVENT_LOG` gates them. The slim plugin's lines still show there unless `SLIM_EVENT_LOG=0`. Toasts are untouched. Read through the hooks module's `$.env`, so set it in the session's environment (`~/.claude/settings.json` → `env`). **Host divergence: Claude Code only.** |
| `FND_SLIM_TOAST` | `1` | `0` silences the hooks module's savings toasts: the MCP-slimming figure (`fnd-mcp-slim: compressed …`) and the pasted-JSON figure (`fnd-prompt-slim: …`). Under `FND_COMPRESSION=proxy` the MCP savings toast is the slim plugin's, silenced by `SLIM_TOAST=0` instead. Slimming and the rewrite themselves are untouched, and so are the Compact-press result toast and the 90 % rate-window alarm (answers to the developer's own action and a warning). Read through the hooks module's `$.env`, so set it in the session's environment (`~/.claude/settings.json` → `env`). **Host divergence: Claude Code only** (toasts are a mod). |
| `FND_SLIM_TOAST_MS` | `5000` | How long the hooks module's savings toasts stay, in milliseconds (a whole number, floored at 1,000; anything else → the default). Set it where the module reads its environment (`~/.claude/settings.json` → `env`). **Host divergence: Claude Code only.** |
| `FND_SCRATCH_GUARD` | `1` | `0` disables the screenshot scratch-path guard (PreToolUse `scratch-path-guard`) — node never spawns. With the default, a `take_screenshot` / `browser_take_screenshot` / `take_snapshot` / `get_network_request` / `browser_run_code_unsafe` whose path resolves **outside** the project (scratchpad, another checkout — the servers refuse those anyway; a chrome-devtools write under its OS temp dir passes, since that server accepts it), or a written file that resolves inside the project working tree and outside a **leading** `.claude/` segment, is **denied** with a reason naming the ABSOLUTE `<project>/.claude/tasks/<work-id>/tmp/<name>` (or `<project>/.claude/tmp/<name>` with no ticket) instead — absolute because a relative filename is resolved by the playwright server against its own output dir, not the project, so a relative remediation would land nested inside the litter dir it replaces. Which server it is decides the verdict: the **bundled** `playwright`, whose manifest pins `--output-dir .claude/fnd-tmp/playwright` (swept, git-excluded — and the guard stamps that exclude itself on the branches that allow, so the allow does not rest on a compressor switch), passes both a bare `filename` and no `filename` at all; every other spelling may be a default-configured server writing to `<cwd>/.playwright-mcp` inside the checkout, so its relative filename is denied and so is its no-`filename` call, which does not skip the write. That allow is bought with the sweep: a file in the bundled server's output dir **expires** on `FND_MCP_SLIM_TTL` (24 h), so anything meant to be kept — QA evidence, the screenshots a Steps to Test points at — still belongs in `<project>/.claude/tasks/<work-id>/tmp/`, which nothing prunes. The guard creates the two remediation destinations itself as it denies (nothing else does — chrome-devtools' write path makes no directory — so a compliant retry would fail with ENOENT). The project root is the session's project dir (`CLAUDE_PROJECT_DIR`, else the checkout the cwd's `.claude/` sits in); in a git worktree a path resolving into the symlinked `.claude/tasks` is denied, and the remediation is `<worktree>/.claude/tmp/<work-id>/<name>`. Anything under a leading `.claude/`, an inline chrome-devtools screenshot / snapshot / network body (no path, no file written) and `browser_run_code_unsafe` with inline `code` or an in-tree script all pass, and any internal error fails open; an in-project `tmp/` is denied like the rest of the tree, since a theme checkout neither ships nor gitignores one. **Host divergence:** wired on Claude Code, Codex and Cursor — the matcher is prefix-agnostic, since Codex names the same tools without the `plugin_fnd_` prefix and either host may have the servers installed per-user, and on Cursor the deny travels through `beforeMCPExecution` (a `permission: "deny"` response, `tool_input` decoded from a JSON string). That prefix-agnosticism has a cost on those two hosts: an unprefixed `browser_take_screenshot` is indistinguishable from a per-user server, so even the bundled one is judged conservatively there — relative filenames denied, absolute workspace paths expected. OpenCode's tool hook has no verified MCP payload shape, so there screenshots are unguarded whatever this is set to. **Mod (Claude Code):** `0` also turns off the [hooks module](#mods-claude-code-function-hooks)'s guard: no deny on the tool call and no path note in the five tools' descriptions. The module reads the session's environment (and, for the description note, `settings.json` → `env`); a `0` that lives only in `~/.config/domaine/env` is seen by the spawned `scratch-path-guard.cjs` alone, which then allows, so nothing is denied, but the description note stays for that session. |
| `FND_SESSION_TITLE` | `1` | `0` disables **both** session-title paths. Both halves read it the same way — process env first, then the GLOBAL Domaine env file (`~/.config/domaine/env`); it is deliberately not one of the project-file keys, so a client repo's `.claude/domaine.env` cannot rename the sessions of everyone who opens it. With the default, `hooks/session-start.sh` names the session after the ticket its BRANCH carries (`<KEY> — <summary>` when `.claude/tasks/<KEY>/ticket.md` holds one, `<KEY>` alone otherwise) and `hooks/session-title.cjs` names it after the **first** prompt of the session carrying a key it can CORROBORATE — a Jira `/browse/<KEY>` URL, or a `.claude/tasks/` workspace for the same project. Key shape alone is not evidence: `UTF-8`, `SHA-256`, `ISO-8601` and `AES-256` all match it, and titling a session after one of those would also spend the shot the real ticket needs. The title is one shot per session, held by a marker file in the temp dir beside the context monitor's band state, so a re-run or a later ticket never re-titles; the title itself is clamped to 100 bytes on a character boundary, which is what keeps it inside the SessionStart envelope's budget. A session the developer already named (`--name`, `/rename`) is left alone by BOTH halves: the SessionStart input carries that name, and seeing it spends the one shot, so the prompt half cannot overwrite it either. The prompt half is also one of the four halves the UserPromptSubmit wiring's short-circuit counts — node spawns unless this, `FND_CTX_MONITOR`, `FND_PROMPT_JSON` and `FND_READER_COMPRESSION` are ALL `0`. **Host divergence: Claude Code only.** `sessionTitle` is a Claude Code hook field; Codex, Cursor and OpenCode name sessions themselves and ignore it, so the prompt half is gated on `FND_HOST=claude` and the SessionStart half rides in the envelope that host alone receives. Verified on the Claude Code CLI; the desktop app's Code tab and Cowork are expected to honour it, unverified |
| `FND_SPILL_ACCESS` | `1` | `0` disables the spill-access recorder (PreToolUse `spill-access.sh`) — the wiring pre-gates on it, so nothing is spawned, and the script re-checks it too. With the default it appends one `entry:"access"` line per DISTINCT spill path a Bash / Read / Grep call named that is a file on disk — PreToolUse fires after the spill was written, so a path that does not exist was only spelled — harvested from the first 16 KB of the unescaped tool_input slice (`fnd-mcp-slim-<hash>.json`, or any name under a `tool-results/` directory — the platform's overflow files are opaquely named, so the recorder matches the same family `mcp-slim.cjs`'s `OVERFLOW_PATH` writes; at most 8 paths per call) to `<FND_MCP_SLIM_DIR>/fnd-mcp-slim-debug.log`, recording which reader got there — that is what lets `json-slim --report` stop calling a whale *missed* when the agent recovered it with `jq` instead of a `json-slim` run. It writes **only while `FND_MCP_SLIM_DEBUG` is on** (the log is a debug artefact), never blocks, prints nothing, and reads a run naming `json-slim.cjs` as no access at all (the CLI logs its own line). Being a PreToolUse hook it records the read that was *attempted*, and a command that only names a spill (`rm`, `ls`, `echo` …) is recorded as `via: named`, which `--report` does not count as a recovery. **Host divergence:** Claude Code matches `Bash|Read|Grep`; Codex adds its `shell` / `local_shell` spellings; Cursor covers the SHELL only, since it documents no read-file event; OpenCode covers `bash` plus its `read` / `grep` tools |
| `FND_READER_COMPRESSION` | `1` | `0` disables the reader-compression relay, both halves: PostToolUse `reader-compression.cjs` (matcher `^(Agent|Task)$`, a foreground spawn's tool result — the wiring pre-gates on it, so node never spawns) and the `reader-notification` half of UserPromptSubmit `user-prompt.cjs` (a background spawn's `<task-notification>` prompt, the agent proven by the host's `agent-<id>.meta.json` beside the session transcript; counted in that wiring's four-switch short-circuit). With the default, a return from one of the three readers (`jira-reader`, `figma-reader`, `doc-reader`, with or without the `fnd:` prefix — **no other agent**, whatever its return quotes) is scanned for the contract's `compression:` field and the figure is put in front of the developer as `systemMessage` — one surface on every host (the CLI prints it inline, the desktop app under its collapsible hook notice), and the model is never asked to print or repeat it. It is the ONLY route out of a reader's own context: the skills no longer relay the field, so an ad-hoc reader spawn — a pasted ticket key, no skill — surfaces the figure too. A subagent return is data, and the ticket text it echoes is data quoted inside data, so the value is relayed only when it parses **end to end** as the printed line of a compressor this plugin ships — `fnd-mcp-slim: <decision> <n> B → <n> B (<pct>)`, json-slim's `<in> → <out> bytes (<pct>% reduction)` with its optional bracketed refusal tag, `figma-node-slim: … nodes= hidden= folded=` — `; `-joined, single-line and capped; a prefix followed by free text is not a figure and is dropped whole, and the field is read past any earlier `compression:` line the ticket body put above it. `none`, an absent field, a non-reader agent, a relay firing inside a subagent (no developer to reach) and an unparseable event all print nothing and exit 0, and so does any internal error — a relay may never delay or block a tool. **Host divergence:** Claude Code only — no other host spawns subagents through a tool whose PostToolUse this plugin sees, so nothing is wired there and this switch changes nothing |
| `FND_HOST_TRACE` | off | `1` (or `true`/`yes`/`on`) turns on the **host-proof log**: every fnd hook appends one JSONL line per invocation to `<FND_MCP_SLIM_DIR>/fnd-host-trace.log` (`os.tmpdir()` when that is unset), so "did the hooks fire on this host?" is answered from disk instead of from a model reporting on itself. One line = `ts`, `host` (`claude`/`cursor`/`codex`/`opencode`, or `unknown` when the wiring set no `FND_HOST`), `event`, `hook`, `decision` (`pass` / `deny` / `inject` / `stub` / `compress` / `skip` / `error`), plus `tool` on a Pre/PostToolUse line, `agent` on a SubagentStart one, the `project` basename and `ms`. **Metadata only** — never a payload, command text, prompt text or the path of a spill — and the whole thing is best-effort: a failure to log can never change a hook's stdout, its stderr or its exit code. The file rotates once to `fnd-host-trace.log.1` at 5 MB and is kept by the spill sweep under both names. **Global-only** (process env or `~/.config/domaine/env`; a project `.claude/domaine.env` cannot arm or silence a repo's own proof), and unset / `0` / an unrecognized value ⇒ no file is created. The off path costs the hot-path guards one builtin-only scan of the global env file per invocation (no fork, no external command) — well under a millisecond, but not literally nothing. Read it back with `node plugins/fnd/scripts/doctor.cjs --trace [--since 2h]`, which prints an event/hook × host matrix with a decision breakdown |
| `FND_FIGMA_SOURCE` | `auto` | which source `figma-reader` may read a design through: `auto` walks the ladder (connector Figma MCP → the local `figma-dev-mode` bridge → the REST API with `FIGMA_TOKEN`), `mcp` forbids the token path, `rest` skips both MCP rungs — for a developer who knows the desktop app is closed. Matched exactly, lowercase; anything else falls back to `auto` with `note=invalid_figma_source value=<v>` on stderr. **Global-only**: it is deliberately NOT one of the thirteen project-file keys above, so a copy in a `<repo>/.claude/domaine.env` is ignored — which rung a read may take is a decision about this machine's Figma access, not something a client repository sets for everyone who opens it. `scripts/figma-rest.sh --policy` prints the resolved value and whether a token is present, with no network call and without printing the token |
| `SHOPIFY_ADMIN_GQL_QUIET` | off | non-`0` value shortens the gql runner's engine-fallback note to `note=engine=token` |
| `FND_GQL_PROBE_CACHE` | `21600` | seconds the gql runner reuses its two sticky machine facts — the `shopify version` probe (~1.5 s, also invalidated whenever the CLI binary is newer than the cache) and "`store execute` is unavailable for this store", which lets a later call skip the doomed probe entirely. `0` re-probes on every call — the escape hatch right after a `shopify store auth`; any invalid value falls back to `21600`. Both caches live in a 0700 per-user dir under `$TMPDIR`; `--engine store` ignores the second one and always attempts |
| `FND_CPT_THROTTLE_WAITS` | `20 60` | pause(s), in seconds, between `create-preview-theme.sh`'s push retries after Shopify answers `Throttled` — the store+token rate limit is shared with a running `shopify theme dev`, so a bulk push can 429 while everything else is healthy. One retry per listed value; empty disables retrying (tests pass `0 0`) |
| `FND_CPT_OVERLAY_VERIFY` | `1` | `0` skips `create-preview-theme.sh` create's overlay read-back (the run prints `overlay=skipped`). With the default, after the settings overlay pushes cleanly the script pulls the settings patterns back off the target theme and requires every overlaid `*.json` to be present — Shopify validates theme JSON server-side and silently drops a file whose section/block types the branch's code lacks while `theme push` exits 0 with a clean stderr (observed live: a dev-theme `templates/product.json` carrying a feature-branch block type never landed and every PDP on the "successful" preview 404'd). Each missing file prints `warn=overlay_file_dropped file=… [unknown_types=…]` (the alien types, best-effort, matched against the pushed code's schemas) plus `overlay=partial` — the run still **exits 0**: everything else landed, and the per-file recovery via `theme-json.sh set` beats deleting a theme whose re-create would replay the same drop. A read-back pull that itself fails is `overlay=unverified` + `warn=overlay_unverified`, never a drop claim and never a failed run. A dev-theme pull that produced no settings file at all is `overlay=empty` + `warn=overlay_empty` (`--reuse`: nothing overlaid, the theme keeps its previous settings) or `error=overlay_pull_failed` (fresh create: the theme is deleted), independent of this switch. Presence-only by design (content legitimately differs — Shopify re-stamps its `/*…*/` banner), so a `--reuse` target's pre-existing stale copy can still pass — a known ceiling. Costs two pulls, and they retry through the same loop as the pushes (`FND_CPT_THROTTLE_WAITS`), so a throttled store can add those pauses *after* every piece of real work already succeeded |
| `FND_CPT_OVERLAY_VERIFY_WAIT` | `2` | seconds before the overlay read-back's ONE re-pull when a file comes back missing — a read issued straight after a write can trail it, and calling consistency lag a drop would cry wolf. `0` re-checks immediately (what the suites pass); any non-numeric value falls back to `2` |
| `FND_THEME_JSON_VERIFY` | `1` | `0` skips `theme-json.sh set`'s read-back verify, which then believes the transport alone (`shopify theme push`'s exit code, an empty `themeFilesUpsert.userErrors`) and prints `verified=skipped` on the result line. With the default — both engines — every `set` pulls the file back and compares it against the payload (`*.json` normalized: Shopify's re-stamped `/*…*/` banner stripped, `jq -S` key order; raw bytes, trailing newlines aside, for anything else), retrying once after `FND_THEME_JSON_VERIFY_WAIT` seconds so a read served the pre-write copy is not called a failure. Landed ⇒ `verified=true`; a read-back that does not carry the payload ⇒ `error=not_applied` on stdout, a hint naming the two known triggers on stderr, preceded by `note=verify_diff` listing the leaf key paths that differ (`only_in_payload=` / `only_in_theme=` / `changed=`, 8 each, keys only, never values) and `diff_lines=` (the count alone when the read-back is not JSON), **exit 6** — same code when the read-back itself could not run (`error=verify_read_failed`, state unconfirmed; a throttled or garbled gql read counts, and is never re-tried on the other engine, since the mutation already committed). Exit 6 means *the theme does not serve the payload*, not *nothing changed*: no pre-image is read before the write, so `get` and restore your snapshot if it moved. Normalizing `*.json` needs perl — without it (or with a perl that will not run) the compare is raw, which cannot tell a re-stamped banner from a lost write, so there a difference is `verified=unverified` + exit 0 and `note=verify_raw_compare` on stderr, never `not_applied`. A read-back that will not parse as JSON on a host that *can* normalize is the opposite case and not a degradation: the payload is validated as JSON before the upload, so that body is not the payload — `note=verify_body_not_json` and the ordinary `not_applied` + exit 6, judged per attempt (a garbled first read followed by a clean matching retry still verifies). Shopify keeps the old content for some payloads it rejects server-side while reporting success, so `0` is an escape hatch for a mis-verified write, not a speed-up |
| `FND_THEME_JSON_VERIFY_WAIT` | `2` | seconds `theme-json.sh set` waits before its ONE read-back retry — a read issued straight after a write can still be served the pre-write copy, and calling that a failure would send the caller chasing a phantom. `0` retries immediately (what the suites pass, so a `not_applied` case does not pay the pause); any non-numeric value falls back to `2`. Only the pause is configurable: the retry itself is not optional, and `FND_THEME_JSON_VERIFY=0` is the switch that skips the read-back entirely |
| `TOML_PATH` | `shopify.theme.toml` | path the theme scripts read their config from — `store =` (all three), the dev-theme id `theme =` (`create-preview-theme.sh` only; must resolve to a NUMERIC id — a theme name is refused, since names are not unique on a store and a mis-parse would orphan a created theme; the `pin` subcommand is the exception, deliberately allowed to run on an absent or malformed `theme =` line precisely to repair it), the Theme Access token (`create-preview-theme.sh`, `theme-json.sh --engine themecli`). In a multi-environment toml every value comes out of ONE `[environments.*]` block — the same block the pin writes: `--env <name>` (`create-preview-theme.sh` only), else `$SHOPIFY_FLAG_ENVIRONMENT`, else `dev`, else `development`, else the top-level keys, else (reads only) file order where every `store =` in the file names the same store; blocks naming different stores with none of those names refuse with `error=ambiguous_env` before any request, unless `--store`/`$SHOPIFY_STORE` (`theme-json.sh`, `create-preview-theme.sh`) names a store one block carries — that block is picked. A key the chosen block does not carry falls back to the top-level keys and then to the file at large — except `store =` / `password =`, the two halves of one per-store credential, which leave the block only in that same-store case. Also the **write** target of `create-preview-theme.sh`'s session-theme pin (`pin` / `--pin-toml`), which rewrites the `theme =` line of one environment block via an atomic same-directory replace — permissions and the symlink target are preserved, the inode is not — so point it at a copy when the real config must not be touched |
| `SHOPIFY_CLI_THEME_TOKEN` | unset | Theme Access token for the `shopify` CLI. `create-preview-theme.sh` reads it as a LAST resort (the repo's own `password =` wins, so a token exported for another project cannot authenticate this repo's pushes against that store) — and as the ONLY token when `--store`/`$SHOPIFY_STORE` names a store other than the toml's (a Theme Access token is minted per store); `theme-json.sh --engine themecli` prefers it over the toml. Both export it into the CLI subprocess and never print it |
| `SHOPIFY_STORE` | unset | store handle/domain used by `theme-json.sh`, `shopify-admin-gql.sh` and `create-preview-theme.sh` when `--store` is not passed, ahead of the toml's `store =`. A store other than the toml's takes `create-preview-theme.sh` off the toml's token, dev theme and pin target: `create` and the pin are refused there, `refresh` pushes with `$SHOPIFY_CLI_THEME_TOKEN` |
| `SHOPIFY_FLAG_ENVIRONMENT` | unset | *read, not set by fnd*: the Shopify CLI's own environment selector (what `shopify theme dev -e <name>` reads), honored as the default `[environments.<name>]` block of `shopify.theme.toml` by all three theme scripts — `create-preview-theme.sh` (store, dev theme id, Theme Access token AND the session-theme pin target; its `--env` flag overrides it), `theme-json.sh` and `shopify-admin-gql.sh` (store, and the Theme Access token on `--engine themecli`; in those two `--env` names the dotenv file, so this variable is the only way to name a block — though `--store`/`$SHOPIFY_STORE` settles an ambiguous file for `theme-json.sh` and `create-preview-theme.sh` by picking the block that names that store). A name no block in the file carries is `error=env_not_found`, not a silent fallback |
| `SHOPIFY_ADMIN_TOKEN` | unset | Admin API access token for the gql runner's token engine, ahead of the `--env` dotenv file — and the escape hatch for a credential that is not shp*_-shaped (only the file value is shape-gated) |
| `SHOPIFY_ADMIN_API_VERSION` | `2026-04` | Admin API version the gql runner requests when `--api-version` is not passed |
| `JIRA_EMAIL` | unset | Atlassian login `jira-attachments.sh` authenticates the attachment download as, ahead of the `--env` dotenv (default `./.env` if present, else `<git toplevel>/.env`). Half of one credential with `JIRA_API_TOKEN` — both absent ⇒ `error=no_jira_credentials` + the setup `hint=`, exit 3, and the ticket read degrades to metadata instead of failing. Shape-gated (no whitespace, quotes, backslash or control characters), never placed on the argv and never echoed |
| `JIRA_API_TOKEN` | unset | the per-developer **scoped read-only** Atlassian API token the same script pairs with `JIRA_EMAIL`, ahead of the `--env` dotenv. Read only by design — it grants strictly less than the Atlassian MCP already has, and the plain (unscoped) token the token page offers first is both wrong and rejected by the `api.atlassian.com` gateway the script speaks to. Charset-gated (`[A-Za-z0-9_.+/=~-]`); it reaches curl through a `0600` config file deleted on exit, never the argv, and is never printed. Wizard and the degradation contract: `plugins/fnd/references/jira-attachments.md` |
| `JIRA_SITE` | `meetdomaine.atlassian.net` | Atlassian site host `jira-attachments.sh` resolves the cloudId from (`https://<site>/_edge/tenant_info`, the one unauthenticated request and the only one that touches the site host — every authenticated call goes to the `api.atlassian.com` gateway). `--site` overrides it, `--cloud-id <uuid>` (the cloud UUID itself, not a site host) skips the lookup entirely; read like the two credentials, process env ahead of the `--env` dotenv |
| `FIGMA_TOKEN` | unset | the per-developer Figma **personal access token** `figma-rest.sh` authenticates the REST rung with, ahead of the `--env` dotenv (default `./.env` if present, else `<git toplevel>/.env`). Scopes: **File content: read-only** (the node tree and the PNG render), **Variables: read-only** (design tokens by name — honoured on Enterprise plans only, harmless elsewhere), **Current user: read-only** (for `--check`). Charset-gated (`[A-Za-z0-9_.+/=~:-]`); it reaches curl through a `0600` config file deleted on exit, never the argv, and is never printed — and it rides to `api.figma.com` only: the render is fetched from its pre-signed S3 URL by a SEPARATE, token-less call. Absent ⇒ `error=no_figma_token` + the setup `hint=`, exit 3, and `figma-reader` asks the developer instead of guessing. Setup, scopes and the degradation contract: `plugins/fnd/references/figma-rest.md` |
| `FND_HOST` | set by the fnd wiring | *set and read by fnd, never by you*: the host name (`claude` / `cursor` / `codex` / `opencode`) each host's own hook wiring exports so a `FND_HOST_TRACE` line can say which host ran the hook. It is not a switch — `domaine-env` will not write one, and a hand-set value only makes the log lie. An absent or unrecognized value is logged as `unknown`, which is what a manual run or a test is |
| `CLAUDE_CODE_SESSION_ID` | set by Claude Code | *read, not set by fnd*: scopes `FND_WHALE_GUIDE`'s one-shot state and `FND_NOGAIN_MEMO`'s no-gain memo to the conversation, so a new session sees the full guidance block — and the declined body — again. Absent (a bare shell) ⇒ both are keyed on the file path alone and the 2 h expiry bounds them |
| `CLAUDE_PROJECT_DIR` | set by Claude Code | *read, not set by fnd*: its basename becomes the `project` tag on a debug line only when the invocation's cwd has no `.git` ancestor — the `.git` walk wins because Claude Code exports this variable to hooks but not to the Bash tool; no ancestor and unset ⇒ that cwd's basename |
| `CLAUDE_PLUGIN_ROOT` / `PLUGIN_ROOT` | set by the host | *read, not set by fnd*: where a hook **wiring** file finds the bundled scripts and session-convention markdown. Claude Code and Cursor set `CLAUDE_PLUGIN_ROOT`; Codex sets `PLUGIN_ROOT` plus `CLAUDE_PLUGIN_ROOT` as a compatibility alias, and `hooks/hooks-codex.json` prefers the alias with a fallback to `PLUGIN_ROOT`. Hook **scripts** never trust either one for guard logic — they resolve their own bundled paths from `__dirname` / their own `dirname`, because Cursor leaks the variable between concurrent plugins' hooks and Claude Code has a source-vs-cache inconsistency |
| `SLIM_MCP` | `1` | **slim plugin.** `0` turns slim's MCP compression off: its hooks module hands every MCP result through untouched, spawns nothing and writes no report line. Read through the module's `$.env` (session environment only). With fnd's `FND_COMPRESSION=proxy`, a `0` here makes fnd keep compressing MCP results itself. **Host divergence: Claude Code only.** |
| `SLIM_BASH` | `1` | **slim plugin.** `0` turns slim's Bash channel off (stdout of large JSON, HTML-fetch, log and plain-text outputs); no spawn, no report line. Read by the module only. |
| `SLIM_READ` | `1` | **slim plugin.** `0` turns slim's Read channel off (whole-file reads of big `.log`/`.jsonl`/`.ndjson` files and of `.json` data files the host cut at its token cap). Read by the module only. |
| `SLIM_WEB` | `1` | **slim plugin.** `0` turns slim's WebFetch and WebSearch channels off. Read by the module only. |
| `SLIM_GREP` | `1` | **slim plugin.** `0` turns slim's Grep and Glob channels off (the listing window; the counts are never changed either way). Read by the module only. |
| `SLIM_AGENT` | `1` | **slim plugin.** `0` turns slim's Agent channel off (the window over a completed subagent's long report). Read by the module only. |
| `SLIM_PLAIN_BYTES` | `65536` | **slim plugin.** Size above which slim windows plain text — code, diffs, test output, prose — to its head and tail with a hidden-lines marker and a `<<full=` handle; below it plain text passes byte-identical. About twice Bash's 30,000-character inline cap, so anything the host would show inline is never touched. A whole number, floored at 8,192; anything else → the default. Read by the module and the base. |
| `SLIM_DIR` | the system temp dir | **slim plugin.** Spill root for original copies, stub payloads and slim's report log `slim-debug.log`. slim never reads `FND_MCP_SLIM_DIR`; with fnd installed too, leave both unset or set them equal — fnd trusts `<<full=` handles only in its own dir and in system temp. |
| `SLIM_TTL` | `24` | **slim plugin.** Hours a spill file lives before slim's sweep removes it; `0` stops slim's sweeps. The sweep prunes only the names slim writes (`slim-mcp-*`, `slim-crush-*`, `slim-jsx-ids-*`) and keeps its own throttle marker (`.slim-sweep`). `FND_MCP_SLIM_TTL` does not reach it: in a spill dir both plugins use, a file lives by the shorter TTL. |
| `SLIM_DEBUG` | off | **slim plugin.** `1` writes one report line per call slim handles, on every channel; `2` adds the module's stand-downs (MCP size-gate, already-slim, plain-gate, read-guard, …) and the attachment probe line. Error, lookup and view lines are written at every level. `FND_MCP_SLIM_DEBUG` does not reach it. |
| `SLIM_STUB` | `1` | **slim plugin.** `0` turns slim's spill-and-stub guard off for MCP results; a host-overflow result is still stubbed. |
| `SLIM_STUB_BYTES` | `32768` | **slim plugin.** Payload size above which an incompressible or weakly compressed result becomes a stub (whole bytes, floored at 1,200; anything else → the default). |
| `SLIM_BUDGET_MS` | `5000` | **slim plugin.** Wall-clock ceiling for one compression in ms; `0` removes it; past it the result passes through or is stubbed. |
| `SLIM_TOAST` | `1` | **slim plugin.** `0` silences the savings toast, which slim shows for MCP results on the main conversation only; compression, the ToolResult line and the ToolGroup suffix are untouched. **Host divergence: Claude Code only.** |
| `SLIM_TOAST_MS` | `5000` | **slim plugin.** How long the savings toast stays, in ms (whole number, floored at 1,000). |
| `SLIM_EVENT_LOG` | `1` | **slim plugin.** `0` stops writing the `slim.events` state other plugins read; the ToolResult line still draws. |
| `SLIM_LOOKUP` | `1` | **slim plugin.** `0` removes the `mcp__slim__lookup` tool, the one-sentence pointer to it in the Bash and WebFetch tool descriptions, and the lookup hint line together. |
| `SLIM_LOOKUP_MODEL` | `haiku` | **slim plugin.** Model the lookup tool asks its one question with — an alias or a model id, checked like `--model`. Every lookup writes its model and token usage to the report log at every debug level. |
| `SLIM_HINT` | `1` | **slim plugin.** `0` drops the one line slim adds to an HTML page it compressed from a Bash fetch (`slim hint: for one fact about this page, call mcp__slim__lookup(…)`). |
| `SLIM_CURL` | unset | **slim plugin.** `deny` refuses a bare `curl <url>` in Bash with a pointer to the lookup tool and WebFetch; a curl with a pipe, an output file or headers is never refused. Any other value does nothing. |
| `SLIM_PROMPT` | `1` | **slim plugin.** `0` turns slim's prompt channel off: a prompt you type or send through the Remote Control bridge is never rewritten. With the default, a prompt of 10 KB or more that holds a data-shaped paste of 8 KB or more (JSON, JSON lines, a log, an HTML page, fenced data) has each such span replaced in place by its compact text (JSON only while under 8 KB) or by its head, followed by the stats line and a `<<full=…>>` handle to the whole span, which is kept in `<project root>/.claude/slim/prompt/` (the main checkout's, from a worktree; git-ignore `.claude/slim/`). Prose and the question are kept byte for byte, and the prompt is never blocked. Read by the module only. |
| `SLIM_ATTACH` | `1` | **slim plugin.** `0` turns slim's @-mention channel off. With the default, an @-mentioned data file over 32 KB (numbered lines of a `.json`, `.jsonl`, `.ndjson`, `.log` or `.txt` file, or of an unnamed one whose content sniffs as JSON, JSON lines or a log) is compressed the way a Read of it would be, with the same Read note and a handle to the file's content; source files and source JSON pass untouched. Read by the module only. |
| `SLIM_SPILL_GUARD` | `1` | **slim plugin.** `0` turns the spill-read guard's deny off. With the default, a Read with no `offset`/`limit` of one of slim's spill files (an original or a rows file, in the spill root or the prompt dir) over 32 KB is denied with a one-line pointer to a windowed Read, `mcp__slim__view({ path, jq })` or `mcp__slim__lookup({ path, question })`; windowed Reads, id maps, Grep, Bash and every plugin's own calls pass. Each spill read that went through writes an `entry:"access"` report line at `SLIM_DEBUG` 1 or 2 whatever this is set to. Read by the module only. |
| `BAND_COST` | off | **band plugin.** `1` (or `true`/`yes`/`on`) adds the session-cost segment to the band plugin's status band (`cost $12.40`, `💰 $12.40` on the desktop): the `/cost` total at API prices, a measure of work on a subscription. Read at session start through the module's `$.env` (session environment only: shell or `settings.json` → `env`); the Domaine env files do not reach it. **Host divergence: Claude Code only.** |
| `BAND_EVENT_LOG` | `1` | **band plugin.** `0` stops band recording its own lines (`session`, `model`, `compact`, `rate`) in the event log; fnd's and slim's lines still show in `/band-log` unless `FND_EVENT_LOG=0` or `SLIM_EVENT_LOG=0`. Toasts are untouched. Read through the module's `$.env` (session environment only: shell or `settings.json` → `env`); the Domaine env files do not reach it. **Host divergence: Claude Code only.** |

## Mods (Claude Code function hooks)

**Claude Code only.** Besides the classic command hooks above, fnd ships a **hooks module**.
`plugins/fnd/hooks/hooks.json` names `hooks/mods/register.tsx`, which Claude Code loads into the
session itself as function hooks. Function hooks can do what a command hook cannot. They draw UI
above the prompt and in a side pane. They replace a tool result after the host has already cut it
down to an overflow notice. They add a note to a tool's description before the model sees it. They
rewrite a prompt before the model reads it.

The module adds six things:

- The **status band** is one row above the prompt. It shows the prompt-cache countdown, model,
  context use, every rate-limit window, the session's cost and the task digest.
- The **progress pane** shows the checklist of the task workspace.
- The **event log pane** keeps the last 200 things that the module did or noticed, one timestamped
  line each: savings figures, guard refusals, compactions, model switches, rate alarms, workspace
  changes, session start and resume.
- The **scratch-path guard** answers on the tool call itself.
- **MCP slimming** also reaches results over the platform limit, which the classic `mcp-slim` hook
  never sees.
- **Pasted JSON** over the gate of the classic guard is replaced in place by its compressed body or
  a stub. So the prompt goes through in one submission and is not blocked.

When the separate band plugin is installed, band draws the status band and both panes. fnd's
module stands down on those three (below). fnd still resolves the task and records its own events,
and band reads them. Guard, slimming and pasted JSON do not duplicate the Node hooks. They spawn the
same `scratch-path-guard.cjs`, `mcp-slim.cjs` and `prompt-json-guard.cjs`. So the D, M and P cases
in `tests/hooks-sim.sh` keep testing the code that decides.

At the top of every prompt, a module rewrites an empty `<tmpdir>/fnd-mod-session-<session id>`
(the session marker). The band plugin's module writes it while band draws the band. fnd's module
writes it when band is not installed. No module writes it while band is installed with
`disabled: true`. While that marker is less than a minute old, the classic UserPromptSubmit hook
skips its context monitor, because the band covers it. The hook still runs the pasted-JSON block,
the session title and the reader relay. The block stays because the rewrite already passes it, so
the block catches only what the module skipped or failed to rewrite.

A marker older than a minute counts for nothing. So a resumed session whose module no longer loads
gets the classic monitor back. The module cannot delete files, so old 0-byte markers stay in the
temp dir until the OS clears it.

We add screenshots of the band and the pane on terminal and desktop (docs/img/mods-band.png,
docs/img/mods-pane.png) after the live check.

### Status band

fnd draws this when the band plugin is not installed. With band, band draws it and fnd yields. The
drawing is the same in both cases. [plugins/band/README.md → Status band](plugins/band/README.md#status-band)
is its reference: the row at each width, the drop order, every segment and button, look, colors,
hover cards, toasts and hotkeys. fnd's copy differs in these points:

- **Debug.** `/fnd-band` prints the raw figures behind fnd's band: the session's `usage()` answer, the
  cache state, the usage atom, the resolved workspace and session root, and the last render's surface
  and measured columns. With band loaded it answers `band draws the band now: /band-debug`.
- **Cost.** fnd's cost segment is `FND_BAND_COST=1`. band reads `BAND_COST` and ignores fnd's switch.
- **Hiding it.** fnd's `statusBand: false` hides fnd's band (see [Mods settings](#mods-settings-userconfig)).
  band's own switch is its `disabled` option. While band is loaded, fnd draws no band, whatever
  `statusBand` says.
- **Buttons.** fnd always draws the Progress and Log buttons. band draws each one only while it has
  something to show. The fallback of the Log button is `/fnd-log`, and that of the Progress button
  is `/fnd-progress`.
- **Rate alarm.** Without band, the 90 % rate toast and its `rate` log line are fnd's. With band,
  they are band's, and fnd's figures stand down, so nothing toasts twice.

### Progress pane

fnd draws this when the band plugin is not installed. With band, band draws it and fnd yields.
[plugins/band/README.md → Progress pane](plugins/band/README.md#progress-pane) describes the pane:
header, rows, glyphs, notes tail and the two hints. fnd always decides which task the pane shows.
fnd resolves the task and publishes it, and the plugin that draws reads it.

- **Without band:** `p: Progress` or `/fnd-progress` opens fnd's pane (`fnd-progress`). With nothing
  resolved it is one line, `no task workspace — /fnd:save-task-context`. `/fnd-progress <id>` pins a
  task and opens the pane; `/fnd-progress -` clears the pin.
- **With band:** `/fnd-progress` alone answers `band draws the panes now: /band-progress` and opens
  nothing. `/fnd-progress <id>` still pins (`Pinned <id>. band draws the panes now: /band-progress`,
  plus `<id> has no task workspace.` when it does not resolve). `/fnd-progress -` still clears the
  pin. band redraws from the new snapshot. `/band-progress` takes no argument, so pinning stays here.

**Which task.** fnd takes the first match in this order:
1. an id pinned with `/fnd-progress <id>` whose `.claude/tasks/<id>/` exists (`/fnd-progress -`
   clears the pin);
2. the last ticket that you named in a prompt, with or without a workspace. That is your current
   task, whatever the branch says. Only prompts count, not the model's replies. Notifications and
   scheduled prompts do not count. A bare key counts only when something corroborates it, as for
   the session title: a Jira `/browse/<KEY>` URL, or a `.claude/tasks/` workspace for the same
   project (`UTF-8`, `SHA-256` and `ISO-8601` have the key shape and are not tickets);
3. the ticket key in the branch name, when its workspace exists;
4. the branch slug, when its workspace exists;
5. the newest `progress.md` changed in the last 12 h, which covers slug workspaces on `main`.

The band and the pane redraw on a Write or Edit under `.claude/tasks/`. A 30 s tick also notices
edits made from Bash (`sed`, a script). A `git checkout` / `switch` / `worktree` and a directory
change resolve the id again. `/clear` forgets the conversation key, but a pin stays.

### Event log pane

fnd draws this when the band plugin is not installed. With band, band draws it and fnd yields.
[plugins/band/README.md → Event log pane](plugins/band/README.md#event-log-pane) describes the pane:
merge order, wrapping, `… N earlier`, and the text answer where nothing draws a pane. fnd always
records its own lines in `fnd.events`, and both panes read them.

- **Without band:** `l: Log` or `/fnd-log` opens fnd's pane (`fnd-log`) with fnd's lines and slim's.
  Where nothing draws a pane, `/fnd-log` answers with the log as text.
- **With band:** `/fnd-log` answers `band draws the panes now: /band-log`. `/band-log` shows band's,
  fnd's and slim's lines together.

fnd's lines:

| Kind | Written when | Text |
|---|---|---|
| `session` | Without band (see below): the module starts (launch and reload), on a resume or fork, and on `/clear` | `start`, `resume`, `fork`, `clear` (a resume can log both `start` and `resume`) |
| `model` | Without band (see below): a `/model` switch to another model | The full model id, `claude-opus-5-5` |
| `compact` | Without band (see below): a compaction of the main thread | The trigger (`manual`, `auto`, `plugin` for the Compact button) and the tokens before → after when the engine reports them. One line per compaction, whichever of its two reports (the `session.compact` chain, the `PostCompact` event) arrives first |
| `rate` | Without band (see below): a rate window first reaches 90 % | The alarm toast's text, `5h window: 92% used, resets in 1h 05m` |
| `workspace` | The resolved task workspace differs from the last one logged (re-resolving the same one after `/clear` logs nothing) | The work id, or `none` |
| `slim` | The module slims an MCP result and finds its savings figure, on the main thread or in a subagent | The tool (the part after the last `__`) and the figure without its `fnd-mcp-slim:` prefix. A subagent's line starts with its agent type (`fnd:` dropped, `agent` when the engine does not list it): `jira-reader · getJiraIssue: compressed …`. The pane shows it as `fnd-slim` once slim has lines of its own |
| `prompt` | A pasted JSON prompt is rewritten and accepted | The toast's figure without its `fnd-prompt-slim:` prefix |
| `guard` | The scratch-path guard refuses a tool call | The tool (the part after the last `__`) and the first line of the reason without the guard's own prefix |

With band loaded, the first four kinds are band's lines in `band.events`, with the same texts.
band does not show those kinds from fnd's list. fnd stops writing them when it reads `band.info`,
which band writes at its own session start. So an fnd hook that runs first can still log
`session start` once. At 200 lines, the oldest `slim` or `prompt` line makes room first. So a
session with many MCP calls keeps its rarer lines. The log lives only in the session's state:
nothing goes to disk, and a new launch starts empty. `FND_SLIM_TOAST=0` silences a savings toast
and keeps its line. `FND_EVENT_LOG=0` records none of fnd's lines; `BAND_EVENT_LOG` controls band's.

### Scratch-path guard on the tool call

The five tools that the classic guard covers (`take_screenshot`, `browser_take_screenshot`,
`take_snapshot`, `get_network_request`, `browser_run_code_unsafe`) get two things from the module:
- **A description note.** The model reads where paths must go (`.claude/tasks/<work-id>/tmp/`,
  `.claude/tmp/<work-id>/` in a worktree, or `.claude/tmp/`, absolute) before it picks one. The
  note is a constant, so it never spends the prompt cache. It is still a live check whether the
  note also reaches a deferred tool loaded through ToolSearch.
- **A deny on the call.** The module gives the tool call to `scratch-path-guard.cjs`, with the
  same input that the classic wiring builds. Its deny becomes the call's answer, with the same fix
  text. This adds no new rule. The deny now comes before the PreToolUse hooks of other plugins, and
  the classic guard stays wired beneath as the backstop. The module latches the project root at
  session start, as the MCP servers latch their own roots. So a later `/cd` does not move it.

### MCP slimming on the tool call

- **Results over the platform limit.** Claude Code cuts a result over `MAX_MCP_OUTPUT_TOKENS` down
  to a notice that names a `tool-results/` file. The classic PostToolUse hook sees only that
  notice. The module gives the notice to `mcp-slim.cjs --overflow=expand`, which slims the file
  that the notice names. Payload text can forge a notice, so the module accepts only this
  session's own host spill, after realpath:
  `<CLAUDE_CONFIG_DIR or ~/.claude>/projects/<dir>/<session id>/tool-results/mcp-<name>-<n>.txt`.
  The model gets the slimmed body with a `<<full=…>>` handle on that file. After a refusal, a
  missing file or an error, the host's notice stays as it was.
- **Whale ceiling.** A whale that slims under `FND_MCP_SLIM_STUB_BYTES` (32 KB) arrives as content.
  A bigger one still comes back as a stub that names the host file, with a `node json-slim` /
  `--jq` recipe. When no stub can carry it, the host's notice stays. The 3.2 MB, 100-issue `*all`
  JQL slims to about 540 KB, so it stays a handback. But it is a slimmed one, and the model queries
  it instead of reading 3 MB in chunks. A higher stub size for this path is an open owner decision.
- **Savings toast.** Every slimmed main-thread result shows a toast with the same figure as the
  classic notice, e.g. `fnd-mcp-slim: compressed 118,203 B → 29,412 B (−75.1%)`, for 5 s
  (`FND_SLIM_TOAST_MS`).
  - The classic hook still slims results under the limit in place. The module only toasts the
    figure that it finds in the result.
  - A reader subagent's result is slimmed but never toasted, as with the classic notice. Its figure
    still goes to the Log pane as a `slim` line, with the agent type as a prefix.
  - `FND_SLIM_TOAST=0` turns the toast off, and the slimming stays.
  - Until a session marker lets the classic hook drop its own notice, a slimmed result can show the
    figure twice: the notice line and the toast.
- **Never twice.** `mcp-slim.cjs` passes its own output through unchanged on every host (debug
  reason `already-slim`), whatever order the module and the classic hook run in.
- **Counted as recovered.** `json-slim --report` counts a whale that the module expanded into a
  compressed body as recovered (`whale recoveries via: … mod`), not missed. A stub that the module
  gave back counts as recovered only when someone runs its recipe, as before.
- **Subagent whales.** The module expands a whale inside a reader subagent only if the host spills
  it under this session's own `tool-results/`. This is still a live check. When the module refuses
  it, the host's notice stays, and the whale convention routes it through json-slim as before.

### Pasted JSON on the prompt

The classic `prompt-json-guard.cjs` blocks a prompt over ~10 KB that carries a parseable JSON blob
over ~8 KB. The module gives such a prompt to `prompt-json-guard.cjs --from-mod` instead. The
script first saves every blob to a file. Then it replaces each blob in place with one of these:

- `mcp-slim.cjs`'s compressed body, with a `<<full=…>>` handle on that file;
- the blob's stub, when compression does not pay off: no gain, a body still 8 KB or more, or the
  prompt's 32 KB replacement budget is spent.

The stub of a pasted blob starts with a runnable `json-slim.cjs <file> --jq` over a sub-path from
the blob's shape. For a Jira search, this is `--jq '.issues[].key'`, then
`'.issues[].fields.status.name'`. So a one-field question costs a few hundred bytes. After it, the
stub names the whole-file profile with its size, for questions that a sub-path cannot answer.

The model gets the rewritten prompt plus one context line. That line names the files and the
`json-slim.cjs --jq` recipe to narrow them. A toast shows the figure, e.g.
`fnd-prompt-slim: 48,210 B → 2,104 B (−95.6%)`. It compares the paste with what the model reads
after fnd. For a stubbed blob, that is the profile that `json-slim.cjs` gives on demand, not the
stub's own size, and the toast says so: `fnd-prompt-slim: 25,072 B → 12,522 B (−50.1%), 1/1 stubbed`.
The toast stays for 5 s (`FND_SLIM_TOAST_MS` sets it, `FND_SLIM_TOAST=0` silences it). You submit
once, and nothing is blocked.
- **The row shows the rewrite.** The transcript row holds the rewritten text, not the paste. The
  original is only in the saved files.
- **The saved files are durable.** They go to the task workspace `tmp/` when there is exactly one
  work-id. Else they go to the project's `.claude/fnd-tmp/prompt-json/` (git-excluded through
  `.git/info/exclude`), never to system temp. Nothing sweeps them, so a handle survives a resume
  days later. Delete them by hand.
- **What it leaves alone.** Prompts with no JSON blob over the gate (prose, HTML, logs) pass as
  typed. The module does not rewrite slash commands, `!` commands and prompts that do not come
  from a person (peer messages, task notifications, plugin prompts). So a big JSON paste in them
  meets the classic block as before.
- **On failure the classic block applies.** If the module cannot build the rewrite (a failed save,
  a timeout, a too-large prompt), the prompt goes on unchanged, and the classic guard blocks it as
  before. The classic guard always runs beneath the rewrite and passes it (a live check).
- **Desktop.** Confirmed live in the desktop app's Code tab: the rewrite applies there too, and the
  spill goes under the project's `.claude/fnd-tmp/prompt-json/`.

### How mods load

- **Users:** install `fnd@domaine` as in [Install](#claude-code--from-the-published-git-marketplace-team-use).
  The module loads in the terminal CLI and in the desktop app's Code tab. You configure nothing
  and add no env entry. `/plugin disable fnd@domaine` turns it off with the rest of the plugin.
  `statusBand` (below) hides only fnd's band. When `band@domaine` is installed too, band draws the
  band and the panes, and fnd's module stands down on them by itself. band's own switch is its
  `disabled` option ([plugins/band/README.md](plugins/band/README.md#settings-userconfig)).
- **Development only:** `claude --plugin-dir plugins/fnd` loads the checkout for one terminal
  session. That session watches it and reloads on save. A desktop session cannot take that flag.
  There, `CLAUDE_CODE_PLUGIN_DIRS` (an absolute path) plus `CLAUDE_CODE_PLUGIN_DIR_WATCH=1`, both
  in the `env` block of `~/.claude/settings.json`, load and watch a folder.
  - That setting is user-global, so it also loads into every terminal session, client projects
    included.
  - Point it at a mod-only sandbox copy. Never point it at `plugins/fnd` beside the installed
    plugin, because that loads every skill, MCP server and classic hook twice.
  - Always **remove both entries after the sitting**.
  - Delete any sandbox copy before you install a release that carries the module. Else you get
    two bands and double hooks.
- `claude plugin validate --strict plugins/fnd` and `claude plugin test plugins/fnd` check the
  module without a session. `tests/mods-sim.sh` wraps them and runs both for every plugin, band
  included.

### Mods settings (userConfig)

`plugin.json` → `userConfig` has two fields. The engine documents them as rows in `/config`; it is
still a live check where they appear. They are stored in `~/.claude/settings.json` →
`pluginConfigs`, and a change reloads the module. Both stay fnd's until fnd's copy of the band is
removed. Both control only fnd's band. While the band plugin is loaded, fnd draws nothing, whatever
`statusBand` says, and the band's TTL comes from band's own `cacheTtl`. band's settings
(`disabled`, `cacheTtl`) are in [plugins/band/README.md](plugins/band/README.md#settings-userconfig).

| Field | Default | Effect |
|---|---|---|
| `statusBand` | `true` | `false` draws no fnd band. The panes, `/fnd-progress`, `/fnd-log`, the guard, slimming and the pasted-JSON rewrite keep working, and the session marker is still written. Ignored while the band plugin is loaded. |
| `cacheTtl` | `auto` | The prompt-cache TTL behind the countdown. `auto` learns it from the session: a `/model` switch reports it, and a subagent result with 1 h cache writes proves 1 h. A learned 1 h is remembered across sessions; a reported 5 min is not (the host reports 5 min before it has seen a 1 h cache write, so remembered it would outlive the session that made it). Until then the estimate is 1 h on a claude.ai account and 5 min when the session bills an API key or a cloud provider (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX` or `CLAUDE_CODE_USE_FOUNDRY` present in the session's environment; only their presence is read). Rate-limit windows arriving also mean a subscription, so they set 1 h too, over the default and over a remembered value, and a 5 min report on a subscription is ignored. A subscription in overage drops to 5 min, which the band cannot see; the cache segment is hidden while a window is at 100 %. `5m` or `1h` forces it. |

### Fallbacks and other hosts

- When a module hook fails, the host skips it, and the session goes on as without it. A failure in
  one fnd hook skips the module's other hooks on the same event. The guard latches its root again on
  the first tool call, and `/fnd-progress` and `/fnd-log` are registered again on the next prompt.
  The classic hooks stay wired underneath, so the guard and slimming lose nothing. A pasted-JSON
  prompt meets the classic block instead of the rewrite.
- Some places cannot spawn commands. The docs call the module's process API CLI-only, but the
  desktop app's Code tab spawns without problems. Where spawning fails, the guard and slimming fall
  back to the classic hooks:
  - the deny comes from the PreToolUse guard;
  - an over-limit result keeps the host's notice, and the whale convention routes it;
  - `prompt-json-guard.cjs` blocks a big JSON paste as before.

  The progress resolver then has no branch name. It falls back to the conversation key and the
  newest workspace.
- Kill switches: `FND_SCRATCH_GUARD=0`, `FND_MCP_SLIM=0` and `FND_PROMPT_JSON=0` also turn off the
  module's guard, slimming and pasted-JSON rewrite. The module reads only the session's environment
  (the shell and `settings.json` → `env`). A value set only in `~/.config/domaine/env` reaches only
  the spawned `.cjs`. That script then allows or emits nothing, so the effect is the same, one
  spawn later. See the three rows in [Environment switches](#environment-switches).
- The classic context monitor (`FND_CTX_MONITOR`) stays wired. It is silent while a session marker
  is fresh. band writes the marker while it draws, and fnd's module writes it when band is not
  installed. The monitor speaks again when the marker goes stale (the module no longer loads), or
  when band is installed with `disabled: true`, which writes no marker.
- **Cursor, Codex CLI and OpenCode do not load the module.** Their manifests name their own hook
  files (`hooks/hooks-cursor.json`, `hooks/hooks-codex.json`), and OpenCode loads only
  `opencode/fnd-plugin.js`. Three shared changes reach them:
  1. `mcp-slim.cjs` passes its own output through unchanged. It also loads as a module without
     reading stdin, tracing or sweeping. `tests/hooks-codex-sim.sh`, `tests/hooks-cursor-sim.sh`
     and `tests/opencode-plugin-sim.mjs` pin the passthrough and that their spawn is unchanged;
     `tests/hooks-sim.sh` M-req pins the module load.
  2. The whale convention is now in two parts. Claude Code reads the short
     `hooks/mcp-whale-claude.md`, because over-limit results arrive already slimmed or stubbed.
     Every other host keeps the full `hooks/mcp-whale.md` (Cursor through `rules/fnd-mcp-whale.mdc`).
  3. The untrusted-content convention names the prompt spills (task workspace `tmp/`,
     `.claude/fnd-tmp/prompt-json/`) as real handles. OpenCode's own `<<fnd-prompt-json full=…>>`
     rewrite (`opencode/fnd-plugin.js`) also makes such handles.

## Lean-code convention

A session-start hook injects `hooks/lean-code.md`, a "lazy senior developer" discipline (idea
adapted from [ponytail](https://github.com/DietrichGebert/ponytail)). Before the agent writes
code, it walks a reuse ladder: exists already? stdlib/Liquid built-in? Shopify-native? installed
dependency? one line? Only then does it write the minimum that works. fnd adds two guardrails. The
ticket/AC defines *scope*, and the ladder only controls *how* the agent builds it. Explicit skill
output contracts outrank the ladder.

A `SubagentStart` hook (`hooks/subagent-conventions.sh`) injects the same convention plus comment
discipline into code-writing subagents (general-purpose, workflow). Where the project profile says
`foundation`, it also injects the Foundation addendum (see `FND_PROFILE`). Read-only readers skip
all of those and get only the outside-content rail. To disable it permanently, set `FND_LEAN=0`
(project or global `settings.json` → `env`). To suspend it for the current session, say
"normal mode".

## How-to-explain convention

A session-start hook also injects `hooks/writing-style.md`. When the agent explains code, a plan,
an error or a change, it follows the ASD-STE100 rules to about 80%: one idea per sentence, active
voice, one word per thing, answer first, steps as a numbered list, and a symbol diagram past three
steps or parts. "Explain in HTML" asks for one self-contained interactive page. The main session
gets this convention, and subagents do not. Skill output formats (Steps to Test, TA, PR body, QA
report) still decide the structure and the mandatory wording. To disable it permanently, set
`FND_STE=0` (project or global `settings.json` → `env`). To suspend it for the current session,
say "normal writing".

## Permission design notes

We made two decisions on purpose. We record them here, so that they do not look like omissions:

- **The big workflow skills ship without `allowed-tools`.** `write-technical-approach`,
  `develop-feature-or-fix`, `qa-feature-or-fix`, `qa-preflight`, `write-steps-to-test`,
  `pre-commit-review`, `create-pull-request`, `ship`, and `save-task-context` orchestrate
  open-ended work (editing, store runners, browser MCPs, subagents). So they run under the
  session's normal permission flow, not under a frozen allowlist. A frozen list that misses one
  instructed tool blocks the skill's own workflow. The other ten skills are narrow utilities
  (translations, breaking-changes ×2, preview themes, worktrees, commit, a11y fixes, preflight
  checks, smoke test, issue reports), and they do declare tight allowlists.
- **The reader/writer agents are fenced with `disallowedTools:`, not `tools:`.**
  `jira-reader`, `jira-writer`, `figma-reader`, and `doc-reader` must work when the Atlassian /
  Figma / Notion MCP comes from this plugin and also when it comes from the user's own config.
  The MCP tool names differ per install scope. So an allowlist of hardcoded names would silently
  break them on the other scope. A denylist cannot break them:
  - It names every **write** tool of those servers in both spellings
    (`mcp__plugin_fnd_atlassian__editJiraIssue` and `mcp__atlassian__editJiraIssue`, …).
  - It denies, as a whole, the servers that an agent has no reason to touch.
  - It drops `Edit` and subagent spawning. For the agents that do not need them, it also drops
    `WebFetch` / `WebSearch`.

  Reads keep working under any scope, and a name that does not exist on this install does
  nothing. The prompt contract still holds. The three readers stay read-only toward their sources,
  and each writes only its own workspace file. `jira-writer` keeps exactly one approved write
  (`editJiraIssue` / `addCommentToJiraIssue`) plus its read-back. Their `Bash` is only for the
  bundled scripts: `adf-to-md.cjs`, `json-slim.cjs` and, for `jira-reader`, `jira-attachments.sh`.
  This script brings a ticket's images to disk, so the agent does not run `curl` or `ffmpeg`
  itself. They also run one `date -u +%FT%TZ` for the `fetched_at` stamp of the workspace file.
  The code-reading agents (`bug-hunter`, `change-reviewer`, `theme-explorer`) name no MCP, so they
  are pinned to `Read, Grep, Glob, Bash` instead.

## Reporting plugin issues

When an fnd component misbehaves, run `/fnd:report-plugin-issue`. Examples are a bundled script
that crashes or prints a misleading `error=`, a converter that damages content, or a skill that
contradicts what the tools actually do. The skill collects sanitized debug info (versions, exact
command, output — **never tokens or secrets**). It checks for duplicates and shows you the draft.
After you approve, it files a GitHub issue on this repo. A session-start hook also tells Claude to
propose it whenever it notices a plugin defect mid-task.

## License

MIT — see [LICENSE](./LICENSE).
