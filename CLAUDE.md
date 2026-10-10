# fnd plugin development — repo conventions

- **The repo is a marketplace of several plugins** (`plugins/fnd`, `plugins/slim`, …). A new
  plugin lands with its `.claude-plugin/marketplace.json` entry in the same commit;
  `scripts/install.sh` and `plugins/fnd/scripts/bump-version.cjs` take `--plugin <name>`
  (default `fnd`). Every rule below applies to every plugin.
- **Node scripts are dependency-free by policy.** Everything under
  `plugins/*/scripts/*.cjs`, `plugins/*/hooks/*.cjs`, and `tests/*.mjs` uses Node
  built-ins only (`fs`, `path`, `os`, `child_process`, …). No `package.json`, no
  `node_modules`, no npm installs — the plugin installs via git clone and must run on
  bare Node on every developer machine. This applies to all FUTURE scripts and hooks
  too. If a capability seems to need a library, port the minimal logic instead (with
  license attribution — see MCP-COMPRESSION-PLAN.md's SmartCrusher port for the
  pattern) or make the dependency an optional, silently-skipped backend.
  The policy covers the Claude Code hooks modules too (`plugins/*/hooks/mods/**/*.ts(x)`):
  the engine compiles it, so it imports only from `claude-code`, its own files and
  `types/index.d.ts` — no npm, no `require`, no `import()`, no Node or DOM globals.
- **Every script and hook ships with test coverage** in `tests/`: bash scripts →
  `scripts-sim.sh` or the script's own `*-sim.sh` suite (`install-sim`, `doctor-sim`,
  `bootstrap-sim`), hooks → `hooks-sim.sh`, the ADF converters →
  `adf-md-fixtures.mjs`, the commit guard → `no-verify-bypass-matrix.sh`. Extend the
  matching suite in the same change that alters behavior. Mod tests live in
  `plugins/<name>/hooks/mods/tests/*.test.ts(x)` and run through `claude plugin test`,
  wrapped by `tests/mods-sim.sh` — one pass per `plugins/*/hooks/hooks.json` (local only:
  CI has no `claude` binary, so it SKIPs there). A change to a classic hook still extends
  `hooks-sim.sh`.
- **Every environment switch a plugin reads** (`FND_*`, `SHOPIFY_ADMIN_GQL_QUIET`, …) is
  documented in README → "Environment switches" — add new ones to that table in the same
  change that introduces them. A sibling plugin owns its own prefix (`SLIM_*` for slim);
  `tests/readme-checks.sh` sweeps every `plugins/*` for undocumented ones.

## Lessons

- A prompt describing a machine that is not there is actively wrong: decide a capability and the
  sentence advertising it in one place (SessionStart context, doctor).
- Two models, one schema: show the second model the first's value to copy or omit, and reject
  empty fields in code (ship ESCALATE fields, the jira-writer brief).
- A schema description is part of the validator's input contract: ask for raw input, normalize
  once in code.
- Before an environment failure reaches the coding agent, ask whether its diff could have caused
  it and can repair it — else escalate or retry; a failure handed over costs every later round.
