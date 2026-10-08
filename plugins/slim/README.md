# slim

## What it is

slim is a compression proxy for Claude Code. One `tool.call` handler sees every tool result — MCP,
Bash, Read, WebFetch, WebSearch, Grep, Glob and Agent — and shrinks the large ones before they reach
the context; a pasted prompt's data and an @-mentioned data file get the same treatment. It decides
by content, never by tool name: JSON goes to the JSON compressor, a log to the log engine, an HTML
page to the HTML engine, Figma design-context JSX to the JSX compactor, a Figma REST nodes response
to the node-tree engine, and plain text (code, diffs, test output) is at most windowed. Two tools
come with it: `lookup` answers one question about a page, a command's output or a file without
loading it whole, and `view` shows a big file or a command's output compactly (and resizes images
and video). Every original stays on disk behind a recovery handle, so nothing is lost.

slim is a Claude Code hooks module (mods) and nothing else: other hosts do not run it, and it never
runs as a classic hook. The hooks run wherever the plugin loads; the drawing (the ToolResult line,
the ToolGroup suffix and the toast) shows in the terminal and the desktop app.

Current release: **slim v0.4.0**.

## Install

```
/plugin marketplace add domaine-oleksandr-kever/claude-plugins
/plugin install slim@domaine
/reload-plugins
```

The prompt channel keeps pasted data in each project's `.claude/slim/` (see Pasted prompts); slim
writes a `.gitignore` holding `*` inside that folder, so git never stages it, and leaves the project's
own `.gitignore` alone.

## Channels

The module's intake (`plugins/slim/hooks/mods/intake.ts`) lets the tool run first. It then measures the
result with a pure byte check — no environment read, no spawn — and stops there for anything under
its channel's gate. A candidate goes to the core, `plugins/slim/scripts/slim.cjs`, as one JSON
envelope on stdin (channel, tool, tool_use_id, tool input, raw result, cwd, session id). The core
answers with one JSON object — the decision, the restored result, the stats figure and the report
record — and the module hands the model a fresh result object. Anything the module cannot read (a
failed spawn, a non-zero exit, bad output) leaves the original result untouched. Only the model's own
tool calls are compressed: a call another plugin makes through `$.tool.call` (lookup's own among
them) gets back the record it asked for.

The core puts the compressed text back into the tool's own result shape, because the engine
validates a hook's result against the built-in tool's output schema: Bash stays
`{stdout, stderr, …}`, Read keeps its file record, Grep and Glob keep their counts.

### Gates and engines

| Channel | Candidate when | What slim does |
|---|---|---|
| MCP (`mcp__*`) | result over 4,096 B, or the host's overflow notice | JSON engines, else spill-and-stub (below) |
| Bash | stdout over 4,096 B that is JSON, JSONL or (for a fetch command) HTML; over 16,384 B from a log command; over `SLIM_PLAIN_BYTES`; or any output the host saved to a file | stdout only; stderr and the other fields are kept |
| Read | a whole-file read of a `.log`, `.jsonl` or `.ndjson` file over 32,768 B, or of a `.json` data file the host cut at its token cap | the file view is compressed; see the Read rules below |
| WebFetch | result over 16,384 B that is JSON or HTML, or over `SLIM_PLAIN_BYTES` | JSON, JSONL and HTML engines, else a window |
| WebSearch | a result string over `SLIM_PLAIN_BYTES` | that string is windowed; the others are untouched |
| Grep, Glob | listing over 16,384 B | window with an 8,192 B budget; `numFiles`, `numLines` and `numMatches` never change |
| Agent | a completed subagent's text block over `SLIM_PLAIN_BYTES` | that block is windowed |
| @-mentioned file | over 32,768 B, the host's numbered lines of a data file | JSON, JSONL and log engines, as a Read; see below |
| Prompt (typed or bridge) | a prompt of 10,240 B or more holding a data span of 8,192 B or more | each span replaced in place; see below |
| View (`mcp__slim__view`) | every call | the tool's own answer is already compact; slim never compresses it again (see View) |

Calls a subagent makes go through the same handler; their events carry the agent type.

**Figma REST node trees.** A `GET /v1/files/:key/nodes` response (detected by its `nodes.<id>.document`
shape, before the generic JSON engine) becomes a markdown build tree: one line per visible node with
its measurements, layout, colours, typography and effects, and every TEXT value in full; hidden
subtrees and vector geometry dropped and counted; identical sibling runs folded with every folded id
and differing value listed. It is admitted wherever JSON is (Bash, Read, WebFetch); MCP results keep
the JSON engine. A tree still over the channel's egress cap goes the JSON route instead (fit, else
stub).

**Engine admission on Bash.** JSON and JSONL output is compressed whatever the command. HTML is
treated as a page only when the command fetches one: `curl`, `wget`, `http`, `https`, `xh` or `lynx`
as the command word of a pipeline segment (`cat src/http/page.html` is not a fetch). Otherwise it is
plain text, so theme source is never stripped. The log engine runs only
for a log source (a command naming a `.log` or `.jsonl` file, `journalctl`, `logs`); any other text
is plain text, so test runners and git output are never deduplicated as a log.

**Guard rails.** These pass through untouched, with their reason on the report line:

