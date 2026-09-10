# Jira attachments — the read-only token, the script, the degradation

Single home for the credential setup `jira-attachments.sh` needs, what the script does with it,
and what a ticket read looks like when the token is absent. **Plugin root** = the plugin's own
directory, this file being `<plugin root>/references/jira-attachments.md`; every `<plugin root>/…`
path below resolves the same way.
On Claude Code use the session context's `fnd plugin root:` path — `${CLAUDE_PLUGIN_ROOT}` is empty
in the Bash tool's shell.

## Why a token at all

The Atlassian MCP returns attachment **metadata** — id, filename, mimeType, size, author — and
exposes no tool that returns the **bytes**. An image pasted into a comment is an ADF `media` node
carrying a uuid and nothing else. The REST content endpoint does hold the bytes, but it is private
(401 unauthenticated, and a web-fetch tool refuses a private URL and would convert a PNG to
markdown anyway), and the MCP's own OAuth token is not reusable: it lives in the host's credential
store, is unreadable from a shell, short-lived, and scoped to the MCP session.

So the download authenticates as **the developer**, with a token that person creates once. Scoped
read-only, it grants strictly **less** than the MCP already has — the MCP exposes comment, edit and
transition tools; this token cannot do any of them.

## Create the token — read-only, scoped

At <https://id.atlassian.com/manage-profile/security/api-tokens>, press **"Create API token with
scopes"**.

**Not** the plain "Create API token" button beside it: that mints an *unscoped classic* token
carrying the developer's full read **and write** rights across Jira and Confluence. The plugin
needs read only, and the script is not built for a classic token — it speaks the
`api.atlassian.com` gateway, where a classic token is not what the flow below assumes.

In the wizard:

1. App: **Jira**.
2. In "Select Jira scopes" set the filters **Scope type: Classic** and **Scope actions: Read** —
   that narrows 388 scopes to 5. Take all five:

   | scope | why |
   |---|---|
   | `read:jira-work` | **the one that matters** — issues, comments and attachments |
   | `read:jira-user`, `read:account`, `read:me` | author/profile data on comments |
   | `read:servicedesk-request` | not needed for Jira Software projects; harmless |

3. Expiry: 30 days is plenty; the script's refusal names the renewal path when it lapses.

Then put the two values in the repo's **gitignored** `.env` — the same file the Shopify runners
read their token from:

```
JIRA_EMAIL=<your atlassian login>
JIRA_API_TOKEN=<the token>
```

Process environment wins over the file, so `JIRA_API_TOKEN=… jira-attachments.sh …` overrides it
for one run. `JIRA_SITE` is read the same way (default `meetdomaine.atlassian.net`).

**Nobody reads that file but the script.** Skills and agents call the script; they never `Read`
`.env`, and the script never prints or echoes either value — it hands them to curl through a
private `0600` config file that is deleted when the process exits, never on the argv.

## One host: the api.atlassian.com gateway

Every authenticated request goes to
`https://api.atlassian.com/ex/jira/<cloudId>/rest/api/3/…` — `myself`,
`issue/<KEY>?fields=attachment`, `attachment/content/<id>`. The **site** host
(`https://<site>/rest/api/3/…`) answers **401** for the very same credentials: that is measured
(→ Evidence), not folklore, and it is why the script has no site-host fallback.

`<cloudId>` is a site-global uuid. Pass it with `--cloud-id` when you already have it — every MCP
response carries it inside its `self` / `content` URLs — otherwise the script discovers it once
with the only request that touches the site host and the only one that carries no credentials:

```bash
curl -s https://meetdomaine.atlassian.net/_edge/tenant_info   # → {"cloudId":"…"}
```

The content endpoint 302s to a pre-signed media host; the script follows it with `-L` and curl
drops the credentials on the cross-host hop by itself (the redirect URL carries its own
signature). `--location-trusted`, which would not drop them, is never passed.

## The script

