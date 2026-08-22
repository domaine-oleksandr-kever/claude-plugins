# fnd on OpenCode

Quickstart, update path and the host-specific deltas. The plugin content is the same checkout
Claude Code uses — only the wiring differs. Start at the
[README](../README.md#install--four-hosts) for the cross-host picture.

OpenCode has no plugin marketplace primitive, so the installer is the whole distribution
channel, and three pieces of configuration stay yours to paste: the MCP block, the commit-guard
backstop and the static conventions.

## Install

Seven steps take a machine that has never seen OpenCode to a proven install: 0 installs the host
itself, 1–2 clone and link the plugin, 3–5 are three pastes into a config file you own, 6 is
optional, 7 proves the whole thing in a live session.

### 0. Prerequisites — the host and the runtime

Skip anything you already have:

- **OpenCode itself.** The official installer:

  ```bash
  curl -fsSL https://opencode.ai/install | bash
  ```

  (`npm i -g opencode-ai` and `brew install sst/tap/opencode` are the upstream alternatives —
  see [opencode.ai/docs](https://opencode.ai/docs/) for the current list.) Then connect a model
  provider: run `opencode auth login` and follow the prompts, or wire a local provider in your
  config. `opencode` must start and answer a prompt before the plugin is worth installing.
- **Node.js** (any current LTS) and **git** on the PATH OpenCode inherits — every fnd script and
  hook runs on bare `node`, no npm installs.

### 1. Clone this repo

The clone is not a temporary download — step 2 symlinks the host config into it, so this
folder **is** the installed plugin and deleting it uninstalls everything. Put it somewhere
permanent (`~/tools/`, not `~/Downloads/`):

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
./scripts/install.sh --target opencode
```

The clone **is** the install: per-entry symlinks under `~/.config/opencode/`
(`$XDG_CONFIG_HOME` is honored) point back into this checkout, so `git pull` updates the host
live. The installer links, never replaces a directory of yours:

| Linked into | From |
|---|---|
| `~/.config/opencode/skills/<name>` | `plugins/fnd/skills/<name>` (18) |
| `~/.config/opencode/agents/<name>.md` | `plugins/fnd/agents-opencode/` (7, generated) |
| `~/.config/opencode/commands/<name>.md` | `plugins/fnd/commands-opencode/` (18 `/name` shims, generated) |
| `~/.config/opencode/plugins/fnd-plugin.js` | `plugins/fnd/opencode/fnd-plugin.js` |

> The install lever is **provisional** (`M1C-DEFAULT`): spike M1c still has to choose between
> these symlinks, `OPENCODE_CONFIG_DIR` and a global `opencode.json` fragment. Exactly one route
> will remain — mixing two would duplicate the content.

The installer finishes by running `doctor.cjs --target opencode` for you — read those rows
before moving on:

```text
PASS  generator-sync         generated dirs match scripts/gen-host-adapters.cjs
PASS  install:opencode       symlink install, 44 entry(ies) live (root: ~/.config/opencode)
```

Re-run it any time: `node plugins/fnd/scripts/doctor.cjs --target opencode`.

The next three steps are pastes into **your own** `opencode.json` — the installer never links or
edits that file, because it is yours. The global one lives at
`~/.config/opencode/opencode.json`; if it does not exist yet, create it as:

```json
{
  "$schema": "https://opencode.ai/config.json"
}
```

### 3. Paste the MCP servers into your `opencode.json`

Open `plugins/fnd/opencode/mcp-fragment.json` (generated from the canonical server list) and
copy its `mcp` object — the whole `"mcp": { … }` block, six servers — into the top level of your
`opencode.json`, next to `$schema`. Do not copy the `_comment` key. If your config already has
an `mcp` block, add the six fnd entries inside it rather than replacing yours.

The end state, in full (this is the fragment's `mcp` block as generated today — if it differs
from your copy of `plugins/fnd/opencode/mcp-fragment.json`, the file wins):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "chrome-devtools-mcp": {
      "type": "local",
      "command": ["npx", "-y", "chrome-devtools-mcp@latest", "--isolated"]
    },
    "atlassian": {
      "type": "local",
      "command": ["npx", "-y", "mcp-remote", "https://mcp.atlassian.com/v1/mcp"]
    },
    "shopify-dev-mcp": {
      "type": "local",
      "command": ["npx", "-y", "@shopify/dev-mcp@latest"],
      "environment": { "LIQUID": "true" }
    },
    "figma-dev-mode": {
      "type": "remote",
      "url": "http://127.0.0.1:3845/sse"
    },
    "playwright": {
      "type": "local",
      "command": ["npx", "@playwright/mcp@latest"]
    },
    "notion-mcp": {
      "type": "remote",
      "url": "https://mcp.notion.com/mcp"
    }
  }
}
```

### 4. Paste the commit-guard backstop

Same file, second block: merge the `permission.bash` object from
`plugins/fnd/opencode/permission-fragment.example.json` into your `opencode.json` (top-level
`permission` key, next to `mcp`). The JS adapter is the precise layer; these globs are the blunt
one that still holds in `--auto` runs and when the adapter never loaded.

Because they are blunt, the fragment re-allows a few documented false positives — read-only
`git config --get core.hooksPath`, `chmod +x` on a hook file,
`git push --no-verify-signatures`. Those re-allows are **exact** command strings, never
`prefix*` patterns: a trailing `*` swallows the rest of the line, and under last-match-wins an
allow like `chmod +x*` would re-permit `chmod +x .husky/pre-commit && git commit --no-verify`
that the deny rules above it had just blocked. The cost of exactness is that a variant
spelling (another hook name, extra `git push` arguments) stays denied — run those yourself
rather than widening the pattern.

### 5. Paste the static conventions

The session conventions that other hosts inject for you — comment discipline, lean code, task
workspace, whale routing, plugin feedback — are wired by you on OpenCode: the plugin adapter
injects only the detection-gated live-store block. Without this paste **no fnd convention
reaches your sessions** (the smoke test's context-injection row goes red on exactly this).

Same file, third block: an `instructions` array at the top level, next to `mcp` and
`permission`, naming the five static files with the absolute path of your clone:

```json
"instructions": [
  "/absolute/path/to/claude-plugins/plugins/fnd/hooks/comment-discipline.md",
  "/absolute/path/to/claude-plugins/plugins/fnd/hooks/lean-code.md",
  "/absolute/path/to/claude-plugins/plugins/fnd/hooks/task-workspace.md",
  "/absolute/path/to/claude-plugins/plugins/fnd/hooks/mcp-whale.md",
  "/absolute/path/to/claude-plugins/plugins/fnd/hooks/plugin-feedback.md"
]
```

If your config already has `instructions`, append these entries to it. List the five files
explicitly — a `hooks/*.md` glob would also pull in `store-access.md`, which the adapter
injects dynamically only where store credentials exist, so a static copy would double it. (An
`AGENTS.md` referencing the same five files works too, if that is how you organize global
instructions.) Because the paths point into the clone, `git pull` updates the content with no
further pasting — only a renamed or added convention file comes back to this step.

### 6. Optional: model tiering

Generated agents carry no `model:` pin (see below); to opt in, copy
the `agent` block from `plugins/fnd/opencode/model-profile.cloud.example.json` or
`model-profile.local.example.json` into your `opencode.json` and replace the ids with ones your
provider config actually exposes.

### 7. Run the smoke test once

Start a **new OpenCode session** (config edits load at startup) and run: `/smoke-test` (the command
shim; OpenCode itself invokes skills by model choice only). It proves MCP connectivity, subagent
delegation, the commit guards firing and the session context arriving. Run it after installing
or updating, not every session — `/preflight-checks` owns the recurring per-project role.

## Update

```bash
cd /path/to/claude-plugins
./scripts/install.sh --target opencode      # = git pull --ff-only + re-link + doctor
```

The installer is the updater — there is no "reinstall" on this host. Skills, references and
agent bodies apply on the next read; the plugin adapter, the command shims and anything in your
own `opencode.json` need a **new session**. A skill removed or renamed upstream is pruned by the
same run that pulled it.

Two config-shaped changes never reach you automatically, because they live in a file you own:
re-check `mcp-fragment.json` and `permission-fragment.example.json` against your `opencode.json`
after an update that touched them.

`--copy` installs a real copy instead of symlinks; such an install does **not** follow
`git pull` — re-run `./scripts/install.sh --target opencode --copy` to refresh it.
`--uninstall` removes only the entries the installer created.

## What's different on OpenCode

- **Bun in-process runtime, real `node` children.** OpenCode loads plugins as JS/TS modules
  under Bun. `opencode/fnd-plugin.js` is wiring only — it spawns the canonical `hooks/*.cjs|sh`
  as real `node` processes rather than importing them, so nothing depends on Bun's CJS interop
  and the guards run byte-identically to Claude Code. `node` must be on the PATH OpenCode
  inherits.
- **No model pins, by design.** Generated `agents-opencode/*.md` carry no `model:` field, so
  every agent inherits the session model and local providers (`ollama/*`, `lmstudio/*`, custom
  OpenAI-compatible endpoints) work. A pin your provider config lacks would break the agent
  outright. Tiering is opt-in through the model-profile fragments above; the honest caveat is
  that the fnd review bar (`bug-hunter`, `pre-commit-review`) was calibrated on frontier models —
  a small local model will run, but finding quality is the model choice's responsibility.
- **Static conventions are yours to wire.** The adapter injects only the dynamic,
  detection-gated live-store block, once per session. The static conventions (comment
  discipline, lean code, task workspace, whale routing, plugin feedback) arrive through your
  `instructions` config — install step 5 is that paste — which costs nothing per message and
  survives compaction. Consequence: `FND_LEAN=0` cannot reach them here; remove the lean-code
  file from `instructions` instead.
- **MCP output is rewritten in place.** `tool.execute.after` exposes a mutable `output.output`,
  so `mcp-slim` both compresses and spills-and-stubs, as on Claude Code and Cursor.
- **A blocked prompt is rewritten, not erased.** Nothing can erase a message on this host, so
  when the prompt-JSON guard fires, each blob it spilled is replaced in place by its `full=`
  handle — the paste is offloaded exactly as on Claude Code instead of riding along every turn.
  The context-usage monitor is inert (`chat.message` hands a hook no transcript path).
- **No subagent-start hook.** The conventions that hook injects elsewhere are written into the
  generated agent bodies instead.
- **`/name` comes from shims.** OpenCode invokes skills by model choice only; the 18 generated
  `commands-opencode/*.md` shims give slash parity by loading the skill by name (with an
  anchored path fallback if the lookup misses).
- **Ship orchestration runs hoisted** unless you raised `subagent_depth`: the conductor is the
  only spawner and every nested helper is hoisted to it, possibly serialized — that costs
  wall-clock, not coverage (`plugins/fnd/references/pipeline-phases.md`).
- **Windows:** OpenCode recommends WSL; fnd is macOS-first and does not engineer around it.

## Project layer

The plugin is a user-space install and stays additive: a project's `.opencode/*`, `AGENTS.md`
and project `opencode.json` all keep working, and OpenCode merges configs across layers with
your own file winning. Do not reuse fnd skill, agent or command names project-side, and never
declare a second copy of the fnd plugin adapter — both would load, which means double injection
and a second compression pass.
