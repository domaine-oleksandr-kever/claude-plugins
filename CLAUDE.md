# fnd plugin development — repo conventions

- **Node scripts are dependency-free by policy.** Everything under
  `plugins/fnd/scripts/*.cjs`, `plugins/fnd/hooks/*.cjs`, and `tests/*.mjs` uses Node
  built-ins only (`fs`, `path`, `os`, `child_process`, …). No `package.json`, no
  `node_modules`, no npm installs — the plugin installs via git clone and must run on
  bare Node on every developer machine. This applies to all FUTURE scripts and hooks
  too. If a capability seems to need a library, port the minimal logic instead (with
  license attribution — see MCP-COMPRESSION-PLAN.md's SmartCrusher port for the
  pattern) or make the dependency an optional, silently-skipped backend.
- **Every script and hook ships with test coverage** in `tests/`: bash scripts →
  `scripts-sim.sh` or the script's own `*-sim.sh` suite (`install-sim`, `doctor-sim`,
  `bootstrap-sim`), hooks → `hooks-sim.sh`, the ADF converters →
  `adf-md-fixtures.mjs`, the commit guard → `no-verify-bypass-matrix.sh`. Extend the
  matching suite in the same change that alters behavior.
- **Every environment switch the plugin reads** (`FND_*`,
  `SHOPIFY_ADMIN_GQL_QUIET`, …) is documented in README → "Environment switches" —
  add new ones to that table in the same change that introduces them.
