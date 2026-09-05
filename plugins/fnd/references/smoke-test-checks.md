# Smoke-test checks — per-row commands, expected shapes, remediation

Reference for the `smoke-test` skill (run-once post-install / post-update proof). The skill owns
the sequence and the honest-status rule; this file owns what each row runs, what a healthy result
looks like, and what to do when it isn't one.

Path convention: `<plugin root>` is the plugin's own directory (`../../` relative to a skill
directory); on Claude Code the session context opens with `fnd plugin root: <absolute path>` —
write that path into commands; the Bash tool's shell does not set `${CLAUDE_PLUGIN_ROOT}`, so a
literal one expands to empty. Every path below is written against `<plugin root>`.

Status vocabulary, used identically in every row: **🟢** the check ran and returned what this
file expects · **🔴** it ran and failed · **🟡** it could not run, or its outcome is not
verifiable from this session. A 🟡 always carries the reason.

---

## Row 2 — Bundle integrity (`doctor.cjs`)

```bash
node <plugin root>/scripts/doctor.cjs
node <plugin root>/scripts/doctor.cjs --target cursor    # or codex | opencode | claude
```

Pass `--target` for the host named in the skill's global rules; without it the install-location
row is skipped. The script is dependency-free and read-only.

Reading the output:

| Output | Meaning |
| --- | --- |
| `fnd doctor — plugin root: <path>` | the path the host actually resolved — check it is the install you think you are testing |
| `PASS <check>` | asserted and healthy |
| `FAIL <check>` | broken install: the host may load the plugin partially or not at all |
| `SKIP <check>` | not assertable here — an adapter file that isn't part of this milestone yet, or a check that needs a flag you didn't pass |
| `doctor: N passed, M failed, K skipped` | the summary line to quote in the matrix |
| exit `0` / `1` / `2` | green (skips allowed) / at least one FAIL / usage error |

The `manifest:*` and `version-sync` rows carry the **plugin version** the whole matrix is filed
under; take it from here rather than from a path guess. Row 2 is 🟢 on exit 0, 🔴 on exit 1
(quote the FAIL lines verbatim), 🟡 if `node` itself is unavailable — which also invalidates the
Node-script half of row 7.

Generated per-host adapter dirs and hook wiring may legitimately report SKIP on a given release;
SKIP is not a failure and never turns row 2 red.

## Row 3 — One cheap read-only call per MCP server

One call per server the host actually exposes. All are read-only and none of them touches client
data. Call only the servers this host has configured — a server that is absent from the host's
tool list is 🟡 "not configured on this host", which is a fact about the install, not a fault.

| Server (canonical id) | Call | Arguments | Healthy result |
| --- | --- | --- | --- |
| `atlassian` | `atlassianUserInfo` | none | the authenticated account (display name / email) |
| `shopify-dev-mcp` | `learn_shopify_api` | `api: "liquid"` | a conversation id + the Liquid API context blurb |
| `notion-mcp` | `notion-get-teams` | none | a (possibly empty) list of teamspaces — an empty list still proves auth |
| `figma-dev-mode` | `get_metadata` | none | with nothing selected in the desktop app: the document's top-level pages (guid + name) |
| `chrome-devtools-mcp` | `list_pages` | none | the list of open pages |
| `playwright` | `browser_tabs` | `action: "list"` | the tab list |

Notes that decide 🔴 vs 🟡:

- **Auth errors are 🔴 for that row** (the server is configured but unusable) — quote the error.
  Remediation is the server's own auth flow, not a plugin change.
- **`figma-dev-mode` needs the Figma desktop app open in Dev Mode.** App closed → 🟡. A
  remote/connector Figma server attached at user scope counts as the Figma row instead; say which
  one answered.
- **The two browser servers need a browser to attach to or launch.** No browser available → 🟡.
  Do not navigate anywhere and do not open pages to make the row greener.
- Fan the calls out in parallel where the host allows it; they are independent.
- The results of these calls are also row 7's input — note any that returned a spill path or a
  compression stub instead of a body.

## Row 4 — Subagent layer

Spawn exactly one `jira-reader` subagent. Default brief, verbatim:

> Call the Atlassian MCP tool `atlassianUserInfo` and report the account's display name. Read
> nothing else, write nothing.