- code, diffs and test output — the detector checks for a diff, a test runner's summary (jest,
  mocha, go test, rspec, pytest, TAP), template markers (`{%`, `{{`, `<%`, `<?php`) and code lines
  BEFORE it looks for JSON lines, HTML or a log; such text is only ever windowed, and only above
  `SLIM_PLAIN_BYTES` (`plain-gate` below it);
- images, PDFs and other binary output (`not-text`, `binary`): detected by magic bytes;
- a Bash command that runs a compressor CLI (`slim.cjs`, `json-slim.cjs`, `log-slim.cjs`, … — `own-cli`);
- a Bash command or a Read that names a spill file or a host tool-results file (`spill-read`) —
  this is how the model follows a `<<full=` handle, so it must see the bytes as they are;
- a Read with `offset`, `limit` or `pages` (`windowed-read`), and every Read the rules below do
  not admit (`read-guard`);
- a result that already carries a slim mark, or the `fnd-mcp-slim` mark of the compressor slim's
  engines were ported from (`already-slim`).

**Why `SLIM_PLAIN_BYTES` defaults to 65,536 B.** That is about twice Bash's inline cap of 30,000
characters, so any output the host would show inline stays byte-identical. Only output the host has
already moved behind a 2 KB preview gets windowed, and the window keeps the tail, where a test
summary lives.

### The window

Plain text over its threshold keeps whole lines from the head (about a third of the budget) and
from the tail (the rest), with one marker line between them:

```
[slim: 2,871 of 3,000 lines hidden (241,388 B)]
```

A text of fewer than three lines, or one long line, gets a character window
(`[slim: <N> B hidden]`). Budgets: 4,096 B for a Bash output the host saved to a file, 8,192 B for
Grep and Glob, 12,288 B otherwise. MCP results are never windowed.

For a Bash output the host saved to a file, the model would otherwise have seen only the host's
2 KB preview. The report line records that view as `bytes_seen`, and the row, the event, the
ToolGroup suffix and `--report` count savings against it, so they are not overstated.

### Read rules

A compressed view of an editable file would break the next Edit (its `old_string` would span lines
the view dropped) and invite a lossy Write. So Read compresses only data files the host would not
have shown whole: a whole-file read of a `.log`, `.jsonl` or `.ndjson` file over 32 KB, or of a
`.json` file the host cut at its token cap. Source JSON never qualifies: files under `config/`,
`templates/`, `locales/`, `sections/`, `blocks/`, `snippets/` or `layout/`, `package.json`,
`package-lock.json`, `tsconfig*.json`, `composer.json`, `jsconfig.json`, `*rc.json` and
`*.schema.json`. A compressed Read starts at line 1 and carries this note before the stats line:

```
slim: this view of <file> is compressed and its line numbers are not file lines — Read it with offset/limit for exact bytes before an Edit or Write
```

The handle names a spill copy of the original, not the file itself (see Spill files and handles).

### Decisions

- **compressed** — the result is replaced by its compressed body, then a stats line and a recovery
  handle:

  ```
  slim: compressed 118,203 B → 29,412 B (−75.1%)

  <<full=/tmp/fnd-mcp-slim-0123456789abcdef.json original_result>>
  ```

  The `→` figure is the exact byte size of what the model receives; the handle names the spilled
  original (`.json` for JSON, `.txt` for text).
- **stubbed** — before stubbing, a JSON result still over the threshold gets two more passes on its
  arrays of rows (a JQL search's 50 issues, say): long prose in those rows (descriptions, comment
  bodies) is cut to its first 300 characters plus `… [+N chars]`, longest first, and if that is not
  enough an evenly spaced subset of the largest array's rows stays (first and last included) while the rest
  leave to a rows file cited by a `{"_ccr_dropped":"<<full=… N_rows_offloaded>>"}` row. Ids, keys,
  numbers and short strings are never cut, and the handle still names the untouched original. An MCP
  result the compressor still cannot bring under the stub threshold (32,768 B) is
  spilled and replaced by a ~1 KB stub that opens `<<slim stub>> <tool> returned <N> B (format=…)`,
  names the spill (`full=<file>`) and gives the recovery recipe: `mcp__slim__view({ path: "<file>" })`
  (with `jq: "<jq-path>"` to narrow JSON first) or a windowed Read (offset/limit). When the
  compressor already gained nothing on one JSON document, the recipe is the jq narrowing alone,
  since a whole-file view would give the same bytes back. On the other
  channels a JSON or JSONL output still over the channel's egress cap (Read 65,536 B, Grep and Glob
  16,384 B, the rest 32,768 B) is stubbed the same way (`egress-cap`); any other output over the cap
  passes through.
- **passthrough** — everything else, with a reason (`plain-gate`, `read-guard`, `no-gain`,
  `non-json`, `budget-exceeded`, …).

A result over the platform limit arrives as the host's own "exceeds maximum allowed tokens … saved
to `<file>`" notice (MCP) or with a `persistedOutputPath` (Bash). slim reads the named file and
compresses the real payload, but only after resolving the path to
`<CLAUDE_CONFIG_DIR or ~/.claude>/projects/<dir>/<session id>/tool-results/<name>` for the current
session, as a regular file this user owns of at most 32 MiB — any other path is payload text and is
refused (`expand-refused`).

