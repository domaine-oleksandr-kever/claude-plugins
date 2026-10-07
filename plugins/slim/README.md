# slim

Slim is the universal tool-result compression proxy for Claude Code: one `tool.call` handler that
shrinks large MCP tool results before they reach the context. It decides by content, never by tool
name — the sniff inside the bundled `json-slim` pipeline sends JSON to the JSON compressor, plain
log or build text to `log-slim`, Figma design-context JSX to the JSX compactor, and anything else to
the spill-and-stub guard or straight through. The hooks run wherever the plugin loads; the drawing
(the ToolResult line and the toast) shows in the terminal and the desktop app.

Current release: **slim v0.2.0**.

## Status

- **Functional for MCP tool results** (`mcp__*` tools).
- Planned: the Bash/curl, Read, WebFetch and Agent channels, and a lookup tool for recovering
  spilled originals.
- Claude Code only: slim is a hooks module (mods), which other hosts do not run.

## Install

```
/plugin install slim@domaine
```

## How it works

The module (`plugins/slim/hooks/mods/`) lets the tool run first, then hands every MCP result it
does not stand down on to the core, `plugins/slim/scripts/slim.cjs`, as one JSON envelope on stdin
(tool, tool_use_id, result, cwd, session id). The core answers with one JSON object — the
decision, the new result, the stats figure and the report record — and the module replaces the
result with a fresh object. Anything the module cannot read (a failed spawn, a non-zero exit, bad
output) leaves the original result untouched.

The module hands the result back untouched on a denied call and under `SLIM_MCP=0`, and also on an
MCP error result (`error-shape`), on a stub-sized result that already carries a slim or fnd mark
(`already-slim`), and on a result of 4,096 B or less (`size-gate`). For those last three it spawns
the core only to write the report line: at `SLIM_DEBUG=1` for an error result, at `2` for the other
two. An error result that is the host's overflow notice always goes to the core, which passes it
through as `error-shape`.

The core's decisions:

- **compressed** — the result is replaced by its compressed body, then a stats line and a recovery
  handle:

  ```
  slim: compressed 118,203 B → 29,412 B (−75.1%)

  <<full=/tmp/fnd-mcp-slim-0123456789abcdef.json original_result>>
  ```

  The `→` figure is the exact byte size of what the model receives; the handle names the spilled
  original.
- **stubbed** — a result the compressor cannot bring under the stub threshold (32,768 B) is spilled
  and replaced by a ~1 KB stub that opens `<<slim stub>> <tool> returned <N> B (format=…)` and gives
  `node …/plugins/slim/scripts/json-slim.cjs <file> …` recovery recipes.
- **passthrough** — everything else, with a reason (`non-json`, `no-gain`, `error-shape`,
  `budget-exceeded`, …).

A result over the platform limit arrives as the host's own "exceeds maximum allowed tokens … saved
to `<file>`" notice. slim expands it: it reads the named file and compresses the real payload, but
only after resolving the path under `<CLAUDE_CONFIG_DIR or ~/.claude>/projects/<dir>/<session
id>/tool-results/mcp-*.txt` for the current session — a notice naming any other file is payload
text and is refused (`expand-refused`).

Limits: the size gate is 4,096 B, one compression gets 5,000 ms of wall clock (`SLIM_BUDGET_MS`),
and an answer over 4,128,768 B (4 MiB − 64 KiB) is dropped in favour of the original
(`output-cap`), with its spills removed.

Spill files keep fnd's `fnd-*` name prefixes, so fnd's handle rules and its spill-access hook treat
slim's handles exactly like their own.

## Next to fnd

- With fnd installed and compressing (its default today), fnd's classic PostToolUse hook runs
  beneath the module, and slim sees a result fnd has already slimmed and stands down with
  `already-slim`. Up to the largest stub size it is fnd's own rule (a stub mark, or a stats line
  beside a `<<full=` handle). A bigger result counts only when it ends in the compressed tail or opens
  with the stub head, its stats line's `→` figure is the result's exact size, and its handle names a
  regular file this user owns: a `fnd-mcp-slim-*.json` spill in `SLIM_DIR`, `FND_MCP_SLIM_DIR` or
  system temp, or this session's host tool-results file. So the check holds at any fnd stub setting,
  and payload text cannot opt a large result out by quoting a stats line.
- To let slim do the compressing today, set `FND_MCP_SLIM=0`. fnd's `FND_COMPRESSION=proxy` switch,
  which hands compression over without that, is the next step.
- A result over 4 KB that fnd passed through (non-JSON, no gain) is run through slim again: one
  extra node spawn and the same decision. This goes away once fnd hands compression over.
- Both plugins use one spill directory and one sweep marker, so the shorter TTL wins. Keep
  `SLIM_DIR` unset or equal to `FND_MCP_SLIM_DIR`: fnd trusts `<<full=` handles only there and in
  system temp.
