---
name: report-plugin-issue
description: >
  File a GitHub issue on the fnd plugin repo when a plugin component misbehaves — a bundled
  script, converter, skill, reference, agent, or hook fails or contradicts actual behavior.
  Use when an fnd script / skill / agent fails or behaves incorrectly, or the user reports a
  plugin bug.
argument-hint: "[one-line summary of the defect — inferred from the conversation if omitted]"
arguments:
  - name: problem
    description: One-line summary of the defect. If omitted, infer it from the failure just observed in the conversation.
allowed-tools: Read, Grep, Glob, Write, Bash(gh auth status), Bash(gh --version), Bash(gh issue list*), Bash(gh issue view*), Bash(gh issue create*), Bash(gh issue comment*), Bash(claude --version), Bash(cursor-agent --version), Bash(codex --version), Bash(opencode --version), Bash(node -v), Bash(jq --version), Bash(shopify version), Bash(uname -srm)
---

# Report a plugin issue

File a defect against the **fnd plugin itself** on
`https://github.com/domaine-oleksandr-kever/claude-plugins`. **Do not skip the ✋
checkpoint — never post without explicit approval.**

## Step 0 — Is it actually a plugin bug?

File an issue only when the **plugin** is at fault:

- a bundled script (`create-preview-theme.sh`, `shopify-admin-gql.sh`, `md-to-adf.cjs`,
  `adf-to-md.cjs`, `fix-breaking-changes.template.js`) crashes, dies silently, produces wrong
  output, or reports a wrong/misleading `error=`;
- a converter mangles content (broken tables/lists/marks, wrong field extracted);
- a SKILL.md / REFERENCE.md / agent instruction is wrong, self-contradictory, or doesn't match
  what the tooling actually does;
- an `allowed-tools` rule blocks a command the same skill instructs you to run;
- a model id pinned in a generated per-host agent no longer resolves on that host, while the
  installed plugin is already the latest version (the `preflight-checks` model-pin row).

**Not** plugin bugs — don't file these: missing CLIs, unauthenticated MCP/`gh`, network
problems, bugs in the user's theme/repo, Shopify/Jira service errors. *Exception:* the plugin
**handling** such a condition badly (crashing instead of printing a clean `error=…`) is a
plugin bug.

## Step 1 — Collect debug info

Gather what applies (skip the rest):

- **Component + mode** — e.g. `create-preview-theme.sh create`, `md-to-adf.cjs --no-tables`,
  `skill:create-pull-request step 4`.
- **Plugin version** — from this skill's own base directory path (`…/fnd/<version>/…`) or
  `Read` `../../.claude-plugin/plugin.json` (relative to this skill's directory).
- **Host + host version** — name the host this session runs on (`claude-code`, `cursor`,
  `codex-cli`, `opencode`) from signals already in the session: how this skill was invoked, which
  tools and MCP servers are exposed, which host config directory the workspace carries. Ambiguous
  signals → report the host as `unknown`; never guess, since the same component behaves differently
  per host. Its version comes from that host's own CLI — `claude --version`, `cursor-agent
  --version`, `codex --version`, `opencode --version` — and a host installed without its CLI on
  PATH reports the version as `unknown` rather than an invented number.
- **Environment** — `uname -srm`; plus `node -v` for the converters/Node scripts, `shopify version`
  + `jq --version` for the theme scripts, `gh --version` for PR/issue flows.
- **Exact command** as run (sanitized — Step 2) and its **exit code** if known.
- **Full output** — the `error=` / `cause=` lines and stderr; for theme-script push failures
  include the tail of the `log=<path>` file the script printed.
- **Expected vs actual** — one line each.
- **Minimal repro** — the smallest sanitized input that triggers it (e.g. the markdown/ADF
  fragment that mis-converts), and which skill/step invoked the component.

## Step 2 — Sanitize (hard rules)

- **Never `Read` or paste `shopify.theme.toml` or `.env`** — tokens live there.
- Redact anything token-shaped — `shptka_…`, `shpat_…`, `shpca_…`, `ghp_…`, `github_pat_…`,
  `ATATT…`, and `Authorization:` / `X-Shopify-Access-Token:` header values — as `<redacted>`.
- Strip share/query params from URLs (`key=`, `_ab`, `_bt`, `_fd`, `_sc`); prefer path-only URLs.
- Default-anonymize client context: `<store>.myshopify.com`, `<theme-id>`, omit the client repo
  name and any customer data. Real identifiers go in only if the developer explicitly says so.
- Never paste ticket / TA / Steps-to-Test excerpts — restate the trigger as a **synthetic minimal
  repro** built from invented copy; client wording is customer data.
- Rewrite absolute paths to their `<plugin root>` / `<repo>` relative form and strip usernames.
- Redact **any** 20+ character high-entropy token and any `user:pass@` URL too, not only the
  prefixes listed above.
- A `log=<path>` tail goes in only after the same substitutions.

## Step 3 — Check for duplicates

```bash
gh issue list --repo domaine-oleksandr-kever/claude-plugins --state all --search "<component or symptom keywords>"
```

If an existing issue covers it, show it and ask whether to **add a comment** with the new debug
info (`gh issue comment <n> --repo domaine-oleksandr-kever/claude-plugins --body-file <file>`)
or skip. Never open a duplicate.

## Step 4 — Draft the issue

- **Title:** `[<component>] <symptom>` — e.g.
  `[create-preview-theme.sh] refresh dies silently when --theme is the last arg`,
  `[skill:write-steps-to-test] instructs a command its allowed-tools blocks`,
  `[agents-cursor] pinned model <id> no longer resolves on Cursor`. One defect per issue —
  related-but-different symptoms get separate issues or comments.
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

## Environment
plugin fnd <version> · host <host name> <host version> · <uname -srm> · <node / shopify / jq / gh versions if relevant>

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

Report the issue URL back. If `gh` is missing, unauthenticated (`gh auth status`), or lacks
access to the repo, print the finished title + body in a fenced block and hand over the manual
link: `https://github.com/domaine-oleksandr-kever/claude-plugins/issues/new`.
