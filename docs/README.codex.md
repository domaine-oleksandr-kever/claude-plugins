# fnd on OpenAI Codex CLI

This page gives the quickstart, the update path and the differences that apply only to Codex.
Claude Code uses the same plugin content from the same checkout; only the wiring is different.
For the picture across all hosts, start at the [README](../README.md#install--four-hosts).

> [!NOTE]
> **fnd is frozen at 0.135.0 and supported on Codex CLI until 2027-06-30.** Until that date, we
> fix only a blocking bug, and only on request (the `report-plugin-issue` skill files it). There
> are no new features. After 2027-06-30, we fix nothing. The Claude Code replacement (slim, band,
> base and the team plugins fe, qa, be, pm) does not run on this host, so fnd stays the plugin here.
> Details: [README → fnd is frozen](../README.md#fnd-is-frozen).

> [!IMPORTANT]
> **Verification status: unverified, frozen 2026-09-07.** The Codex wiring ships as it was last
> measured. We tested the marketplace install route live, and the hooks fire as the
> `FND_HOST_TRACE` matrix shows. Since then, nobody has smoke-tested a release here in an
> interactive session, and nobody ever recorded a full `smoke-test` run on this host. Two weak
> points are known: some updates drop the `/hooks` trust, and the model map is still PROPOSED.
> For details and the meaning of "best-effort", see [README → Host verification
> status](../README.md#host-verification-status--cursor-codex-cli-and-opencode-are-unverified).

The install needs **two channels, and both are required**. The marketplace plugin carries the
skills, the hooks and MCP. The command `install.sh --target codex` links the TOML subagents into
`~/.codex/agents/`. Codex reads custom roles only from that folder or from a project's
`.codex/agents/`, never from the plugin cache. We measured this on 2026-09-08 on CLI 0.153.4: the
spawn tool offered no fnd role until the links existed. Also, the plugin manifest format has no
key that can declare a role.

## Install

Fast path: the bootstrap one-liner from the [README](../README.md#install--four-hosts) clones the
repo and does the subagent link of step 4 in one command. You still do the marketplace add of
step 1 by hand.

### 0. Prerequisites — the host and the runtime

Skip each item that you already have:

- **Codex CLI itself:**

  ```bash
  npm install -g @openai/codex
  ```

  Homebrew also ships it; the [Codex docs](https://developers.openai.com/codex/cli/) list the
  current channels. Then run `codex` once and sign in, with a ChatGPT plan or with an API key if
  your organization uses one. Make sure that Codex starts and answers a prompt before you install
  the plugin.
- **Node.js** (any current LTS) and **git** on your PATH. Every fnd script and hook runs on bare
  `node`, without npm installs.

### 1. Add the marketplace and install the plugin

```text
codex plugin marketplace add domaine-oleksandr-kever/claude-plugins
```

Codex reads `.claude-plugin/marketplace.json` as a legacy-compatible marketplace location. Thus
this repo is already a Codex marketplace, and we publish nothing separately. Then run `/plugins`
in Codex, find **fnd** and install it.

The same marketplace also lists **slim**, **band**, **base**, **fe**, **qa**, **be** and **pm**.
These seven plugins run only on Claude Code (they are Claude Code hooks modules and have no Codex
manifest), so do not install any of them from Codex `/plugins`.

To undo a registration, run `codex plugin marketplace list` to see the configured name. Then run
`codex plugin marketplace remove <name>` to remove it. A registration also pins the git ref that
you added it with. To point it at a different ref, remove it and add it again. When you remove a
marketplace, an installed plugin stays installed; you uninstall the plugin in `/plugins`.

We measured the legacy-compatible path on 2026-08-23 on CLI 0.149.0. The add command finds
`plugins/fnd` from `.claude-plugin/marketplace.json` as the file is now. If a later CLI stops this
compatible read, the repo will get a native `.agents/plugins/marketplace.json`. Then only this
section changes; the rest of the install stays the same.

### 2. Turn the hooks feature on

The default of this feature changes between CLI versions. Thus, set it explicitly in
`~/.codex/config.toml`:

```toml
[features]
hooks = true
```

### 3. Trust-review the hooks

Codex runs a non-managed hook only after you review it explicitly, **per content hash**. Run
`/hooks` in Codex, read the fnd entries and approve them. These entries are the commands in
`plugins/fnd/hooks/hooks-codex.json`. Each update that changes a hook command needs a new review.
This is the purpose of the content hash; it is not a bug.

If you skip steps 2 and 3, nothing warns you. Skills and MCP load in both cases, so the install
*looks* complete. But the full guard layer is then off: the session conventions, the prompt-JSON
guard, the spill-and-stub of mcp-slim, and **both git guards**, which include the `--no-verify`
block.

### 4. Link the subagents from a checkout

This step is required. Codex reads no role from the marketplace cache. Without this step, each
skill that delegates calls an agent that the host never loaded.

```bash
git clone https://github.com/domaine-oleksandr-kever/claude-plugins.git
cd claude-plugins
./scripts/install.sh --target codex
```

Keep this clone in a permanent location. The links point into it, so if you delete the folder,
the linked subagents go too. The marketplace half does not change, because Codex keeps its own
cache.

This command links `plugins/fnd/agents-codex/*.toml` into `~/.codex/agents/` and does nothing
else. The skills, the hooks and MCP stay with the marketplace install. `--copy` and `--uninstall`
work as on every target. A `--copy` install does not follow `git pull`, so run the installer
again to refresh it.

### 5. Verify

Run `doctor.cjs --target codex`. The installer runs it at the end, and the smoke test also runs
it from inside a session. Four of its rows exist only for this host:

```text
PASS  install:codex          marketplace cache install (root: ~/.codex/plugins/cache/…)
PASS  codex:agents           7/7 role files linked → /path/to/claude-plugins/plugins/fnd/agents-codex
SKIP  codex:hooks-gate       no [features] hooks entry in ~/.codex/config.toml — set it to true
SKIP  codex:hooks-trust      not inspectable — prove it with `git commit --no-verify -m probe`
```

`codex:agents` checks step 4 on disk. It FAILs when `~/.codex/agents/` is missing any role file,
whatever the marketplace half reports. It SKIPs only when the checkout has no generated roles.
`codex:hooks-trust` is always a reminder, because the trust state is host state that a script
cannot read. To run the doctor again at any time, use
`node plugins/fnd/scripts/doctor.cjs --target codex`. On a machine with only the marketplace
install, an unlinked checkout shows `install:codex` as **not installed**. This result is about the
checkout, not the host, and the row names the cached bundle to run the doctor from.

Then start a **new Codex session** and run the smoke test once: `$smoke-test`. Codex invokes
skills with `$`, not with `/`. The smoke test proves MCP connectivity, subagent delegation, that the
commit guards fire, and the arrival of the session conventions. Run it after an install or an update,
not in each session. `$preflight-checks` does the recurring check per project.

**Proving the hooks fired.** Arm `FND_HOST_TRACE` globally
(`node plugins/fnd/scripts/domaine-env.cjs set FND_HOST_TRACE=1`). Start a session and use it.
Then run `node plugins/fnd/scripts/doctor.cjs --trace --since 2h`. Under host `codex`, a healthy
run shows these rows: `SessionStart/session-start`, `UserPromptSubmit/user-prompt`,
`SubagentStart/subagent-conventions`, both `PreToolUse` commit guards (one of them `deny` for the
probe), `PreToolUse/spill-access`, `PostToolUse/codex-mcp-shim` and `PostToolUse/mcp-slim`. The
shim is the wired command, because this host replaces a result only through the block channel.
The `mcp-slim` that the shim starts logs its own line. An empty matrix almost always means that
the `[features] hooks` gate or the `/hooks` trust review above is not done yet. Full recipe:
[Verifying any install](../README.md#verifying-any-install).

## Update

```text
codex plugin marketplace upgrade      # skills, hooks, MCP
```

```bash
cd /path/to/claude-plugins
./scripts/install.sh --target codex   # subagents (= git pull + re-link + doctor)
```

Then start a new session. Expect three things:

- **Unpushed commits are invisible.** Codex clones from the git remote into a cache with one entry
  per version (`~/.codex/plugins/cache/…`). It never reads your local folder. Thus a local commit
  reaches this host only after you push it.
- **An unbumped version can show as "nothing to update".** The version stamp tells Codex to
  replace its cache. `plugins/fnd/scripts/bump-version.cjs` writes every copy of that stamp.
- **Codex asks for hook trust again** after each update that changes a hook command or script
  content. Approve again in `/hooks`. Until you do, the guard layer is off again.

The subagent half is a live-checkout install (symlinks into `~/.codex/agents/`), so `git pull`
alone updates it. Run the installer again only to get added or renamed roles. A `--copy` install
does not follow the pull at all, so it also needs the installer.

## What's different on Codex

- **Compression and whale offloading both work, through the `block` channel.** A whale is a tool
  result too large to keep in context. Codex refuses `updatedToolOutput`. But when a `PostToolUse`
  hook prints `{"decision":"block","reason":…}`, Codex REPLACES the result that the model sees and
  holds back the raw one (measured 2026-09-09 on CLI 0.153.4). `hooks/codex-mcp-shim.cjs` runs
  `mcp-slim.cjs --delivery=block:<BLOCK_REASON_BYTES>`. It returns the output of mcp-slim as that
  `reason`, behind one short fixed header. This output is the compressed body, or the
  spill-and-stub text with the `full=<path>` handle. The header is necessary. Codex shows every
  block to the model as `Script failed` / `Script error:` and logs one
  `ERROR codex_base::tools::router` line per replacement. So the header says that the call
  SUCCEEDED, that this text is its compressed result, and that the model must not retry it.
- **There are two fallbacks, and the log shows both.** The shim caps the reason at
  `BLOCK_REASON_BYTES` (10000). Above the `tool_output_token_limit` of Codex, Codex truncates the
  output of a hook: it keeps the head and the tail, removes the middle, and leaves a full copy
  under `$TMPDIR/hook_outputs/`. An uncapped reason would thus lose its middle rows silently. The
  cap applies to the whole reason: the shim gives the child process the cap minus its own header,
  so the header and the body together never go above it. When a compressed body is larger than
  the cap, the shim spills it and sends a **stub** instead, through the same channel (debug reason
  `block-cap`). With `FND_MCP_SLIM_STUB=0`, there is nothing small enough to send, and the shim
  drops the body. A text `reason` cannot carry a result that has a non-text block (image,
  resource). For that event, the shim uses the old path: a stub as `additionalContext` next to the
  raw result, and no compressed body. Each debug line carries `delivery` (`replace` /
  `additional` / `discard`), `delivered` (the stub bytes on the `additional` fallback) and `host`.
  `node json-slim.cjs --report` counts a `replace` as a real saving. It counts the other two as 0
  saved, and `additional` as context ADDED. It prints a `delivery:` line when any event used a
  fallback.
- **This channel has limits.** We measured the cap; we did not take it from the docs. The limit
  of Codex is 2,500 "tokens", and Codex counts one token per 4 bytes of the reason. A reason of
  10,000 B passed whole. A reason of 10,004 B came back as `original token count: 2501` and was
  truncated. ASCII JSON and 2-byte Cyrillic gave the same 4.00 B/token. Measure again if you set a
  per-tool `mcp_servers.<id>.tools.<tool>.output_token_limit` below this value, or if Codex
  changes the default. In Codex **code mode** (tools called from JavaScript), a block rejects the
  tool promise and returns no text. fnd wires no code mode, but a session that uses it loses this
  channel. Also, only the header asks the model not to retry. In one free-running probe, the model
  answered from the replacement and did not call the tool again. The host gives no guarantee.
- **The context monitor reads the numbers of Codex.** It takes the current figure from the last
  `token_count` event in the rollout, and the window size that this event states. When the rollout
  states no window, the monitor says nothing. It does not show a percentage against a window of
  Claude size. To get a readout anyway, set `FND_CTX_WINDOW=<tokens>`.
- **You invoke skills with `$name`.** As on every host, the model can also start a skill from its
  description. Upstream deprecated the custom prompts in `~/.codex/prompts`, and fnd uses none of
  them.
- **Hooks do not exist on Windows.** Skills, MCP and subagents work there; the guard layer does
  not. `hooks/no-verify.rules` is an optional second layer for the same commit block. It is
  declarative (Codex execpolicy Starlark) and opt-in; the header of the file tells how. It is not
  a Windows workaround.
- **`plugins/fnd/mcp-codex.json` carries the MCP list without changes**, except for one rewrite:
  `figma-dev-mode` uses streamable HTTP instead of SSE. The file is deliberately *not* named
  `.mcp.json`. Claude Code reads that name as one of its own plugin components, so an edit for
  Codex only would change what Claude Code loads. No cap on the tool count is documented, so all
  six servers ship. Every subagent inherits that list. Codex cannot give servers to one agent only,
  so no `agents-codex/*.toml` names servers. Codex ships **no SSE client** (measured 2026-08-23).
  Thus `figma-dev-mode` points at the streamable endpoint of Figma, `http://127.0.0.1:3845/mcp`,
  instead of `/sse`. If your Figma build serves only `/sse`, remove the server from
  `mcp-codex.json` and add it for your user:
  `codex mcp add figma-dev-mode --url http://127.0.0.1:3845/mcp`.
- **Ship orchestration runs hoisted, with real parallel work.** "Hoisted" means that the
  conductor is the only agent that starts other agents, and it starts every nested helper itself.
  `max_concurrent_threads_per_session` lets those hoisted helpers run at the same time. This is
  the nearest that a non-Claude host gets to the Claude fan-out. The losses are the same as on
  every other host: no adversarial verify fan-out and no telemetry per phase
  (`plugins/fnd/references/host-orchestration.md`).
- **The model pins are PROPOSED, not approved.** The gpt-5.6 tier map in
  `plugins/fnd/references/host-model-map.md` waits for the owner to approve it. The map is one
  table in `plugins/fnd/scripts/gen-host-adapters.cjs`, and the generator makes the agent files
  from it. Never edit a file under `agents-codex/` by hand.
- **Both plugin-root variables are set.** Codex exports `PLUGIN_ROOT` and also the compatible alias
  `CLAUDE_PLUGIN_ROOT`. `hooks/hooks-codex.json` uses the alias first and `PLUGIN_ROOT` second. The
  guard scripts find their own paths from `__dirname` in all cases. `hooks/session-start.sh` is the
  SessionStart composer that this wiring starts; `plugin.json` runs the same one on Claude Code.
  It reads either variable, and if both are missing, it uses its own location.

## Project layer

The plugin is a user-space install and only adds to a project. A project's `.agents/skills` and
`.codex/{agents,hooks,rules,config.toml}` (in trusted projects) keep working. Do not use fnd skill
or agent names in a project. Never declare the fnd hooks again in the `hooks.json` of a project.
All layers fire, so a duplicate hook runs twice; it does not override.
