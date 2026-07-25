# json-slim fixtures

Inputs for the `reduction:*` cases in `../json-slim-fixtures.mjs` and the M1 byte-reduction
measurements in `MCP-COMPRESSION-PLAN.md`. Secrets scrubbed (emails redacted; no tokens).

| File | Source | Shape | Notes |
|---|---|---|---|
| `jira-issue-ELC-104.json` | **real** — getJiraIssue (read-only) | issue w/ 55 customfields, 14 ADF nodes, 8 comments, 60-entry changelog | rich-read shape (renderedFields dropped); **75.5%** reduction (ADF→md + null-drop + changelog array crush 60→16) |
| `jql-search-ELC.json` | **real** — searchJiraIssuesUsingJql | 20 same-shape issues | realistic field projection; issues array crush 20→15; 61% reduction |
| `figma-metadata-3326-39542.xml` | **real** — Figma dev-mode `get_metadata` | XML node tree | kept for the record — NOT JSON, so json-slim passes it through (see M1 Figma finding) |
| `figma-variable-defs.json` | **real** — Figma dev-mode `get_variable_defs` | flat token object | ~0% reduction (flat, no arrays) |
| `figma-design-context.jsx` | **real** — Figma dev-mode `get_design_context` (node `13920:240398`), lines 494–712 of the 211 KB payload | generated React/Tailwind JSX | the M13 `jsx` stage: className dictionary + node-id legend + ×N sibling fold; **~64%** on this excerpt (moves ±0.1pp with the tmp spill-path length in the ids= header), **76.5%** on the whole 211 KB payload (**77.3%** on the 219 KB envelope as captured) |
| `figma-node-rest.json` | **synthetic** — Figma REST `/v1/files/:key/nodes` shape | PLP frame w/ 60 repeated product-card instances | grounded in the real node's repetition; 76.8% reduction. The dev-mode MCP does not emit large JSON node trees; the REST API does (Phase 2). |

`figma-design-context.jsx` is 28 KB rather than a couple of KB because the jsx stage's win is
cross-sibling: two adjacent Comparison Column subtrees are the smallest real excerpt that still
carries a repeated className dictionary worth a legend, the `$N` var-token pass and a ×N fold.
Anything smaller drops the excerpt's ratio to ~0.3 and the assertions with it. The whole capture —
211 KB of JSX inside a 219 KB MCP envelope — stays out of the repo at
`.claude/fnd/mcp-compression/figma-captures/` (git-excluded).

`../parity/fixtures/smart_crusher/` holds Headroom's 17 SmartCrusher parity fixtures (vendored
verbatim, Apache-2.0 — see `../parity/NOTICE`); they are the array-crush porting contract.
