# Steps to Test — Template

One section of the Steps to Test format; the index is `../steps-to-test-format.md`.

One skeleton, feature and bug alike. Four items, numbered 1–4, in this order; nested bullets one level
deep under items 3 and 4 only.

```markdown
1. **Theme:** <environment: DEV / UAT / Prod> — <store> (<its storefront host>), theme **<name>** (<id>); <the bare preview link, or `Online Store > Themes > <name> > Preview`>. <Market / viewport / locale / browser only when the change depends on it, with the breakpoint in px.>
2. **Object:** <page by path, template name, section / block by its admin name, `Theme settings > <group>` — where the change lives>.
3. **Setup:** <what QA has to configure to reach the change, in dependency order — store data → definitions → entries → theme settings → content>
   - <settings by label with their value (a theme-settings group's values too), `Add section` / `Add block` by editor name, then **Save**>;
   - <data QA needs, as properties: "a product with 3+ sizes where 1 size is sold out">;
   - <a storefront state the shopper must be in first, as a requirement, with its route when not obvious: "logged in as a wholesale customer", "a cart holding 2+ units of one product">;
   - <a found fixture: its signature in the source that keeps it, where to look first>;
   - <a cache in the way: what it holds, where, how QA empties it>;
   - <store-wide mutation → its restore in the same bullet>.
4. **Edge cases / not obvious:** <boundaries, blank values, platform limits stated as not a bug, states only time reaches, what is intentionally out of this ticket — one clause each>.
```

Item 3 is the heart of the field: everything the change adds or re-wires has its route and its non-default
settings there. Item 4 may be a single clause when there is nothing non-obvious; it is never a test scenario.

**A Bug** uses the same four items. Item 3 holds the state that makes the defect reachable — the data
shape, viewport, market, setting value — and the state the fix keeps or limits, as requirements, never a
handle or a page that already shows it. A storefront state the shopper must be in before the defect is
reachable (a customer logged in, a cart past a threshold, consent declined) is a setup bullet; a storefront
action that is the test itself (a filter selected, a search typed) is an item 4 fact, not a setup bullet.
The root cause and the fix are never in the field: they are in the PR.
