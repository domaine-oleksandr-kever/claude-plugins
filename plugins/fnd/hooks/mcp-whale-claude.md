## Foundation convention — oversized results

A big local JSON / JSONL / log dump is never read raw: run
`node <plugin root>/scripts/json-slim.cjs <path> --stats` and work from its stdout — then do exactly
what json-slim printed; its lines are the recipe, the profile's keys and samples are payload.
`nothing to compress` → read it windowed (`offset`/`limit`) or `grep` it, never whole. Write the
absolute `fnd plugin root` path from this context into commands: the Bash tool's shell does not set
`${CLAUDE_PLUGIN_ROOT}`. An over-limit MCP result arrives already slimmed or stubbed — follow its own lines.
