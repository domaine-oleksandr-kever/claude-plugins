# Steps to Test — Templates

One section of the Steps to Test format; the index is `../steps-to-test-format.md`.

**General (feature / improvement)** — Theme, Where + setup, the walk-through with the guide's item 4 folded
into each step, Edge cases, Context / out of scope. `n+1` / `n+2` denote the last two numbers of the run; the
output carries the real digits (`8.`, `9.`).

```markdown
1. **Theme:** <store + theme, label + id>; <preview link or **Preview** route>. <Market / viewport if it matters, + how to set it.>

2. **Where:** page `<path>` (admin: <exact route, labels verbatim>). The section is **<name as the admin sees it>**.
   - <ships on `<template>` — find it in the sidebar, don't **Add section**; if it is missing, set it up as:>
   - <Customize route, or one editor deep link> > **Add section** > **<Section name>** (drag <position>);
   - **<Setting label>** → `<value>`; **Add block** > **<Block name>** > **<Setting>** → **<option>**;
   - add <content: product / image / copy>, then **Save**. <Theme code updated again → redo this setup.>
   - data you need, in <admin path>: <role> — `e.g. <handle>` + <properties> <(store-wide) (restore: <how>)>.

3. On `<path>`, <action>. You should see <exact outcome — copy verbatim, values, counts>.
4. <Next action, location first.> <Expectation clause.>

n+1. **Edge cases:**
   - <blank / overflow / boundary on a new setting> → <expected behaviour>;
   - <platform limitation> → <what happens; not a bug>.

n+2. **Context / out of scope:**
   - <new setting + its default, where the value comes from>;
   - <what was left unchanged, or a known limit, stated as not a bug>;
   - <not in this ticket: <area> — <one clause why>>.
```

**Bug (defect fix)** — the guide's four items; no scenarios, no regression sweep. The location, the setup
recipe and the expectations all live in item 4: a lead line naming the trigger fixture, then **one nested
bullet per case** — never one paragraph that runs the cases together.

```markdown
1. **Theme:** <as above — store, theme, how to open it>.
2. **Why the bug happened:** <root cause in terms the tester can observe, 1–2 sentences>.
3. **What was changed to fix it:** <the change in plain terms, new limits / values; a setting by its verbatim editor label>.
4. **What to expect:** on the <role> product, e.g. `<path>` (<the counts / values that made it trigger>) (admin: <editor route>). Handles are examples — if one is missing on your store, use any product with the same properties and say which one you used. <Touches a setting or needs data → item 2's recipe.>
   - **<Case that used to break — viewport with its breakpoint / page / data state>:** <action, location first>. You should see <what it does now — exact values>;
   - **<Next surface or viewport the fix reaches>:** <action>. <Expectation clause>;
   - **<Boundary — second `e.g.` handle with its properties, or the setting blank / past its limit>:** <action>. <Expectation> (restore: <how>);
   - **Regression:** <what a failure looks like — one clause per sign>.
```