Limits: one compression gets 5,000 ms of wall clock (`SLIM_BUDGET_MS`; every engine checks it, and
the HTML tokenizer stays linear on malformed markup), and an answer over
4,128,768 B (4 MiB − 64 KiB) is dropped in favour of the original (`output-cap`), with its spills
removed.

### Pasted prompts

A prompt you type (or send through the Remote Control bridge) of 10,240 B or more is searched for
data-shaped spans of 8,192 B or more: a JSON object or array that parses, two or more JSON lines in
a row, a run of timestamp- or level-led log lines (with their stack frames) the log detector
confirms, an HTML page (`<!doctype html>` / `<html>` through the `</html>` tag), and a fenced block
whose body is one of those. A log span ends at its last log line or stack frame, so a question typed
on the next line, indented or not, stays prose.
Each span is replaced **in place**; the prose around it and your question stay byte for byte, and
the prompt is never blocked:

```
<the compact text>

slim: compressed 117,700 B → 5,144 B (−95.6%)

<<full=<project root>/.claude/slim/prompt/slim-prompt-0eb3a1494d5b0e1d.json original_result>>
```

JSON is inlined only while its compact text is under 8,192 B (rows the fit drops go to a
`slim-prompt-rows-*` file beside it); otherwise, and for a log or a page whose compact text is still
over 100 KB, the span becomes its first ~2 KB, a line saying where the rest is, a `slim: stub …`
figure and the handle. The rewritten prompt never carries a parseable JSON span of 8,192 B or more;
if it would, the prompt goes in as typed. A span that already carries a handle or stats line (slim's, or
the `fnd-` ones) is left alone, and so are slash commands, `!` lines and prompts from any other origin (the
SDK, a notification, a schedule, another session or plugin). A rewrite shows a toast and a Log line
(`prompt: compressed 152 KB → 5 KB (−96%) · json · 2 spans`). `SLIM_PROMPT=0` turns it off.

The spans are kept in `<project root>/.claude/slim/prompt/` (the main checkout's when the session runs
in a linked worktree, since a worktree's ignored files go with it), 0600, content-addressed. The
rewrite consumed the paste, so that copy is the only one left: nothing sweeps the folder by age, and
a link anywhere on its path makes slim leave the prompt alone. A rewrite the session never took is
removed: the prompt was interrupted or a hook beneath dropped it (`slim.cjs --prompt-drop`), or the
run was killed at its 20 s timeout (the next prompt run removes what its `.pending-*` journal lists
once it is ten minutes old). When it creates the folder, slim writes `.claude/slim/.gitignore` holding
`*`, so `git add -A` never stages a paste; an existing file there is never overwritten, and the
project's own `.gitignore` is left alone.

### @-mentioned files

An @-mentioned file reaches the model as the host frames a Read of it: `Called the Read tool with
the following input: {"file_path": …}`, then the file as numbered lines. Over 32,768 B, a data file —
the framing names a `.json`, `.jsonl`, `.ndjson`, `.log` or `.txt` file that is not source JSON, or
names none and the content sniffs as JSON, JSON lines or a log — has its numbered lines replaced by
the compressed content, the Read note and a handle, inside the same framing; source, prose and code
pass through. The same text is always compressed the same way (the host keeps the answer and asks
again after a compaction), and the Log line (`@rows.jsonl: compressed 61 KB → 2 KB (−97%) · jsonl`)
and the report line are written once per content. `SLIM_ATTACH=0` turns it off.

### The spill-read guard

Reading a spill back whole puts the whale the compression kept out straight into the context. A
model's Read with no `offset`/`limit` of an original or a rows file (`fnd-mcp-slim-*`, `fnd-crush-*`,
`slim-prompt-*`) over 32,768 B is therefore denied with one line:

```
slim: <file> is a 120000 B spill — Read it with offset/limit, or call mcp__slim__view({ path, jq }) to narrow it, or mcp__slim__lookup({ path, question }) for one fact
```

Windowed Reads, id maps (`fnd-jsx-ids-*`), host tool-results files, Grep, Bash and every plugin's
own calls (view's and lookup's probes among them) pass. `SLIM_SPILL_GUARD=0` turns the deny off.
Each Read, Bash or Grep that named a spill or a host tool-results file writes one `entry:"access"`
line per file at `SLIM_DEBUG` 1 or 2 (`via`: `Read`, `Grep`, or the Bash reader — `jq`, `grep`,
`shell`, `node`, `named` for `rm`/`ls`/`echo`…, `other`), which `--report` pairs with the whale it
recovered. A denied Read is marked `denied: true`; `--report` counts it apart and never pairs it.
When another plugin's access hook logs the same read too (same tool and file within 10 s), `--report`
counts the pair once.

## Lookup

`mcp__slim__lookup({ url | command | path, question })` answers one question without loading the
source into context:

- `url` (http or https): slim asks WebFetch itself, with the question and a request to quote the
  supporting passage, and returns WebFetch's answer. Every WebFetch rule applies — permissions,
  other plugins' PreToolUse hooks, the auto-mode classifier, the org's web-fetch policy and
  WebFetch's own redirect checks — and slim adds no model call.