```bash
<plugin root>/scripts/jira-attachments.sh <ISSUE-KEY> [--out <dir>] [--ids <id,id>] [--all]
    [--max-mb <N>] [--force] [--no-frames] [--frames <N>] [--env <dotenv>] [--site <host>]
    [--cloud-id <uuid>] [--json]
<plugin root>/scripts/jira-attachments.sh --check [--env <dotenv>] [--site <host>] [--cloud-id <uuid>]
```

| flag | default | what it does |
|---|---|---|
| `--out <dir>` | `.claude/tasks/<KEY>/tmp/attachments` | download dir; must be a path git ignores (below) |
| `--ids <id,id>` | all | only these attachment ids |
| `--all` | off | lift the `image/*` + `video/*` filter (PDFs, zips, …) |
| `--max-mb <N>` | `25` | per-file size cap; over it the row is `skipped_size` |
| `--force` | off | re-download and re-cut frames even when the file is already on disk |
| `--no-frames` / `--frames <N>` | frames on, `8` | video frame extraction (below) |
| `--env <dotenv>` | `./.env` | where `JIRA_EMAIL` / `JIRA_API_TOKEN` / `JIRA_SITE` are read from |
| `--site <host>` / `--cloud-id <uuid>` | `$JIRA_SITE`, else `meetdomaine.atlassian.net` | the cloudId lookup, or skipping it |
| `--json` | TSV | the same rows as a JSON array — what the reader consumes |
| `--check` | — | probe the credentials only |

stdout is one row per attachment, header first:
`id  status  kind  mime  size  created  author  path  frames  filename` — `status` is
`saved` / `cached` / `skipped_type` / `skipped_size` / `failed`, `kind` is `image` / `video` /
`other`, `path` is empty unless the file is on disk, `frames` is `<framesdir>:<count>` or empty.
`--check` prints `ok=1 jira_user=<name> cloud_id=<uuid> ffmpeg=<yes|no>` instead.

stderr carries per-failure notes (`note=download_failed id=… http=…`, `note=frames_failed id=…`,
`note=ffmpeg_not_found videos=…`, `note=invalid_attachment_id id=…` — an id that is not
`[A-Za-z0-9_-]` is skipped: it would ride both a URL path and the filename) and always ends with
the summary
`ok=1 saved=N cached=N skipped=N failed=N frames=N out=<dir>`.

| exit | meaning | typical `error=` |
|---|---|---|
| 0 | every wanted file is on disk | — |
| 1 | at least one download failed; the rest were saved | rows say `failed` |
| 2 | usage or precondition | `invalid_issue_key`, `curl_not_found`, `jq_not_found`, `cloud_id_lookup_failed`, `out_dir_not_ignored`, `out_dir_not_in_repo` |
| 3 | credentials | `no_jira_credentials` (+ the setup `hint=`), `invalid_jira_credentials` |
| 4 | the API rejected the request | `jira_auth_rejected http=401` (+ hint), `issue_not_found` |
| 5 | curl transport failure | `curl_transport_failed` |

Runs are **idempotent**: a file already on disk whose size equals the metadata size is `cached` —
no request — and size equality also catches a run truncated halfway. `--force` redoes it.

## Where the bytes land — git must ignore it

The script refuses an `--out` that git would track (`git check-ignore`): downloads must never
reach a commit, and the same gate is what keeps a ticket that says *"save it to ~/…"* inside a
repo's scratch. Under `.claude/tasks/` it stamps the `info/exclude` line
`<plugin root>/references/task-workspace.md` prescribes and proceeds; any other unignored
directory is `error=out_dir_not_ignored`, exit 2, nothing created and no issue or attachment
request made — with no `--cloud-id` the unauthenticated `_edge/tenant_info` lookup has already
run, since the gate sits after it.

**The question is put to the dir's physical location.** In a `git worktree` checkout
`.claude/tasks` is a **symlink** into the main checkout (`worktree-setup.sh` points it there so
one workspace serves every worktree), and `git check-ignore` cannot look past a symbolic link at
all — asked about a path under one it dies `fatal: pathspec '…' is beyond a symbolic link`. So the
script resolves the out dir (nearest existing ancestor through the symlinks, plus the segments
that do not exist yet) and asks the repository that **physically holds the bytes**: in a worktree
that is the main checkout, whose `.gitignore`/`info/exclude` already covers `.claude`. The rows,
the `path` column and the summary's `out=` all name that physical path — which is also what says
out loud which checkout a worktree actually wrote to.

