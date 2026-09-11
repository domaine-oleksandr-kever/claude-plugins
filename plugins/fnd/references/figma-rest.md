# Figma REST fallback — the source ladder, the token, the compactor

Single home for the third rung of `figma-reader`'s source ladder: the credential `figma-rest.sh`
needs, what the script does with it, what the compactor makes of the payload, and what a design
read looks like when neither Figma MCP answers. **Plugin root** = the plugin's own directory, this
file being `<plugin root>/references/figma-rest.md`; every `<plugin root>/…` path below resolves
the same way.
On Claude Code use the session context's `fnd plugin root:` path — `${CLAUDE_PLUGIN_ROOT}` is empty
in the Bash tool's shell.

## The ladder

`figma-reader` picks its source itself, in one fixed order, and reports which rung answered as
`source:`:

| rung | source | taken when |
|---|---|---|
| 1 | `mcp-connector` | the remote/connector Figma server's tools (`mcp__figma__…`) are listed — URL-driven, no desktop app |
| 2 | `mcp-desktop` | the local `figma-dev-mode` bridge is listed **and** its first call succeeds — it needs the Figma desktop app running with the page loaded |
| 3 | `rest` | no Figma MCP tool is available at all, or a rung-1/2 call failed the way a closed app fails: connection refused, "node not found", "page not loaded" |
| — | `""` | nothing answered — one `hint=` / `error=` line in `needs_clarification`, nothing else |

Under `policy=mcp` with neither Figma MCP answering the ladder simply ends: the reader's
`needs_clarification` says the policy forbids the token path and names `FND_FIGMA_SOURCE` as the
switch that would allow it — one line, `source:` empty, and **no** script run, since the REST rung
was never permitted to begin with.

The spec the reader returns and saves is the **same** whichever rung ran; only `source:` differs
(plus the tokens line, when this plan has no Variables API — below). `FND_FIGMA_SOURCE` forces a
rung: `mcp` forbids the token path, `rest` skips the MCP rungs for a developer who knows the app is
closed, `auto` (default) walks the ladder. It is a **global-only** switch — the shell or
`~/.config/domaine/env`, never a repo's `.claude/domaine.env` — and `figma-rest.sh --policy`
reports the value it resolved to.

## Why a script at all

A Figma MCP is not always there: the connector is attached per user/project, and the local Dev Mode
bridge only sees pages loaded in the **desktop app** — with the app closed, or the page merely not
open in it, every call fails. The REST API answers from anywhere with a personal access token, and
that token already lives in the repo's gitignored `.env` on the projects that use it.

It is a script rather than a fetch tool for two reasons. The credential must never reach the model
or an argv — it rides a private `0600` curl config, exactly as `jira-attachments.sh` does
(`<plugin root>/references/jira-attachments.md`). And the payloads are enormous: one frame's node
tree is 230–280 KB, a page is ~1 MB, `variables/local` is ~650 KB. They land on disk and a
dependency-free compactor turns them into a build tree of a few KB — no REST JSON is ever pasted
into a spec, and the reader never `Read`s the raw files.

## Create the token — read-only, scoped

At <https://www.figma.com/settings> → **Security** → **Personal access tokens** → generate a new
token. Scopes:

| scope | why |
|---|---|
| **File content: read-only** | the node tree and the PNG render — the one that matters |
| **Variables: read-only** | design tokens by name; honoured on **Enterprise** plans only, harmless elsewhere |
| **Current user: read-only** | `--check`, the preflight probe |

Pick an expiry you are willing to renew; the script's refusal names the way back when it lapses.
Then put the value in the repo's **gitignored** `.env` — the same file the Shopify runners and the
Jira attachment fetcher read their credentials from:

```
FIGMA_TOKEN=<the token>
```

Process environment wins over the file, so `FIGMA_TOKEN=… figma-rest.sh …` overrides it for one
run, and `--env <dotenv>` names a different file (default `./.env`).

**Nobody reads that file but the script.** Skills and agents call the script; they never `Read`
`.env`, and the script never prints or echoes the value — it hands it to curl through a private
`0600` config file deleted when the process exits, never on the argv. A value carrying a quote,
whitespace or a control character is refused (`error=invalid_figma_token`) rather than sent.

