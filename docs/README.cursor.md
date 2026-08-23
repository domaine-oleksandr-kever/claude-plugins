# fnd on Cursor

Quickstart, update path and the host-specific deltas. The plugin content is the same
checkout Claude Code uses — only the wiring differs. Start at the
[README](../README.md#install--four-hosts) for the cross-host picture.

## Install

The route is the **local checkout**: the clone **is** the install — Cursor reads a symlink into
`~/.cursor/plugins/local/fnd`, so the files it loads are the ones in this checkout, agent model
pins bind, and a `git pull` updates the host live. A marketplace route also exists, but a Cursor
bug currently breaks its model routing — it is documented at the end of this section as the
alternative, with that caveat.

### 0. Prerequisites

- **Cursor itself** — the desktop app from [cursor.com](https://cursor.com), on a current
  version (the plugin layer — `plugin.json`, hooks, `mcp.json` — is a recent addition; update
  the app before blaming the install). Sign in so chat works. No Cursor CLI is needed.
- **Node.js** (any current LTS) and **git** on your PATH — every fnd script and hook runs on
  bare `node`, no npm installs.

### 1. Install — one command

The bootstrap one-liner clones this repo to a permanent location (default
`~/tools/claude-plugins`; `--dir <path>` to change) and runs the Cursor installer inside it:

```bash
curl -fsSL https://raw.githubusercontent.com/domaine-oleksandr-kever/claude-plugins/main/scripts/bootstrap.sh | bash -s -- --targets cursor
```

The clone is not a temporary download — the symlink points into it, so this folder **is** the
installed plugin and deleting it uninstalls everything; leave it where the bootstrap put it.
Already have a clone, or prefer the steps by hand? The equivalent is:

```bash
git clone https://github.com/domaine-oleksandr-kever/claude-plugins.git ~/tools/claude-plugins
cd ~/tools/claude-plugins
./scripts/install.sh --target cursor
```

Either way the installer pulls (`git pull --ff-only`, skipped on a dirty tree), creates the
symlink, refuses to clobber anything it did not create, and finishes by running `doctor.cjs
--target cursor` for you — read those rows before doing anything else:

```text
PASS  manifest:cursor        .cursor-plugin/plugin.json version <version>
PASS  version-sync           3 manifests all at <version>
PASS  generator-sync         generated dirs match scripts/gen-host-adapters.cjs
PASS  install:cursor         symlink install, 1 entry(ies) live (root: ~/.cursor/plugins/local)
```

Re-run it any time: `node plugins/fnd/scripts/doctor.cjs --target cursor`.

### 2. Reload the Cursor window

Command Palette (`Cmd+Shift+P`) → *Developer: Reload Window*. The manifest, the hooks wiring
and `mcp.json` are read at startup, so a fresh install is not live until you do. First load
also brings MCP auth prompts for the remote servers (Atlassian, Notion) — approve the ones you
use.

### 3. Run the smoke test once

`/smoke-test` in a Cursor chat. It proves the layers a script cannot reach — MCP connectivity,
subagent spawning, the commit guards firing, the session conventions arriving. Run it after
installing or updating, not every session (`/preflight-checks` owns the recurring per-project
role).

`--copy` installs a real copy instead of the symlink (no-symlink environments); such an install
does **not** follow `git pull` — re-run `./scripts/install.sh --target cursor --copy` to refresh
it. `./scripts/install.sh --target cursor --uninstall` removes only the entries the installer
created.

### Alternative: marketplace route — currently degraded

> [!WARNING]
> **Marketplace installs currently ignore agent model pins.** A staff-acknowledged Cursor bug
> (open since April 2026, **no fix date**) makes marketplace-installed plugin agents drop their
> `model:` frontmatter — on this route every fnd subagent silently inherits the session model
> instead of the tier map in `plugins/fnd/references/host-model-map.md`. Skills, hooks, MCP and
> the agents themselves still work; only the model routing is lost. Until Cursor fixes it,
> **prefer the local-checkout route above** — pins bind there — and confirm once with the
> `/preflight-checks` model-pin row.

No clone, no shell (live-verified 2026-08-22). In Cursor: **Customize → Plugins →
Add Marketplace** (or `/add-plugin` in chat), paste

```text
https://github.com/domaine-oleksandr-kever/claude-plugins
```

then press **Add** on the **fnd** card that appears under the marketplace's name. Cursor clones
the plugin into its own cache and keeps it updated by re-indexing the marketplace from GitHub —
which also means **unpushed commits are invisible** on this route, exactly as on Codex.
`node plugins/fnd/scripts/doctor.cjs --target cursor` recognizes the result as
`marketplace cache install`. Then do step 2 (reload) and step 3 (smoke test).

**Uninstalling** happens on the same screen: the fnd card's `…` menu → Uninstall in
Customize → Plugins; a stale or duplicate marketplace entry is removed there too. Registering
a marketplace does NOT install its plugins, and removing a marketplace does not uninstall an
already-installed plugin.

This route is editor-UI only, on purpose: the Cursor CLI has no plugin install/uninstall
commands (staff-confirmed), so anything scripted ends in workarounds — stay in the editor.

**Pick one route per machine.** A marketplace install and a local-checkout install are two
independent plugin copies — with both present, both load: duplicate skills and agents reach the
model, and every hook fires twice. `./scripts/install.sh --target cursor --uninstall` removes
the local one; the marketplace one is removed from Customize → Plugins.

## Update

On the **local-checkout route**:

```bash
cd /path/to/claude-plugins
./scripts/install.sh --target cursor        # = git pull --ff-only + re-link + doctor
```

On the **marketplace route** there is nothing to run: Cursor re-indexes the marketplace from
GitHub on its own (batching pushes, roughly every 10 minutes), or press **Refresh** on the
marketplace in Customize → Plugins. Only pushed commits arrive.

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
- **Every subagent is pinned; the session picker does not reach them.** Cursor frontmatter takes
  only `inherit` or an exact versioned id (no family aliases, verified 2026-08-23). Per the
  Domaine model-selection guidelines: the reader-type agents and `theme-explorer` pin Cursor's
  cheapest model (`composer-2.5[fast=false]` — the standard variant; Fast is the pricier
  default), and the review gates (`bug-hunter`, `change-reviewer`) pin `claude-sonnet-5`, where
  the guidelines start deep PR review — Opus is barred from standard reviews there, so going
  past a pin is a deliberate manual act, not a session default. The whole map is in
  `plugins/fnd/references/host-model-map.md`; the session-level ladder + Plan-Mode triggers ride
  in `rules/fnd-model-policy.mdc`. Never hand-edit a generated agent: change the tier table in
  `plugins/fnd/scripts/gen-host-adapters.cjs` and re-run the generator. Known host bug: a
  **marketplace-installed** plugin's agents currently ignore `model:` frontmatter entirely
  (staff-acknowledged), so on that route every agent inherits until Cursor fixes it; pins apply
  on the local-symlink install. `claude-sonnet-5` may be absent from a fresh model picker — if a
  spawn rejects it, enable it once via the picker's **Add Models**, then re-check with the
  `/preflight-checks` model-pin row.
- **The context-usage monitor is inert.** It reads the session transcript, which
  `beforeSubmitPrompt` does not hand a hook; the prompt-JSON guard half of the same hook works
  normally.
- **Cloud Agents run without your plugins.** A Cursor Cloud/background agent executes on a
  remote VM whose plugin cache is empty (live-verified 2026-08-22: `.cloud-plugin-manifest.json`
  carries `plugins: []`) — no fnd skills, hooks, MCP or subagents ride along, and in particular
  the `--no-verify` commit guard is **absent** there. Everything in this document describes local
  desktop sessions; run `/smoke-test` in a regular local chat, not a Cloud Agent, or it reports
  on an empty host.
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
