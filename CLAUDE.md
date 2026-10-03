# fnd plugin development — repo conventions

- **Node scripts are dependency-free by policy.** Everything under
  `plugins/fnd/scripts/*.cjs`, `plugins/fnd/hooks/*.cjs`, and `tests/*.mjs` uses Node
  built-ins only (`fs`, `path`, `os`, `child_process`, …). No `package.json`, no
  `node_modules`, no npm installs — the plugin installs via git clone and must run on
  bare Node on every developer machine. This applies to all FUTURE scripts and hooks
  too. If a capability seems to need a library, port the minimal logic instead (with
  license attribution — see MCP-COMPRESSION-PLAN.md's SmartCrusher port for the
  pattern) or make the dependency an optional, silently-skipped backend.
  The policy covers the Claude Code hooks module too (`plugins/fnd/hooks/mods/**/*.ts(x)`):
  the engine compiles it, so it imports only from `claude-code`, its own files and
  `types/index.d.ts` — no npm, no `require`, no `import()`, no Node or DOM globals.
- **Every script and hook ships with test coverage** in `tests/`: bash scripts →
  `scripts-sim.sh` or the script's own `*-sim.sh` suite (`install-sim`, `doctor-sim`,
  `bootstrap-sim`), hooks → `hooks-sim.sh`, the ADF converters →
  `adf-md-fixtures.mjs`, the commit guard → `no-verify-bypass-matrix.sh`. Extend the
  matching suite in the same change that alters behavior. Mod tests live in
  `plugins/fnd/hooks/mods/tests/*.test.ts(x)` and run through `claude plugin test`,
  wrapped by `tests/mods-sim.sh` (local only: CI has no `claude` binary, so it SKIPs
  there). A change to a classic hook still extends `hooks-sim.sh`.
- **Every environment switch the plugin reads** (`FND_*`,
  `SHOPIFY_ADMIN_GQL_QUIET`, …) is documented in README → "Environment switches" —
  add new ones to that table in the same change that introduces them.