## One host, and one token-less hop

Every authenticated request goes to `https://api.figma.com` with the header `X-Figma-Token` from
that config: `/v1/files/<key>/nodes`, `/v1/files/<key>/variables/local`, `/v1/images/<key>`,
`/v1/files/<key>?depth=1` (the `--probe` version check) and `/v1/me`. curl runs with `--proto =https --proto-redir =https` and no `-L` on those calls.

`/v1/images` does not return pixels — it returns a **pre-signed S3 URL**. That download is a
**separate** curl call **without** the token config, so the credential never leaves `api.figma.com`.
The URL carries its own signature and expires on its own; it is not a secret worth keeping and the
script does not.

## The script

```bash
<plugin root>/scripts/figma-rest.sh <figma-url | --file <key> --node <id>> [--out <dir>]
    [--env <dotenv>] [--scale <N>] [--no-variables] [--no-image] [--force] [--json]
<plugin root>/scripts/figma-rest.sh --check [--env <dotenv>]
<plugin root>/scripts/figma-rest.sh --policy [--env <dotenv>]
<plugin root>/scripts/figma-rest.sh --probe <figma-url | --file <key>> [--env <dotenv>]
```

| flag | default | what it does |
|---|---|---|
| `<figma-url>` | — | the design link; the file key is the segment after `/design/`, `/file/`, `/proto/` or `/board/`, the node id is the `node-id` query param with `-` read back as `:` (`node-id=123-456` ⇒ `123:456`). A URL with no `node-id` is `error=missing_node_id`: whole-file reads are out of scope |
| `--file <key> --node <id>` | — | the explicit form, for a key/node already in hand. Passing it **together with** a URL is a usage error |
| `--out <dir>` | `.claude/tasks/_figma/tmp` | where the payloads land; must be a path git ignores (below). The reader passes `<workspace>/tmp/figma` |
| `--env <dotenv>` | `./.env` | where `FIGMA_TOKEN` is read from when the process env does not carry it |
| `--scale <N>` | `2` | the PNG render scale, `0 < N <= 4`; anything else is `error=invalid_scale` |
| `--no-variables` | off | skip `/variables/local` — that row comes back `skipped` |
| `--no-image` | off | skip the render — that row comes back `skipped` |
| `--force` | off | re-fetch even when the files are already on disk |
| `--json` | key=value lines | the same facts as one JSON object |
| `--check` | — | probe the credential only: `GET /v1/me`. Takes no target |
| `--policy` | — | print the resolved source policy; no network, no out-dir gate. Takes no target |
| `--probe` | — | **the freshness probe**: ask Figma when the FILE last changed (`GET /v1/files/<key>?depth=1`) and print `ok=1 file_key=… [node_id=…] last_modified=…`. Nothing is written, no out-dir gate, and the link's `node-id` is optional |

**Mode precedence.** The three mode flags are three different questions, and the gate runs right
after parsing — before the credential, before the target, before anything is fetched:

1. any **two** mode flags together (`--check --policy`, `--check --probe`, `--policy --probe`) is
   `error=conflicting_mode`, exit 2 — checked **first**, so `--check --policy <url>` names the mode
   clash, not the target one;
2. `--check` and `--policy` take **no target**: a URL, or `--file` / `--node`, alongside either is
   `error=conflicting_target`, exit 2 — the same error a URL and `--file/--node` together already
   give. `--probe` **does** take a target (the file key is its question), and its `node-id` is
   optional.

Neither is silently ignored: a flag swallowed by another mode answers a question the caller did not
ask, and nothing in the output would say so.

Both halves of the target are validated **before** anything is built from them: the file key as
`[A-Za-z0-9]+`, the node id as `[0-9]+:[0-9]+` or an instance id
`I[0-9]+:[0-9]+(;[0-9]+:[0-9]+)+`. Anything else is `error=invalid_file_key` /
`error=invalid_node_id`, exit 2, before the first request — neither value can become a path segment
or a URL trick.

stdout is one `key=value` line per artifact, then one meta line:

