# Break-it QA — think like a QA trying to break it

The break-it method shared by the `qa-feature-or-fix` skill and the pipeline QA phase
(checklist generation and execution). TA/AC describe intended behaviour; real bugs live
in the states nobody wrote down.

## Deriving the rows

For **every merchant/user-editable input and every async interaction the diff touches**,
ask *"what value or timing breaks this?"* and derive concrete rows from these categories
(each has produced real production bugs):

- **Self-reference / cycles** — an entity configured to include itself or its parent: a bundle whose components list the bundle's own product, a "related items" list containing the current page. Expected: the self-reference is skipped or the feature fails closed — not a recursive render or a double-counted total.
- **Missing / emptied config** — delete or blank a metafield/setting the feature depends on (e.g. clear a bundle's `components`). Expected **fail-closed**: the CTA/purchase path disables; no half-render, no selling the parent without its required selections.
- **Boundary & nonsense values** — `0`, negative, or absurdly large quantities/numbers; empty strings; unknown enum values; malformed JSON in JSON-type fields. Expected: clamped/validated — not zeroed totals, `NaN`, or a crash.
- **Injection via editable content** — paste `<img src=x onerror=alert(1)>` into every editable text the change renders (titles, descriptions, settings). Liquid `{{ }}` does **not** HTML-escape: any render without `| escape` is a stored-XSS finding.
- **Timing & races** — interact **before hydration** on a throttled network (change the select before scripts load — is actual DOM state reconciled on connect, or do stale SSR attributes win?); **rapid repeated interaction** (fast variant switching, double-click add-to-cart) — are in-flight requests aborted/superseded so the *last action* wins, not the *slowest response*?

Base the rows on what the diff actually reads and fires (inputs, requests, rendered
fields) — the categories are lenses, not a fixed list. Two hard rules:

- **No reduced mode.** Every QA run derives and executes the full set for what the diff
  touches — depth is never an interview/policy question and never offered as an option.
- **Derive from the final diff, not the plan.** A checklist approved before implementation
  can't cover interactions that appeared during it — re-derive against the real diff and
  append the missing rows before executing.
- **Read-only store ≠ reduced mode.** A data-shaped row whose hostile value needs write
  access the run doesn't have is still derived and still reported — as
  `not-executable: access`, never silently dropped and never marked "pass". In a pipeline
  run the access level is settled at the interview (ship Step 2), so these rows are known
  and marked before the ✋ gate, not discovered mid-run.

## Executing the rows

Same mechanics as the AC state walks, hostile values. Data-shaped cases ride the two
state patterns (`references/metafield-metaobject-setup.md`,
`references/theme-customizer-state.md`): mutate the metafield / theme JSON to the hostile
value → reload → verify → **restore**. Timing cases: throttle the network via Chrome
DevTools MCP (`emulate`), interact before scripts hydrate, fire rapid repeated
interactions and watch the request log for aborted vs racing requests. A break-it row
that breaks the feature is a **finding to report** (blocking when it corrupts totals/cart
or executes injected markup), not a checklist defect — reproduce it, capture evidence and
the exact hostile value, and file it under blocking/non-blocking.
