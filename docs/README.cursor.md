# fnd on Cursor

Quickstart, update path and the host-specific deltas. The plugin content is the same
checkout Claude Code uses — only the wiring differs. Start at the
[README](../README.md#install--four-hosts) for the cross-host picture.

## Install

Four steps from a clean machine to a proven install. The clone **is** the install: Cursor reads
a symlink into `~/.cursor/plugins/local/fnd`, so the files it loads are the ones in this
checkout. There is no separate "plugin cache" and no per-user copy to keep in sync.

### 0. Prerequisites

- **Cursor itself** — the desktop app from [cursor.com](https://cursor.com), on a current
  version (the plugin layer — `plugin.json`, hooks, `mcp.json` — is a recent addition; update
  the app before blaming the install). Sign in so chat works. No Cursor CLI is needed.
- **Node.js** (any current LTS) and **git** on your PATH — every fnd script and hook runs on
  bare `node`, no npm installs.

### 1. Clone this repo

```bash
git clone https://github.com/domaine-oleksandr-kever/claude-plugins.git
cd claude-plugins
```

While the multi-harness port is unreleased, its content lives on the `harness-port` branch —
check it out before installing (once the port merges, `main` is the branch and this step
disappears):

```bash
git checkout harness-port
```

### 2. Run the installer

```bash
./scripts/install.sh --target cursor
```

The installer pulls (`git pull --ff-only`, skipped on a dirty tree), creates the symlink,
refuses to clobber anything it did not create, and finishes by running `doctor.cjs --target
cursor` for you — read those rows before doing anything else:

```text
PASS  manifest:cursor        .cursor-plugin/plugin.json version <version>
PASS  version-sync           3 manifests all at <version>
PASS  generator-sync         generated dirs match scripts/gen-host-adapters.cjs
PASS  install:cursor         symlink install, 1 entry(ies) live (root: ~/.cursor/plugins/local)
```

Re-run it any time: `node plugins/fnd/scripts/doctor.cjs --target cursor`.

### 3. Reload the Cursor window

Command Palette (`Cmd+Shift+P`) → *Developer: Reload Window*. The manifest, the hooks wiring
and `mcp.json` are read at startup, so a fresh install is not live until you do. First load
also brings MCP auth prompts for the remote servers (Atlassian, Notion) — approve the ones you
use.

### 4. Run the smoke test once

`/smoke-test` in a Cursor chat. It proves the layers a script cannot reach — MCP connectivity,
subagent spawning, the commit guards firing, the session conventions arriving. Run it after
installing or updating, not every session (`/preflight-checks` owns the recurring per-project
role).

`--copy` installs a real copy instead of the symlink (no-symlink environments); such an install
does **not** follow `git pull` — re-run `./scripts/install.sh --target cursor --copy` to refresh
it. `./scripts/install.sh --target cursor --uninstall` removes only the entries the installer
created.

## Update

```bash
cd /path/to/claude-plugins
./scripts/install.sh --target cursor        # = git pull --ff-only + re-link + doctor
```

The installer is the updater — there is no "reinstall" on this host. What lands when:

| Changed | Live after |
|---|---|
| Skills, references, agents, scripts | the next read (no reload needed) |
| `.cursor-plugin/plugin.json`, `hooks/hooks-cursor.json`, `mcp.json`, `rules/` | a window reload |

A `--copy` install refreshes only when you re-run the installer, so prefer the symlink route
unless your filesystem forbids it.

## What's different on Cursor

- **Statics arrive as rules, not as a session hook.** The Foundation session conventions
  (comment discipline, lean code, task workspace, whale routing, plugin feedback) ship as
  always-applied `rules/fnd-*.mdc`, alongside the vendored `meetdomaine/foundation` theme rules
  (13 `.mdc`, provenance in `plugins/fnd/rules/SOURCE.md`). The `sessionStart` hook keeps only
  the dynamic, detection-gated part (live-store access). Consequence: `FND_LEAN=0` does not
  reach the session copy here — turn `rules/fnd-lean-code.mdc` off instead.
- **MCP output is rewritten in place.** Cursor's `afterMCPExecution` can replace a tool result,
  so `mcp-slim` both compresses and spills-and-stubs here, exactly as on Claude Code.
- **The ~40-tool cap.** Cursor is community-reported to stop exposing tools past ~40 across all
  servers; the six bundled servers are roughly three times that. `mcp.json` still ships all six —
  see [Bundled MCP servers](../README.md#the-same-list-on-the-other-hosts) for the pruned
  priority profile (`mcp.pruned.json`) and how to apply it from Cursor Settings → MCP.
- **One level of subagents.** `ship` and the review flow run the *hoisted* orchestration shape:
  the conductor is the only spawner, and every nested helper a phase brief names
  (`bug-hunter`, `change-reviewer`, the PR conformance pass) is hoisted to the conductor and its
  findings handed into the phase. Same phases, same gates, same artifacts; what is lost is the
  adversarial verify fan-out and the per-phase telemetry —
  `plugins/fnd/references/pipeline-phases.md` states it in full. Claude Code's scripted Workflow
  layer has no analogue and nothing to reproduce: `ship` never scripted one.
- **Models are pinned per agent** from the Domaine "Model Selection and Agentic Usage
  Guidelines" v1.0 — the generated `agents-cursor/*.md` carry them, the whole map is in
  `plugins/fnd/references/host-model-map.md`, and the ladder + Plan-Mode triggers ride in
  `rules/fnd-model-policy.mdc`. Never hand-edit a generated agent: change the tier table in
  `plugins/fnd/scripts/gen-host-adapters.cjs` and re-run the generator.
- **The context-usage monitor is inert.** It reads the session transcript, which
  `beforeSubmitPrompt` does not hand a hook; the prompt-JSON guard half of the same hook works
  normally.
- **Hook path resolution.** Cursor sets both `CURSOR_PLUGIN_ROOT` and `CLAUDE_PLUGIN_ROOT` and
  has a staff-acknowledged leak between concurrent plugins' hooks, so the wiring probes a chain
  (`CURSOR_PLUGIN_ROOT` → `CLAUDE_PLUGIN_ROOT` → `~/.cursor/plugins/local/fnd`) and the guard
  scripts resolve their own paths from `__dirname`. If no shim is found, a git command that
  looks like a commit/push/merge/pull is **denied** rather than run unchecked.

## Project layer

The plugin is a user-space install and stays additive: a project's own `.cursor/rules`,
`.cursor/skills`, `.cursor/hooks.json` and `mcp.json` all keep working. Two rules keep the two
layers from fighting — do not reuse fnd skill or agent names project-side (both copies reach the
model), and never re-declare the fnd hooks in a project `hooks.json` (all layers fire, so a
duplicate means double-run, not override).