```
kind=nodes status=saved|cached path=<abs> bytes=<n>
kind=variables status=saved|cached|unavailable|failed|skipped path=<abs or empty> bytes=<n or 0>
kind=image status=saved|cached|unavailable|failed|skipped path=<abs or empty> bytes=<n or 0>
kind=meta file_key=<key> node_id=<id> last_modified=<ts> name=<node name>
```

`name=` comes **last** on the meta line and is the only field that may carry spaces — a frame named
`Hero last_modified=2020` in front of the other fields would shadow them for anything that splits
on whitespace. Everything before it is a fixed `key=value` grammar; the name is the rest of the
line.

`--json` prints the same thing as one object —
`{file_key, node_id, name, last_modified, nodes:{status,path,bytes}, variables:{…}, image:{…}}`.
`--check` prints `ok=1 figma_user=<handle> token_source=env|file` instead; `--probe` prints
`ok=1 file_key=<key> [node_id=<id>] last_modified=<ts>` and nothing else; `--policy` prints
`policy=auto|mcp|rest token=present|missing|invalid token_source=env|file|none` and nothing else (an
unrecognised `FND_FIGMA_SOURCE` value falls back to `auto` with `note=invalid_figma_source` on
stderr). `token=invalid` means a value **is** there and no Figma token looks like it — it carries
whitespace, a quote or a control character — so `token_source=` names the file to repair;
`token=missing` means there is nothing to repair yet. Both still exit 0: `--policy` reports the
rung, it never refuses. Neither mode ever prints the token.

stderr carries `note=` lines and always ends with the summary
`ok=1 saved=N cached=N unavailable=N failed=N out=<abs dir>`:

| note | what it says |
|---|---|
| `note=variables_unavailable http=403` | this Figma plan has no Variables API (it is an Enterprise feature). **Not an error** — the row is `unavailable`, the exit code is unaffected, and the compactor falls back to the node's own `styles` map and raw values |
| `note=variables_failed http=<code>` | the variables request failed for another reason — row `failed`, exit 1 at the end |
| `note=image_unavailable` | Figma returned a `null` render URL for the node — row `unavailable` |
| `note=image_failed http=<code>` | the pre-signed download failed — row `failed`, exit 1 at the end |
| `note=rate_limited_retry after=<n>s` | a 429; the one retry is waiting out `Retry-After`, clamped into 1–60 s — `<n>` is the wait actually taken, and 5 s when the response carried no header |
| `note=invalid_figma_source value=<v>` | `FND_FIGMA_SOURCE` holds something that is not `auto`/`mcp`/`rest`; `auto` is used (`--policy` only) |

| exit | meaning | typical `error=` |
|---|---|---|
| 0 | the node tree landed (and every artifact that was asked for and available) | — |
| 1 | an **optional** artifact failed — variables (non-403) or the image download; the tree is complete | rows say `failed` |
| 2 | usage or precondition | `invalid_file_key`, `invalid_node_id`, `missing_node_id`, `missing_file_key`, `conflicting_target`, `conflicting_mode`, `invalid_scale`, `unknown_arg`, `unexpected_arg`, `missing_value`, `curl_not_found`, `jq_not_found`, `curl_config_unwritable`, `common_lib_not_found`, `out_dir_not_in_repo`, `out_dir_not_ignored`, `out_dir_not_writable` |
| 3 | credentials | `no_figma_token` (+ the setup `hint=`), `invalid_figma_token` |
| 4 | the API rejected the request | `token_rejected` (+ hint; 401 and 403 both), `node_not_found`, `file_not_found` (`--probe`), `rate_limited`, `figma_request_failed http=<code>` |
| 5 | curl transport failure | `curl_transport_failed` |

A **404**, and a `200` whose `nodes.<id>` is null or absent, are both `node_not_found`: Figma
answers 200 with a null node for an id that does not exist in that file. A **429** is retried
**once**, honouring `Retry-After` clamped into 1–60 s (`Retry-After: 0` means "retry now", an hour
means "run this later, not now"); a second 429 on the node request is `error=rate_limited`, exit 4.

Runs are **idempotent**. A `<key>-<node>.nodes.json` already on disk that is non-empty valid JSON
carrying the node is `cached` — no request — and the same rule covers the variables file and a
non-empty PNG **at the requested scale** (the scale is part of the render's name, so `--scale 4`
is a cache miss against a 2× render rather than a silent hit). A `null` render URL removes the
render a previous run left, so a node Figma can no longer draw stops answering `cached` with
superseded bytes. `--force` re-fetches everything.

