# fnd on OpenCode

This page gives the quickstart, the update path and the differences that apply only to OpenCode.
Claude Code uses the same plugin content from the same checkout; only the wiring is different.
For the picture across all hosts, start at the [README](../README.md#install--four-hosts).

> [!NOTE]
> **fnd is frozen at 0.135.0 and supported on OpenCode until 2027-06-30.** Until that date, we fix
> only a blocking bug, and only on request (the `report-plugin-issue` skill files it). There are
> no new features. After 2027-06-30, we fix nothing. The Claude Code replacement (slim, band, base
> and the team plugins fe, qa, be, pm) does not run on this host, so fnd stays the plugin here.
> Details: [README → fnd is frozen](../README.md#fnd-is-frozen).

> [!IMPORTANT]
> **Verification status: unverified, frozen 2026-09-07.** The OpenCode wiring ships as it was last
> measured: the installer route and the hooks fired as the `FND_HOST_TRACE` matrix recorded them.
> Since then, nobody has smoke-tested a release here in an interactive session, and nobody ever
> recorded a full `smoke-test` run on this host. Known gaps: there is no guard at the MCP level,
> and the MCP payload shape is not verified. Thus screenshots have no guard. For details and the
> meaning of "best-effort", see [README → Host verification
> status](../README.md#host-verification-status--cursor-codex-cli-and-opencode-are-unverified).

OpenCode has no plugin marketplace, so the installer is the only distribution channel. You paste
three pieces of configuration yourself: the MCP block, the commit-guard backstop and the static
conventions.

## Install

Seven steps take a machine without OpenCode to a proven install:

0. Install the host.
1. Install the plugin with one command.
2. Do step 1 by hand, if you prefer; this step also lists what the installer links.
3. Paste the MCP block into a config file that you own.
4. Paste the commit-guard backstop into the same file.
5. Paste the static conventions into the same file.
6. Optional: set up model tiering.
7. Prove the full install in a live session.

### 0. Prerequisites — the host and the runtime

Skip each item that you already have:

- **OpenCode itself.** Use the official installer:

  ```bash
  curl -fsSL https://opencode.ai/install | bash
  ```

  The upstream alternatives are `npm i -g opencode-ai` and `brew install sst/tap/opencode`;
  [opencode.ai/docs](https://opencode.ai/docs/) has the current list. Then connect a model
  provider: run `opencode auth login` and follow the prompts, or set up a local provider in your
  config. Make sure that `opencode` starts and answers a prompt before you install the plugin.
- **Node.js** (any current LTS) and **git** on the PATH that OpenCode inherits. Every fnd script
  and hook runs on bare `node`, without npm installs.

### 1. Install — one command

The bootstrap one-liner clones this repo to a permanent location and runs the OpenCode installer
in it. The default location is `~/tools/claude-plugins`; use `--dir <path>` to change it.

```bash
curl -fsSL https://raw.githubusercontent.com/domaine-oleksandr-kever/claude-plugins/main/scripts/bootstrap.sh | bash -s -- --targets opencode --yes
```

`--yes` makes it one command: it accepts the default location and does not ask for one when a
terminal is attached. Piped runs never ask. The clone is not a temporary download. The symlinks
point into it, so this folder **is** the installed plugin, and if you delete it, you uninstall
everything. Keep it where the bootstrap put it. You still do the three config pastes (steps 3–5)
yourself, because no script edits your `opencode.json`.

### 2. The installer — manual equivalent, and what it links

If you already have a clone, or prefer to do the steps by hand, run this:

```bash
git clone https://github.com/domaine-oleksandr-kever/claude-plugins.git ~/tools/claude-plugins
cd ~/tools/claude-plugins
./scripts/install.sh --target opencode
```

The clone **is** the install. Symlinks, one per entry, under `~/.config/opencode/` point back into
this checkout (the installer honors `$XDG_CONFIG_HOME`). Thus `git pull` updates the host live.
The installer only adds links; it never replaces a directory of yours:

| Linked into | From |
|---|---|
| `~/.config/opencode/skills/<name>` | `plugins/fnd/skills/<name>` (18) |
| `~/.config/opencode/agents/<name>.md` | `plugins/fnd/agents-opencode/` (7, generated) |
| `~/.config/opencode/commands/<name>.md` | `plugins/fnd/commands-opencode/` (18 `/name` shims, generated) |
| `~/.config/opencode/plugins/fnd-plugin.js` | `plugins/fnd/opencode/fnd-plugin.js` |

> This install method is **provisional**. A decision between these symlinks,
> `OPENCODE_CONFIG_DIR` and a global `opencode.json` fragment is still open. Only one route will remain,
> because two routes together would duplicate the content.

At the end, the installer runs `doctor.cjs --target opencode` for you. Read those rows before you
continue:

```text
PASS  generator-sync         generated dirs match scripts/gen-host-adapters.cjs
PASS  install:opencode       symlink install, 44 entry(ies) live (root: ~/.config/opencode)
```

To run the doctor again at any time, use `node plugins/fnd/scripts/doctor.cjs --target opencode`.

The next three steps are pastes into **your own** `opencode.json`. The installer never links or
edits that file, because it is yours. The global file is at `~/.config/opencode/opencode.json`.
If it does not exist yet, create it with this content:

```json
{
  "$schema": "https://opencode.ai/config.json"
}
```

You do not have to write those three blocks by hand. From the checkout, run:

```bash
node plugins/fnd/scripts/opencode-config.cjs
```

It prints all three blocks (steps 3, 4 and 5 below) as labeled JSON blocks. The absolute paths of
this clone are already in them, so you can copy them from the terminal. `--json` prints the same
three blocks merged into one object, for a merge with `jq`. The command only reads; it never
writes your `opencode.json`. Steps 3–5 tell what each block is and why. Use them as the
reference when you merge by hand.

### 3. Paste the MCP servers into your `opencode.json`

Open `plugins/fnd/opencode/mcp-fragment.json`, which is generated from the canonical server list.
Copy its `mcp` object, the full `"mcp": { … }` block with six servers. Paste it at the top level of
your `opencode.json`, next to `$schema`. Do not copy the `_comment` key. If your config already
has an `mcp` block, add the six fnd entries into it; do not replace your entries.

This is the full end state. It shows the `mcp` block of the fragment as it is generated today. If
it is different from your copy of `plugins/fnd/opencode/mcp-fragment.json`, use the file.

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
      "command": ["npx", "@playwright/mcp@latest", "--output-dir", ".claude/fnd-tmp/playwright"]
    },
    "notion-mcp": {
      "type": "remote",
      "url": "https://mcp.notion.com/mcp"
    }
  }
}
```

### 4. Paste the commit-guard backstop

This is the second block in the same file. Merge the `permission.bash` object from
`plugins/fnd/opencode/permission-fragment.example.json` into your `opencode.json`, as the
top-level `permission` key next to `mcp`. The JS adapter is the precise guard layer. These globs
are the coarse layer. They still work in `--auto` runs and when the adapter did not load.

Because the globs are coarse, the fragment allows again a few known false positives: the
read-only `git config --get core.hooksPath`, `chmod +x` on a hook file, and
`git push --no-verify-signatures`. These allow rules are **exact** command strings, never
`prefix*` patterns. A trailing `*` matches the rest of the line, and the last matching rule wins.
Thus an allow rule like `chmod +x*` would allow
`chmod +x .husky/pre-commit && git commit --no-verify` again, after the deny rules above it
blocked it. Because the strings are exact, a different spelling (another hook name, more
`git push` arguments) stays denied. Run those commands yourself; do not widen the pattern.

### 5. Paste the static conventions

On other hosts, the plugin injects the session conventions for you: comment discipline, lean
code, how to explain, whale routing, plugin feedback, task workspace and untrusted content. On
OpenCode, you wire them yourself. The plugin adapter injects only what a static file cannot
answer: the location of the bundle and the project profile. It also injects the two blocks that
depend on detection: live-store access and the Foundation LiquidDoc-and-core addendum. Without
this paste, **no fnd convention reaches your sessions**. The context-injection row of the smoke
test goes red for exactly this reason.

This is the third block in the same file: an `instructions` array at the top level, next to `mcp`
and `permission`. It names the static convention files with the absolute path of your clone.
`node plugins/fnd/scripts/opencode-config.cjs` prints this array with the paths already filled
in. It names these files:

```json
"instructions": [
  "/absolute/path/to/claude-plugins/plugins/fnd/hooks/comment-discipline.md",
  "/absolute/path/to/claude-plugins/plugins/fnd/hooks/lean-code.md",
  "/absolute/path/to/claude-plugins/plugins/fnd/hooks/mcp-whale.md",
  "/absolute/path/to/claude-plugins/plugins/fnd/hooks/plugin-feedback.md",
  "/absolute/path/to/claude-plugins/plugins/fnd/hooks/task-workspace.md",
  "/absolute/path/to/claude-plugins/plugins/fnd/hooks/untrusted-content.md",
  "/absolute/path/to/claude-plugins/plugins/fnd/hooks/writing-style.md"
]
```

If your config already has `instructions`, add these entries to it. Name each file explicitly; do
not use a `hooks/*.md` glob. A glob would also add `store-access.md` and
`comment-discipline-foundation.md`. The adapter injects these two itself when the workspace calls
for them: the first when there are store credentials, the second when there are Foundation
markers. A static copy would thus duplicate them. A glob would also add `mcp-whale-claude.md`,
which is the Claude Code variant of `mcp-whale.md`. The renderer excludes exactly these files, so
its output is the safe list to paste. An `AGENTS.md` that names the same files also works, if you
organize your global instructions that way. Because the paths point into the clone, `git pull`
updates the content, and you do not paste again. Come back to this step only when a convention
file is renamed or added. To see such a change, run the renderer again.

### 6. Optional: model tiering

The generated agents have no `model:` pin (see below). To opt in, copy the `agent` block from
`plugins/fnd/opencode/model-profile.cloud.example.json` or `model-profile.local.example.json` into
your `opencode.json`. Then replace the ids with ids that your provider config really offers.

### 7. Run the smoke test once

Start a **new OpenCode session**, because OpenCode loads config changes at startup. Then run
`/smoke-test`. This is the command shim; OpenCode itself starts skills only when the model chooses
them. The smoke test proves MCP connectivity, subagent delegation, that the commit guards fire, and the
arrival of the session context. Run it after an install or an update, not in each session.
`/preflight-checks` does the recurring check per project.

**Proving the hooks fired.** Arm `FND_HOST_TRACE` globally
(`node plugins/fnd/scripts/domaine-env.cjs set FND_HOST_TRACE=1`). Start a session and use it.
Then run `node plugins/fnd/scripts/doctor.cjs --trace --since 2h`. Under host `opencode`, a
healthy run shows `UserPromptSubmit/fnd-plugin` from the adapter and `SessionStart/fnd-plugin`.
`SessionStart/fnd-plugin` appears once per session, in every checkout, because the bundle location
and the project profile are always injected. Only the store-access and Foundation blocks in that
injection depend on detection. The run also shows `user-prompt`, the two shell commit guards,
`spill-access` and `mcp-slim`. There is no `SubagentStart` row, because OpenCode has no
subagent-start event. This absence is expected and is not a gap. Full recipe:
[Verifying any install](../README.md#verifying-any-install).

## Update

```bash
cd /path/to/claude-plugins
./scripts/install.sh --target opencode      # = git pull --ff-only + re-link + doctor
```

The installer is also the updater; this host has no "reinstall". Skills, references and agent
bodies apply at the next read. The plugin adapter, the command shims and all changes in your own
`opencode.json` need a **new session**. When upstream removes or renames a skill, the same run
that pulled the change also removes the old link.

Two config changes never reach you automatically, because they are in a file that you own. After
an update that changed `mcp-fragment.json` or `permission-fragment.example.json`, compare them
with your `opencode.json` again.

`--copy` installs a real copy instead of symlinks. Such an install does **not** follow
`git pull`. To refresh it, run `./scripts/install.sh --target opencode --copy` again.
`--uninstall` removes only the entries that the installer created.

## What's different on OpenCode

- **A Bun runtime in the process, real `node` child processes.** OpenCode loads plugins as JS/TS
  modules under Bun. `opencode/fnd-plugin.js` contains only wiring. It starts the canonical
  `hooks/*.cjs|sh` as real `node` processes and does not import them. Thus nothing depends on the
  CJS interop of Bun, and the guards run byte-identically to Claude Code. `node` must be on the
  PATH that OpenCode inherits.
- **No model pins, by design.** The generated `agents-opencode/*.md` have no `model:` field. So
  every agent uses the session model, and local providers work (`ollama/*`, `lmstudio/*`, custom
  OpenAI-compatible endpoints). A pin that your provider config does not have would break the agent
  completely. Tiering is opt-in, through the model-profile fragments above. One honest warning: we
  calibrated the fnd review bar (`bug-hunter`, `pre-commit-review`) on frontier models. A small
  local model runs, but the quality of its findings depends on your model choice.
- **You wire the static conventions yourself.** Once per session, the adapter injects only what a
  static file cannot answer: the location of the bundle and the project profile. It also injects
  the two blocks that depend on detection: live-store access and the Foundation LiquidDoc-and-core
  addendum. The static conventions (comment discipline, lean code, how to explain, task workspace,
  whale routing, plugin feedback, the untrusted-content rail) arrive through your `instructions`
  config. Install step 5 is that paste. It costs nothing per message and stays after compaction.
  As a result, `FND_LEAN=0` and `FND_STE=0` cannot reach these conventions here. Remove the
  lean-code or writing-style file from `instructions` instead. The two injected blocks behave the
  other way. They use `chat.message`, so they do NOT stay after compaction, and a task subagent
  never sees them. On this host, the Foundation addendum is thus a reminder in the first message,
  not a permanent rule.
- **MCP output is rewritten in place.** `tool.execute.after` gives a changeable `output.output`.
  Thus `mcp-slim` both compresses and does spill-and-stub, as on Claude Code (Cursor is the
  observe-only host — nothing is compressed, stubbed or spilled there).
- **A blocked prompt is rewritten, not erased.** This host cannot erase a message. So when the
  prompt-JSON guard fires, it replaces each blob that it spilled with its `full=` handle, in place.
  As on Claude Code, the paste moves out of the context and does not repeat in every turn. The
  context-usage monitor does not work, because `chat.message` gives a hook no transcript path.
- **No subagent-start hook.** On other hosts, that hook injects conventions. Here, the generated
  agent bodies contain those conventions instead.
- **No screenshot scratch-path guard.** In this adapter, `tool.execute.before` reaches only the
  bash tool. Also, the shapes of the MCP tool names and arguments that OpenCode gives it are not
  verified. On the other three hosts, a deny keeps QA screenshots out of the checkout. That deny
  is absent here, so the `tmp/` convention of the task workspace is the only rail
  (`plugins/fnd/references/task-workspace.md`).
- **`/name` comes from shims.** OpenCode starts skills only when the model chooses them. The 18
  generated `commands-opencode/*.md` shims give the same slash commands as other hosts: each shim
  loads its skill by name. If the lookup fails, it uses an anchored path.
- **Ship orchestration runs hoisted**, unless you increased `subagent_depth`. The conductor is the
  only agent that starts other agents, and it starts every nested helper itself, possibly one after
  another. This costs time, not coverage (`plugins/fnd/references/host-orchestration.md`).
- **Windows:** OpenCode recommends WSL. fnd is made for macOS first and has no special support for
  Windows.

## Project layer

The plugin is a user-space install and only adds to a project. A project's `.opencode/*`,
`AGENTS.md` and project `opencode.json` all keep working. OpenCode merges the configs of all
layers, and your own file wins. Do not use fnd skill, agent or command names in a project. Never
declare a second copy of the fnd plugin adapter. Both copies would load, which causes double
injection and a second compression pass.
