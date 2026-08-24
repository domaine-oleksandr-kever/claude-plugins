# Commit message format — Conventional Commits, Domaine profile

The message rules shared by the `commit` skill and the pipeline finalize phase —
[Conventional Commits](https://www.conventionalcommits.org/) plus house rules.

## Rules

- **Write the entire commit message in English** (subject, body, and footers), regardless of the conversation language.
- **Never add a Claude/Co-Authored-By signature or any AI attribution** to the commit message.
- **Never bypass git hooks** — no `--no-verify` / `-n`, in any flow (auto pipeline or manual skill run). Hooks are quality gates. If a hook fails on a pre-existing repo defect your change didn't touch, report it to the developer (auto flows: ESCALATE) instead of bypassing — only the developer may bypass, by hand.
- Subject line: lowercase after the type, no trailing period, imperative mood, ≤ 72 chars.

## Format

```
<type>(<scope>): <description>

[body — as many paragraphs as needed; lines wrapped at ~72 cols]

[optional footer — BREAKING CHANGE: …]
```

`<scope>` is optional. Drop the parentheses entirely if there's no scope: `fix: correct off-by-one in pagination`.

## The body

No length cap — `~72 cols` is line *wrapping*, not a limit. Write it complete enough that a future reader understands the change without opening the diff: **what** changed at a high level, **why** (motivation, bug symptom, requirement), and non-obvious **context** (trade-offs, rejected alternatives, side effects, follow-ups). Skip the body only for genuinely trivial changes; when in doubt, write it.

## Types

| type | use for |
|------|---------|
| `feat` | new feature |
| `fix` | bug fix |
| `refactor` | code change that isn't a feature or fix |
| `perf` | performance improvement |
| `style` | formatting, whitespace, no logic change |
| `docs` | documentation only |
| `test` | adding or fixing tests |
| `build` | build system, dependencies |
| `ci` | CI config |
| `chore` | tooling, housekeeping |

## Examples

```
feat(ELC-61): add Braze email signup to footer
fix(cart): show delivery row in order summary
```

## Breaking changes

`!` after the type/scope plus a `BREAKING CHANGE: …` footer — e.g. `feat(api)!: drop support for legacy collection handles`.
