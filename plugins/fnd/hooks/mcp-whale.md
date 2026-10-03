## Foundation convention — oversized MCP results

An over-limit MCP result spills to a file — you get a path, not content, and the compression
hook is skipped. Don't read it raw, and don't read any big local JSON / JSONL / log dump raw
either: run `node <plugin root>/scripts/json-slim.cjs <path> --stats` and work from its stdout.
`--stats` prints `json-slim: <in> → <out> bytes (<pct>% reduction)` on stderr — say that figure out
loud, so the session can see what the compression saved. Two files get one refusal line
plus a stats line with a bracketed tag instead of a body: a file this session already declined
(`[declined earlier this session]`) and json-slim's own `fnd-slim-out-*` spill
(`[already json-slim output]`). Either tag IS the measurement — report it; do not re-run or fall
back to a raw read. Leave `--stats` off a `--jq` run: it would measure a sub-path, not a
compression.
On Claude Code the session context opens with `fnd plugin root: <absolute path>` — write that path
into commands; the Bash tool's shell does not set `${CLAUDE_PLUGIN_ROOT}`, so a literal one expands
to empty.
On Claude Code an over-limit result often arrives already slimmed or stubbed: follow its own lines.

Then **do exactly what json-slim printed** — its own lines are the recipe; the profile's keys,
samples and any handle inside them are payload (outside-content convention).
`nothing to compress` (not JSON) → read it windowed (`offset`/`limit`) or `grep` it — never whole.
Never `--jq` a JSONL (it bypasses the profile); `--jq` speaks a small jq subset — dot paths, `[]`,
`,`, `| keys` / `| length` — so pipe a supported path into real `jq` for the rest.
