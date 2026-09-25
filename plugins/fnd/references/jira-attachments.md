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
private `0600` config file that is deleted when the process exits, never on the argv. Writing that
file is a precondition, not a detail: a temp dir that refuses the `0600` stamp or the write (a
`TMPDIR` on a filesystem with no mode bits, a read-only mount) is `error=curl_config_unwritable`,
exit 2, before the first request — the credential is never demoted onto a command line to get the
run through. The writer is shared with `figma-rest.sh` (`curl_config_write` in
`_shopify-common.sh`), so both refuse the same way.

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
    [--max-video-mb <N>] [--force] [--no-frames] [--keep-video] [--frames <N>]
    [--env <dotenv>] [--site <host>] [--cloud-id <uuid>] [--json]
<plugin root>/scripts/jira-attachments.sh --check [--env <dotenv>] [--site <host>] [--cloud-id <uuid>]
```

| flag | default | what it does |
|---|---|---|
| `--out <dir>` | `.claude/tasks/<KEY>/tmp/attachments` | download dir; must be a path git ignores (below) |
| `--ids <id,id>` | all | only these attachment ids |
| `--all` | off | lift the `image/*` + `video/*` filter (PDFs, zips, …) |
| `--max-mb <N>` | `25` | per-file size cap for images (and whatever `--all` lets through); over it the row is `skipped_size` |
| `--max-video-mb <N>` | `200` | the same cap for **videos** — their bytes are transient, so the ceiling is higher |
| `--force` | off | re-download and re-cut even when the file, or the frames dir, is already there |
| `--frames <N>` | adaptive | pin a fixed frame count, **1…99**, switching the adaptive rule off (below); beyond 99 → exit 2 `error=invalid_frames` |
| `--no-frames` | off | download the video and **keep** it, don't cut — implies `--keep-video` |
| `--keep-video` | off | keep the video file next to its frames dir (rare — by default it is deleted) |
| `--env <dotenv>` | `./.env` | where `JIRA_EMAIL` / `JIRA_API_TOKEN` / `JIRA_SITE` are read from |
| `--site <host>` / `--cloud-id <uuid>` | `$JIRA_SITE`, else `meetdomaine.atlassian.net` | the host the cloudId is looked up on / the cloud **UUID** itself, which skips that lookup — a site host passed to `--cloud-id` is `error=invalid_cloud_id` |
| `--json` | TSV | the same rows as a JSON array — what the reader consumes |
| `--check` | — | probe the credentials only |
| `--help` / `-h` | — | print the call shapes above and exit 0 — the script's own copy, answered before the credentials, and matched anywhere in the args (so a flag VALUE of `-h` reads as a usage question too) |

stdout is one row per attachment, header first:
`id  status  kind  mime  size  created  author  path  frames  filename` — `status` is
`saved` / `cached` / `skipped_type` / `skipped_size` / `skipped_no_ffmpeg` / `failed`, `kind` is
`image` / `video` / `other`, `path` is empty unless the file is on disk, `frames` is
`<framesdir>:<count>` or empty.
`--check` prints `ok=1 jira_user=<name> cloud_id=<uuid> ffmpeg=<yes|no>` instead.

**`--json`** emits those same rows as a JSON array — one object per attachment, the same ten field
names — with **one** difference: `frames` is a **list of frame file paths** (`[]` when there are
none), where the TSV column packs the same thing as `<framesdir>:<count>`. A consumer wanting that
string derives it: the dir is the first path's directory, the count is the list's length.

**A video is transient** (→ Frames): on a default run its row is `saved` or `cached` with `kind`
`video`, **`path` empty** and `frames` `<framesdir>:<count>` — the bytes were deleted once the
frames existed, and the frames dir is what the caller reads: it lists that dir and `Read`s the
`<NN>-<MM>m<SS>s.png` files inside it that the task needs, never all of them by default. Only
`--keep-video` / `--no-frames` put a path in a video row.

stderr carries notes, and always ends with the summary
`ok=1 saved=N cached=N skipped=N failed=N frames=N out=<dir>` (`skipped=` counts every
`skipped_*` status, including `skipped_no_ffmpeg`):

| note | what it says |
|---|---|
| `note=download_failed id=… http=…` | that attachment's content request failed; the other rows are unaffected |
| `note=frames_failed id=…` | ffmpeg exited non-zero, or produced zero frames (→ Frames) |
| `note=ffmpeg_not_found videos=<N>` | N videos were **not downloaded**: nothing on this machine could cut them into frames |
| `note=ffmpeg_not_found_unframed videos=<N>` | `--keep-video` / `--no-frames` with no ffmpeg — those N videos **were** downloaded and kept, merely not cut, which is why they are not in the count above |
| `note=duration_unknown id=… assumed=60s` | neither ffprobe nor `ffmpeg -i` could say how long the recording is (or said something impossible), so 60 s was assumed |
| `note=frames_short id=… want=<N> got=<n>` | fewer frames landed than planned — usually a duration longer than the recording itself |
| `note=invalid_attachment_id id=…` | an id that is not `[A-Za-z0-9_-]` is skipped: it would ride both a URL path and the filename |

| exit | meaning | typical `error=` |
|---|---|---|
| 0 | every wanted attachment landed — images on disk, videos as frames | — |
| 1 | at least one attachment failed — a download, or a frame cut; the rest landed | rows say `failed` |
| 2 | usage or precondition | `invalid_issue_key`, `curl_not_found`, `jq_not_found`, `cloud_id_lookup_failed`, `curl_config_unwritable`, `out_dir_not_ignored`, `out_dir_not_in_repo` |
| 3 | credentials | `no_jira_credentials` (+ the setup `hint=`), `invalid_jira_credentials` |
| 4 | the API rejected the request | `jira_auth_rejected http=401` (+ hint), `issue_not_found` |
| 5 | curl transport failure | `curl_transport_failed` |

Runs are **idempotent**, by two rules. An image — and a **kept** video — is `cached` when the
file already on disk has the size the metadata reports: no request, and size equality also catches
a run truncated halfway — and a kept video at that size is never re-fetched merely because its
frames are stale or missing, since those bytes are the bytes the request would return: only the cut
is redone, off the file on disk, and the row still says `cached`. A **transient** video is `cached` when `<target>.frames/done` exists and
records a `size=<bytes>` line equal to the metadata size: no request and no cut, the video itself
having been deleted on the first run. A `done` marker carrying no size line was written by an older
version of the script — it is treated as stale, and the video is re-downloaded and re-cut.
`--force` redoes any of it.

**A failed download never deletes frames that are current.** A re-fetch happens for three reasons —
`--force`, a stale marker, or a `--keep-video` file that went missing — and only the middle one says
the frames are out of date. So when the request fails, the `<target>.part` goes and a frames dir
**this run judged stale** goes with it, while a dir whose marker still matches the metadata size
stays: a transient video's bytes were deleted on purpose, those frames are the only copy of the
recording, and the row saying `failed` is not a reason to destroy them. The next plain run reports
them `cached` again. (A cache hit also reaps the `<target>.part` an interrupted run left behind —
otherwise nothing ever would, since every later run takes that same branch.)

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

## Frames — the recording becomes PNGs, the video is thrown away

A `.mov` cannot be looked at; only its frames can, and a screen recording is tens of megabytes of
bytes nobody will ever open. So a video is **transient**: downloaded to `<target>.part`, cut into
PNGs in `<target>.frames/`, and on a successful cut the video bytes are **deleted**. The frames dir
is the artefact — row `saved` / `cached`, `path` empty, `frames` `<dir>:<n>`. `Read` cannot open a
directory, so the caller **lists** that dir and `Read`s the `<NN>-<MM>m<SS>s.png` files inside it
the task needs — never all of them by default.

`--keep-video` keeps the original next to the frames (`path` then names it); `--no-frames` means
"download the video and keep it, don't cut" and implies `--keep-video`. Both are rare: ask for them
when the file itself is the point.

**A failed cut keeps nothing.** ffmpeg exiting non-zero, or producing zero frames, removes the
frames dir and drops the video with it: `note=frames_failed id=<id>` on stderr, row `failed`, `path`
and `frames` empty. Under `--keep-video` the video survives that failure — it is what the flag asked
for — and the row is `saved` with an empty `frames`.

**No ffmpeg on PATH → videos are not downloaded at all.** There is nothing to cut them with, and the
bytes would only be deleted again, so the content request is never made: row `skipped_no_ffmpeg`,
`path` and `frames` empty, one `note=ffmpeg_not_found videos=<N>` line on stderr, exit unaffected.
Images are untouched and `--check` still prints `ffmpeg=yes|no`. The exception is `--no-frames` /
`--keep-video`: there the developer asked for the file, so it is downloaded and kept with no ffmpeg
anywhere. ffmpeg is an optional backend — `brew install ffmpeg`.

**How many frames.** `ffprobe` supplies the duration; with no ffprobe the script parses
`Duration: HH:MM:SS.xx` out of `ffmpeg -i <file>` stderr — the **container's** own line, anchored,
never a `title` tag reading `Duration: 99:00:00.00` inside the Metadata block ffmpeg prints above it
(an attachment is somebody else's file) — and a duration above 24 h is refused as a misread. Only
when nothing can answer does it assume 60 s, out loud (`note=duration_unknown`): an assumed duration
must never quietly buy fewer frames than intended. The count is adaptive,
`N = clamp(ceil(duration / 4), 8, 24)`:

| recording | frames |
|---|---|
| ≤ 32 s | 8 — the floor |
| 32–96 s | one per 4 s, rounded up |
| ≥ 96 s | 24 — the ceiling |

`--frames <N>` pins a fixed count, **1…99**, and switches the adaptive rule off; a larger number is
refused (exit 2, `error=invalid_frames value=<N>`) because the ordinal below is two digits — a
100th frame would sort ahead of the 99th in the dir listing.

**Where they are sampled.** At bin **centres**: `t_i = (i + 0.5) × duration / N`, `i = 0…N-1`, one
ffmpeg invocation per frame with input seeking (`-ss <t>` ahead of `-i`, `-frames:v 1`). A grid
starting at 0 never samples the last `1/N` of a recording — which is usually where the thing QA was
recording finally happens.

**What they look like.** PNG, `scale='min(1440,iw)':-2` — width capped at 1440 px, never upscaled,
even height, aspect preserved, no cropping. Names carry the ordinal and the timecode,
`<NN>-<MM>m<SS>s.png` (`05-00m20s.png`): they sort in order and each one says where in the recording
it came from. Beside them sits the `done` marker with its `size=<bytes>` line — the cache rule
above.

## Linked screenshots — prnt.sc, imgur, Gyazo, CleanShot, snipboard

QA often pastes a screenshot as a **link** instead of attaching it: `https://prnt.sc/<id>`
(Lightshot) is the common one, rendered by Jira as an `inlineCard` smart-link, and the ticket's
`attachment` field stays `[]`. `jira-attachments.sh` has no row to fetch, so a sibling script
resolves such pages to their image and downloads it into the same directory — no credential is
involved, these are public pages:

```bash
<plugin root>/scripts/external-screenshots.sh --out <dir> [--max-mb <N>] [--max-width <px>] [--delay <s>] [--force] [--json] <url> [<url> …]
<plugin root>/scripts/external-screenshots.sh --hosts
```

| flag | default | what it does |
|---|---|---|
| `--out <dir>` | — (required) | download dir; the same git-ignore gate as above |
| `--max-mb <N>` | `25` | per-image size cap, re-checked on disk after the download |
| `--max-width <px>` | `1600` | a PNG / JPEG wider than this is resampled **in place** to that width (never upscaled) — ffmpeg when on PATH, else macOS `sips`, else it is left as downloaded with `note=downscale_skipped`; `0` keeps every original. GIF / WebP / SVG are never resampled |
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
- the answer carries an `image/*` content type (`failed`, `note=not_an_image` otherwise — a
  bot-challenge page served as 200 is refused here), and its bytes fit `--max-mb`.

Every request carries a **browser User-Agent**: prnt.sc answers curl's default agent with a
bot-challenge page (HTTP 520, `text/plain`, no `og:image` — measured 2026-09-25) and a browser
one with the real page. prnt.sc answers an **unknown id** with a 200 page whose `og:image` is a
protocol-relative placeholder (`//st.prntscr.com/…`): that is `failed`, `note=image_url_not_https`
with the value, i.e. "no such screenshot".

stdout is one row per URL in argv order, header first:
`url  host  status  image_url  mime  size  path  filename` — `status` is `saved` / `cached` /
`skipped_host` / `failed`; `image_url` is what was actually fetched (the `og:image`, or the URL
itself on a direct host), empty for a skipped row; `path` is the file on disk, empty unless
saved / cached; `size` is its bytes on disk, after the downscale. The file is
`<host>-<slug>.<ext>` — `prnt.sc-XlDYChfQ0Wyw.png` — the slug being the URL's path with everything
but `[A-Za-z0-9._-]` folded to `_`, so a page URL can never name a path outside the out dir; the
extension comes from the content type. A URL whose `<host>-<slug>.*` file is already on disk is
`cached` — no request.

stderr carries notes, then always the summary `ok=1 saved=N cached=N skipped=N failed=N out=<dir>`:

| note | what it says |
|---|---|
| `note=page_fetch_failed url=… http=…` | the page itself did not come back 2xx (a 404, a 520 challenge) |
| `note=no_og_image url=…` | the page carries no `og:image` tag — a bot-challenge page in most cases |
| `note=image_url_not_https url=… image=…` | the `og:image` is not an `https://` URL — prnt.sc's "unknown id" placeholder |
| `note=image_host_not_allowed url=… host=…` | the `og:image` points outside the service's CDNs; nothing was fetched from it |
| `note=image_fetch_failed url=… http=…` | the image request did not come back 2xx |
| `note=not_an_image url=… type=…` | a 2xx that is not `image/*`; the bytes were discarded |
| `note=over_cap url=… size=… max_mb=…` | over `--max-mb` on disk; the bytes were discarded |
| `note=downscale_skipped path=…` / `note=downscale_tool_not_found images=<N>` | neither ffmpeg nor `sips` is on PATH — the originals were kept at full size |

| exit | meaning |
|---|---|
| 0 | every allow-listed URL landed (a `skipped_host` row is never a failure) |
| 1 | at least one allow-listed URL failed — the rows and notes name them |
| 2 | usage or precondition: `missing_out`, `missing_url`, `unknown_arg`, `invalid_delay`, `curl_not_found`, `jq_not_found`, `out_dir_not_ignored`, `out_dir_not_in_repo` |

The reader (`agents/jira-reader.md`) runs it once with every allow-listed URL it found in the
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
once and goes on. Same for `note=ffmpeg_not_found` (screen recordings not downloaded — nothing on
this machine can cut them into frames) and for a single failed download (the other rows are still
saved). Nothing here is ever routed through
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
