## Foundation convention — oversized MCP results

An over-limit MCP result spills to a file — you get a path, not content, and the
compression hook is skipped. Don't raw-`Read` it: run
`node ${CLAUDE_PLUGIN_ROOT}/scripts/json-slim.cjs <path>` and use its stdout (`--stats`
shows the cut). The same command fits any big local JSON dump — run json-slim on it rather
than raw-`Read`ing the file. A downloaded **JSONL** dump (one JSON object per line, e.g. a
Shopify bulk-operation result) is never compressed and never printed as rows: at ANY size
json-slim returns a PROFILE (row + parse-failure counts, per-key stats, sample rows) instead
of the data. Never raw-`Read` a big JSONL — query the ORIGINAL file by line with a `readline`
filter or `sed -n '<N>p' <path>` / `grep`, not `--jq` (which would re-read the whole file). The
sample rows exist so you can write that filter correctly — they reveal gotchas like a sub-field
being a JSON-encoded string, not an array. A NON-JSONL file gets its path handed back in two cases,
each with its own recovery: not JSON at all — read it with a windowed `Read` (offset/limit), `--jq`
does not apply; a big error envelope, never compressed — read it directly, and `--jq <dot.path>` can
narrow into it. A dump of UNIQUE ENTITIES (uniform rows, all-distinct ids/handles/titles, no error row)
is declined by design — sampling unique rows would lose content — and json-slim then prints it back
UNCHANGED (no percentage unless you pass `--stats`, which reports the 0.0 %). For a payload under the
CLI's ~48 KB output cap a second whole-file run therefore costs context and gains nothing — narrow with
`--jq <dot.path>`, or query the file directly (`grep` / `sed -n '<N>p'`); above the cap the CLI caps its
own output (spill + summary), so a whole-file run is safe. A `<<fnd-mcp-slim stub>>` names the recovery that fits its own case — when it says the
compressor already gained nothing, run the `--jq` line it gives you, not a bare re-run.
