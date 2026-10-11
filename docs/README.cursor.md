# fnd on Cursor

This page gives the quickstart, the update path and the differences that apply only to Cursor.
Claude Code uses the same plugin content from the same checkout; only the wiring is different.
For the picture across all hosts, start at the [README](../README.md#install--four-hosts).

> [!NOTE]
> **fnd is frozen at 0.135.0 and supported on Cursor until 2027-06-30.** Until that date, we fix
> only a blocking bug, and only on request (the `report-plugin-issue` skill files it). There are
> no new features. After 2027-06-30, we fix nothing. The Claude Code replacement (slim, band, base
> and the team plugins fe, qa, be, pm) does not run on this host, so fnd stays the plugin here.
> Details: [README → fnd is frozen](../README.md#fnd-is-frozen).

> [!IMPORTANT]
> **Verification status: unverified, frozen 2026-09-07.** The Cursor wiring ships as it was last
> measured. The hooks fire as the `FND_HOST_TRACE` matrix shows, and a headless `cursor-agent` run
> accepted the deny path. Since then, nobody has smoke-tested a release here in an interactive
> session. Three gaps stay open by decision. First, `afterMCPExecution` is observe-only, so Cursor
> gets no compression, stub or spill. Second, nobody has confirmed the `subagentStart` injection of
> the conventions. Third, the model-pin bug below. For details and the meaning of "best-effort",
> see [README → Host verification
> status](../README.md#host-verification-status--cursor-codex-cli-and-opencode-are-unverified).

## Install

> [!WARNING]
> **Cursor currently ignores subagent model pins — on every install route.** Because of a Cursor
> bug, plugin agents drop their `model:` frontmatter. Cursor staff acknowledged the bug; it is open
> since April 2026, with **no fix date**. We first saw it on marketplace installs. On 2026-08-24 we
> verified it live on the local-symlink install too. On both routes, every fnd subagent
> (`jira-reader`, `figma-reader`, `bug-hunter`, …) silently uses the session model. It does not
> use the tier map in `plugins/fnd/references/host-model-map.md`. Skills, hooks, MCP and the
> agents still work; only the model routing is lost. The pins stay in the generated agents, so they
> apply as soon as Cursor ships the fix. Until then, **choose the session model with the
> subagents in mind**. For example, run the review gates from a `claude-sonnet-5` session.

Use the **marketplace** route. It needs no clone and no shell: Cursor installs the plugin into its
own cache and gets updates from GitHub. A local-checkout route also exists: a symlink install
through `./scripts/install.sh`. The end of this section describes it as the alternative. Use it
to work on the plugin itself or to run unpushed commits.

### 0. Prerequisites

- **Cursor itself**: the desktop app from [cursor.com](https://cursor.com), in a current version.
  The plugin layer (`plugin.json`, hooks, `mcp.json`) is a recent addition, so update the app
  before you suspect the install. Sign in, so that chat works. You do not need the Cursor CLI.
- **Node.js** (any current LTS) and **git** on your PATH. Every fnd script and hook runs on bare
  `node`, without npm installs.

### 1. Install from the marketplace

This step needs no clone and no shell (verified live on 2026-08-22). In Cursor, open
**Customize → Plugins → Add Marketplace** (or type `/add-plugin` in chat). Paste this URL:

```text
https://github.com/domaine-oleksandr-kever/claude-plugins
```

Then press **Add** on the **fnd** card under the name of the marketplace. Cursor clones the plugin
into its own cache. It keeps the plugin updated when it indexes the marketplace again from
GitHub. Thus, as on Codex, **unpushed commits are invisible** on this route.
`node plugins/fnd/scripts/doctor.cjs --target cursor` shows the result as
`marketplace cache install`.

To **uninstall**, use the same screen: in Customize → Plugins, open the `…` menu of the fnd card
and select Uninstall. You also remove an old or duplicate marketplace entry there. When you add a
marketplace, Cursor does NOT install its plugins. When you remove a marketplace, an installed
plugin stays installed.

This route uses only the editor UI, on purpose. The Cursor CLI has no commands to install or
uninstall a plugin (Cursor staff confirmed this). Any script would need workarounds, so stay in
the editor.

### 2. Reload the Cursor window

Open the Command Palette (`Cmd+Shift+P`) and run *Developer: Reload Window*. Cursor reads the
manifest, the hooks wiring and `mcp.json` at startup. Thus a new install is not live until you
reload. On the first load, the remote servers (Atlassian, Notion) also ask for MCP auth. Approve
the servers that you use.

### 3. Run the smoke test once

Run `/smoke-test` in a Cursor chat. It proves the layers that a script cannot reach: MCP
connectivity, subagent spawning, that the commit guards fire, and the arrival of the session conventions.
Run it after an install or an update, not in each session. `/preflight-checks` does the recurring
check per project.

**Proving the hooks fired.** The last row of the smoke test reads a log; it does not trust the
model. Arm `FND_HOST_TRACE` globally
(`node plugins/fnd/scripts/domaine-env.cjs set FND_HOST_TRACE=1`). Reload the window and use the
session normally. Then run `node plugins/fnd/scripts/doctor.cjs --trace --since 2h`. Under host
`cursor`, a healthy run shows `SessionStart/cursor-shim`, `UserPromptSubmit/cursor-shim` and
`SubagentStart/cursor-shim`, because on this host the adapter builds those contexts. Next to them
are the rows that the started scripts log for themselves (`user-prompt`, `subagent-conventions`,
`no-verify-bypass`, `no-ai-attribution`, `spill-access`, `mcp-slim`). Full recipe:
[Verifying any install](../README.md#verifying-any-install).

### Alternative: local checkout — script install

On this route, the clone **is** the install. Cursor reads a symlink into
`~/.cursor/plugins/local/fnd`, so it loads the files in the checkout, and a `git pull` updates
the host live. Use this route to work on the plugin itself or to run unpushed commits. The
bootstrap one-liner clones this repo to a permanent location and runs the Cursor installer in it.
The default location is `~/tools/claude-plugins`; use `--dir <path>` to change it.

```bash
curl -fsSL https://raw.githubusercontent.com/domaine-oleksandr-kever/claude-plugins/main/scripts/bootstrap.sh | bash -s -- --targets cursor --yes
```

`--yes` makes it one command: it accepts the default location and does not ask for one when a
terminal is attached. Piped runs never ask. The clone is not a temporary download. The symlink
points into it, so this folder **is** the installed plugin, and if you delete it, you uninstall
everything. Keep it where the bootstrap put it. If you already have a clone, or prefer to do the
steps by hand, run this equivalent:

```bash
git clone https://github.com/domaine-oleksandr-kever/claude-plugins.git ~/tools/claude-plugins
cd ~/tools/claude-plugins
./scripts/install.sh --target cursor
```

On both paths, the installer does a pull (`git pull --ff-only`, skipped on a dirty tree) and
creates the symlink. It refuses to overwrite anything that it did not create. At the end, it runs
`doctor.cjs --target cursor` for you. Read those rows before you do anything else:

```text
PASS  manifest:cursor        .cursor-plugin/plugin.json version <version>
PASS  version-sync           3 manifests all at <version>
PASS  generator-sync         generated dirs match scripts/gen-host-adapters.cjs
PASS  install:cursor         symlink install, 1 entry(ies) live (root: ~/.cursor/plugins/local)
```

To run the doctor again at any time, use `node plugins/fnd/scripts/doctor.cjs --target cursor`.
On a machine with only the marketplace install, the same command from an unlinked checkout shows
`install:cursor` as **not installed**. This result is about the checkout, not the host, and the
row names the cached bundle to run the doctor from.

`--copy` installs a real copy instead of the symlink, for environments without symlinks. Such an
install does **not** follow `git pull`. To refresh it, run
`./scripts/install.sh --target cursor --copy` again.
`./scripts/install.sh --target cursor --uninstall` removes only the entries that the installer
created. Then do step 2 (reload) and step 3 (smoke test).

**Use one route per machine.** A marketplace install and a local-checkout install are two
separate copies of the plugin. If both are present, both load: the model gets duplicate skills
and agents, and every hook fires twice. `./scripts/install.sh --target cursor --uninstall` removes
the local copy. You remove the marketplace copy in Customize → Plugins.

## Update

On the **marketplace route**, you run nothing. Cursor indexes the marketplace again from GitHub
by itself, about every 10 minutes, with pushes in batches. You can also press **Refresh** on the
marketplace in Customize → Plugins. Only pushed commits arrive.

On the **local-checkout route**:

```bash
cd /path/to/claude-plugins
./scripts/install.sh --target cursor        # = git pull --ff-only + re-link + doctor
```

The installer is also the updater; this host has no "reinstall". This table shows when each
change becomes live:

| Changed | Live after |
|---|---|
| Skills, references, agents, scripts | the next read (no reload needed) |
| `.cursor-plugin/plugin.json`, `hooks/hooks-cursor.json`, `mcp.json`, `rules/` | a window reload |

A `--copy` install refreshes only when you run the installer again. Thus use the symlink route,
unless your filesystem does not allow symlinks.

## What's different on Cursor

- **The static conventions arrive as rules, not through a session hook.** The Foundation session
  conventions are comment discipline, lean code, how to explain, task workspace, whale routing,
  plugin feedback and outside content as data. They ship as always-applied `rules/fnd-*.mdc`.
  `gen-host-adapters.cjs` generates these files from `plugins/fnd/hooks/*.md`. Never edit one by
  hand: change the hook and run the generator again. They are next to the vendored
  `meetdomaine/foundation` theme rules (13 `.mdc`; `plugins/fnd/rules/SOURCE.md` records their
  source). The `sessionStart` hook keeps only the dynamic part. This part is what a rule file
  cannot answer (the plugin-root and project-profile lines) and the blocks that depend on
  detection: live-store access and, in a `foundation` checkout, the LiquidDoc-and-core addendum
  `hooks/comment-discipline-foundation.md`. A rule cannot look at the workspace. As a result,
  `FND_LEAN=0` and `FND_STE=0` do not reach the session copy here. Turn off
  `rules/fnd-lean-code.mdc` or `rules/fnd-writing-style.mdc` instead.
- **MCP output is NOT compressed here.** The `afterMCPExecution` hook of Cursor has no response
  schema. The docs list none, and on 2026.09.02 we measured that Cursor ignores
  `updated_mcp_tool_output` and every other key. Thus a hook cannot rewrite or stub a tool result:
  the model reads it raw, and this host never starts `mcp-slim`. The shim only logs that the event
  fired (`PostToolUse/cursor-shim skip` in `doctor --trace`). The `json-slim` CLI recipe still
  applies to any large file on disk.
- **The cap of about 40 tools.** Community reports say that Cursor stops showing tools after about
  40 across all servers. The six bundled servers have about three times that number. `mcp.json`
  still ships all six. See [Bundled MCP servers](../README.md#the-same-list-on-the-other-hosts) for
  the reduced priority profile (`mcp.pruned.json`) and for how to apply it in Cursor Settings → MCP.
- **Only one level of subagents.** `ship` and the review flow run the *hoisted* orchestration
  shape. The conductor is the only agent that starts other agents. A phase brief names nested
  helpers (`bug-hunter`, `change-reviewer`, the PR conformance pass). The conductor starts each of
  them itself and gives their findings to the phase. The phases, gates and artifacts are the same.
  The losses are the adversarial verify fan-out and the telemetry per phase.
  `plugins/fnd/references/host-orchestration.md` gives the full description
  (`plugins/fnd/references/pipeline-phases.md` → Orchestration is the branch point).
- **Every subagent has a model pin, but the pins currently do nothing (see the warning at the top
  of Install).** Cursor frontmatter accepts only `inherit` or an exact versioned id, without family
  aliases (verified 2026-08-23). The pins follow the Domaine model-selection guidelines. The
  reader-type agents and `theme-explorer` pin the cheapest model of Cursor,
  `composer-2.5[fast=false]`. This is the standard variant; the default Fast variant costs more.
  The review gates (`bug-hunter`, `change-reviewer`) pin `claude-sonnet-5`, the model at which the
  guidelines start deep PR review. The guidelines do not allow Opus for standard reviews. Thus a
  model above a pin must be a deliberate manual choice, not a session default. The full map is in
  `plugins/fnd/references/host-model-map.md`. The model ladder for the session and the Plan-Mode
  triggers are in `rules/fnd-model-policy.mdc`. Never edit a generated agent by hand: change the
  tier table in `plugins/fnd/scripts/gen-host-adapters.cjs` and run the generator again. Until
  Cursor fixes the frontmatter bug, every subagent runs on the session model. So the session model
  picker is the only model control that works. The model picker of a fresh install can lack `claude-sonnet-5`. If
  a spawn rejects it, enable it once through **Add Models** in the picker. Then check again with
  the model-pin row of `/preflight-checks`.
- **The context-usage monitor does not work.** It reads the session transcript, and
  `beforeSubmitPrompt` does not give a hook the transcript. The prompt-JSON guard, the other half
  of the same hook, works normally.
- **The screenshot scratch-path guard uses `beforeMCPExecution`.** It gives the same deny as on
  Claude Code and Codex, in the form of this host: a `permission: "deny"` response with a
  `user_message` / `agent_message` pair. The shim handles two payload differences. Cursor gives
  the hook `tool_input` as a JSON *string*. Also, the tool name has no server prefix
  (`mcp_server_name` is a separate field). `FND_SCRATCH_GUARD=0` turns the guard off here too.
- **Cloud Agents run without your plugins.** A Cursor Cloud/background agent runs on a remote VM
  with an empty plugin cache. We verified this live on 2026-08-22: `.cloud-plugin-manifest.json`
  carries `plugins: []`. No fnd skills, hooks, MCP or subagents go with the agent. In particular,
  the `--no-verify` commit guard is **absent** there. This document describes only local desktop
  sessions. Run `/smoke-test` in a normal local chat, not in a Cloud Agent, or it reports on an
  empty host.
- **Hook path resolution.** Cursor sets both `CURSOR_PLUGIN_ROOT` and `CLAUDE_PLUGIN_ROOT`. Cursor
  staff also acknowledged a leak between the hooks of plugins that run at the same time. Thus the
  wiring tries a chain (`CURSOR_PLUGIN_ROOT` → `CLAUDE_PLUGIN_ROOT` →
  `~/.cursor/plugins/local/fnd`), and the guard scripts find their own paths from `__dirname`. If
  the wiring finds no shim, it **denies** a git command that looks like a commit, push, merge or
  pull. It does not run that command unchecked.
- **Headless `cursor-agent -p` loads none of the installed plugins.** We measured this on
  2026.09.02: no fnd hook fires and no trace line appears. Thus a scripted run must name the
  plugin itself: `cursor-agent -p --plugin-dir ~/.cursor/plugins/local/fnd …`. The IDE does not
  need this flag.

## Project layer

The plugin is a user-space install and only adds to a project. A project's own `.cursor/rules`,
`.cursor/skills`, `.cursor/hooks.json` and `mcp.json` all keep working. Two rules prevent
conflicts between the two layers. Do not use fnd skill or agent names in a project, because the
model gets both copies. Never declare the fnd hooks again in a project `hooks.json`. All layers
fire, so a duplicate hook runs twice; it does not override.
