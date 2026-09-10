## Foundation convention — LiquidDoc and core

This checkout is detected as a Foundation theme (profile `foundation`). Every snippet ships a
LiquidDoc `{% doc %}` block with a default on each param. The JS/TS core, `src/entry/core/*`, is
protected: extend or compose it, never edit it in place. The Liquid core — `snippets/@*`,
`sections/core-*`, `blocks/core-*` — may be edited, but every edit has to be hand-synced from the
foundation repo, so prefer a copy under a new name.
