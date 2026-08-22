# fnd on OpenCode

Quickstart, update path and the host-specific deltas. The plugin content is the same checkout
Claude Code uses — only the wiring differs. Start at the
[README](../README.md#install--four-hosts) for the cross-host picture.

OpenCode has no plugin marketplace primitive, so the installer is the whole distribution
channel, and two pieces of configuration stay yours to paste: the MCP block and the static
conventions.

## Install

```bash
git clone https://github.com/domaine-oleksandr-kever/claude-plugins.git
cd claude-plugins
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

Then merge two fragments into your own `opencode.json` (nothing links these — they change a
file you own):

1. **MCP servers** — paste the `mcp` block from `plugins/fnd/opencode/mcp-fragment.json`.
2. **The commit-guard backstop** — merge the `permission.bash` deny globs from
   `plugins/fnd/opencode/permission-fragment.example.json`. The JS adapter is the precise layer;
   these globs are the blunt one that still holds in `--auto` runs and when the adapter never
   loaded.

   Because they are blunt, the fragment re-allows a few documented false positives — read-only
   `git config --get core.hooksPath`, `chmod +x` on a hook file,
   `git push --no-verify-signatures`. Those re-allows are **exact** command strings, never
   `prefix*` patterns: a trailing `*` swallows the rest of the line, and under last-match-wins an
   allow like `chmod +x*` would re-permit `chmod +x .husky/pre-commit && git commit --no-verify`
   that the deny rules above it had just blocked. The cost of exactness is that a variant
   spelling (another hook name, extra `git push` arguments) stays denied — run those yourself
   rather than widening the pattern.

Optional: **model tiering**. Generated agents carry no `model:` pin (see below); to opt in, copy
the `agent` block from `plugins/fnd/opencode/model-profile.cloud.example.json` or
`model-profile.local.example.json` into your `opencode.json` and replace the ids with ones your
provider config actually exposes.

### Verify

The installer finishes by running `doctor.cjs --target opencode`:

```text
PASS  generator-sync         generated dirs match scripts/gen-host-adapters.cjs
PASS  install:opencode       symlink install, 44 entry(ies) live (root: ~/.config/opencode)
```

Re-run it any time: `node plugins/fnd/scripts/doctor.cjs --target opencode`.

Then start a **new OpenCode session** and run the smoke test once: `/smoke-test` (the command
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
  discipline, lean code, task workspace, whale routing, plugin feedback) belong in your
  `instructions` config or an `AGENTS.md` pointed at `plugins/fnd/hooks/*.md` — which costs
  nothing per message and survives compaction. Consequence: `FND_LEAN=0` cannot reach them here;
  remove the file from `instructions` instead.
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
