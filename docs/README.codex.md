# fnd on OpenAI Codex CLI

Quickstart, update path and the host-specific deltas. The plugin content is the same checkout
Claude Code uses — only the wiring differs. Start at the
[README](../README.md#install--four-hosts) for the cross-host picture.

Codex is the one host where the install arrives through **two channels**: the marketplace
plugin carries skills, hooks and MCP; the TOML subagents are linked by `install.sh` because no
plugin-level agents channel is confirmed yet (spike M1b). Skipping the second channel leaves
every delegating skill hitting an unknown agent.

## Install

### 0. Prerequisites — the host and the runtime

Skip anything you already have:

- **Codex CLI itself:**

  ```bash
  npm install -g @openai/codex
  ```

  (Homebrew ships it too; see the [Codex docs](https://developers.openai.com/codex/cli/) for
  the current channels.) Then run `codex` once and sign in — with a ChatGPT plan, or an API key
  if that is how your org runs it. Codex must start and answer a prompt before the plugin is
  worth installing.
- **Node.js** (any current LTS) and **git** on your PATH — every fnd script and hook runs on
  bare `node`, no npm installs.

### 1. Add the marketplace and install the plugin

```text
codex plugin marketplace add domaine-oleksandr-kever/claude-plugins
```

Codex reads `.claude-plugin/marketplace.json` as a legacy-compatible marketplace location, so
this repo is already a Codex marketplace — nothing separate is published. Then run `/plugins`
in Codex, find **fnd**, and install it.

To undo a registration: `codex plugin marketplace list` shows the configured name,
`codex plugin marketplace remove <name>` drops it. A registration also pins the git ref it
was added with — remove and re-add is how you point it at a different one. Removing a
marketplace does not uninstall an already-installed plugin; that happens in `/plugins`.

That legacy-compat path is research, not yet a live measurement (spike M1b). If the add command
does not resolve `plugins/fnd`, the repo gains a native `.agents/plugins/marketplace.json` and
this section changes with it — nothing else about the install does.

### 2. Turn the hooks feature on

Its default varies by CLI version, so set it explicitly in `~/.codex/config.toml`:

```toml
[features]
hooks = true
```

### 3. Trust-review the hooks

Non-managed hooks run only after an explicit **per-content-hash** review: run `/hooks` in
Codex, read fnd's entries (they are the commands in `plugins/fnd/hooks/hooks-codex.json`) and
approve them. Every update that changes a hook command needs the review again — that is what
the content hash is for, not a bug.

Nothing warns you if you skip steps 2 and 3: skills and MCP load either way, so the install
*looks* complete while the whole guard layer sits disarmed — session conventions, the
prompt-JSON guard, mcp-slim's spill-and-stub, and **both git guards**, including the
`--no-verify` block.

### 4. (Optional) Link the subagents from a checkout

Current Codex loads the whole bundle from the marketplace cache — TOML subagents included
(measured on CLI 0.149.0: `jira-reader` delegated on a cache-only install). Skip this step
unless subagent delegation fails on your CLI version, or you develop plugin content and want
Codex running your local checkout's agents:

```bash
git clone https://github.com/domaine-oleksandr-kever/claude-plugins.git
cd claude-plugins
./scripts/install.sh --target codex
```

Keep this clone somewhere permanent — the links point into it, so deleting the folder removes
the linked subagents (the marketplace half is unaffected; Codex keeps its own cache).

This links `plugins/fnd/agents-codex/*.toml` into `~/.codex/agents/` and nothing else — skills,
hooks and MCP stay with the marketplace install. `--copy` and `--uninstall` work as on every
target; a `--copy` install does not follow `git pull`, so re-run the installer to refresh it.

### 5. Verify

Run `doctor.cjs --target codex` (the installer finishes with it on the dev channel; on the
cache-only route the smoke test runs it for you from the cached plugin path, where the install
row reads `marketplace cache install`). Two of its rows exist only for this host:

```text
PASS  install:codex          marketplace cache install (root: ~/.codex/plugins/cache/…)
SKIP  codex:hooks-gate       no [features] hooks entry in ~/.codex/config.toml — set it to true
SKIP  codex:hooks-trust      not inspectable — prove it with `git commit --no-verify -m probe`
```

`codex:hooks-trust` is always a reminder: the trust state is host state a script cannot read.
Re-run the doctor any time with `node plugins/fnd/scripts/doctor.cjs --target codex`.

Then start a **new Codex session** and run the smoke test once: `$smoke-test` (Codex invokes
skills with `$`, not `/`). It proves MCP connectivity, subagent delegation, the commit guards
firing and the session conventions arriving. Run it after installing or updating, not every
session — `$preflight-checks` owns the recurring per-project role.

## Update

```text
codex plugin marketplace upgrade      # skills, hooks, MCP
```

```bash
cd /path/to/claude-plugins
./scripts/install.sh --target codex   # only if you linked subagents (= git pull + re-link + doctor)
```

Then start a new session. Three things to expect:

- **Unpushed commits are invisible.** Codex clones from the git remote into a version-keyed
  cache (`~/.codex/plugins/cache/…`), never from your local folder — a local commit reaches this
  host only after it is pushed.
- **An unbumped version may read as "nothing to update".** The version stamp is the
  cache-invalidation mechanism; `plugins/fnd/scripts/bump-version.cjs` owns every copy of it.
- **Hook trust is re-requested** after any update that changes a hook command or script content.
  Re-approve in `/hooks`; until you do, the guard layer is dormant again.

The subagent half is a live-checkout install (symlink into `~/.codex/agents/`), so it follows
`git pull` — unless you installed with `--copy`.

## What's different on Codex

- **Compression is a no-op; whale offloading is not.** Codex's `PostToolUse` can add context or
  block, but cannot rewrite a tool result. `hooks/codex-mcp-shim.cjs` therefore drops every
  compressed body (Codex already delivered the full result — adding the compressed copy would
  only grow context) and forwards the **spill-and-stub** half as `additionalContext`: the spill
  path, the shape hint and the `json-slim` command to run on it. With `FND_MCP_SLIM=1` you get
  whale offloading here, never compression.
- **Skills are invoked with `$name`**, and implicitly by description like everywhere else.
  `~/.codex/prompts` custom prompts are deprecated upstream — nothing in fnd builds on them.
- **Hooks do not exist on Windows.** Skills, MCP and subagents work; the guard layer does not.
  `hooks/no-verify.rules` is an optional second, declarative layer (Codex execpolicy Starlark)
  for the same commit block — opt-in, see the file's header — and is not a Windows workaround.
- **The MCP list is carried as-is** into `plugins/fnd/mcp-codex.json` (deliberately *not*
  `.mcp.json`: Claude Code reads that name as one of its own plugin components, so a Codex-only
  edit would change what Claude Code loads). No tool-count cap is documented, so all six servers
  ship. The Figma **SSE** server is unverified on this host until spike M1b — if it fails, drop
  it from `mcp-codex.json` and `codex mcp add` it per-user.
- **Ship orchestration runs hoisted, with real parallelism.** The conductor is the only spawner
  and every nested helper is hoisted to it, but `max_concurrent_threads_per_session` makes those
  hoisted helpers genuinely concurrent — the closest a non-Claude host gets to the Claude
  fan-out. Losses are the same as on every other host: no adversarial verify fan-out, no
  per-phase telemetry (`plugins/fnd/references/pipeline-phases.md`).
- **Model pins are PROPOSED, not blessed.** The gpt-5.6 tier map in
  `plugins/fnd/references/host-model-map.md` awaits owner sign-off; it lives in one table in
  `plugins/fnd/scripts/gen-host-adapters.cjs` and is regenerated from there — never hand-edit a
  file under `agents-codex/`.
- **Both plugin-root variables are set.** Codex exports `PLUGIN_ROOT` plus a `CLAUDE_PLUGIN_ROOT`
  compatibility alias; `hooks/hooks-codex.json` prefers the alias and falls back to
  `PLUGIN_ROOT`, while the guard scripts resolve their own paths from `__dirname` regardless.

## Project layer

The plugin is a user-space install and stays additive: a project's `.agents/skills` and
`.codex/{agents,hooks,rules,config.toml}` (in trusted projects) keep working. Do not reuse fnd
skill or agent names project-side, and never re-declare the fnd hooks in a project's
`hooks.json` — all layers fire, so a duplicate means double-run, not override.