`variables/local` is the slow one — it serialises the file's whole variable library and takes about
a minute on a large one (66 s for 656 KB on a real read, against ~2 s for the node tree and ~4 s
for the render) — so it gets a `--max-time` of **300 s** where every other call gets 120, and it is
cached per **file key**: every later node in the same file reuses `<key>.variables.json` and pays
that wait exactly once.

On a cached run `last_modified` is the value the cached payload carries — the cache's own stamp,
**not** a version check: comparing it with itself can only ever say "unchanged". `--probe` is what
asks Figma, and `figma-reader` stores the stamp it fetched in the spec's frontmatter so there is a
baseline to compare with (`<plugin root>/references/task-workspace-freshness.md`).

Every download stages through a **per-process** sibling of its final name and is renamed into place:
`figma-reader` runs one per Figma URL in parallel, and two frames of the same file share both the
out dir and the file key, so a fixed staging name would have two curls writing one file. A staging
rename that loses a race degrades that row to `failed` — it never takes the run down.

## Where the bytes land — git must ignore it

The gate is the one `jira-attachments.sh` uses, character for character: the out dir must be
git-ignored in the repository that **physically holds** it. Under `.claude/tasks/` the script
stamps the `info/exclude` line `<plugin root>/references/task-workspace.md` prescribes and
proceeds; any other unignored directory is `error=out_dir_not_ignored`, exit 2, with nothing
created and no request made; a dir that resolves outside every git repository is
`error=out_dir_not_in_repo`. A `git worktree` checkout whose `.claude/tasks` is a symlink into the
main checkout resolves to that main checkout and is asked there — `git check-ignore` cannot look
past a symbolic link at all. The reason is the same as for attachments: fetched payloads must never
reach a commit.

Filenames are `<key>-<node>.nodes.json`, `<key>.variables.json` and `<key>-<node>@<scale>x.png`
(`<key>-1-2@2x.png` at the default scale), with the node id's `:` written as `-` and `;` as `_` so
the names are portable.

## The compactor

```bash
node <plugin root>/scripts/figma-node-slim.cjs <nodes.json> [--variables <variables.json>]
    [--out <file.md>] [--stats] [--max-text <N>] [--file-key <key>]
```

Dependency-free Node. It turns the REST node response into a markdown **build tree** — one line per
node, hierarchy by indentation — that is **lossless for build-relevant data**:

- `[TYPE] "name" #<id> WxH @x,y` plus, when present: auto-layout (direction, gap, padding,
  primary/counter alignment, wrap), per-axis sizing (`hug|fill|fixed`), fills and strokes
  (`#RRGGBB` + opacity, image-fill ref, and a gradient as its **direction and stops** —
  `linear-gradient(to right 0,0→1,0, #FF0000@0% → #0000FF@100%)`, the angle in degrees when the
  axis is not cardinal, centre and axes for the radial/angular/diamond types), stroke weight —
  **per side** as `t/r/b/l px` when the node carries individual weights, so a bottom-only divider
  never reads as a box — and alignment, corner radius, effects (shadow offset / blur / colour),
  constraints, opacity, non-normal blend mode, `clipsContent`, min/max sizes.
- TEXT nodes carry their `characters` (truncated at `--max-text`, default 200, with the full length
  noted) plus family / style / weight / size / line-height / letter-spacing / case / decoration /
  alignment and, when the run carries one, its link destination (`link:<url>`, or
  `link:node <id>` for a prototype jump) — a link renders as nothing, so the PNG cannot recover it.
  The text style's name comes from the node's `styles` map when it points at one.
