---
name: report-plugin-issue
description: >
  File a GitHub issue on the plugin repo when a base component misbehaves — a bundled script,
  converter, guard, skill, reference, agent, or the doctor fails or contradicts actual behavior.
  Use when a base script / skill / agent / guard fails or behaves incorrectly, or the user reports
  a plugin bug.
argument-hint: "[one-line summary of the defect — inferred from the conversation if omitted]"
arguments:
  - name: problem
    description: One-line summary of the defect. If omitted, infer it from the failure just observed in the conversation.
allowed-tools: Read, Grep, Glob, Write, Bash(gh auth status), Bash(gh --version), Bash(gh issue list*), Bash(gh issue view*), Bash(gh issue create*), Bash(gh issue comment*), Bash(claude --version), Bash(node -v), Bash(jq --version), Bash(uname -srm), Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/doctor.cjs*)
---

# Report a plugin issue

File a defect against the **base plugin itself** on
`https://github.com/domaine-oleksandr-kever/claude-plugins`. **Do not skip the ✋ checkpoint — never
post without explicit approval.**

## Step 0 — Is it actually a plugin bug?

File an issue only when the **plugin** is at fault:

- a bundled script (`md-to-adf.cjs`, `figma-rest.sh`, `jira-attachments.sh`,
  `external-screenshots.sh`, `worktree-setup.sh`, `doctor.cjs`, `scratch-hygiene.cjs`) crashes, dies
  silently, produces wrong output, or reports a wrong/misleading `error=`;
- a converter mangles content (broken tables/lists/marks, wrong field extracted);
- a guard denies a command or a path it should allow, or lets through one it should deny (the
  attribution guard, the git-hooks guard `hooks/no-verify-bypass.sh`, the scratch-path guard
  `hooks/scratch-path-guard.cjs`);
- a SKILL.md / reference / agent instruction is wrong, self-contradictory, or doesn't match what the
  tooling actually does;
- an `allowed-tools` rule blocks a command the same skill instructs you to run;
- `/base-doctor` reports a row wrong for the install it inspects.

A result compacted wrongly by slim is slim's defect, filed on the same repo with the component
`slim:<channel or engine>`.

**Not** plugin bugs — don't file these: missing CLIs, unauthenticated MCP/`gh`, network problems,
bugs in the user's own repo, Jira/Figma/Notion service errors. *Exception:* the plugin **handling**
such a condition badly (crashing instead of printing a clean `error=…`) is a plugin bug.

## Step 1 — Collect debug info

Gather what applies (skip the rest):

- **Component + mode** — e.g. `md-to-adf.cjs --no-tables`, `worktree-setup.sh --remove`,
  `guard:no-verify-bypass`, `skill:commit step 6`, `agent:jira-reader`.
- **Install state** — ask the developer to run `/base-doctor` and keep its output: the static rows,
  slim and fnd as the session sees them, each MCP server's connection, and the tail of `base.events`
  (the guards' denies, the reader refusals, the install lines). Without it, run
  `node ${CLAUDE_PLUGIN_ROOT}/scripts/doctor.cjs` for the static rows.
- **Plugin version** — from the doctor's `manifest` row, or `Read`
  `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json`.
- **Environment** — `claude --version`, `uname -srm`; plus `node -v` for the Node scripts,
  `jq --version` for the jq steps, `gh --version` for issue flows.
- **Exact command** as run (sanitized — Step 2) and its **exit code** if known.
- **Full output** — the `error=` / `cause=` lines and stderr; a `log=<path>` file's tail when the
  script printed one.
- **Expected vs actual** — one line each.
- **Minimal repro** — the smallest sanitized input that triggers it (e.g. the markdown fragment that
  mis-converts), and which skill/step invoked the component.

## Step 2 — Sanitize (hard rules)

- **Never `Read` or paste `.env`** or any config that holds a token.
- Redact anything token-shaped — `ghp_…`, `github_pat_…`, `ATATT…`, `figd_…`, `shpat_…`, and
  `Authorization:` header values — as `<redacted>`.
- Strip share/query params from URLs; prefer path-only URLs.
- Default-anonymize client context: `<site>.atlassian.net`, `<project>`, omit the client repo name
  and any customer data. Real identifiers go in only if the developer explicitly says so.
- Never paste ticket / design / doc excerpts — restate the trigger as a **synthetic minimal repro**
  built from invented copy; client wording is customer data. The same holds for `base.events` lines
  that carry a ticket key or a path: keep the kind and the shape, invent the rest.
- Rewrite absolute paths to their `<plugin root>` / `<repo>` relative form and strip usernames.
- Redact **any** 20+ character high-entropy token and any `user:pass@` URL too, not only the
  prefixes listed above.
- A `log=<path>` tail goes in only after the same substitutions.

## Step 3 — Check for duplicates

```bash
gh issue list --repo domaine-oleksandr-kever/claude-plugins --state all --search "<component or symptom keywords>"
```

If an existing issue covers it, show it and ask whether to **add a comment** with the new debug info
(`gh issue comment <n> --repo domaine-oleksandr-kever/claude-plugins --body-file <file>`) or skip.
Never open a duplicate.

## Step 4 — Draft the issue

- **Title:** `[<component>] <symptom>` — e.g.
  `[worktree-setup.sh] --remove calls a clean worktree dirty when a --copy path is a directory`,
  `[skill:commit] instructs a command its allowed-tools blocks`,
  `[guard:scratch-path] denies a path under .claude/base-tmp`. One defect per issue — related-but-
  different symptoms get separate issues or comments.
- **Body** (write it to a temp file for `--body-file`):

````markdown
## What happened
<one paragraph: observed behaviour>

## Expected
<what should have happened>

## Command
`<sanitized command>` (exit <code>)

## Output
```text
<sanitized stdout/stderr, trimmed to the relevant part>
```

## Install
```text
<sanitized /base-doctor output, or the doctor.cjs rows>
```

## Environment
plugin base <version> · claude code <version> · <uname -srm> · <node / jq / gh versions if relevant>

## Repro / context
<minimal sanitized repro; which skill/step invoked the component>
````

### ✋ Checkpoint

Show the developer the full **title + body** and where it will be posted
(`domaine-oleksandr-kever/claude-plugins`). **Post only after explicit approval.**

## Step 5 — Create it

```bash
gh issue create --repo domaine-oleksandr-kever/claude-plugins --title "<title>" --body-file <file>
```

Report the issue URL back. If `gh` is missing, unauthenticated (`gh auth status`), or lacks access to
the repo, print the finished title + body in a fenced block and hand over the manual link:
`https://github.com/domaine-oleksandr-kever/claude-plugins/issues/new`.
