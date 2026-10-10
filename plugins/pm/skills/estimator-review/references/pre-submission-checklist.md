# Estimate Pre-Submission Checklist

Source of truth: [Notion — Estimator Pre-Submission Checklist](https://app.notion.com/p/3571e5089a2580b5a010e5deeea4c6aa),
last synced 2026-07-29; the "How to check" column is distilled from
[Estimation Best Practices — Domaine SE](https://app.notion.com/p/3571e5089a25814da7b9e59ebe27bac2)
and [Project Estimate Review Process](https://app.notion.com/p/11a1e5089a2580ff9c77e4b14a8f7846).
If a user says the checklist has changed, re-fetch the page through base's notion MCP
(`notion-fetch`), review against the fresh text, and tell the user this file in the pm plugin needs
the update.

**The Standard:** if this estimate were copied directly into an SOW, it would be safe to execute.
Reviews are final executive approvals, not workshop sessions.

**Key:** 🔴 required, a blocker. 🟡 SE judgment: surface the facts, never the verdict; ❓ is for these
rows only. **SE confirms** marks a process confirmation the document cannot show: ask the SE, never
assume yes, never ❓.

**Core stance:** everything is in scope until it is explicitly marked out; a blank out-of-scope
section is a finding, not a pass.

**In Scope? rule:** judge hours, complexity, bundles and parity on `In Scope? = True` rows only. The
template keeps default FED/BED/QA/BSA hours on `In Scope? = False` rows on purpose, so a row can flip
back into scope without re-estimating: a False row with hours is never a flag under any category.
Only a tab's SUBTOTAL / EST. TOTAL row that fails to net those hours out is.

## 1 — Quality & Presentation

Every client-visible field: estimates, SOWs, proposal decks.

| Item | | How to check |
|---|---|---|
| Spell check and grammar review completed | 🔴 | Read every visible cell on every tab. Flag typos, broken formatting, leftover placeholder text ("Lorem ipsum", "TBD", "xx hours"). |
| All line item names are clear and client-ready | 🔴 | Would a non-technical client stakeholder understand each name? Flag internal shorthand, tool names with no context, acronyms spelled out nowhere in the sheet. |
| No placeholder or incomplete sections | 🔴 | Search for "TBD", "TODO", "???", in-scope rows with zero hours and no rationale, and empty required cells: a blank OOS section, an OOS row still reading the template text ("OOS Item / Assumes OOS Item is out of scope"). |

## 2 — Scope & Assumptions

A 2–3 sentence summary states the scope's intent: client expectation, project complexity, client
sentiment and working-relationship expectations.

| Item | | How to check |
|---|---|---|
| Key assumptions reviewed, no line items contradict them | 🔴 | Extract every Key Assumption and scan every tab for a row that contradicts it ("single storefront" above a multi-region build row; a "single language / single currency" Site Configuration row above an International Configuration row assuming Markets + Translate & Adapt). Cite both and name which one is wrong. Also flag open items that contradict a closed assumption. A named-hour commitment ("up to 50 BED hours for [system]") that consumes the role's whole phase budget (any overage becomes a PCR) or leaves *consultation only* vs. hands-on ambiguous is a flag. On multi-site, lower per-site Build hours need a written assumption that later sites inherit Core code/config. |
| No unexplained large bundles (e.g. 55-hour blocks) | 🔴 | Flag any row at or above ~40–55 h with no breakdown and no written reason it cannot be split into two or more rows. A number alone fails. |
| Complexity ratings honest (scored with the bundle item) | 🔴 | Run the three-question screen of `complexity-framework.md` on every significant row; each "yes" rated below what its question demands is a flag. Complexity is risk and unknowns, never hours. |
| Design and build tabs are in sync | 🔴 | Cross-check every Build component against the Design tab, and back. Check by name every time: mini cart, bundle PDP, dev handoff hours in Design. |
| Explicitly out-of-scope items are documented | 🔴 | Each of data migration, SEO/URL migration, backend/ERP integrations, content entry and legacy customer account support is named, in scope or in the OOS section of design, build or back end. Silence is a flag, not "not applicable". |
| Timeline is realistic relative to scope | 🟡 | Take the client's target launch date (sheet, Drive docs, Bluedot/Slack) and the phase breakdown; show the math against total hours and the implied team size. Flag to sales if the date cannot hold. |
| Studio vs. Domaine approach is clear | 🟡 | The estimate states which offering it is (Studio vs. Domaine Qualifying Guide); unstated or ambiguous is a flag, never a guess. |

## 3 — Cross-Functional Alignment

Novel or untested technology carries its assumptions and LOE, validated with the right SMEs.

| Item | | How to check |
|---|---|---|
| Integration approach is documented in line item assumptions | 🔴 | Every row naming a third-party system (CDP, ERP, search, CRM, payments, any vendor or app) states the approach: what is in and out, what it depends on. "Rudderstack integration — 34 hours" alone fails. |
| SME input confirmed on backend/complex scope | 🔴 | SE confirms they got SME input, feedback or sign-off on backend, integration or other complex scope. Slack/Bluedot may corroborate; a missing written trail is not a finding. |
| High-risk or novel scope flagged for delivery team | 🟡 | Surface anything technically untested, at unusual scale, or dependent on an unvalidated third party that is buried in assumptions. First use of a Shopify feature and custom ERP/OMS/PIM backends are the usual ones (the High triggers in `complexity-framework.md`). |
| Role coverage vs. scope (no checklist row; reviewers ask it) | 🟡 | BED present where markets, regional payments, tax or ERP/OMS work is scoped. QA split per site/brand/surface with the arithmetic shown: under ~30 h per site on multi-site needs more hours or an assumption that Core FSUAT covers all sites. Discovery hours ground each Build integration (50 BED h of ERP in Build against 10 in Discovery = architecture unknown at commit). |

## 4 — Commercial Readiness

Owned jointly by the AE and SE. Commercial restraint applies: no price, cost or rate is read.

| Item | | How to check |
|---|---|---|
| Revenue viability assessed | 🟡 | Surface total hours, hours per phase and scope size; write "value: not read (commercial restraint)". |
| Estimate is competitively positioned | 🟡 | Surface scope size and hours against any comparable prior estimate the sources reference; pricing is not read. |
| Multi-option or phased approaches are clearly separated | 🔴 | Each scenario (single store vs. multi-site, Phase 1 vs. full scope) has its own tab or section, and no assumption bleeds across (a "single storefront" stated once but applied to a multi-site Option B). |
| Currency matches the client's region | 🔴 | The client-facing tabs use the currency of the client's stated region, read from a stated label (a header, an assumption, a column's number format or currency code), never from the price values. A CAD/USD/EUR mix-up, or a source naming another currency, is a flag. No label: SE confirms the currency. |
| Rate card is current | 🔴 | SE confirms the estimator uses the current rate card: it lives on the Settings tab this review never reads. (The checklist's "Currency and rate card are correct" row, split in two.) |
| Escalation / risk items flagged for reviewer | 🟡 | Known risks and open questions are called out in the estimator or the review request. Zero risks on a complex project earns a light flag: ask whether that is really true. |

## 5 — Final Gate

| Item | | How to check |
|---|---|---|
| First-pass self-review completed by submitting SE | 🔴 | SE confirms they read the whole estimate as the reviewer would and can defend every line. |
| Estimate is ready to be copied into an SOW | 🔴 | The composite verdict: every 🔴 row passed and every 🟡 row is ✅ or answered by the SE in this session; a 🟡 row still 🚩 or ❓ makes it "Ready pending SE judgment". |

## Failure modes to search for

- Assumptions copied from a prior estimate and never updated for this scope.
- Migration, SEO, content entry or backend integration never mentioned, so the reviewer has to ask
  "is X in scope?".
- The client's requested launch date entered as the delivery date with no math run against it.
- A Build component with no Design counterpart.
- An integration row with an hour count and no approach.
- A currency that does not match the client's region.