- A **bound value** is printed once, as `$Collection/Group/Name (<node value>)`. The `$` marks the
  binding, the `--variables` file supplies only the NAME, and the value in the parentheses is the
  **node's own** — what a build ships. When that file also resolves a default-mode value and it
  **differs**, the line carries the discrepancy as `$Name (<node value>; var default <v>)` instead of
  silently picking a side; when the alias chain leaves the file — the norm when every variable is a
  library variable — the name alone stands, and with no name at all the label is `$var:<short id>`
  (the id's tail, never the 40-character library hash). A bound field with no raw counterpart on the
  node falls back to the variables file's value. With no variables file the header says
  `tokens: raw values (Variables API unavailable on this plan)` and bindings still show, as
  `$var:<short id> (<node value>)`.
- `[INSTANCE of "<component>"]` names the main component from the response's `components` map and
  carries its `componentProperties` as `props:{…}` — a SLOT property's value being the id of the node
  that fills it, or `empty` when nothing does — with the map silent on that id the line is
  `[INSTANCE]` plus a `component:<id>` attribute; either way the instance's children are still
  walked, because they carry the measurements. The REST `overrides` array beside those properties is
  **not** rendered: it lists which fields each descendant overrode, never the values, and every
  descendant is walked and printed with its actual values anyway.
- One node is one **primary line**. A `props:{…}` longer than ~120 characters moves to its own
  indented continuation line under that node — the shape the mixed-run style table already uses — so
  a variant-heavy instance does not push the measurements off the end of the line. Nothing else is
  wrapped: no line is cut at a hard limit.
- `visible:false` subtrees are dropped and counted; consecutive siblings whose subtrees are
  identical apart from text and image refs fold to one exemplar tagged `×N` that lists the folded
  ids and each one's differing text. Structure, size, layout or style differing ⇒ **no fold** —
  and "style" includes the gradient's direction, the per-side border and the link, all of which are
  part of the line the fold compares.
  Every visible node id in the input is either on a line of its own or inside a fold's id list.
- The header block states file key, node id, name, `lastModified`, node count, hidden-dropped and
  folded counts, bytes before → after, and the tokens line above — followed by a legend for the
  line grammar and a `type styles` table the TEXT lines reference as `T<n>`, so one typography set
  is spelled once.

`--out <file.md>` writes the tree there and prints `saved=<path> bytes=<n>` — the directory must
already exist, the script creates nothing outside that one file; without `--out` the markdown goes
to stdout. `--file-key <key>` supplies the header's file key when the input is not named
`<key>-<node>.nodes.json`. Vector geometry, render bounds, export settings, the instance `overrides`
array and the other non-buildable fields are dropped by design (the PNG beside the payload is the
visual ground truth). `--stats` adds
`figma-node-slim: <in> B → <out> B (-NN.N%) nodes=N hidden=N folded=N` on stderr. Input that is not
JSON, or not this shape, exits 2 with an `error=` line — never a stack trace.

## Degradation — a missing token never fails a design read

With no credential the script exits 3 with `error=no_figma_token` and one `hint=` line naming the
token page, the three scopes, the `.env` key and this file. **Nothing is requested** — the refusal
happens before the first network call.

`figma-reader` carries that line into `needs_clarification` verbatim, once, with `source:` empty,
and stops: it does not guess measurements. Everything upstream of the design read is unaffected —
the calling skill still has the ticket, the AC and the codebase, and asks the developer for the
one missing thing. The same one-line treatment covers a REST failure that *did* have a token and
left no tree (exit **4 / 5**): the script's `error=` line, once.

Exit **1** is not one of those. It means the node tree landed and an *optional* artifact did not:
there is no `error=` line to quote — only `note=variables_failed` / `note=image_failed` — so the
reader proceeds from the tree it has, with `source: rest`, and notes the gap. The two partial
degradations that exit 0 never reach `needs_clarification` either: a 403 on variables (no Variables
API on this plan) is a tokens-line difference in the tree, and a `null` image URL costs the visual
cross-check, which the spec notes rather than fails on.

Under `policy=mcp` the script is never run at all, so there is no line to quote: with neither Figma
MCP answering, `figma-reader` returns one `needs_clarification` line of its own saying the policy
forbids the token path and naming `FND_FIGMA_SOURCE` as the switch that would open it — `source:`
empty, nothing fetched, nothing guessed.

The `preflight-checks` skill probes the credential with `--check`, so a stale or absent token is
usually reported before any design is read.

## What this token cannot do

A read-only scope set means every write verb comes back **403**: no design edit, no comment, no
Code Connect mapping. It also sees only the files that person can already open in Figma — it grants
no project access of its own. Editing Figma is not something this plugin does on any rung.
