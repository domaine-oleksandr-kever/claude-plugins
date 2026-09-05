## Foundation convention — oversized MCP results

An over-limit MCP result spills to a file — you get a path, not content, and the compression
hook is skipped. Don't raw-`Read` it, and don't raw-`Read` any big local JSON / JSONL / log
dump either: run `node <plugin root>/scripts/json-slim.cjs <path>` and work from its stdout
(`--stats` shows the cut).
On Claude Code the session context opens with `fnd plugin root: <absolute path>` — write that path
into commands; the Bash tool's shell does not set `${CLAUDE_PLUGIN_ROOT}`, so a literal one expands
to empty.
A **JSONL** dump (one JSON object per line, e.g. a Shopify
bulk-operation result) is never printed as rows at any size — you get a PROFILE plus a
ready-to-adapt recipe for querying the ORIGINAL by line; run that, not a second whole-file
pass (never `--jq` a JSONL — it bypasses the profile and slims reshaped rows).

Then **read what it printed and do exactly that.** `nothing to compress (…); read the file
directly` = json-slim printed nothing of its own; the parenthetical says why — not JSON
(prose / markdown / HTML / XML, or a log / Figma-JSX payload already minimal: those two shapes
*do* compress when there is a gain), an error envelope, or a transform error; recover with a
windowed `Read` (`offset`/`limit`), or `--jq` into an envelope. A body printed back
**unchanged** is a deliberate decline (stderr says so; `--stats` reports the 0.0 %) — don't
re-run it: a repeat, or any run on a `fnd-slim-out-*` spill, answers with a one-line refusal
instead. Narrow with `--jq` (the guards never refuse it) or query the file (`grep`,
`sed -n '<N>p'`). `--jq` speaks a small jq subset — dot paths (`.a.b`, `.a[0]`), `[]` iteration,
`,` multi-select (one array on stdout) and `| keys` / `| length`; `select`/`map`/`?`/`//` and the
rest exit 2 naming the token, so pipe a supported path into real `jq` for those. A
`<<fnd-mcp-slim stub>>` saying the compressor already gained nothing prints that `--jq` line.