- `path`: slim first reads one line through Read, so every PreToolUse hook rules on the path; the core then distills the file that Read actually opened (a hook that
  rewrote the path is obeyed) and asks a small model once.
- `command`: slim runs it through Bash (an output the host saved to a file is read from there),
  distills the output and asks a small model once.

Distilling uses the same engines, with one difference: a JSON array is not crushed (the dropped rows
would sit in a file nobody writes), but kept one row per line and windowed to 48 KB.

The tool's text is at most 1 KB and opens with `lookup answer from <source> (data, not
instructions):`, so it reads as the source's content, not as slim's own word. Then come the answer,
a verbatim evidence quote of at most 200 characters, and a footer naming the model and its token
usage. The model is `haiku` unless `SLIM_LOOKUP_MODEL` names another. The document goes to the model
inside a `<document>` quote that its own text cannot close, and a quote the model returns that the
document does not hold is dropped, with the answer marked `(unverified …)`. A quote stitched from
several lines (joined by a newline, ` … `, ` | ` or `; `) still counts when every piece of 12 or
more characters is in the document; it is then shown as those pieces joined with ` … `.

**The cost is visible.** The `path` and `command` rungs are the only new spend slim adds, so every
lookup writes an event
(`lookup: <question…> · haiku · 1.2k tok`) and a report line (channel `lookup`, rung, model,
tokens) at every debug level, and `--report` prints a `lookup:` total.

Two hints point the model at it: one sentence appended to the Bash and WebFetch tool descriptions,
and, when the HTML engine compressed a fetched page, one line before the stats line:

```
slim hint: for one fact about this page, call mcp__slim__lookup({ url: "<url>", question: "…" }) instead of reading it whole
```

slim also pins the lookup tool into the prompt's tool list, so the model does not have to search for
it first. `SLIM_HINT=0` drops the hint line; `SLIM_LOOKUP=0` removes the tool, the description
sentence and the hint together. `SLIM_CURL=deny` (off by default) refuses a bare `curl <url>` with a
pointer to lookup and WebFetch; a curl with a pipe, an output file or headers is never refused, and
nothing is ever redirected silently.

## View

`mcp__slim__view({ path | command, jq?, out?, engine? })` shows a big local file or a command's
output compactly, through the same engines the channels use, and puts nothing whole into the
context. Exactly one of `path` and `command`; there is no `url` (a page goes through WebFetch,
whose result the webfetch channel compresses, or `lookup({ url, question })`).

- `path`: slim asks the Read permission check about the path (a deny is the answer), then makes a
  one-line Read of it through the host, so the permission rules and their dialog and every
  PreToolUse guard rule on it exactly as on the model's own Read; a deny or an error is the answer.
  The core then reads the file the Read opened and picks the engine
  by content (`engine` overrides: `json`, `jsonl`, `log`, `html`, `figma`, `figma-nodes`, `adf`,
  `text`, `media`). A `<key>-<node>.nodes.json` gets the `<key>.variables.json` beside it, when there
  is one, so bound variables read by name. An image or a video goes to the media backend (see Media).
- `command`: slim runs it through Bash (permission rules and hooks rule on it); an output the host
  saved to a file is read from there. A compressed output keeps its original in the spill root, and
  the reply names it (`original: <path>`).
- `jq`: narrows a JSON (or JSON lines, or one dominant fenced JSON block) before the engine, in the
  subset `.a.b`, `.a[0]`, `[]` iteration, `,` multi-select, `| keys`, `| length`, and `.a | .b`.
  Anything else is refused by name (`jq: unsupported syntax near 'select(' — supported: …`), a path
  that resolves nothing says what was there (`jq: 'issuez' not found at top level; keys: …`), and a
  source holding integers JavaScript would round is refused (`number-precision`). A narrowed result
  up to 16 KB is shown as is; a bigger one goes through the engine. The figure then gives no saving,
  because jq changed what is measured:
  `slim view: narrowed by jq to 3,891 B of a 63,004 B source (no saving figure: jq changed the measured object)`.
- `out`: a file under `<project>/.claude/tasks/<id>/` or slim's spill root, relative paths against
  the session's directory; anything else, a folder or a link is refused before anything runs. The
  module writes it through the host's Write tool (an existing file is Read first, as Write
  requires), so permission rules and guards decide; a deny is the answer and nothing is written.
  Its first line is a marker, `<<slim view k=<request hash> engine=<engine> v=<slim version>>>`.
  For a `path`, a later call with the same `jq` and `engine` and the same `out` answers `cached`
  without recomputing while that file is newer than the input and carries the marker of this slim
  version. A `command` always recomputes. `jq` and `out` do not apply to an image or a video.
  Rows the json engine offloads still go to part files in the spill root, which the sweep empties
  after `SLIM_TTL`; a `cached` answer needs every part its file cites, so a call after the sweep
  recomputes and writes them again.

The reply is one figure line (`slim: compressed …`, the `figma-nodes:` line with its node counts,
the narrowing figure above, `cached`, or `slim view: <n> B, not compressed (<reason>)`), then
`out: <path> (<n> lines)` when a file was written, then `--- head ---` and the compact text — whole
up to 16 KB, else its first 40 lines and `read <file> windowed (offset/limit)`. Without `out`, JSON
is fitted to those 16 KB (the rows that did not fit go to a part file the text cites), and a longer
text is kept in the spill root for that windowed Read. With `out` JSON is fitted to 64 KB instead
(the read channel's budget), so the file holds a compact view, never the source copied whole. A
compact text over 4 MiB is refused, with or without `out`; narrow it with `jq`. A refusal is one line naming why.

Every call writes a `slim.events` entry
(`jira-reader · view issues.json: 118 KB → 29 KB (−75%) · json`, or `narrowed by jq`, `cached`,
`refused (<reason>)`) and a report line (channel `view`) at every debug level. A view of a spill
file or a host tool-results file also writes an `entry: "access"` line (`via: "view"`), so
`--report` counts it as a recovery. slim pins the tool into the prompt's tool list, as it does
lookup; `SLIM_LOOKUP=0` does not remove it, and view's result is never compressed again by slim.

## Media

Images and video reach the model through a resize, never raw: an image becomes `<name>.1568.<ext>`
(long edge at most 1568 px, aspect kept, never upscaled, metadata stripped; `<ext>` is the file's own
`png`, `jpg`, `jpeg` or `gif`, and PNG for anything else, WebP included), and a video becomes
`<name>.frames/001.jpg …`, one frame every 2 seconds from the start, at most 24 (a longer clip
spreads the 24 over its whole length), each resized the same way. A portrait phone clip or a JPEG
with an EXIF orientation comes out upright, at its displayed size. The outputs land beside the
input, and the reply lists their paths (frames with their timestamps) after one figure line:

```
media: 2481920 B → 412300 B (-83%) frames=12
```

written as `media: <in> B → <out> B (-NN%) frames=N` (`frames=1` for an image, `+` when the outputs
are larger). The `view` tool (`view { path }` on an image or a video) is the way in.

slim adds no dependency for this. It uses what the machine already has: `ffprobe` + `ffmpeg` on
PATH for images and video, else macOS `sips` for images only (sips cannot strip metadata, and the
reply says so). With neither, or a video with only sips, the answer is the refusal
`media: no backend (install ffmpeg)`. The Read and Write permission checks rule on the input and on
the exact output path (the image, or the first frame); a deny from either is the answer, and an
`ask` from either becomes one Yes/No question naming both (a no, or a dismissed question, writes
nothing). An image also takes the one-line Read, so PreToolUse guards rule on it; the Read tool
cannot open a video, and the backend writes outside the Write tool, so for a video's input and for
every output only the permission rules and the person decide. A file the name or `engine: "media"`
sends this way whose bytes are not an image or a video (a text file named `*.mp4`, or a link to one)
is refused (`not-media`), never shown as text. slim marks a
frames folder it creates; a re-run replaces only its own frames there, and a `<name>.frames` that is
a link, or a folder slim did not make that already holds files, is refused, never cleared. Claude already downsizes every image it is shown to
about 1568 px, so the resize saves bytes and upload time rather than tokens; slim never crops. The
planning is the pure `plugins/slim/scripts/engines/media.cjs` (CONTRACT.md §5a); the backend is
`plugins/slim/scripts/delivery/media.cjs`.

## What you see

- **The ToolResult line.** Under a tool row slim compressed or stubbed, one dim line:

  ```
  slim  json  118 KB → 29 KB  −75%
  ```

  It is drawn in the success colour when slim saved 50 % or more. A Bash window over an output the
  host saved to a file can be larger than the host's 2 KB preview it replaces; its line then reads
  `slim  text  2 KB → 4 KB  +78%` and its event says `windowed`.
- **The ToolGroup suffix.** Read, Grep and Bash runs fold into one group row; when slim compressed
  any call in the group, the fold line ends with ` · 2 compressed, −186 KB`. Only calls whose view
  shrank count. An expanded group shows the per-row lines instead.
- **The toast.** For MCP results on the main conversation only (never for a subagent's calls, never
  for the other tool channels), e.g. `searchJiraIssuesUsingJql: compressed 118 KB → 29 KB (−75%) · json`,
  and for a rewritten prompt (`prompt: compressed 152 KB → 5 KB (−96%) · json`).
  `SLIM_TOAST=0` silences it; `SLIM_TOAST_MS` sets how long it stays.

## State other plugins read

slim owns four `$.state` keys under `plugin: 'slim'`. Any plugin reads them; only slim writes them.
The contract is `plugins/slim/types/index.d.ts`:

```ts
export type SlimEngine = 'json' | 'jsonl' | 'log' | 'html' | 'figma' | 'figma-nodes' | 'adf' | 'text' | 'stub'
export type SlimChannel = 'mcp' | 'bash' | 'read' | 'webfetch' | 'websearch' | 'grep' | 'glob' | 'agent' | 'attachment' | 'prompt'
type SlimEventBase = { v: 1; atMs: number; text: string; src: 'slim'; tool: string; agentType?: string; ms: number }
export type SlimCompressEvent = SlimEventBase & { kind: 'slim'; channel: SlimChannel; bytesIn: number; bytesOut: number; engine: SlimEngine }
export type SlimLookupEvent = SlimEventBase & { kind: 'lookup'; model: string; tokens: { input: number; output: number } | null; answered: boolean }
export type SlimViewEvent = SlimEventBase & { kind: 'view'; channel: 'view'; decision: 'compressed' | 'narrowed' | 'passthrough' | 'cached' | 'refused'; engine: string | null; bytesIn: number; bytesOut: number }
export type SlimEvent = SlimCompressEvent | SlimLookupEvent | SlimViewEvent
export type SlimInfo = { v: 1; version: string; channels: SlimChannel[] }
```

- **`slim.info`** — a snapshot written at session start: slim's version (read from its manifest)
  and the channels whose switch is on. A plugin that finds it non-null knows slim is loaded and
  which channels it compresses.
- **`slim.events`** — one event per compressed or stubbed result and per lookup or view call,
  oldest first, at most 200. `text` is one line, e.g. `<agent type> · Bash: compressed 120 KB → 11 KB (−91%) · json`
  (the agent prefix only for a subagent's call) or `lookup: <question…> · haiku · 1.2k tok`.
  `agentType` is absent on the main conversation, the subagent's type (`core:jira-reader`) when it is
  listed, and `agent` when it is not. `SLIM_EVENT_LOG=0` stops the writes, and the list stays `[]`.
  A Log pane (band's) merges these events with its own.
- **`slim.rows`** — one member per compressed tool_use_id; internal to the ToolResult line and the
  ToolGroup suffix.
- **`slim.seen`** — one member per @-mentioned file content slim compressed this session; internal
  to the once-per-content Log line.

## Report log

slim writes one report log: `fnd-mcp-slim-debug.log` in the spill root. Each of its
lines carries `src: 'slim'` and its `channel`, plus `tool_use_id`, the decision, reason, engine,
bytes in/out (and `bytes_seen` where the host showed less), % and ms — never any payload.

- `SLIM_DEBUG=1` writes one line per call slim handles; `2` adds the `size-gate`, `already-slim`,
  `plain-gate`, `read-guard` and other stand-downs the module sends. A Bash or Read call under its
  channel's gate is not a slim invocation and writes nothing at any level.
- Error lines (`decision: 'error'`, `entry: 'hook'` from the core, `entry: 'mod'` when the module's
  spawn failed), lookup lines and view lines are written at every level, including off. A view
  line's reason is `jq-narrowed` for a narrowed result and `cached` for a cached one. A media view's
  line keeps the image or video sizes in `media_in` / `media_out` and logs `bytes_in` /
  `bytes_out` as 0: those bytes never headed for the context, so the savings totals leave them out.
- The module's own stand-downs are logged only when the level is set in the session's environment
  (shell, `~/.claude/settings.json` → `env`).
- A prompt line (`channel: 'prompt'`, `entry: 'mod'`, `spans`, every span's spill in `spills`) is
  written at level 1 like the tool channels; a prose-only prompt (`no-span`) at level 2.
- An access line (`entry: 'access'`, `tool`, `via`, `spill`, `denied` when the guard refused it) per
  spill file a model's Read, Bash or Grep named, at level 1 or 2 (see the spill-read guard).

Read the totals with:

```
node plugins/slim/scripts/slim.cjs --report [logfile] [--since <ISO>]
```

It prints the totals plus a `by src:` line (one total per writer; a line without `src` counts as
`fnd`, the log format's original writer), a `by channel:` line and, when
lookup ran, a `lookup:` line (calls, answered, tokens in and out, models). A group whose summaries are
bigger than what the model would have seen — Bash outputs the host saved to a file, where the
baseline is its 2 KB preview — reads as a grown view rather than a negative saving:

```
bash: 2 results, 560,779 B of output summarised into 14,935 B (host preview would have shown 4,646 B; the view grew ×3.2)
```

Below ×1.1 the growth is given in bytes, and results that passed through untouched are counted apart
(`+ 1 passed through (500 B)`).

## Spill files and handles

Every original slim replaces, and every part a compact text cites, is a file this user owns (0600,
written atomically, content-addressed, never through a link):

| Where | Name | Holds |
|---|---|---|
| spill root | `fnd-mcp-slim-<sha16>[-<8 hex>].json` or `.txt` | the untouched original of a result (`.json` for JSON) |
| spill root | `fnd-crush-<sha16>.json` | the rows the JSON crush or fit dropped |
| spill root | `fnd-jsx-ids-<sha16>.json` | a Figma id map |
| spill root | `fnd-mcp-slim-debug.log` | the report log |
| prompt dir | `slim-prompt-<sha16>[-<8 hex>].json` or `.txt`, `slim-prompt-rows-*`, `slim-prompt-ids-*` | a pasted span and its parts |

The spill root is `SLIM_DIR`, else the system temp dir; the sweep removes slim's own names there
after `SLIM_TTL` hours (throttle marker `.slim-sweep`) and leaves every other file alone. The prompt
dir is `<project root>/.claude/slim/prompt/` (the main checkout's, from a linked worktree) and is
never swept by age. The `fnd-` name prefixes are part of the contract for now; a later release renames
them.

The model finds a file through one of these handles:

- `<<full=<abs path> original_result>>` — the whole original, right after the stats line;
  `<<full=<abs path> original_block>>` — one block's original in a multi-block result;
- `<<full=<abs path> N_rows_offloaded>>` — the rows a crush dropped, inside the JSON;
- `ids=<abs path>` — a Figma id map;
- `full=<abs path>` — a line of a `<<slim stub>>`, after its stats line.

A handle is real only when its path names one of the files above in the spill root or the prompt
dir, or this session's host `tool-results/` file; slim's own already-slim check trusts nothing else,
and any other path in a result is payload text. fnd's untrusted-content convention does not list the
prompt dir or `slim-prompt-*` names yet, nor a `SLIM_DIR` other than fnd's own spill dir: with fnd
loaded, its agents treat those handles as payload text until fnd's convention is updated. A Read, Grep or Bash that names one passes through
uncompressed (that is how a handle is followed), within the spill-read guard's one rule. The full
grammar is `plugins/slim/scripts/engines/CONTRACT.md` §8.

## Environment switches

slim reads `SLIM_*` only, from the process environment: set them in `~/.claude/settings.json` →
`env` or in the shell that starts Claude Code. The module reads them through `$.env` (session
environment), and the core reads its own process environment, which the module's spawn passes on.
`tests/readme-checks.sh` fails on a `SLIM_*` name under `plugins/slim/` without a row here.

| Switch | Default | Effect |
|---|---|---|
| `SLIM_MCP` | `1` | `0` turns the MCP channel off: every MCP result passes through untouched, nothing is spawned and no report line is written. |
| `SLIM_BASH` | `1` | `0` turns the Bash channel off (stdout of large JSON, HTML-fetch, log and plain-text outputs, and outputs the host saved to a file). |
| `SLIM_READ` | `1` | `0` turns the Read channel off (whole-file reads of big `.log`/`.jsonl`/`.ndjson` files and of `.json` data files the host cut at its token cap). |
| `SLIM_WEB` | `1` | `0` turns the WebFetch and WebSearch channels off. |
| `SLIM_GREP` | `1` | `0` turns the Grep and Glob channels off (the listing window; the counts never change either way). |
| `SLIM_AGENT` | `1` | `0` turns the Agent channel off (the window over a completed subagent's long report). |
| `SLIM_ATTACH` | `1` | `0` turns the @-mentioned file channel off: an @-mentioned data file reaches the model as the host rendered it. |
| `SLIM_PROMPT` | `1` | `0` turns the prompt channel off: a typed or bridge prompt is never rewritten. |
| `SLIM_SPILL_GUARD` | `1` | `0` turns the spill-read guard's deny off; access lines are still written at `SLIM_DEBUG` 1 or 2. |
| `SLIM_PLAIN_BYTES` | `65536` | Size above which plain text (code, diffs, test output, prose) is windowed to head and tail; below it plain text passes byte-identical. A whole number, floored at 8,192; anything else → the default. |
| `SLIM_DIR` | system temp dir | Spill root: originals, rows files, id maps and the report log `fnd-mcp-slim-debug.log`. A handle is trusted only there, in the prompt dir and in this session's host `tool-results/`. |
| `SLIM_TTL` | `24` | Hours a spill file lives before the sweep removes it; `0` stops the sweep. Only slim's names in the spill root are pruned; the prompt dir is never swept by age. |
| `SLIM_DEBUG` | off | `1` (or `true`/`yes`/`on`) writes one report line per call slim handles, on every channel, and the spill access lines; `2` adds the module's stand-downs (`size-gate`, `already-slim`, `plain-gate`, `read-guard`, …), prose-only prompts and the attachment probe. Error, lookup and view lines are written at every level. |
| `SLIM_STUB` | `1` | `0` turns the spill-and-stub guard off for MCP results; a result the host cut at its token limit is still stubbed. |
| `SLIM_STUB_BYTES` | `32768` | Payload size above which an incompressible or weakly compressed MCP result becomes a stub (whole bytes, floored at 1,200; anything else → the default). |
| `SLIM_BUDGET_MS` | `5000` | Wall-clock ceiling for one compression in ms; `0` removes it; past it the result passes through or is stubbed. |
| `SLIM_TOAST` | `1` | `0` silences the savings toast (MCP results and rewritten prompts, main conversation only); compression, the ToolResult line and the ToolGroup suffix are untouched. |
| `SLIM_TOAST_MS` | `5000` | How long the toast stays, in ms (whole number, floored at 1,000). |
| `SLIM_EVENT_LOG` | `1` | `0` stops writing the `slim.events` state other plugins read; the ToolResult line still draws. |
| `SLIM_LOOKUP` | `1` | `0` removes the `mcp__slim__lookup` tool, the one-sentence pointer to it in the Bash and WebFetch tool descriptions and the lookup hint line together. The view tool stays. |
| `SLIM_LOOKUP_MODEL` | `haiku` | Model the lookup tool asks its one question with — an alias or a model id. Every lookup writes its model and token usage to the report log at every debug level. |
| `SLIM_HINT` | `1` | `0` drops the one line slim adds to an HTML page it compressed from a Bash fetch (`slim hint: for one fact about this page, call mcp__slim__lookup(…)`). |
| `SLIM_CURL` | unset | `deny` refuses a bare `curl <url>` in Bash with a pointer to the lookup tool and WebFetch; a curl with a pipe, an output file or headers is never refused. Any other value does nothing. |

## Not covered

- **Grep and Glob on native builds.** The native 2.1.289 build does not register Grep or Glob as
  tools; slim matches them by name where they exist. The host already caps both (Grep at 20,000
  characters and 250 entries, Glob at 100 files), so the channel rarely fires.
- **Images pasted or @-mentioned in a prompt.** `prompt.submit` tells a hook only that an image is
  there, never its bytes, so slim cannot resize it; ask for `view { path }` on the file instead.
- **@-mentioned source files and prose.** Only data files are compressed (see @-mentioned files);
  a large source file reaches the model as the host rendered it.
- **Raw HTML from WebFetch.** WebFetch hands back its own model's answer, not the page; slim only
  sees large answers.
- **Source JSON and files you edit through Read** — see the Read rules.
- **A Read over the host's size limit.** The host refuses it before slim sees a result.
- **Images, PDFs and binary output** pass through the hook channels untouched; images and video are
  resized only when asked through `view { path }` (see Media).
- **A `.json` file the host showed whole.** A Read under the host's token cap is left as is. Ask a
  question about it with `lookup({ path, question })`, or narrow it with `view({ path, jq })`.

## Layout

slim has three layers with a hard boundary between each, plus its evals.

- **Engines** — `plugins/slim/scripts/engines/`: a host-independent compression library. Pure Node
  modules (no environment, no filesystem, no process, no timers): text or an object in, a result
  object out. An engine returns what should be spilled; it never writes it. Any Node program can
  embed it — a microservice, a CLI, a hook on another harness. The versioned contract — input,
  detection rules, each engine's algorithm, output, guarantees and runnable examples — is
  `plugins/slim/scripts/engines/CONTRACT.md`. Beside `compress()`, `plugins/slim/scripts/engines/jq.cjs`
  narrows JSON for the view tool, `plugins/slim/scripts/engines/media.cjs` plans a resize and
  `plugins/slim/scripts/engines/spans.cjs` finds the data spans in a pasted prompt.
  How the layers fit together, with diagrams of one tool result's path, the five destinations and the
  lookup and view rungs: `plugins/slim/ARCHITECTURE.md`.
- **Delivery** — `plugins/slim/scripts/slim.cjs` and `plugins/slim/scripts/delivery/`: the only
  Claude Code-specific code. It knows the channel envelopes (`plugins/slim/scripts/delivery/channels.cjs`),
  host overflow files, the `SLIM_*` switches, spill files and their sweep, the report log and
  the stats and stub text. Besides the hook mode, `slim.cjs` has `--distill` (the lookup tool's
  fetch-and-distill step), `--view` (the view tool's core, `plugins/slim/scripts/delivery/view.cjs`),
  `--prompt` (the prompt channel, `plugins/slim/scripts/delivery/prompt.cjs`), `--prompt-drop` (the
  spills of a rewrite the session never took), `--access` (a spill
  access line), `--record` (a lookup or view report line), `--error`, `--report` and `--help`.
- **Module** — `plugins/slim/hooks/mods/`: the intake (tool results and @-mentioned files), the
  prompt channel (`prompt.ts`), the spill-read guard (`guard.ts`), the lookup and view tools, the
  description note, the `slim.info` snapshot and the drawing.
- **Evals** — `plugins/slim/evals/`: the eval suite below; `plugins/slim/evals/_shared/` holds the
  deterministic generators that write its inputs (and the committed `tests/fixtures/page.html` and
  `tests/fixtures/app.log`).

## Evals

`plugins/slim/evals/` is a `claude plugin eval` suite with five cases, each run with and without
the plugin (the default with-without ablation): a Read of a big JSON export, a curl of an HTML page,
a cat of a log, a mocked Jira MCP search (`plugins/slim/evals/mocks/atlassian/`) and a one-fact
lookup. Each case has free graders (tool used, regex on the trace) and one LLM grader (haiku judge).
Every run is a full `claude` child on your own credential, so run it by hand:

```
claude plugin eval plugins/slim --runs 1 --max-cost-usd 2 --model sonnet --scaffold --allow-tools Bash WebFetch ToolSearch mcp__slim__lookup mcp__atlassian__searchJiraIssuesUsingJql
```

`--scaffold` runs each case's `scaffold.sh`, which writes the input file into the run's scratch
directory. Results land in the suite's `results/` directory (git-ignored).

## Tests

```
node tests/slim-engines.mjs        # the engines as pure functions on the real fixtures, and the library contract
node tests/html-slim-fixtures.mjs  # the HTML engine
node tests/slim-fixtures.mjs       # delivery end to end: every channel, --view, --prompt, --access, --report
claude plugin test plugins/slim    # the module's kit tests
bash tests/mods-sim.sh             # validate --strict + the kit tests per plugin (local only; needs claude)
```

## Licence

`plugins/slim/scripts/engines/json.cjs` and `plugins/slim/scripts/engines/log.cjs` are Apache-2.0
ports; see [NOTICE](../../tests/parity/NOTICE).
