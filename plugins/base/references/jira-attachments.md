# Jira attachments — the read-only token, the script, the degradation

Single home for the credential setup `jira-attachments.sh` needs, what the script does with it,
how the downloaded files reach the model (slim's `view` tool), and what a ticket read looks like
when the token is absent. **Plugin root** = the plugin's own directory, this file being
`<plugin root>/references/jira-attachments.md`; every `<plugin root>/…` path below resolves the
same way. Use the session context's `base plugin root:` path — `${CLAUDE_PLUGIN_ROOT}` is empty in
the Bash tool's shell.

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

Then put the two values in the repo's **gitignored** `.env`:

```
JIRA_EMAIL=<your atlassian login>
JIRA_API_TOKEN=<the token>
```

Process environment wins over the file, so `JIRA_API_TOKEN=… jira-attachments.sh …` overrides it
for one run. `JIRA_SITE` is read the same way (default `meetdomaine.atlassian.net`).

**Nobody reads that file but the script.** Skills and agents call the script; they never `Read`
`.env`, and the script never prints or echoes either value — it hands them to curl through a
private `0600` config file that is deleted when the process exits, never on the argv. Writing that
file is a precondition, not a detail: a temp dir that refuses the `0600` stamp or the write (a
`TMPDIR` on a filesystem with no mode bits, a read-only mount) is `error=curl_config_unwritable`,
exit 2, before the first request — the credential is never demoted onto a command line to get the
run through. The writer is shared with `figma-rest.sh` (`curl_config_write` in
`<plugin root>/scripts/_common.sh`), so both refuse the same way.

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
<plugin root>/scripts/jira-attachments.sh <ISSUE-KEY> [--out <dir>] [--ids <id,id>] [--all] [--max-mb <N>]
    [--max-video-mb <N>] [--force] [--env <dotenv>] [--site <host>]
    [--cloud-id <uuid>] [--json]
<plugin root>/scripts/jira-attachments.sh --check [--env <dotenv>] [--site <host>] [--cloud-id <uuid>]
```

| flag | default | what it does |
|---|---|---|
| `--out <dir>` | `.claude/tasks/<KEY>/tmp/attachments` | download dir; must be a path git ignores (below) |
| `--ids <id,id>` | all | only these attachment ids |
| `--all` | off | lift the image / video / text filter (PDFs, zips, …) and the text cap |
| `--max-mb <N>` | `25` | per-file size cap for images (and whatever `--all` lets through); over it the row is `skipped_size` |
| — | 256 KB | the cap for **text** (`text/*`, `application/json`, `application/javascript`, a `.liquid` name under `application/octet-stream` or no mime); over it the row is `skipped_size` |
| `--max-video-mb <N>` | `200` | the same cap for **videos**, whose recordings run to tens of MB |
| `--force` | off | re-download even when the file is already there at the metadata size |
| `--env <dotenv>` | `./.env` | where `JIRA_EMAIL` / `JIRA_API_TOKEN` / `JIRA_SITE` are read from |
| `--site <host>` / `--cloud-id <uuid>` | `$JIRA_SITE`, else `meetdomaine.atlassian.net` | the host the cloudId is looked up on / the cloud **UUID** itself, which skips that lookup — a site host passed to `--cloud-id` is `error=invalid_cloud_id` |
| `--json` | TSV | the same rows as a JSON array — what the reader consumes |
| `--check` | — | probe the credentials only |
| `--help` / `-h` | — | print the call shapes above and exit 0 — the script's own copy, answered before the credentials, and matched anywhere in the args (so a flag VALUE of `-h` reads as a usage question too) |

stdout is one row per attachment, header first:
`id  status  kind  mime  size  created  author  path  filename` — `status` is
`saved` / `cached` / `skipped_type` (kind `other` without `--all`) / `skipped_size` (over the
kind's cap) / `failed`, `kind` is `image` / `video` / `text` / `other`, `path` is empty unless the
file is on disk. A `text` file keeps its name only when it ends in a text extension (`.json`,
`.js`, `.csv`, `.liquid`, `.md`, …); any other gains `.txt` (`405-run.sh.txt`) — it is read as
data, never run.
`--check` prints `ok=1 jira_user=<name> cloud_id=<uuid>` instead.

**`--json`** emits those same rows as a JSON array — one object per attachment, the same nine field
names.

A video is a file like an image: downloaded whole and kept, so slim's `view` tool can cut it into
frames (→ Frames and resizing). A text file needs no resize: the reader quotes it into `ticket.md`
as outside content (`base:jira-reader` → Fetch the attachments).

stderr carries notes, and always ends with the summary
`ok=1 saved=N cached=N skipped=N failed=N out=<dir>`:

| note | what it says |
|---|---|
| `note=download_failed id=… http=…` | that attachment's content request failed; the other rows are unaffected |
| `note=invalid_attachment_id id=…` | an id that is not `[A-Za-z0-9_-]` is skipped: it would ride both a URL path and the filename |
| `note=transport_retry curl_exit=… after=5s` | a request hit a transport blip (curl exit 6/7/28/35/52/56, or no HTTP status) and was sent once more; a retry that fails too ends retrying for the rest of the run |

| exit | meaning | typical `error=` |
|---|---|---|
| 0 | every wanted attachment landed | — |
| 1 | at least one download failed; the rest landed | rows say `failed` |
| 2 | usage or precondition | `invalid_issue_key`, `curl_not_found`, `jq_not_found`, `cloud_id_lookup_failed`, `curl_config_unwritable`, `out_dir_not_ignored`, `out_dir_not_in_repo` |
| 3 | credentials | `no_jira_credentials` (+ the setup `hint=`), `invalid_jira_credentials` |
| 4 | the API rejected the request | `jira_auth_rejected http=401` (+ hint), `issue_not_found` |
| 5 | curl transport failure | `curl_transport_failed` |

Runs are **idempotent**: a file already on disk with the size the metadata reports is `cached` — no
request — and size equality also catches a run truncated halfway. A cache hit reaps the
`<target>.part` an interrupted run left behind. `--force` re-downloads.

## Where the bytes land — git must ignore it

The script refuses an `--out` that git would track (`git check-ignore`): downloads must never
reach a commit, and the same gate is what keeps a ticket that says *"save it to ~/…"* inside a
repo's scratch. Under `.claude/tasks/` it stamps the `info/exclude` line
`<plugin root>/references/task-workspace.md` prescribes and proceeds; any other unignored
directory is `error=out_dir_not_ignored`, exit 2, nothing created and no issue or attachment
request made — with no `--cloud-id` the unauthenticated `_edge/tenant_info` lookup has already
run, since the gate sits after it.

**The question is put to the dir's physical location.** In a `git worktree` checkout
`.claude/tasks` is a **symlink** into the main checkout (the worktree setup points it there so one
workspace serves every worktree), and `git check-ignore` cannot look past a symbolic link at
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

## Frames and resizing — slim's `view`

The scripts only download. The model never looks at a downloaded file directly: the reader hands
each image and each video to slim, one call per file:

```text
mcp__slim__view({ path: "<workspace>/tmp/attachments/<file>" })
```

slim's media engine resizes an image to `<name>.1568.<ext>` (long edge at most 1568 px, metadata
stripped) and cuts a video into `<name>.frames/001.jpg …` (one frame every 2 seconds, at most 24,
each resized the same way), beside the input. The reply is one figure line,
`media: <in> B → <out> B (-NN%) frames=N`, then the output paths (frames with their timestamps).
Those output paths are what `ticket.md` and `comments.md` cite; the caller `Read`s the ones the task
needs, never all of them by default. The original stays on disk beside them.

slim uses `ffprobe` + `ffmpeg` when they are on PATH, else macOS `sips` for images only. With
neither (or a video with only `sips`) the answer is the one-line refusal
`media: no backend (install ffmpeg)`; the reader carries it into `attachments_note` verbatim and the
file stays downloaded, unresized. slim also asks the permission checks about the input and the
output path: an "ask" becomes one Yes/No question to the developer, and a no writes nothing and
answers `view: not confirmed — …`, carried the same way (an allow rule for `.claude/tasks/**`
skips the question; base's README → Install). Without slim loaded, base refuses `base:jira-reader`
outright.

## Linked screenshots — prnt.sc, imgur, Gyazo, CleanShot, snipboard

QA often pastes a screenshot as a **link** instead of attaching it: `https://prnt.sc/<id>`
(Lightshot) is the common one, rendered by Jira as an `inlineCard` smart-link, and the ticket's
`attachment` field stays `[]`. `jira-attachments.sh` has no row to fetch, so a sibling script
resolves such pages to their image and downloads it into the same directory — no credential is
involved, these are public pages:

```bash
<plugin root>/scripts/external-screenshots.sh --out <dir> [--max-mb <N>] [--delay <s>] [--force] [--json] <url> [<url> …]
<plugin root>/scripts/external-screenshots.sh --hosts
```

| flag | default | what it does |
|---|---|---|
| `--out <dir>` | — (required) | download dir; the same git-ignore gate as above |
| `--max-mb <N>` | `25` | per-image size cap, re-checked on disk after the download |
| `--delay <s>` | `1` | whole seconds between two requests — never before the first, none for a cached or skipped row |
| `--force` | off | re-download an image already on disk |
| `--json` | TSV | the same rows as a JSON array — what the reader consumes |
| `--hosts` | — | print the hosts the script fetches from, one per line, and exit 0 |
| `--help` / `-h` | — | the two call shapes above, exit 0 |

**The allow-list is the security boundary.** A URL is outside content — a ticket can carry any
link, and a fetcher that followed arbitrary ones would be an SSRF / exfiltration surface driven by
ticket text. So a URL is fetched only when **all** of these hold, and anything else is a
`skipped_host` row with **no request**:

- `https://` only — an `http://` link, even to an allow-listed host, is skipped;
- the host is **exactly** one of the **page hosts** `prnt.sc`, `prntscr.com`, `imgur.com`,
  `gyazo.com`, `share.cleanshot.com`, `snipboard.io` (the URL is an HTML page whose `og:image` is
  the screenshot) or the **direct hosts** `img.lightshot.app`, `i.imgur.com`, `i.gyazo.com` (the
  URL *is* the image) — no subdomain wildcards, so `prnt.sc.evil.example` is not `prnt.sc`;
- the `og:image` a page resolves to is itself `https://` on a host under `lightshot.app`,
  `prnt.sc`, `prntscr.com`, `imgur.com`, `gyazo.com`, `cleanshot.com`, `cleanshot.cloud` or
  `snipboard.io` — the service's own CDN, never an arbitrary host (`failed`,
  `note=image_host_not_allowed`);
- every redirect hop, page or image, lands on that same list over `https://` — curl follows no
  redirect on its own, so a hop elsewhere is refused before it is requested (`failed`,
  `note=image_host_not_allowed … via=redirect`), and five hops are the most taken;
- the bytes are an image: PNG, JPEG, GIF and WebP are told by their first bytes, whatever the
  content type says (`application/octet-stream` with PNG bytes is saved as a PNG); a format with
  no such check here (SVG …) needs an `image/*` content type. Anything else is `failed`,
  `note=not_an_image` — a bot-challenge page served as 200 is refused here — and the bytes must
  fit `--max-mb`.

Every request carries a **browser User-Agent**: prnt.sc answers curl's default agent with a
bot-challenge page (HTTP 520, `text/plain`, no `og:image` — measured 2026-09-25) and a browser
one with the real page. prnt.sc answers an **unknown id** with a 200 page whose `og:image` is a
protocol-relative placeholder (`//st.prntscr.com/…`): that is `failed`, `note=image_url_not_https`
with the value, i.e. "no such screenshot".

stdout is one row per URL in argv order, header first:
`url  host  status  image_url  mime  size  path  filename` — `status` is `saved` / `cached` /
`skipped_host` / `failed`; `image_url` is what was actually fetched (the `og:image`, or the URL
itself on a direct host), empty for a skipped row; `path` is the file on disk, empty unless
saved / cached; `size` is its bytes on disk. The image is kept as served; slim's `view` resizes it. The file is
`<host>-<slug>.<ext>` — `prnt.sc-XlDYChfQ0Wyw.png` — the slug being the URL's path with everything
but `[A-Za-z0-9._-]` folded to `_`, so a page URL can never name a path outside the out dir; the
extension comes from the format the bytes named, else the content type. A URL whose `<host>-<slug>.*` file is already on disk is
`cached` — no request.

stderr carries notes, then always the summary `ok=1 saved=N cached=N skipped=N failed=N out=<dir>`:

| note | what it says |
|---|---|
| `note=page_fetch_failed url=… http=…` | the page itself did not come back 2xx (a 404, a 520 challenge) |
| `note=no_og_image url=…` | the page carries no `og:image` tag — a bot-challenge page in most cases |
| `note=image_url_not_https url=… image=…` | the `og:image` is not an `https://` URL — prnt.sc's "unknown id" placeholder |
| `note=image_host_not_allowed url=… host=…` | the `og:image` points outside the service's CDNs; nothing was fetched from it |
| `note=image_host_not_allowed url=… host=… via=redirect` | the page or the image redirected outside those CDNs (or off `https://` — `host=` is then the hop's URL); the hop was not requested |
| `note=image_fetch_failed url=… http=…` | the image request did not come back 2xx |
| `note=not_an_image url=… type=…` | a 2xx whose bytes are not an image, `type=` as served; the bytes were discarded |
| `note=over_cap url=… size=… max_mb=…` | over `--max-mb` on disk; the bytes were discarded |

| exit | meaning |
|---|---|
| 0 | every allow-listed URL landed (a `skipped_host` row is never a failure) |
| 1 | at least one allow-listed URL failed — the rows and notes name them |
| 2 | usage or precondition: `missing_out`, `missing_url`, `unknown_arg`, `invalid_delay`, `curl_not_found`, `jq_not_found`, `out_dir_not_ignored`, `out_dir_not_in_repo` |

The reader (`base:jira-reader`) runs it once with every allow-listed URL it found in the
ticket's fields and comments, reports each row as an attachment whose `source` names the comment
and the link, and drops those URLs from `comment_links` / `other_links`. A screenshot that lives
only in a **Slack thread** ("see the screenshot in the source thread") is out of reach without a
Slack token — the reader names it in `attachments_note` and moves on.

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
once and goes on. Same for slim's `media: no backend (install ffmpeg)` refusal (the file is on disk,
unresized) and for a single failed download (the other rows are still saved). Nothing here is ever
routed through `needs_clarification`: a missing screenshot must not block a ticket read.

`jira-attachments.sh --check` probes the credential on its own, so a stale or absent token can be
found before any ticket is read.

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
overlays naming classes and fonts that exist nowhere in the repo — QA had measured the legacy
site, not the new build, so all six reported failures were invalid. That verdict was not reachable
from the ticket text.
