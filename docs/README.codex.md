# fnd on OpenAI Codex CLI

Quickstart, update path and the host-specific deltas. The plugin content is the same checkout
Claude Code uses — only the wiring differs. Start at the
[README](../README.md#install--four-hosts) for the cross-host picture.

> [!IMPORTANT]
> **Verification status: unverified, frozen 2026-09-07.** The Codex wiring ships as last
> measured (the marketplace install route exercised live; hooks fire per the `FND_HOST_TRACE`
> matrix), but no release since has been smoke-tested here in an interactive session, and no full
> `smoke-test` run was ever recorded on this host. Known soft spots: the `/hooks` trust that some
> updates drop, and a model map still marked PROPOSED. Details and what "best-effort" means:
> [README → Host verification
> status](../README.md#host-verification-status--cursor-codex-cli-and-opencode-are-unverified).

The install arrives through **two channels, both required**: the marketplace plugin carries
skills, hooks and MCP, and `install.sh --target codex` links the TOML subagents into
`~/.codex/agents/`. Codex reads custom roles from there (or a project's `.codex/agents/`) and
never from the plugin cache — measured 2026-09-08 on CLI 0.153.4, where the spawn tool offered no
fnd role until the links existed, and the plugin manifest format has no key that could declare one.

## Install

Fast path: the bootstrap one-liner from the [README](../README.md#install--four-hosts) does the
clone plus step 4's subagent link in one command; step 1's marketplace add stays manual.

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

That legacy-compat path is measured (2026-08-23, CLI 0.149.0): the add command resolves
`plugins/fnd` from `.claude-plugin/marketplace.json` as it stands. If a later CLI drops the
compat read, the repo gains a native `.agents/plugins/marketplace.json` and this section changes
with it — nothing else about the install does.

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

### 4. Link the subagents from a checkout

Required: nothing in the marketplace cache is read as a role, so without this step every
delegating skill calls an agent the host never loaded.

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

Run `doctor.cjs --target codex` (the installer finishes with it; the smoke test also runs it from
inside a session). Four of its rows exist only for this host:

```text
PASS  install:codex          marketplace cache install (root: ~/.codex/plugins/cache/…)
PASS  codex:agents           7/7 role files linked → /path/to/claude-plugins/plugins/fnd/agents-codex
SKIP  codex:hooks-gate       no [features] hooks entry in ~/.codex/config.toml — set it to true
SKIP  codex:hooks-trust      not inspectable — prove it with `git commit --no-verify -m probe`
```

`codex:agents` is step 4 proved from disk — it FAILs while `~/.codex/agents/` is missing any of
them, whatever the marketplace half reports (it SKIPs only when the checkout has no generated
roles at all). `codex:hooks-trust` is always a reminder: the trust
state is host state a script cannot read. Re-run the doctor any time with
`node plugins/fnd/scripts/doctor.cjs --target codex`. Run from an unlinked checkout on a
marketplace-only machine, `install:codex` reads **not installed** — that is the checkout, not the
host — and names the cached bundle to re-run it from.

Then start a **new Codex session** and run the smoke test once: `$smoke-test` (Codex invokes
skills with `$`, not `/`). It proves MCP connectivity, subagent delegation, the commit guards
firing and the session conventions arriving. Run it after installing or updating, not every
session — `$preflight-checks` owns the recurring per-project role.

**Proving the hooks fired.** Arm `FND_HOST_TRACE` globally
(`node plugins/fnd/scripts/domaine-env.cjs set FND_HOST_TRACE=1`), start a session, use it, then
run `node plugins/fnd/scripts/doctor.cjs --trace --since 2h`. Under host `codex` a healthy run
shows `SessionStart/session-start`, `UserPromptSubmit/user-prompt`,
`SubagentStart/subagent-conventions`, both `PreToolUse` commit guards (one of them `deny` for the
probe), `PreToolUse/spill-access`, `PostToolUse/codex-mcp-shim` and `PostToolUse/mcp-slim` — the shim
is the wired command, since this host replaces a result only through the block channel, and the
`mcp-slim` it spawns logs its own line. An empty matrix here almost always means
the `[features] hooks` gate or the `/hooks` trust review above is still pending. Full recipe:
[Verifying any install](../README.md#verifying-any-install).

## Update

```text
codex plugin marketplace upgrade      # skills, hooks, MCP
```

```bash
cd /path/to/claude-plugins
./scripts/install.sh --target codex   # subagents (= git pull + re-link + doctor)
```

Then start a new session. Three things to expect:

- **Unpushed commits are invisible.** Codex clones from the git remote into a version-keyed
  cache (`~/.codex/plugins/cache/…`), never from your local folder — a local commit reaches this
  host only after it is pushed.
- **An unbumped version may read as "nothing to update".** The version stamp is the
  cache-invalidation mechanism; `plugins/fnd/scripts/bump-version.cjs` owns every copy of it.
- **Hook trust is re-requested** after any update that changes a hook command or script content.
  Re-approve in `/hooks`; until you do, the guard layer is dormant again.

The subagent half is a live-checkout install (symlinks into `~/.codex/agents/`), so `git pull`
alone updates it — re-run the installer only to pick up added or renamed roles, or after a
`--copy` install, which does not follow the pull at all.

## What's different on Codex

- **Compression and whale offloading both land — through the `block` channel.** `updatedToolOutput`
  is refused here, but a `PostToolUse` hook that prints `{"decision":"block","reason":…}` REPLACES
  the model-visible result and withholds the raw one (measured 2026-09-09 on CLI 0.153.4).
  `hooks/codex-mcp-shim.cjs` runs `mcp-slim.cjs --delivery=block:<BLOCK_REASON_BYTES>` and returns
  its emission — the compressed body, or the spill-and-stub text with the `full=<path>` handle — as
  that `reason`, behind one short fixed header. The header is load-bearing: Codex frames every
  block to the model as `Script failed` / `Script error:` (and logs one
  `ERROR codex_core::tools::router` line per replacement), so the header states that the call
  SUCCEEDED, that this is its compressed result, and that it must not be retried.
- **Two fallbacks, both visible in the log.** The reason is capped by `BLOCK_REASON_BYTES` in the
  shim (10000) — past Codex's `tool_output_token_limit` a hook's output is truncated (head and
  tail kept, the middle elided, a full copy left under `$TMPDIR/hook_outputs/`), so an uncapped
  reason would lose the rows in its middle silently. The cap governs the whole reason: the shim
  hands the child the ceiling less its own header, so header + body never exceed it. A compressed
  body over the cap is spilled and **stubbed** instead, and the stub goes back through the same
  channel (debug reason `block-cap`);
  with `FND_MCP_SLIM_STUB=0` there is nothing small enough to send and the body is dropped. A
  result whose emission carries a non-text block (image, resource) cannot ride in a text `reason`
  at all, so that event takes the old path: a stub as `additionalContext` beside the raw result, a
  compressed body dropped. Each debug line carries `delivery` (`replace` / `additional` /
  `discard`), `delivered` (stub bytes on the `additional` fallback) and `host`, and
  `node json-slim.cjs --report` counts a `replace` as the saving it is, the other two as 0 saved
  (`additional` as context ADDED), with a `delivery:` line whenever any event took a fallback.
- **Ceilings on that channel.** The cap is measured, not read off the docs: Codex's limit is 2,500
  "tokens", and it counts one token per 4 bytes of the reason (10,000 B passed whole, 10,004 B
  came back `original token count: 2501` and truncated; ASCII JSON and 2-byte Cyrillic gave the
  same 4.00 B/token) — re-measure it if you set a per-tool
  `mcp_servers.<id>.tools.<tool>.output_token_limit` below it or Codex moves the default. In Codex
  **code mode** (tools invoked from JavaScript) a block rejects the tool promise instead of
  returning text; fnd wires no code mode, but a session that does loses this channel. And the
  "do not retry" contract rests on the header alone — one free-running probe answered from the
  replacement without re-calling; there is no host-level guarantee.
- **The context monitor reads Codex's own numbers.** It takes the live figure from the rollout's
  last `token_count` event and the window that event states; when the rollout states no window it
  says nothing at all rather than report a percentage against a Claude-sized one — set
  `FND_CTX_WINDOW=<tokens>` if you want a readout regardless.
- **Skills are invoked with `$name`**, and implicitly by description like everywhere else.
  `~/.codex/prompts` custom prompts are deprecated upstream — nothing in fnd builds on them.
- **Hooks do not exist on Windows.** Skills, MCP and subagents work; the guard layer does not.
  `hooks/no-verify.rules` is an optional second, declarative layer (Codex execpolicy Starlark)
  for the same commit block — opt-in, see the file's header — and is not a Windows workaround.
- **The MCP list is carried as-is** into `plugins/fnd/mcp-codex.json` — except the
  SSE→streamable-HTTP rewrite for `figma-dev-mode` (deliberately *not* `.mcp.json`: Claude Code
  reads that name as one of its own plugin components, so a Codex-only edit would change what
  Claude Code loads). No tool-count cap is documented, so all six servers ship, and every
  subagent inherits that list — Codex has no per-agent server scoping, so no
  `agents-codex/*.toml` names servers at all. Codex ships **no SSE client**
  (measured 2026-08-23), so `figma-dev-mode` is pointed at Figma's streamable
  endpoint `http://127.0.0.1:3845/mcp` instead of `/sse`. If your Figma build serves only `/sse`,
  drop the server from `mcp-codex.json` and add it per-user:
  `codex mcp add figma-dev-mode --url http://127.0.0.1:3845/mcp`.
- **Ship orchestration runs hoisted, with real parallelism.** The conductor is the only spawner
  and every nested helper is hoisted to it, but `max_concurrent_threads_per_session` makes those
  hoisted helpers genuinely concurrent — the closest a non-Claude host gets to the Claude
  fan-out. Losses are the same as on every other host: no adversarial verify fan-out, no
  per-phase telemetry (`plugins/fnd/references/host-orchestration.md`).
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
