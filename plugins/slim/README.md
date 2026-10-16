# slim

slim is a Claude Code plugin that compresses large tool results, pasted data and @-mentioned data
files before they reach the model's context. It keeps every original on disk, so nothing is lost.
To install it, add the marketplace and install `slim@domaine`: see the root README section
[Quick install (Claude Code)](../../README.md#quick-install-claude-code).

## What it is

slim is a compression proxy for Claude Code. One `tool.call` handler sees every tool result: MCP,
Bash, Read, WebFetch, WebSearch, Grep and Agent. The handler shrinks the large results before they
reach the context. slim treats a pasted prompt's data and an @-mentioned data file in the same way.

slim picks an engine by content, never by tool name. An engine is the compressor for one data
format:

- JSON goes to the JSON compressor.
- A log goes to the log engine.
- An HTML page goes to the HTML engine.
- An XML document or SVG goes to the element-tree engine.
- Figma design-context JSX goes to the JSX compactor.
- A Figma REST nodes response goes to the node-tree engine.
- A browser MCP's accessibility snapshot goes to the snapshot folder.
- Linter output goes to the lint engine.
- A path listing from `find`, `ls -R` or `tree` goes to the listing outline.
- A CSV or TSV table goes to the table profiler.
- Plain text (code, diffs, test output) is at most windowed: slim keeps its head and tail (see
  The window).

Two tools come with slim. `lookup` answers one question about a page, a command's output or a file,
and does not load the source whole. `view` shows a big file or a command's output in a compact form,
and resizes images and video. slim keeps every original on disk behind a recovery handle (a path the
model can read back), so nothing is lost.

slim is a Claude Code hooks module (mods) and nothing else. Other hosts do not run it, and it never
runs as a classic hook. The hooks run wherever the plugin loads. The drawing (the ToolResult line,
the ToolGroup suffix and the toast) shows in the terminal and the desktop app.

Current release: **slim v0.12.0**.

## Install

```
/plugin marketplace add domaine-oleksandr-kever/claude-plugins
/plugin install slim@domaine
/reload-plugins
```

The prompt channel keeps pasted data in each project's `.claude/slim/` folder (see Pasted prompts).
slim writes a `.gitignore` that holds `*` inside that folder, so git never stages it. slim leaves the
project's own `.gitignore` alone.

## Channels

A channel is the path that one kind of input takes into slim: the results of one tool, a typed
prompt, or an @-mentioned file. A tool channel works in these steps (the prompt channel has no tool;
its path is described under "Pasted prompts" below):

1. The module's intake (`plugins/slim/hooks/mods/intake.ts`) lets the tool run first.
2. The intake measures the result with a pure byte check: it reads no environment and spawns
   nothing. A result under its channel's gate (the size threshold) stops here.
3. The intake sends a candidate to the core, `plugins/slim/scripts/slim.cjs`, as one JSON envelope
   on stdin. The envelope holds the channel, tool, tool_use_id, tool input, raw result, cwd and
   session id.
4. The core answers with one JSON object: the decision, the restored result, the stats figure and
   the report record.
5. The module gives the model a fresh result object.

If the module cannot read the core's answer (a failed spawn, a non-zero exit, bad output), the
original result stays untouched. slim compresses only the model's own tool calls. A call that another
plugin makes through `$.tool.call` (lookup's own calls too) gets back the record it asked for.

The core puts the compressed text back into the tool's own result shape. It must do this because the
host's hook engine validates a hook's result against the built-in tool's output schema. Bash stays
`{stdout, stderr, …}`, Read keeps its file record, and Grep keeps its counts.

### Gates and engines

| Channel | Candidate when | What slim does |
|---|---|---|
| MCP (`mcp__*`) | result over 4,096 B, or the host's overflow notice | each text block sniffed like any other channel's text: JSON, JSONL, fenced JSON, Figma JSX, XML, SVG, linter output, delimited tables and logs compressed, browser accessibility snapshots folded; plain, guarded and HTML text untouched; spill-and-stub when still too large (below) |
| Bash | stdout over 4,096 B that is JSON, JSONL, a delimited table or (for a fetch command) HTML or XML; over 16,384 B from a log command; over 8,192 B from a linter or a listing command; over `SLIM_PLAIN_BYTES`; or any output the host saved to a file (plain text included, whatever its size) | stdout only; stderr and the other fields are kept |
| Read | a whole-file read of a `.log`, `.jsonl`, `.ndjson`, `.csv`, `.tsv` or `.xml` file over 32,768 B, or of a `.json` data file the host cut at its token cap | the file view is compressed; see the Read rules below |
| WebFetch | result over 16,384 B that is JSON, HTML, XML or a delimited table, or over `SLIM_PLAIN_BYTES` | JSON, JSONL, HTML, XML and csv engines, else a window |
| WebSearch | a result string over `SLIM_PLAIN_BYTES` | that string is windowed; the others are untouched |
| Grep | `content` output over 16,384 B (a file listing is never touched) | window with an 8,192 B budget; `numFiles`, `numLines` and `numMatches` never change |
| Agent | a completed subagent's text block over `SLIM_PLAIN_BYTES` | that block is windowed |
| @-mentioned file | over 32,768 B, the host's numbered lines of a data file | JSON, JSONL, log and csv engines, as a Read; see below |
| Prompt (typed or bridge) | a prompt of 10,240 B or more holding a data span of 8,192 B or more | each span replaced in place; see below |
| View (`mcp__slim__view`) | every call | the tool's own answer is already compact; slim never compresses it again (see View) |

A subagent's calls go through the same handler. Their events carry the agent type.

**Figma REST node trees.** slim detects a `GET /v1/files/:key/nodes` response by its
`nodes.<id>.document` shape, before the generic JSON engine. The response becomes a markdown build
tree. Each visible node gets one line with its measurements, layout, colours, typography and
effects, and every TEXT value in full. slim drops hidden subtrees and vector geometry and counts
them. It folds runs of identical siblings and lists every folded id and differing value.

slim admits this engine wherever it admits JSON (Bash, Read, WebFetch); MCP results keep the JSON
engine. A tree over the channel's egress cap (the largest output the channel lets through) folds its
deepest level first, one level at a time, until it fits. The nodes at the new last level keep their
lines, each with `… N nodes deeper folded` under it. Siblings there fold as `×N` only when what they
folded is identical too. The header counts what slim folded.

Folding never goes past the root's direct children. A tree that still does not fit goes the JSON
route (fit, else stub). The view tool never folds a tree: it reads a long tree windowed from a file
instead.

**Browser accessibility snapshots.** This engine reads a Playwright MCP snapshot
(`- role "name" [ref=eN]` lines) or a Chrome DevTools MCP one (`uid=… role "name"` lines). The
snapshot comes from `browser_snapshot` / `take_snapshot` or from any action tool that returns one.
The output keeps the snapshot's own grammar and folds repeated siblings. For example, a run of
product cards keeps the first two and becomes one line,
`- … 46 more like the 2 above [refs e40–e361]: names "Cleanser No. 3", … +34; prices $22.00–$112.00`.
slim flattens nameless wrappers and drops nameless leaf images.

slim never folds headings, landmarks, alerts, dialogs, form state (`[checked]`, `[disabled]`,
`[expanded]`, `[level=N]`) or prose. It never renumbers or loses a ref. Each ref is on a kept line,
in a fold's ranges or on the dropped-images line, and every ref stays clickable. The last line names
the narrowing call (`browser_find`, `take_snapshot({ verbose: true })` or `lookup` on the spill).

Over the stub limit, slim first folds harder (one exemplar, 6 names). Then it drops `/url` lines and
non-state attributes, then it collapses the deepest levels. A prose page that saves under 10 % passes
through. The engine runs on MCP only, from the 4,096 B gate. `SLIM_A11Y=0` turns it off.

**Linter output.** The lint engine reads ESLint (stylish and unix), stylelint, theme-check text, tsc
(plain and `--pretty`) and `prettier --check` lists. The output must have 30 or more lines, and at
least 70 % of them must be in one of those grammars. The engine groups the lines by rule and message
template, with quoted names and numbers slotted. Errors come first, then warnings, then notes, and
larger groups come first. Each group keeps its count and its first 5 locations verbatim
(`file:line:col`, or tsc's `file(line,col)`, with the message when it differs from the template).
Then a line `… +N in M files (file ×n, …)` names every file.

tsc's indented elaboration lines stay under their error. The tool's own summary lines close the
output, verbatim. Over the channel's size cap, each fold names its first 8 files. Then each group
keeps 3 locations, then 1, then counts only; else slim stubs the output. The output starts with
`<<slim-lint>>`.

slim admits the lint engine on Bash for a linter command (below) and on MCP by content. It also
admits it on a Read of a `.log`, `.jsonl` or `.ndjson` report over 32,768 B (see the Read rules).
Any other file stays as the host shows it. Theme-check output that quotes Liquid source lines stays
template text (see Guard rails).

**Delimited tables.** A CSV, TSV or `;`-separated table becomes a profile when all of these are true:

- It has 20 or more records.
- One delimiter splits ≥ 95 % of them into the header's width (3 columns or more).
- The header holds no number.
- It does not open like a log line (a date, time or level).
- No header cell is typed like its column's values (a header that looks like a data row is not a header).

The profile has three parts:

- A `<<slim-csv>>` line with rows × cols, the delimiter and the size.
- One line per column with its type (number, integer, date, bool, category, string), min and max as
  written, nulls and distinct count. The line also holds either the values of a category or bool with
  their counts, or three samples. An identifier-like sample without whitespace stays whole up to 400
  chars; slim clips prose past 160.
- A markdown table of the header, rows 1–3 and three sampled rows with their data-row numbers. Cells
  stay as written; slim clips a cell over 160 chars and gives its length.

A generator seeded with the content hash picks the samples and sampled rows, so a rerun shows the
same ones. In a `;` file, slim reads `1.299,00` as a number. Over the channel's egress cap, the table
rows go first (3, then none), then the samples (one per column). If the profile is still over the
cap, slim stubs it.

The table engine runs on Bash whatever the command, on WebFetch, on a Read of a `.csv` / `.tsv` file,
on an @-mentioned one, and on MCP text. For a row, a column or a filter, the footer names
`lookup({ path, question })` on the original.

**XML and SVG.** The element-tree engine reads a text that opens with `<?xml` or with an element that
is not HTML. Examples are sitemaps, product and Google Merchant feeds, RSS, Figma `get_metadata` and
any XML. The output has one line per element with its attributes and text. Five or more same-name
siblings fold into one `url ×50,000 {loc, lastmod, changefreq, priority}` line. Three records follow
it verbatim (first, middle, last; `#N` is the record's position). Siblings of several shapes give
each shape with its count and samples; past 12 shapes, a `fields:` line counts every field.

Folded siblings with an `id` list every id (`ids: P0…P1999`). An id-bearing node never folds when it
is a bare attribute line or nests further ids, so a Figma node tree keeps every node. slim cuts a
text or attribute value over 200 chars to a head and its length, except a multi-line text body. An
element that mixes text with inline elements (a Notion page) reads as written, with every inline
reference in place.

An SVG keeps its markup, ids, groups, `<use>` refs, fills, styles and `<text>`. `d` and `points` read
`d="(1,204 chars)"`. slim drops comments, `<metadata>` and editor namespaces (Inkscape, Sodipodi,
Sketch, Serif). The first line is `<<slim-xml>>` with the element and byte counts. The last line
names `lookup({ path, question })` for one record. Over the channel's cap, slim drops samples
(3 → 1 → 0), then folds the deepest level, then stubs the output.

slim admits the element-tree engine on Bash only after a fetch command (`cat assets/icon.svg` stays
text). It also admits it on WebFetch by content, on Read for an `.xml` file over 32,768 B (never
`.svg`), and on MCP. Liquid with markup stays `template`. An HTML fragment (a leading `<div>`,
`<section>`, …) stays text. An HTML or XHTML page (`<html>`, `<head>` or `<body>` first, with or
without a prolog) goes to the HTML engine.

**Engine admission on Bash.** slim compresses JSON, JSONL and delimited-table output whatever the
command. It treats HTML as a page only when the command fetches one. A fetch is `curl`, `wget`,
`http`, `https`, `xh` or `lynx` as the command word of a pipeline segment
(`cat src/http/page.html` is not a fetch). Other HTML is plain text, so slim never strips theme
source.

The log engine runs only for a log source: a command that names a `.log` or `.jsonl` file,
`journalctl`, or `logs`. Any other text is plain text, so slim never deduplicates test runners and
git output as a log.

The lint engine runs for `eslint`, `stylelint`, `theme-check`, `shopify theme check`, `tsc` and
`prettier`. Each one counts when it runs directly, through `npx`/`pnpm exec`/`yarn`/`bunx`, or by
bin path. A package's `lint` script counts too (`npm run lint`, `pnpm lint`, `yarn lint`,
`bun run lint`). Any other command's output is not lint: a `grep -rn error: logs/` hit list keeps
every line.

The listing engine runs only when a listing command (`find`, `fd`, `ls`, `tree`, `git ls-files`,
`rg --files`) writes the output. The listing command must be the last command. Only `sort`, `uniq`,
`head`, `tail` or `grep` may follow it in its pipeline, and it has no `-exec`. `cat paths.txt`,
`ls data && cat data/prices.csv` and `find … | xargs grep -c` stay plain text.

**Path listings.** A Bash listing over 8,192 B becomes a directory outline. The listing can be one
path per line (`find`, `fd`, `git ls-files`, `rg --files`), `ls -R` blocks or `tree` box drawing.
The outline has one line per directory that holds files, such as `./sections/ (12 files, 1 dir)`.
Directories keep the order that the command printed them in: an `ls -t` keeps its newest first, and
an order across directories holds within each. A directory with at most 8 files lists them by bare
name under its line. A larger directory gets an extension histogram and three example names on its
line (`./assets/ (1,350 files): .js 610, .css 380, .svg 240 · e.g. …`).

slim never cuts depth. Over the egress cap, the threshold falls to 4, then to histograms only, then
slim stubs the output. Lines that are not paths (`find: …: Permission denied`, tree's summary) stay
verbatim under the header. slim prints a name as it came or counts it, and never rewrites it. A
listing with nothing to fold stays as it came (`no-gain`), unless it is over the egress cap. The
footer names the next call: a narrower `find <dir> -name '<pattern>'` or `ls <dir>`, or a windowed
Read of the original.

**Guard rails.** These results pass through untouched, with their reason on the report line:

- Code, diffs and test output. The detector checks for a diff, a test runner's summary (jest, mocha,
  go test, rspec, pytest, TAP), template markers (`{%`, `{{`, `<%`, `<?php`) and code lines. It does
  this BEFORE it looks for JSON lines, HTML or a log. slim only ever windows such text, and only
  above `SLIM_PLAIN_BYTES` (`plain-gate` below it) or when the host saved the Bash output to a file.
  In that case the model would see only a 2 KB preview of it, so the exact text is gone either way.
  An MCP text block runs through the same checks but is never windowed. It passes through with the
  guard's name (`diff`, `test-output`, `template`) or `non-json`, and over 32,768 B slim stubs it.
  So theme-check output that quotes Liquid stays as it came, from any MCP tool.
- Images, PDFs and other binary output (`not-text`, `binary`), detected by magic bytes.
- A Bash command that runs a compressor CLI (`slim.cjs`, `json-slim.cjs`, `log-slim.cjs`, … —
  `own-cli`).
- A Bash command or a Read that names a spill file or a host tool-results file (`spill-read`). This
  is how the model follows a `<<full=` handle, so it must see the bytes as they are.
- A Read with `offset`, `limit` or `pages` (`windowed-read`), and every Read that the rules below do
  not admit (`read-guard`).
- A result that already carries a slim mark (`already-slim`).

**Why `SLIM_PLAIN_BYTES` defaults to 65,536 B.** That value is about twice Bash's inline cap of
30,000 characters, so any output that the host would show inline stays byte-identical. The host
moves a large Bash output behind a 2 KB preview. slim windows such an output whatever its size,
because the window beats the preview. The window keeps the tail, where a test summary lives.

### The window

Plain text over its threshold keeps whole lines from the head (about a third of the budget) and from
the tail (the rest). One marker line sits between them:

```
[slim: 2,871 of 3,000 lines hidden (241,388 B)]
```

slim uses a character window (`[slim: <N> B hidden]`) for a text of fewer than three lines, for one
long line, or for whole lines that fill less than half the budget (a huge line between short ones).
The budgets are 4,096 B for a Bash output the host saved to a file, 8,192 B for Grep, and 12,288 B
otherwise. slim never windows MCP results.

Without slim, the model would see a smaller view in three cases:

- the host's 2 KB preview, for a Bash output the host saved to a file;
- the host's short overflow notice, for an MCP result over the host's limit;
- the cut text, for a Read that the host cut at its token cap.

The report line records that view as `bytes_seen`. The row, the ToolGroup suffix and `--report`
count savings against it, so they do not overstate the savings. A result bigger than that view shows
as `+N%`. The Log event counts from the raw bytes and names that view beside the saving:
`windowed 48 KB → 4 KB (−91%; host preview 2 KB)`.

### Read rules

A compressed view of an editable file would break the next Edit, because its `old_string` would span
lines that the view dropped. It would also invite a lossy Write. So Read compresses only data files
that the host would not have shown whole:

- a whole-file read of a `.log`, `.jsonl`, `.ndjson`, `.csv`, `.tsv` or `.xml` file over 32 KB;
- a whole-file read of a `.json` file that the host cut at its token cap.

Source JSON never qualifies: files under `config/`, `templates/`, `locales/`, `sections/`, `blocks/`,
`snippets/` or `layout/`, `package.json`, `package-lock.json`, `tsconfig*.json`, `composer.json`,
`jsconfig.json`, `*rc.json` and `*.schema.json`. A compressed Read starts at line 1 and carries this
note before the stats line:

```
slim: compressed view — line numbers are not file lines; Read with offset/limit before an Edit
```

The handle names a spill copy of the original, not the file itself (see Spill files and handles).

The host refuses a file over its own Read size cap (256 KB:
`File content (289.8KB) exceeds maximum allowed size (256KB)`) before any hook runs. So slim never
sees that Read. Use `mcp__slim__view({ path })` instead, or `mcp__slim__lookup({ path, question })`
for one fact.

### Decisions

- **compressed** — slim replaces the result with its compressed body, then a stats line and a
  recovery handle:

  ```
  slim: compressed 118,203 B → 29,412 B (−75.1%)

  <<full=/tmp/slim-mcp-0123456789abcdef.json original_result>>
  ```

  The `→` figure is the exact byte size of what the model receives. The handle names the spilled
  original (`.json` for JSON, `.txt` for text).
- **stubbed** — a stub is a short text that replaces a result and points to the original on disk (~1 KB for a
  tool result; the prompt channel keeps the span's first ~2 KB).
  Before stubbing, a JSON result that is still over the threshold gets two more passes on its arrays
  of rows (a JQL search's 50 issues, for example):

  1. slim cuts long prose in those rows (descriptions, comment bodies) to its first 300 characters
     plus `… [+N chars]`, longest first.
  2. If that is not enough, an evenly spaced subset of the largest array's rows stays (first and
     last included). The other rows go to a rows file, cited by a
     `{"_ccr_dropped":"<<full=… N_rows_offloaded>>"}` row.

  slim never cuts ids, keys, numbers and short strings, and the handle still names the untouched
  original. If the compressor still cannot bring an MCP result under the stub threshold (32,768 B),
  slim spills the result and replaces it with a ~1 KB stub. The stub opens
  `<<slim stub>> <tool> returned <N> B (format=…)` and names the spill (`full=<file>`). It gives the
  recovery recipe: `mcp__slim__view({ path: <full> })` (with `jq: "<jq-path>"` to narrow JSON first)
  or a windowed Read (offset/limit). When the compressor already gained nothing on one JSON document,
  the recipe is the jq narrowing alone, because a whole-file view would give the same bytes back.

  On the other channels, slim stubs a compressed output in the same way (`egress-cap`) when it is
  still over the channel's egress cap. The caps are Read 65,536 B, Grep 16,384 B, Bash the host's
  inline limit less 2,048 (at most 32,768 B), and the rest 32,768 B. This applies whichever engine
  produced the output (JSON, a node tree, a log, a page, a window). slim first fits JSON and node
  trees under the cap.

  On Bash, slim measures the finished answer once more as the host measures it: characters of stdout
  plus stderr. slim stubs an answer at or past the host's inline limit. When not even the stub fits
  beside stderr, slim passes the answer through (`egress-cap`). Past that limit, the host would save
  slim's own answer to a file and show the model a 2 KB preview of it.
- **passthrough** — everything else, with a reason (`plain-gate`, `read-guard`, `no-gain`,
  `non-json`, `budget-exceeded`, …).

A result over the platform limit arrives in one of two forms: the host's own "exceeds maximum
allowed tokens … saved to `<file>`" notice (MCP), or a `persistedOutputPath` (Bash). slim reads the
named file and compresses the real payload. It does this only after it resolves the path to
`<CLAUDE_CONFIG_DIR or ~/.claude>/projects/<dir>/<session id>/tool-results/<name>` for the current
session. The file must be a regular file that this user owns, of at most 32 MiB. slim refuses any
other path as payload text (`expand-refused`).

Limits: one compression gets 5,000 ms of wall clock (`SLIM_BUDGET_MS`). Every engine checks this
budget, and the HTML tokenizer stays linear on malformed markup. slim drops an answer over
4,128,768 B (4 MiB − 64 KiB) in favour of the original (`output-cap`) and removes its spills.

### Pasted prompts

slim searches a prompt of 10,240 B or more that you type (or send through the Remote Control bridge)
for data-shaped spans of 8,192 B or more. A span is one of these:

- a JSON object or array that parses;
- two or more JSON lines in a row;
- a run of timestamp- or level-led log lines (with their stack frames) that the log detector
  confirms;
- an HTML page (`<!doctype html>` / `<html>` through the `</html>` tag);
- a fenced block whose body is one of those.

A log span ends at its last log line or stack frame, so a question typed on the next line, indented
or not, stays prose. slim replaces each span **in place**. The prose around it and your question
stay byte for byte, and slim never blocks the prompt:

```
<the compact text>

slim: compressed 117,700 B → 5,144 B (−95.6%)

<<full=<project root>/.claude/slim/prompt/slim-prompt-0eb3a1494d5b0e1d.json original_result>>
```

slim inlines JSON only while its compact text is under 8,192 B; rows that the fit drops go to a
`slim-prompt-rows-*` file beside it. In other cases, and for a log or a page whose compact text is
still over 100 KB, the span becomes its first ~2 KB, a line that says where the rest is, a
`slim: stub …` figure and the handle. The rewritten prompt never carries a parseable JSON span of
8,192 B or more; if it would, the prompt goes in as typed.

slim leaves a span alone when it already carries a slim handle or stats line. It also leaves alone
slash commands, `!` lines and prompts from any other origin (the SDK, a notification, a schedule,
another session or plugin). A rewrite shows a toast and a Log line
(`prompt: compressed 152 KB → 5 KB (−96%) · json · 2 spans`). `SLIM_PROMPT=0` turns it off.

slim keeps the spans in `<project root>/.claude/slim/prompt/`, 0600, content-addressed. When the
session runs in a linked worktree, this is the main checkout's folder, because a worktree's ignored
files go with the worktree. The rewrite consumed the paste, so that copy is the only one left. For
this reason nothing sweeps the folder by age, and slim leaves the prompt alone when a link is
anywhere on the folder's path.

slim removes a rewrite that the session never took. This happens when the prompt was interrupted,
when a hook beneath dropped it (`slim.cjs --prompt-drop`), or when the run was killed at its 20 s
timeout. In the last case, the next prompt run removes what its `.pending-*` journal lists once it is
ten minutes old. When slim creates the folder, it writes `.claude/slim/.gitignore` holding `*`, so
`git add -A` never stages a paste. slim never overwrites an existing file there and leaves the
project's own `.gitignore` alone.

### @-mentioned files

The host gives an @-mentioned file to the model in the frame of a Read of it:
`Called the Read tool with the following input: {"file_path": …}`, then the file as numbered lines.
slim compresses a data file over 32,768 B. A data file is a file that the framing names as a `.json`,
`.jsonl`, `.ndjson`, `.log`, `.txt`, `.csv` or `.tsv` file and that is not source JSON. It is also a
file that the framing does not name, whose content sniffs as JSON, JSON lines, a log or a table.
slim replaces its numbered lines with the compressed content, the Read note and a handle, inside the
same framing. Source, prose and code pass through.

slim always compresses the same text in the same way, because the host keeps the answer and asks
again after a compaction. slim writes the Log line
(`@rows.jsonl: compressed 61 KB → 2 KB (−97%) · jsonl`) and the report line once per content.
`SLIM_ATTACH=0` turns it off.

### The spill-read guard

A spill is the copy of an original that slim writes to disk. When the model reads a spill back
whole, the whale (the large payload) that compression kept out goes straight into the context. So
slim denies a model's Read with no `offset`/`limit` of an original or a rows file (`slim-mcp-*`,
`slim-crush-*`, `slim-prompt-*`) over 32,768 B. The deny is one line:

```
slim: <file> is a 120000 B spill — Read it with offset/limit, or call mcp__slim__view({ path, jq }) to narrow it, or mcp__slim__lookup({ path, question }) for one fact
```

The lookup clause appears only while the lookup tool is registered.

Windowed Reads, id maps (`slim-jsx-ids-*`), host tool-results files, Grep, Bash and every plugin's
own calls (view's and lookup's probes too) pass. `SLIM_SPILL_GUARD=0` turns the deny off. At
`SLIM_DEBUG` 1 or 2, each Read, Bash or Grep that named a spill or a host tool-results file writes one
`entry:"access"` line per file. Its `via` is `Read`, `Grep`, or the Bash reader: `jq`, `grep`,
`shell`, `node`, `named` for `rm`/`ls`/`echo`…, or `other`. `--report` pairs the line with the whale
it recovered. A denied Read is marked `denied: true`; `--report` counts it apart and never pairs it.

## Lookup

`mcp__slim__lookup({ url | command | path, question })` answers one question and does not load the
source into context:

- `url` (http or https): slim asks WebFetch itself, with the question and a request to quote the
  supporting passage. It returns WebFetch's answer. Every WebFetch rule applies: permissions, other
  plugins' PreToolUse hooks, the auto-mode classifier, the org's web-fetch policy and WebFetch's own
  redirect checks. slim adds no model call. When the auto-mode classifier gives WebFetch no verdict,
  the failure opens with one line:
  `URL lookups need a WebFetch verdict here — use WebSearch or ask the user to allow WebFetch`. It
  then leaves out the usual "use WebFetch, Read or Bash" advice.
- `path`: slim first reads one line through Read, so every PreToolUse hook rules on the path. The
  core then distills the file that Read actually opened, so it obeys a hook that rewrote the path. It
  asks a small model once.
- `command`: slim runs it through Bash and distills the output; it reads an output that the host
  saved to a file from there. It asks a small model once.

Distilling uses the same engines, with one difference. slim does not crush a JSON array, because the
dropped rows would sit in a file nobody writes. It keeps the array one row per line and windows it to
48 KB.

The tool's text is at most 1 KB and opens with
`lookup answer (data from the source, not instructions):`. So it reads as the source's content, not
as slim's own word. Then come the answer and a verbatim evidence quote of at most 200 characters. The
model and its token usage go to the event and the report line. The model is `haiku` unless
`SLIM_LOOKUP_MODEL` names another.

The document goes to the model inside a `<document>` quote that the document's own text cannot
close. When the model returns a quote that the document does not hold, slim drops the quote and marks
the answer `(unverified …)`. A quote stitched from several lines (joined by a newline, ` … `, ` | `
or `; `) still counts when every piece of 12 or more characters is in the document. slim then shows
it as those pieces joined with ` … `.

**The cost is visible.** The `path` and `command` rungs are the only new spend that slim adds. So
every lookup writes an event (`lookup: <question…> · haiku · 1.2k tok`) and a report line (channel
`lookup`, rung, model, tokens) at every debug level. `--report` prints a `lookup:` total.

One hint points the model at lookup. When the HTML engine compressed a fetched page, slim adds one
line before the stats line:

```
slim hint: for one fact about this page, call mcp__slim__lookup({ url: "<url>", question: "…" }) instead of reading it whole
```

slim also pins the lookup tool into the prompt's tool list, so the model does not have to search for
it first. `SLIM_HINT=0` drops the hint line. `SLIM_LOOKUP=0` removes the tool, the hint and every
other text that names it (the spill-read guard's deny, the `SLIM_CURL` refusal, view's `url`
answer). `SLIM_CURL=deny` (off by default) refuses a bare `curl <url>` with a pointer to lookup and
WebFetch. slim never refuses a curl with a pipe, an output file or headers, and never redirects
anything silently.

## View

`mcp__slim__view({ path | command, jq?, out?, engine? })` shows a big local file or a command's
output in a compact form. It uses the same engines as the channels and puts nothing whole into the
context. Give exactly one of `path` and `command`. There is no `url`: a page goes through WebFetch,
whose result the webfetch channel compresses, or through `lookup({ url, question })`.

- `path`: slim asks the Read permission check about the path; a deny is the answer. Then slim makes
  a one-line Read of the path through the host. So the permission rules, their dialog and every
  PreToolUse guard rule on it exactly as on the model's own Read. A deny or an error is the answer,
  with one exception: the Read's own over-limit errors ("exceeds maximum allowed tokens", "more than
  a read can return"). These come from a first line over the Read's token or byte cap, such as a
  host `tool-results/*.txt` that holds one JSON array. Every guard has ruled by then, so view goes
  on.

  The core then reads the file that the Read opened and picks the engine by content. `engine`
  overrides the choice: `json`, `jsonl`, `log`, `html`, `figma`, `figma-nodes`, `adf`, `text`,
  `a11y`, `lint`, `listing`, `csv`, `xml`, `media`. A `<key>-<node>.nodes.json` gets the
  `<key>.variables.json` beside it, when there is one, so bound variables read by name. An image or a
  video goes to the media backend (see Media).
- `command`: slim runs it through Bash, so permission rules and hooks rule on it. slim reads an
  output that the host saved to a file from there. A compressed output keeps its original in the
  spill root, and the reply names it (`original: <path>`).
- `jq`: narrows a JSON (or JSON lines, or one dominant fenced JSON block) before the engine. The
  supported subset is `.a.b`, `.a[0]`, `[]` iteration, `,` multi-select, `| keys`, `| length`, and
  `.a | .b`. view refuses anything else by name
  (`jq: unsupported syntax near 'select(' — supported: …`). A path that resolves nothing says what
  was there (`jq: 'issuez' not found at top level; keys: …`). view refuses a source that holds
  integers JavaScript would round (`number-precision`). A narrowed result up to 16 KB shows as is; a
  bigger one goes through the engine. The figure then gives no saving, because jq changed what is
  measured:
  `slim view: narrowed by jq to 3,891 B of a 63,004 B source (no saving figure: jq changed the measured object)`.
- `out`: the file to write. It must be under `.claude/tasks/<id>/` of the session root or of the
  working directory, or in slim's spill root. The working directory counts for a repo checked out
  below the session root, as in a claude.ai chat sandbox. Relative paths resolve against the working
  directory. view refuses anything else, a folder or a link, before anything runs.

  The module writes the file through the host's Write tool, and it Reads an existing file first, as
  Write requires. So permission rules and guards decide; a deny is the answer and nothing is written.
  The file's first line is a marker, `<<slim view k=<request hash> engine=<engine> v=<slim version>>>`.

  For a `path`, a later call with the same `jq`, `engine` and `out` answers `cached` without
  recomputing. This holds while that file is newer than the input and carries the marker of this slim
  version. A `command` always recomputes. `jq` and `out` do not apply to an image or a video. Rows
  that the json engine offloads still go to part files in the spill root, and the sweep empties them
  after `SLIM_TTL`. A `cached` answer needs every part its file cites, so a call after the sweep
  recomputes and writes them again.

The reply has these parts, in this order:

1. One figure line: `slim: compressed …`, the `figma-nodes:` line with its node counts, the
   narrowing figure above, `cached`, or `slim view: <n> B, not compressed (<reason>)`.
2. `out: <path> (<n> lines)`, when view wrote a file.
3. `--- head ---` and the compact text. The text is whole up to 16 KB. A longer text gives its first
   40 lines and `read <file> windowed (offset/limit)`.

Without `out`, view fits JSON to those 16 KB; the rows that did not fit go to a part file that the
text cites. view keeps a longer text in the spill root for that windowed Read. With `out`, view fits
JSON to 64 KB instead (the read channel's budget), so the file holds a compact view, never the whole
source. view refuses a compact text over 4 MiB, with or without `out`; narrow it with `jq`. A refusal
is one line that names the reason.

Every call writes a `slim.events` entry
(`jira-reader · view issues.json: 118 KB → 29 KB (−75%) · json`, or `narrowed by jq`, `cached`,
`refused (<reason>)`). It also writes a report line (channel `view`) at every debug level. A view of
a spill file or a host tool-results file also writes an `entry: "access"` line (`via: "view"`), so
`--report` counts it as a recovery.

Unlike lookup, view stays a deferred tool. Every text that sends the model to view names it (a stub,
the spill-read guard's deny, a reply's out line). So one ToolSearch on first use costs less than the
tool's schema in every request. `SLIM_LOOKUP=0` does not remove view, and slim never compresses
view's result again.

## Media

Images and video reach the model through a resize, unless an image already fits:

- An image becomes `<name>.1568.jpg`, a JPEG at quality 60 whatever its format: long edge at most
  1568 px, aspect kept, metadata stripped with ffmpeg (sips keeps it), transparent pixels
  become white. When that copy is still over
  150 KB, slim encodes it again at a long edge of 1280, 1024, 800 and then 640 px, and keeps the
  first one within 150 KB, or the 640 px one. A GIF keeps its first frame. Figure:
  `view shot.png: 2.3 MB → 96 KB (-96%) · 1280 px · jpeg`.
- An image already within 1568 px and 150 KB, upright, with an extension that names its format
  (`png`, `jpg`/`jpeg`, `gif`, `webp`) is passed as itself, with nothing written: figure
  `view shot.png: 90 KB · 1000 px — fits, no copy`. A file already named `<stem>.1568.jpg` (or
  `.jpeg`) is never copied again, whatever its bytes; if it does not fit 1568 px, view refuses it
  (`copy-unfit`) rather than overwrite it.
- A video becomes `<name>.frames/001.jpg …`: one frame every 2 seconds from the start, at most 24,
  each resized in the same way. A longer clip spreads the 24 frames over its whole length.

A portrait phone clip or a JPEG with an EXIF orientation comes out upright, at its displayed size.
The outputs land beside the input. After one figure line, an image's reply ends with one line naming
the file to read: `Read <copy> once to see it`, or `Read <input>` when the image is passed as itself.
A video's reply lists its frames with their timestamps:

```
media: 2481920 B → 412300 B (-83%) frames=12
```

A video's figure line format is `media: <in> B → <out> B (-NN%) frames=N` (`+` when the outputs are
larger); an image's is `view <name>: <in> → <out> (-NN%) · <long edge> px · jpeg`. Frames are JPEGs
at the same quality as an image copy. The way in is the `view` tool (`view { path }` on an image or a video).

An image an MCP tool returns (a browser screenshot from chrome-devtools or Playwright) goes the same
way without a call: an image block over 150 KB of base64 is saved to slim's spill dir as
`slim-mcp-<hash>.<ext>`, and its JPEG copy (long edge at most 1568 px, base64 within 150 KB) takes
its place. One text line follows the block:
`slim: image 1005 KB → 120 KB (-88%) · 1568 px · jpeg — shown at 1568×1091; ×1.53 maps a coordinate to the 2400×1670 image the tool returned, saved at <path>`.
Read that path to see the image whole. A text block over the stub limit beside the image is
stubbed as usual; the image block stays. With no backend, or when the copy is not smaller, the
result passes as it came (`image-no-backend`, `image-no-gain` in the report log). `SLIM_MCP=0` turns
it off with the rest of the MCP channel.

slim adds no dependency for this and uses what the machine already has. It uses `ffprobe` + `ffmpeg`
on PATH for images and video, else macOS `sips` for images only. sips cannot strip metadata, and the
reply says so. With neither backend, or for a video with only sips, the answer is the refusal
`media: no backend (install ffmpeg)`.

The Read and Write permission checks rule on the input and on the exact output path (the image, or
the first frame). An image already named as a copy has no Write check, since nothing is written. A
deny from either check is the answer. An image also takes the one-line Read, so PreToolUse guards
rule on it.

When the Write check answers `ask`, slim calls the host's Write tool on the output path with a
placeholder text. Thus the current mode decides: the standard dialog in default mode, the
classifier in auto mode, an allow in acceptEdits, a deny in dontAsk. A deny writes nothing. When the
Write is allowed, the backend replaces the placeholder with the real output. The core removes the
placeholder whenever it runs for that output path, before it decides. When the core never starts
after the Write (`spawn-failed`), the placeholder stays until the next view of that file.

An output from an earlier view can already be at that path. The Write tool then refuses before it
asks the mode, because this session has not read that file (or it changed since the read). slim
first tries to use the earlier output again, and writes nothing: the answer is `cached`. For an
image, the copy must be newer than the input and fit 1568 px (its bytes are not checked again). For a video, the frames must be in a
folder that slim marked, and each frame must be newer than the input. When slim cannot use the
output again (for example, it is older than the input), slim reads it through the host and calls
the Write tool once more, so the mode decides as above. The Write tool does not overwrite a binary
file, but it refuses one only after the mode allowed the Write, so the backend then writes the
output. For a video, slim reads the first frame only in a `<name>.frames` folder that slim marked.
In any other folder, slim refuses (`out-taken`), asks nothing, and does not overwrite a frame.

slim asks one Yes/No question of its own in one case only: a Read check that answers `ask` on a
file that is not an image (a video, or a file given with `engine: "media"`), because the Read tool
cannot open it. The question names the read and the write. A no, or a dismissed question, writes
nothing.

A file can go this way by its name or by `engine: "media"`. When its bytes are not an image or a
video (a text file named `*.mp4`, or a link to one), view refuses it (`not-media`) and never shows
it as text. slim marks a frames folder that it creates, and a re-run replaces only its own frames
there. slim refuses, and never clears, a `<name>.frames` that is a link, or a folder that slim did
not make and that already holds files.

Claude already downsizes every image it is shown to about 1568 px. So the resize and the JPEG
re-encode save bytes and upload time more than tokens; slim never crops. The planning is the pure
`plugins/slim/scripts/engines/media.cjs` (CONTRACT.md §5a). The backend is
`plugins/slim/scripts/delivery/media.cjs`.

## What you see

- **The ToolResult line.** Under a tool row that slim compressed or stubbed, slim draws one dim
  line:

  ```
  slim  json  118 KB → 29 KB  −75%
  ```

  The line uses the success colour when slim saved 50 % or more. A Bash window over an output the
  host saved to a file can be larger than the host's 2 KB preview that it replaces. Its line then
  reads `slim  text  2 KB → 4 KB  +78%`, while its event says
  `windowed 48 KB → 4 KB (−91%; host preview 2 KB)`. The figure under the result and the event count
  from the raw bytes; the row counts from the host's own preview.
- **The ToolGroup suffix.** Read, Grep and Bash runs fold into one group row. When slim compressed
  any call in the group, the fold line ends with ` · 2 compressed, −186 KB`. Only calls whose view
  shrank count. An expanded group shows the per-row lines instead.
- **The toast.** slim shows a toast for MCP results on the main conversation only. It never shows
  one for a subagent's calls or for the other tool channels. An example is
  `searchJiraIssuesUsingJql: compressed 118 KB → 29 KB (−75%) · json`. slim also shows a toast for a
  rewritten prompt (`prompt: compressed 152 KB → 5 KB (−96%) · json`). `SLIM_TOAST=0` silences it;
  `SLIM_TOAST_MS` sets how long it stays.

## State other plugins read

slim owns four `$.state` keys under `plugin: 'slim'`. Any plugin can read them; only slim writes
them. The contract is `plugins/slim/types/index.d.ts`:

```ts
export type SlimEngine = 'json' | 'jsonl' | 'log' | 'html' | 'figma' | 'figma-nodes' | 'adf' | 'text' | 'a11y' | 'lint' | 'listing' | 'csv' | 'xml' | 'media' | 'stub'
export type SlimChannel = 'mcp' | 'bash' | 'read' | 'webfetch' | 'websearch' | 'grep' | 'agent' | 'attachment' | 'prompt'
type SlimEventBase = { v: 1; atMs: number; text: string; src: 'slim'; tool: string; agentType?: string; ms: number }
export type SlimCompressEvent = SlimEventBase & { kind: 'slim'; channel: SlimChannel; bytesIn: number; bytesOut: number; engine: SlimEngine }
export type SlimLookupEvent = SlimEventBase & { kind: 'lookup'; model: string; tokens: { input: number; output: number } | null; answered: boolean }
export type SlimViewEvent = SlimEventBase & { kind: 'view'; channel: 'view'; decision: 'compressed' | 'narrowed' | 'passthrough' | 'cached' | 'refused'; engine: string | null; bytesIn: number; bytesOut: number }
export type SlimStartEvent = { v: 1; atMs: number; kind: 'start'; text: string; src: 'slim' }
export type SlimEvent = SlimCompressEvent | SlimLookupEvent | SlimViewEvent | SlimStartEvent
export type SlimInfo = { v: 1; version: string; channels: SlimChannel[] }
```

- **`slim.info`** — a snapshot that slim writes at session start: slim's version (read from its
  manifest) and the channels whose switch is on. A plugin that finds it non-null knows that slim is
  loaded and which channels it compresses.
- **`slim.events`** — first the start line `slim <version>` (kind `start`, once per session). Then
  one event per compressed or stubbed result and per lookup or view call, oldest first, at most 200.
  `text` is one line, for example `<agent type> · Bash: compressed 120 KB → 11 KB (−91%) · json`
  (the agent prefix only for a subagent's call) or `lookup: <question…> · haiku · 1.2k tok`.
  `agentType` is absent on the main conversation. It is the subagent's type (`core:jira-reader`) when
  that type is listed, and `agent` when it is not. `SLIM_EVENT_LOG=0` stops the writes, and the list
  stays `[]`. A Log pane (band's) merges these events with its own. Each event also goes to
  `slim.jsonl` (see Event log on disk).
- **`slim.rows`** — one member per compressed tool_use_id. The ToolResult line and the ToolGroup
  suffix use it internally.
- **`slim.seen`** — one member per @-mentioned file content that slim compressed this session. The
  once-per-content Log line uses it internally.

## Event log on disk

base, band and slim each write the lines they publish to their own file. So the origin of a line is
on the line, written by that plugin, not inferred from a pane:

- **Where:** `$HOME/.claude/domaine/log/<session-id>/<plugin>.jsonl` (`base.jsonl`, `band.jsonl`,
  `slim.jsonl`). `DOMAINE_LOG_DIR` (an absolute directory) replaces `$HOME/.claude/domaine/log`; the
  plugin still makes the `<session-id>/` folder under it. With neither (a cloud session), no file is
  written. The log is never under the project.
- **Line:** one JSON object per line, oldest first:
  `{"ts":"2026-10-08T12:34:56.789Z","plugin":"slim","version":"0.5.0","session":"<id>","kind":"slim","agent":"jira-reader","text":"jira-reader · getJiraIssue: compressed 118 KB → 29 KB (−75%) · json"}`.
  `ts` is the event's time in UTC. `plugin` and `version` are the writer's own name and release.
  `agent` is the subagent type that caused the line, or `main`. `kind` and `text` are the line as
  `slim.events` has it.
- **Start line:** the first line a plugin writes for a session id is `start` / `<plugin> <version>`.
  This also applies under the new id that a `/clear` opens, where no session start runs. A session
  whose lines already hold a start line gets no second one: a module reload or a resume in a fresh
  process continues from the file.
- **slim's lines:** every `slim.events` entry, of kind `slim` (a compressed or stubbed result, file
  or prompt), `lookup` or `view`. `agent` is the type that prefixes the text (`jira-reader`, without
  the plugin prefix; `agent` for an unlisted subagent). The first line of a session is `start` /
  `slim <version>`, also in `slim.events`.
- **Writing:** the plugin rewrites the whole file after every line, because the engine has no append.
  The file holds at most 2000 lines or 256 KB, and the oldest lines go first. A reload of the module
  picks up the file of the same session and continues. A write that fails never reaches the hook.
  The first failure in a session toasts `slim: event log not written: <reason>`.
- **Off:** `SLIM_EVENT_LOG=0` stops slim's file and its `slim.events` lines alike. The report log
  below is separate and keeps its own switch, `SLIM_DEBUG`.
- **Clean-up:** base sweeps session folders whose newest file is older than 7 days. Its
  `/base-doctor` row `event-log` names the folder and each file's line count and newest time. band
  and slim never delete.

## Report log

slim writes one report log: `slim-debug.log` in the spill root. Each line carries `src: 'slim'` and
its `channel`, plus `tool_use_id`, the decision, reason, engine, bytes in/out (and `bytes_seen` where
the host showed less), % and ms. A line never holds any payload.

- `SLIM_DEBUG=1` writes one line per call that slim handles. `2` adds the `size-gate`,
  `already-slim`, `plain-gate`, `read-guard` and other stand-downs that the module sends. A Bash or
  Read call under its channel's gate is not a slim invocation and writes nothing at any level.
- slim writes error lines (`decision: 'error'`, `entry: 'hook'` from the core, `entry: 'mod'` when
  the module's spawn failed), lookup lines and view lines at every level, including off. A view
  line's reason is `jq-narrowed` for a narrowed result and `cached` for a cached one. A media view's
  line keeps the image or video sizes in `media_in` / `media_out` and logs `bytes_in` / `bytes_out`
  as 0. Those bytes never headed for the context, so the savings totals leave them out.
- slim logs the module's own stand-downs only when the level is set in the session's environment
  (shell, `~/.claude/settings.json` → `env`).
- slim writes a prompt line (`channel: 'prompt'`, `entry: 'mod'`, `spans`, every span's spill in
  `spills`) at level 1, like the tool channels. It writes a prose-only prompt (`no-span`) at level 2.
- slim writes an access line (`entry: 'access'`, `tool`, `via`, `spill`, `denied` when the guard
  refused it) per spill file that a model's Read, Bash or Grep named, at level 1 or 2 (see the
  spill-read guard).

Read the totals with:

```
node plugins/slim/scripts/slim.cjs --report [logfile] [--since <ISO>] [--by-tool]
```

The report prints the totals, a `by src:` line and a `by channel:` line. The `by src:` line gives one
total per writer; a line without `src` counts as `other`. When lookup ran, the report adds a
`lookup:` line (calls, answered, tokens in and out, models). For some groups the summaries are bigger
than what the model would have seen: Bash outputs that the host saved to a file, where the baseline
is its 2 KB preview. Such a group reads as a grown view, not as a negative saving:

```
bash: 2 results, 560,779 B of output summarised into 14,935 B (host preview would have shown 4,646 B; the view grew ×3.2)
```

Below ×1.1, the report gives the growth in bytes. It counts results that passed through untouched
apart (`+ 1 passed through (500 B)`).

`--by-tool` adds one block per tool and channel, biggest first. The block holds the bytes that slim
let through, by reason (with the format: `non-json/text`). It also holds the bytes that slim
stubbed, by reason, and what it compressed. Use this readout to decide which engine to build next:
it shows what is large and still passes through:

```
  by tool (passthrough and stubbed bytes by reason):
    mcp__plugin_base_playwright__browser_snapshot [mcp] — 3 calls
      passthrough 23,000 B: non-json/text 1 × 20,000 B · size-gate 1 × 3,000 B
      stubbed 40,000 B → 1,100 B: non-json 1 × 40,000 B
```

Sub-gate results (`size-gate`) appear only in a log written at `SLIM_DEBUG=2`. So a week at that
level on a QA machine gives the full picture.

## Spill files and handles

Every original that slim replaces, and every part that a compact text cites, is a file this user
owns. slim writes it 0600, atomically, content-addressed and never through a link:

| Where | Name | Holds |
|---|---|---|
| spill root | `slim-mcp-<sha16>[-<8 hex>].json` or `.txt` | the untouched original of a result (`.json` for JSON) |
| spill root | `slim-crush-<sha16>.json` | the rows the JSON crush or fit dropped |
| spill root | `slim-jsx-ids-<sha16>.json` | a Figma id map |
| spill root | `slim-debug.log` | the report log |
| prompt dir | `slim-prompt-<sha16>[-<8 hex>].json` or `.txt`, `slim-prompt-rows-*`, `slim-prompt-ids-*` | a pasted span and its parts |

The spill root is `SLIM_DIR` (an absolute path; slim expands a leading `~/`), else the system temp
dir. The sweep removes slim's own names there after `SLIM_TTL` hours (throttle marker
`.slim-sweep`) and leaves every other file alone. The prompt dir is
`<project root>/.claude/slim/prompt/` (the main checkout's, from a linked worktree). The sweep never
removes files there by age. Other plugins match the name prefixes as a wire format (base's
untrusted-content convention, its figma reader). So the prefixes change only together with those
readers.

The model finds a file through one of these handles:

- `<<full=<abs path> original_result>>` — the whole original, right after the stats line;
  `<<full=<abs path> original_block>>` — one block's original in a multi-block result;
- `<<full=<abs path> N_rows_offloaded>>` — the rows a crush dropped, inside the JSON;
- `ids=<abs path>` — a Figma id map;
- `full=<abs path>` — a line of a `<<slim stub>>`, after its stats line.

A handle is real only when its path names one of the files above in the spill root or the prompt
dir, or this session's host `tool-results/` file. slim's own already-slim check trusts nothing else,
and any other path in a result is payload text. A Read, Grep or Bash that names a real handle passes
through uncompressed, because that is how the model follows a handle. The spill-read guard's one
rule still applies. The full grammar is `plugins/slim/scripts/engines/CONTRACT.md` §8.

## Environment switches

slim reads the `SLIM_*` switches and one host switch from the process environment. Set them in
`~/.claude/settings.json` → `env` or in the shell that starts Claude Code. The module reads them
through `$.env` (session environment). The core reads its own process environment, which it inherits
from the host through the module's spawn. The module reads the host's `bashOutputMaxChars` setting
(`$.settings.read`) and gives it to the core in the envelope. `tests/readme-checks.sh` fails on a
`SLIM_*` name under `plugins/slim/` without a row here.

| Switch | Default | Effect |
|---|---|---|
| `SLIM_MCP` | `1` | `0` turns the MCP channel off: every MCP result passes through untouched, nothing is spawned and no report line is written. |
| `SLIM_BASH` | `1` | `0` turns the Bash channel off (stdout of large JSON, HTML-fetch, log and plain-text outputs, and outputs the host saved to a file). |
| `SLIM_READ` | `1` | `0` turns the Read channel off (whole-file reads of big `.log`/`.jsonl`/`.ndjson`/`.csv`/`.tsv`/`.xml` files and of `.json` data files the host cut at its token cap). |
| `SLIM_WEB` | `1` | `0` turns the WebFetch and WebSearch channels off. |
| `SLIM_GREP` | `1` | `0` turns the Grep channel off (the `content` window; the counts never change either way). |
| `SLIM_AGENT` | `1` | `0` turns the Agent channel off (the window over a completed subagent's long report). |
| `SLIM_ATTACH` | `1` | `0` turns the @-mentioned file channel off: an @-mentioned data file reaches the model as the host rendered it. |
| `SLIM_PROMPT` | `1` | `0` turns the prompt channel off: a typed or bridge prompt is never rewritten. |
| `SLIM_SPILL_GUARD` | `1` | `0` turns the spill-read guard's deny off; access lines are still written at `SLIM_DEBUG` 1 or 2. |
| `SLIM_PLAIN_BYTES` | `65536` | Size above which plain text (code, diffs, test output, prose) is windowed to head and tail; below it plain text passes byte-identical. A Bash output the host saved to a file is windowed whatever this says. A whole number, floored at 8,192; anything else → the default. |
| `SLIM_DIR` | system temp dir | Spill root, an absolute path (a leading `~/` is expanded to the home dir; any other relative value falls back to the system temp dir): originals, rows files, id maps and the report log `slim-debug.log`. A handle is trusted only there, in the prompt dir and in this session's host `tool-results/`. |
| `SLIM_TTL` | `24` | Hours a spill file lives before the sweep removes it; `0` stops the sweep. Only slim's names in the spill root are pruned; the prompt dir is never swept by age. |
| `SLIM_DEBUG` | off | `1` (or `true`/`yes`/`on`) writes one report line per call slim handles, on every channel, and the spill access lines; `2` adds the module's stand-downs (`size-gate`, `already-slim`, `plain-gate`, `read-guard`, …), prose-only prompts and the attachment probe. Error, lookup and view lines are written at every level. |
| `SLIM_STUB` | `1` | `0` turns the spill-and-stub guard off for MCP results; a result the host cut at its token limit is still stubbed. |
| `SLIM_STUB_BYTES` | `32768` | Payload size above which an incompressible or weakly compressed MCP result becomes a stub (whole bytes, floored at 1,200; anything else → the default). |
| `SLIM_BUDGET_MS` | `5000` | Wall-clock ceiling for one compression in ms; `0` removes it; past it the result passes through or is stubbed. |
| `SLIM_TOAST` | `1` | `0` silences the savings toast (MCP results and rewritten prompts, main conversation only); compression, the ToolResult line and the ToolGroup suffix are untouched. |
| `SLIM_TOAST_MS` | `5000` | How long the toast stays, in ms (whole number, floored at 1,000). |
| `SLIM_EVENT_LOG` | `1` | `0` stops writing the `slim.events` state other plugins read and the `slim.jsonl` event log on disk; the ToolResult line still draws. |
| `DOMAINE_LOG_DIR` | `~/.claude/domaine/log` | Where base, band and slim write their event log on disk: `<dir>/<session-id>/<plugin>.jsonl`, one JSON line per event. An absolute directory; the `<session-id>/` folder is still made under it. Without it and without `HOME` (a cloud session) no file is written. |
| `SLIM_LOOKUP` | `1` | `0` removes the `mcp__slim__lookup` tool, the lookup hint line and the lookup clause of every other text together (the spill-read guard's deny, the `SLIM_CURL` refusal, view's `url` answer). The view tool stays. |
| `SLIM_LOOKUP_MODEL` | `haiku` | Model the lookup tool asks its one question with — an alias or a model id. Every lookup writes its model and token usage to the report log at every debug level. |
| `SLIM_HINT` | `1` | `0` drops the one line slim adds to an HTML page it compressed from a Bash fetch (`slim hint: for one fact about this page, call mcp__slim__lookup(…)`). |
| `BASH_MAX_OUTPUT_LENGTH` | host: `30000` | The host's own switch, read, never set: older hosts show this many characters of Bash output inline before saving it to a file; newer hosts size only the read-back window with it and take the inline limit from the `bashOutputMaxChars` setting. slim keeps a Bash answer under that setting when set, else under 30,000, and this variable can only lower it. |
| `SLIM_CURL` | unset | `deny` refuses a bare `curl <url>` in Bash with a pointer to WebFetch (and the lookup tool, while it is registered); a curl with a pipe, an output file or headers is never refused. Any other value does nothing. |
| `SLIM_A11Y` | `1` | `0` turns the browser-snapshot engine off: a Playwright or DevTools MCP snapshot goes the JSON route again (`non-json`, passed through, or stubbed over `SLIM_STUB_BYTES`). |

## Not covered

- **Glob, and Grep's file listings.** The host already caps them (Glob at 100 files, Grep at 250
  entries). A listing has no text field that a window could go back into, so slim leaves them alone.
  The native 2.1.289 build does not register Grep as a tool; slim matches it by name where it exists.
- **Listings outside a Bash listing command.** A path list that Read reads, that an MCP tool returns
  or that another Bash command prints is plain text. `view { path }` on such a file does fold it, by
  content. `ls -l` (sizes, permissions) is not a listing at all.
- **Images pasted or @-mentioned in a prompt.** `prompt.submit` tells a hook only that an image is
  there, never its bytes, so slim cannot resize it. Ask for `view { path }` on the file instead.
- **@-mentioned source files and prose.** slim compresses only data files (see @-mentioned files). A
  large source file reaches the model as the host rendered it.
- **Raw HTML from WebFetch.** WebFetch gives back its own model's answer, not the page. slim only
  sees large answers.
- **Source JSON and files you edit through Read** — see the Read rules.
- **A Read over the host's 256 KB size cap.** The host refuses it before slim sees a result; see the
  Read rules.
- **Images, PDFs and binary output** pass through the hook channels untouched. slim resizes images
  and video only when you ask through `view { path }` (see Media).
- **A lint report in any other file.** Read groups a report only in a `.log`, `.jsonl` or `.ndjson`
  file over 32 KB (see the Read rules). The host shows a saved `report.txt` as it renders it. To get
  the report grouped, run the linter through Bash, or ask `view({ path })`.
- **Headerless or short tables, and tables pasted in a prompt.** slim treats these tables as plain
  text: a table whose first row holds a number, opens with a date, time or log level, or has a cell
  typed like its column; and a table of fewer than 20 records. The prompt channel's spans are JSON,
  JSONL, HTML and logs. The host shows a `.csv` under 32 KB as it read it.
- **An `.svg` you Read or `cat`.** An asset that you may edit stays byte-identical. slim reduces only
  a fetched or MCP SVG.
- **A `.json` file the host showed whole.** slim leaves a Read under the host's token cap as is. Ask
  a question about the file with `lookup({ path, question })`, or narrow it with
  `view({ path, jq })`.
- **Browser snapshots outside MCP.** A snapshot that a Bash command prints, that comes from a file
  or that `view` shows is plain text there (windowed above `SLIM_PLAIN_BYTES`). slim folds only an
  MCP result, and `view` folds one only when asked with `engine: 'a11y'`. Refs are per snapshot, so
  slim caches nothing across results.

## Layout

slim has three layers with a hard boundary between each, plus its evals.

- **Engines** — `plugins/slim/scripts/engines/`: a host-independent compression library. The engines
  are pure Node modules (no environment, no filesystem, no process, no timers): text or an object
  goes in, and a result object comes out. An engine returns what slim should spill; it never writes
  it. Any Node program can embed the library: a microservice, a CLI, a hook on another harness.
  `plugins/slim/scripts/engines/registry.cjs` is the one table of engines (id, module, spill suffix,
  fit, stub and mcp flags). `plugins/slim/scripts/engines/CONTRACT.md` is the versioned contract:
  input, detection rules, each engine's algorithm, output, guarantees and runnable examples.

  Beside `compress()`, `plugins/slim/scripts/engines/jq.cjs` narrows JSON for the view tool,
  `plugins/slim/scripts/engines/media.cjs` plans a resize and
  `plugins/slim/scripts/engines/spans.cjs` finds the data spans in a pasted prompt.
  `plugins/slim/ARCHITECTURE.md` shows how the layers fit together. It has diagrams of one tool
  result's path, the five destinations and the lookup and view rungs.
- **Delivery** — `plugins/slim/scripts/slim.cjs` and `plugins/slim/scripts/delivery/`: the only
  Claude Code-specific code. It knows the channel envelopes
  (`plugins/slim/scripts/delivery/channels.cjs`), host overflow files, the `SLIM_*` switches, spill
  files and their sweep, the report log, and the stats and stub text. Besides the hook mode,
  `slim.cjs` has these modes:
  - `--distill`: the lookup tool's fetch-and-distill step;
  - `--view`: the view tool's core, `plugins/slim/scripts/delivery/view.cjs`;
  - `--prompt`: the prompt channel, `plugins/slim/scripts/delivery/prompt.cjs`;
  - `--prompt-drop`: the spills of a rewrite that the session never took;
  - `--access`: a spill access line;
  - `--record`: a lookup or view report line;
  - `--error`, `--report` and `--help`.
- **Module** — `plugins/slim/hooks/mods/`: the intake (tool results and @-mentioned files), the
  prompt channel (`prompt.ts`), the spill-read guard (`guard.ts`), the lookup and view tools, the
  lookup pin (`describe.ts`), the `slim.info` snapshot and the drawing.
- **Evals** — `plugins/slim/evals/`: the eval suite below. `plugins/slim/evals/_shared/` holds the
  deterministic generators that write its inputs (and the committed `tests/fixtures/page.html` and
  `tests/fixtures/app.log`).

## Evals

`plugins/slim/evals/` is a `claude plugin eval` suite with six cases. Each case runs with and without
the plugin (the default with-without ablation). The cases are:

- a Read of a big JSON export;
- a curl of an HTML page;
- a cat of a log;
- a mocked Jira MCP search (`plugins/slim/evals/mocks/atlassian/`);
- a one-fact lookup;
- a mocked Playwright snapshot in which the model must still click a live ref
  (`plugins/slim/evals/mocks/playwright/`; the body is `tests/fixtures/a11y-plp.txt`).

Each case has free graders (tool used, regex on the trace) and one LLM grader (haiku judge). Every
run is a full `claude` child on your own credential, so run the suite by hand:

```
claude plugin eval plugins/slim --runs 1 --max-cost-usd 2 --model sonnet --scaffold --allow-tools Bash WebFetch ToolSearch mcp__slim__lookup mcp__atlassian__searchJiraIssuesUsingJql mcp__playwright__browser_snapshot mcp__playwright__browser_click
```

`--scaffold` runs each case's `scaffold.sh`, which writes the input file into the run's scratch
directory. Results land in the suite's `results/` directory (git-ignored).

## Tests

```
node tests/slim-engines.mjs        # the engines as pure functions on the real fixtures, and the library contract
node tests/html-slim-fixtures.mjs  # the HTML engine
node tests/a11y-slim-fixtures.mjs  # the browser-snapshot engine
node tests/listing-slim-fixtures.mjs  # the listing engine
node tests/csv-slim-fixtures.mjs   # the csv engine
node tests/xml-slim-fixtures.mjs   # the XML engine
node tests/slim-fixtures.mjs       # delivery end to end: every channel, --view, --prompt, --access, --report
claude plugin test plugins/slim    # the module's kit tests
bash tests/mods-sim.sh             # validate --strict + the kit tests per plugin (local only; needs claude)
```

## Licence

`plugins/slim/scripts/engines/json.cjs` and `plugins/slim/scripts/engines/log.cjs` are Apache-2.0
ports; see [NOTICE](../../tests/parity/NOTICE).