- With fnd's module inside slim's, slim sees fnd's output and stands down, a small output that
  quotes the overflow phrase above its host-file handle included. The reverse order has one gap
  until `FND_COMPRESSION=proxy` lands: when slim expands a host notice into an output of 8 KB or
  less whose body quotes "exceeds maximum allowed tokens", fnd's module can take that output for a
  fresh notice and compress the original a second time.

## What you see

- **The ToolResult line.** Under an MCP tool row slim compressed or stubbed, one dim line:

  ```
  slim  json  118 KB → 29 KB  −75%
  ```

  It is drawn in the success colour when slim saved 50 % or more. Rows folded into a tool group draw
  no line.
- **The toast.** On the main conversation only (never for a subagent's calls), e.g.
  `searchJiraIssuesUsingJql: compressed 118 KB → 29 KB (−75%) · json`. `SLIM_TOAST=0` silences it;
  `SLIM_TOAST_MS` sets how long it stays.

## slim.events

slim owns the `$.state` key `{ plugin: 'slim', key: 'events' }`: one event per compressed or
stubbed result, oldest first, at most 200. Any plugin reads it; only slim writes it. The contract is
`plugins/slim/types/index.d.ts`:

```ts
export type SlimEngine = 'json' | 'log' | 'jsx' | 'stub'
export type SlimEvent = { v: 1; atMs: number; kind: 'slim'; text: string; src: 'slim'; tool: string; agentType?: string; bytesIn: number; bytesOut: number; engine: SlimEngine; ms: number }
```

- `text` is one line: `<agent type> · <tool short name>: compressed 118 KB → 29 KB (−75%) · json`,
  the agent prefix only for a subagent's call.
- `tool` is the full tool name.
- `agentType` is absent on the main conversation, the subagent's type (`fnd:jira-reader`) when it is
  listed, and `agent` when it is not.

`SLIM_EVENT_LOG=0` stops the writes, and the list stays `[]`. The second key, `slim.rows` (one
member per compressed tool_use_id), is internal to the ToolResult line.

## Report log

slim writes to the same report log as fnd: `fnd-mcp-slim-debug.log` in the spill root. Each of its
lines carries `src: 'slim'` and `channel: 'mcp'`, plus `tool_use_id` (not yet paired with fnd's
lines, which carry no id), the decision, reason, engine, bytes in/out, % and ms — never any
payload.

- `SLIM_DEBUG=1` writes one line per MCP call slim handles; `2` adds the `size-gate` and
  `already-slim` passthroughs.
- Error lines (`decision: 'error'`, `entry: 'hook'` from the core, `entry: 'mod'` when the module's
  spawn failed) are written at every level, including off.
- The module's own stand-downs are logged only when the level is set in the session's environment
  (shell, `~/.claude/settings.json` → `env`); a level set only in a Domaine env file reaches the
  core but not the module.

Read the totals per plugin with:

```
node plugins/slim/scripts/slim.cjs --report [logfile] [--since <ISO>]
```

It prints json-slim's report plus a `by src:` line (`fnd … · slim …`). `json-slim.cjs --report`
still works but mixes both plugins' lines. Lines from a recovery run of slim's `json-slim.cjs` carry
no src and count as fnd's; that CLI also skips the project-directory pass of the sweep, so it never
runs git or prunes fnd's `.claude/fnd-tmp/playwright`.

## Environment switches

slim's switches (`SLIM_MCP`, `SLIM_DIR`, `SLIM_TTL`, `SLIM_DEBUG`, `SLIM_STUB`,
`SLIM_STUB_BYTES`, `SLIM_BUDGET_MS`, `SLIM_TOAST`, `SLIM_TOAST_MS`, `SLIM_EVENT_LOG`) are
documented in [the root README's Environment switches table](../../README.md#environment-switches),
next to fnd's.

The compressors slim bundles are byte-identical copies of fnd's and read fnd's names, so the core
maps its own onto them for its process only: a set `SLIM_DIR`, `SLIM_TTL` or `SLIM_DEBUG` overrides
`FND_MCP_SLIM_DIR`, `FND_MCP_SLIM_TTL` or `FND_MCP_SLIM_DEBUG`, and those fnd names are the
fallbacks when the slim one is unset. `FND_MCP_SLIM_STUB_BYTES` also widens the size bound of the
`already-slim` check, so a raised fnd stub threshold is still recognised.

`SLIM_*` are read from the process environment only, never from the Domaine env files — set them in
`~/.claude/settings.json` → `env`. A recovery run of slim's `json-slim.cjs` reads the `FND_MCP_SLIM_*`
names.

## Tests

```
node tests/slim-fixtures.mjs   # the core on the real fixtures, plus the byte-identity gate against fnd's compressors
bash tests/mods-sim.sh         # validate --strict + the module's kit tests (local only; needs claude)
```

## Licence

`json-slim.cjs` and `log-slim.cjs` are Apache-2.0 ports; see [NOTICE](../../tests/parity/NOTICE).
