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
narrow into it.
