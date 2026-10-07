# slim

Slim will be a universal tool-result compression proxy for Claude Code: one place that shrinks
large tool results (MCP, Bash, reads) before they reach the context. Today that work lives in the
`fnd` plugin (`plugins/fnd`, its mcp-slim hook and slim mods); slim takes it over once built.

**Status: stub, not yet functional.** It registers one pass-through hook and changes nothing.

Current release: **slim v0.1.0**.

```
/plugin install slim@domaine
```

Claude Code only: slim is a hooks module (mods), which other hosts do not run.
