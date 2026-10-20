# Steps to Test — Theme resolution (item 1)

One section of the Steps to Test format; the index is `../steps-to-test-format.md`.

In order, stopping at the first that answers:

1. **The ticket** — a QA theme link or id in the Description, Steps to test, AC or comments, unless it is
   evidently the PR's own preview theme.
2. **A theme this session confirmed on that store**, from the workspace `notes.md` — written as `id <id> as of
   <date> — confirm with the TL`.
3. **Ask the developer once** — "which theme does the TL push to for QA?" (one AskUserQuestion).
4. **Placeholder** — `[QA] theme — confirm with the TL`, or a known id whose owner is unknown, stated as
   unconfirmed; never invent a theme.

Never the QA store registry's `defaultTheme`, and never the session's own preview theme from the
workspace — that is the PR's theme.