The `info/exclude` stamp is only ever written when that physical repo is **the same repository**
as the cwd's (same `--git-common-dir` — a worktree and its main checkout share one, so the
symlink case still stamps). A `.claude/tasks` belonging to a *different* checkout gets no line
from us and is refused unless that repo already ignores it. And a dir that resolves outside every
git repository — `--out ~/x`, or a symlink escaping the checkout — is
`error=out_dir_not_in_repo`, exit 2, before any request.

Filenames are `<attachment-id>-<sanitised-name>`. The id prefix is site-global, so a batch
workspace can share one directory, and it maps each file 1:1 to its metadata row — which also
dedups a comment-embedded image (Jira stores it as an issue attachment too).

## Frames — reading a screen recording

A `.mov` cannot be looked at, so each saved video is additionally cut into 8 evenly spaced PNGs
next to it (`<file>.frames/01.png` …, plus a `done` marker so a re-run does not re-cut). This
needs **ffmpeg** on PATH — an optional backend, `brew install ffmpeg`. Without it the video is
still downloaded and the run still exits 0; one `note=ffmpeg_not_found videos=<N>` line says why
there are no frames. `ffprobe` supplies the duration for the spacing; with no ffprobe the script
assumes 60 s.

## What this token cannot do

No write scope was selected, so `POST`/`PUT`/`DELETE` come back **403**: no comment, no field
edit, no transition, no delete, no attachment upload. Writes keep going through the MCP's own
OAuth tools (`<plugin root>/references/jira-adf-write.md`) exactly as before. The token also sees
only what that person can already see in Jira — it grants no project access of its own.

## Degradation — a missing token never fails a ticket read

With no credentials the script exits 3 with `error=no_jira_credentials` and one `hint=` line
naming the two env vars, the token URL, the "Create API token with scopes" button, the read-only
scope filters, and this file. **Nothing is requested** — the refusal happens before the first
network call.

The reader treats that as information, not failure: the ticket still comes back with every field,
every comment and the full attachment table, `path` empty, and the script's hint carried verbatim
into `attachments_note` with the count in front of it —
`"6 attachments (6 images) not downloaded — <hint>"`. The caller shows that line to the developer
once and goes on. Same for `note=ffmpeg_not_found` (videos saved, no frames) and for a single
failed download (the other rows are still saved). Nothing here is ever routed through
`needs_clarification`: a missing screenshot must not block a ticket read.

The `preflight-checks` skill probes the credential with `--check`, so a stale or absent token is
usually reported before any ticket is read.

## Evidence — measured 2026-09-10 (elc-theme, ELC-1309)

By hand, with exactly the scoped read-only token described above — no classic token, no MCP
credentials.

| probe | result |
|---|---|
| `GET https://api.atlassian.com/ex/jira/<cloudId>/rest/api/3/myself` | **200** |
| same credentials against `https://meetdomaine.atlassian.net/rest/api/3/myself` | **401** — a scoped token needs the gateway host |
| `GET https://meetdomaine.atlassian.net/_edge/tenant_info` (no auth) | **200**, returns the `cloudId` |
| `GET …/rest/api/3/issue/ELC-1309?fields=attachment` | **200**, 6 attachments with id / filename / mimeType / size |
| `GET …/rest/api/3/attachment/content/<id>` with `-L`, ×6 | **200**, `content_type=image/png`, byte counts identical to the metadata (362084, 207002, 87917, 147132, 120451, 297437) |

What it bought on that ticket: the six QA screenshots, read back as images, showed DevTools
overlays naming classes and fonts that exist nowhere in the theme repo — QA had measured the
legacy site, not the Shopify build, so all six reported failures were invalid. That verdict was
not reachable from the ticket text.