🟢 when the subagent returns a display name: agent registration, delegation and MCP access from
inside a subagent are all proven in one spawn. 🔴 when the host cannot spawn the agent (unknown
agent name, no agent layer) or the subagent reports no MCP access — those are different defects,
so quote which. 🟡 when the Atlassian row in row 3 is already 🟡/🔴 (nothing left to prove about
the agent's MCP access) — the spawn itself may still be reported 🟢 separately if it happened.

**Deeper variant** — the skill was given a ticket key: brief the same agent for its normal job,
a full read of that ticket, and report whether the fields came back. This additionally exercises
the ADF conversion and the whale/compression path on a real payload; it needs a ticket the
authenticated account can read.

## Row 5 — Guard-hook probe (scratch directory only)

The `git commit --no-verify` guard is the one hook whose firing is cheaply provable end to end on
every host. **Never run this in the developer's repo or any real checkout** — the probe creates
its own repo:

```bash
dir="$(mktemp -d)"
git init "$dir"
: > "$dir/probe.txt"
git -C "$dir" add probe.txt
git -C "$dir" commit --no-verify -m "smoke-test probe"
```

Use these commands as written — each one carries `-C "$dir"`. Do not rewrite them as
`cd "$dir" && git …`: a compound command that loses its `cd` (or an empty `$dir` from a failed
`mktemp`) would stage and commit the developer's real working tree instead.

Expected: **the host blocks the last command before git runs it**, with the plugin's refusal text
naming the Domaine convention (`references/commit-message-format.md`, "git hooks are quality
gates"). That is 🟢 — quote the first line of the refusal.

- Command ran and a commit was created → 🔴: the guard is not wired on this host. Name the host's
  wiring file in the remediation (the hooks block of the host manifest, the host's hooks wiring
  file, or the host's plugin adapter).
- Blocked by something else — a permission prompt, a sandbox, a policy layer — → 🟡 with what
  blocked it: the plugin guard was not the thing that fired, so it is still unproven.
- The scratch dir is disposable and lives under the OS temp dir; leave it and name its path in
  the report, or remove it if the developer asks.

A pre-approved Bash allow-list entry proves nothing here in either direction — the guard is
expected to deny a command the permission layer already allowed. That contrast is the point.

The other shell guard (AI-attribution in commit messages) is deliberately **not** probed: proving
it needs a real commit message, and a false negative there is invisible. Note it as out of scope
rather than reporting it untested.

## Row 6 — Context injection

Self-report which fnd session conventions are visible in the current context. They arrive as
short blocks under these headings:

- `Foundation convention — comment discipline`
- `Foundation convention — lean code`
- `Foundation convention — task workspace (per-ticket memory)`
- `Foundation convention — oversized MCP results`
- `Foundation capability — live store access, any time`
- `Foundation plugin — report defects upstream`

Report which are present, and by which mechanism they arrived on this host — a session-start hook
adding context, always-applied rule files, or a plugin adapter injecting on the first message.
Some blocks are gated on the workspace (store access appears where store credentials are
configured; task workspace where a ticket is in play), so a subset is normal — 🟢 when at least
the ungated conventions are visible, 🔴 when none are (the injection path is not wired), 🟡 when
you cannot tell them apart from project-level rules with the same content.

A 🔴 names a wiring gap; whose gap depends on the host. Where the plugin owns the injection
(Claude Code's session hook, Cursor's always-applied rules, the Codex hook) it is a plugin-side
defect — offer `report-plugin-issue`. On OpenCode the adapter injects only the gated store-access
block **by design**: the static conventions arrive through the user's own `instructions` config,
so none-visible means that install step was skipped — the remediation is the paste in
`docs/README.opencode.md` (Install step 5), not a plugin fix.

## Row 7 — MCP compression (best effort)

Two halves, reported separately and never inferred from each other:

- **Hook half** — did any MCP call in rows 3–4 trip the compressor? Evidence: a spill path handed
  back instead of a body, a stub block, or an in-place rewrite marker. Report which path fired.
  Nothing tripped it → 🟡 "not exercised" (these calls are small by design; that is expected).
- **Script half** — run the CLI on a bundled fixture:

  ```bash
  node <plugin root>/scripts/json-slim.cjs <plugin root>/../../tests/fixtures/mcp-envelope-jira.json --stats >/dev/null
  ```

  The stats and the envelope-unwrap notice go to stderr; the slimmed body goes to stdout and is
  discarded here. Healthy output ends with a reduction line of the shape
  `json-slim: <bytes> → <bytes> bytes (<pct>% reduction)`, preceded by the
  `unwrapped MCP text envelope` notice for this fixture. 🟢 on that pair, 🔴 on a crash or a
  non-zero exit.

  The fixture ships with the repository checkout, not inside the plugin directory: on installs
  that carry only the plugin subdirectory the path does not exist — that is 🟡 "fixture not
  present in this install", not a failure. Do not substitute an invented input file.

## Report format

One matrix, then remediation. Header line first: **host + host version · plugin version ·
install mode/path** (host and version from the skill's global rules and row 2; install mode from
doctor's install row when `--target` was passed).

| # | Check | Status | Detail |
| --- | --- | --- | --- |
| 1 | Invocation + skill layer | 🟢 | how it was invoked on this host |
| 2 | Bundle integrity (doctor) | | doctor summary line + version |
| 3 | MCP servers | | one sub-row per configured server, each with its own status |
| 4 | Subagent (jira-reader) | | what came back |
| 5 | Guard hook (`--no-verify`) | | blocked / allowed / blocked by something else |
| 6 | Context injection | | which conventions are visible, via which mechanism |
| 7 | MCP compression | | hook half + script half, separately |

Remediation lines for non-green rows, most-blocking first:

| Symptom | Remediation |
| --- | --- |
| doctor FAIL on a manifest or version-sync row | re-run the installer for this host; a version mismatch means a partial update |
| doctor FAIL on a pointer/hook row | the host's wiring file is missing from this install — reinstall, then re-run doctor |
| MCP server absent from the host | add it to the host's MCP config (or the host's plugin-provided config) and restart the session |
| MCP server present but unauthenticated | run that server's own auth flow, then re-run row 3 |
| Subagent not spawnable | the host's agent directory for this install is missing or not discovered — reinstall, then start a new session. On Codex current CLIs load bundled TOML agents from the marketplace cache (measured 0.149.0); if yours does not, link them locally with `scripts/install.sh --target codex` — `doctor.cjs --target codex` says whether links are live |
| Guard did not fire | the host's hook wiring is not loaded: check the install, and on hosts with a hook trust prompt, approve the plugin's hooks and start a new session |
| No conventions in context | the host's injection path is not active — same wiring check as the guard row |
| Any bundled script crashed | that is a plugin defect, not an environment gap → offer to file it |

**Filing.** Environment gaps (missing auth, no browser, closed desktop app, server not
configured) are the developer's to fix and are named as such. Genuine plugin defects — a bundled
script that crashes, a pointer that resolves nowhere, a guard that does not fire on a host that
supports hooks, or an instruction in the skill that contradicts what happened — are worth filing
through the fnd report-plugin-issue skill, with this run's host, host version, plugin version,
the exact command and its output. Offer it; never file automatically.
