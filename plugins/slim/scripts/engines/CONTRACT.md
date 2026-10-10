# slim engines — library contract v1

`plugins/slim/scripts/engines/` is a compression library any Node program can embed: a microservice,
a CLI, a hook on another harness. It takes one payload, decides what kind of data it is, compresses it
with the algorithm for that kind, and returns the result as data. It never reads the environment,
never touches the filesystem or the network, never starts a timer and never logs. Whatever has to be
kept — the original, the rows a crush dropped — comes back in the result for the **caller** to store.

```js
import { compress, sniff, peek } from './engines/index.cjs';   // or: const { compress } = require(…)
```

Dependency-free: Node built-ins only, and of those only `crypto` (content hashes). Every engine file
requires nothing but `crypto` and its siblings.

## 1. Input

One call: `compress(input, options)`.

`input`

| field | type | meaning |
|---|---|---|
| `data` | `string \| Buffer \| object` | the payload. A Buffer is checked for binary magic bytes, then decoded as UTF-8. An object is serialized with `JSON.stringify` (a circular one is refused). |
| `hint` | `{ mime?, filename?, source?, variables? }` | optional. Detection is content-based and never reads it. An engine may read documented fields: **figma-nodes** reads `variables` (the Figma `/v1/variables/local` payload, an object) and `filename` (a `<key>-<node>.nodes.json` name gives the file key). A hint that is not a plain object is ignored. |

`options` (all optional)

| option | default | meaning |
|---|---|---|
| `budgetBytes` | `null` | byte budget of the plain-text window (`null` → 12288). When set, html output is clipped to it too (body windowed first, links and scripts kept). |
| `maxMs` | `5000` | wall-clock budget. `0` = none; a negative value = already expired (the deterministic way to test the budget path). Every engine checks it before it starts; json and log also between stages, html every 512 tokens, and figma discards a pass that ends late. Past it the input comes back as `passthrough` / `budget-exceeded`. A single regex or stage already running is not interrupted, so the overrun is bounded by that unit, not by `maxMs`. |
| `engines` | all | allow-list of engine ids. A payload sniffed as another engine comes back `passthrough` / `engine-not-allowed`. |
| `engine` | `null` | run this engine and skip detection (the caller already knows the kind). |
| `profile` | `'default'` | the only profile in v1. Anything else → `refused` / `bad-option`. |
| `plainBytes` | `65536` | plain text at or under this size is never windowed (`passthrough` / `plain-gate`). |
| `spillDir` | `''` | prefix of the paths the text cites for parts (`<<full=<spillDir>/<name> …>>`). Empty → the bare name. |
| `spillNames` | `{ original: 'slim-original-', rows: 'slim-rows-', ids: 'slim-ids-' }` | name prefix per spill kind. |
| `trace` | `false` | fill `stats.stages` with the pipeline stages that changed bytes. |
| `targetBytes` | `null` | json / jsonl and figma-nodes: the size the caller can show. A JSON body still above it after the crush runs the `trim` and `fit` stages (see **json**); a node tree above it folds its deepest levels (see **figma-nodes**). Other engines ignore it. |
| `maxInputBytes` | `67108864` | larger input → `refused` / `too-large`. |
| `marker` | `'handle'` | `'ccr'` reproduces Headroom's content-hash crush marker; parity tests only. |

An option of the wrong type is `refused` / `bad-option`, with the field named in `warnings`.

## 2. Detection

`sniff(input)` → `{ engine, confidence, reason }`, where `engine` is one of `json | jsonl | log | html
| figma | figma-nodes | adf | text | binary | none` and `confidence` is 0..1. Content only; first match wins:

1. **binary** — a Buffer starting with PNG, JPEG, GIF8, `%PDF-`, zip (`PK\x03\x04`), gzip (`1F 8B`),
   `RIFF…WEBP`, wasm (`\0asm`), ELF or Mach-O magic, or holding a NUL byte in its first 8192 bytes; a
   string holding a NUL there, or starting with `%PDF-` or `\u0089PNG`.
2. **none** — empty or whitespace only.
3. **json / adf / figma-nodes** — the text (BOM stripped) opens with `{` or `[` and `JSON.parse` accepts it;
   a bare `{type:'doc', content:[…]}` Atlassian document is `adf`; a Figma REST nodes response — an
   object whose non-empty `nodes` map holds, for every id, a `document` with a string `type`, at least
   one of them with `absoluteBoundingBox` or `children` — is `figma-nodes` (confidence 0.95, reason
   `figma-rest-nodes`). Anything else, including a `nodes` map with a null or document-less entry, is `json`.
4. **figma** — Figma design-context JSX: `data-node-id="`, `className="` and `var(--` each at least 3 times.
5. **guards → text** — text no transforming engine may touch, checked in the first 64 KB:
   `diff` (two or more `diff --git` / `--- a/` / `+++ b/` / `@@ -n,n +n,n @@` lines), `test-output`
   (jest `PASS`/`FAIL` heads and `Tests:` totals, TAP `ok n`, `N passing/passed/failed`, pytest `===
   … passed … ===`, go `--- PASS`/`ok  pkg 0.4s`, rspec `N examples, N failures`, three or more ✓/✗
   lines), `template` (`{%`, `{{`, `<%`, `<?php`), `code` (a `#!` shebang), `xml` (`<?xml`, or a
   leading tag that is not an HTML document).
6. **fence** — one dominant markdown fence (≥ 80 % of the bytes, ≤ 3 preamble and trailer lines): the
   body's engine, reason `fence`.
7. **jsonl** — two or more lines, every non-blank line a JSON object or array.
8. **code → text** — non-markup text where 30 % of the first 200 non-empty lines open like code
   (`import`, `const`, `function`, `def`, `return`, `{`, `}`, `//`, …). After the fence and JSONL rules,
   because a JSON line opens with a brace too.
9. **html** — opens with `<!doctype html` or `<html`, or has `<head`/`<body` in the first 2048 chars.
10. **log** — the log detector's confidence ≥ 0.5 (level fields such as `ERROR`/`[warn]`/`error:`).
11. **text** — reason `prose`.

`peek(text)` → `{ format, hint }`: a one-line shape hint (`array of N`, the top-level keys, or a
whitespace-collapsed head preview) for a caller that shows a stub instead of a payload.

## 3. Engines

**json** — the shape-driven JSON pipeline, in order: ADF documents → markdown; noise drop (`null`,
`{}`, `[]`, avatar/thumbnail keys, Atlassian `self` REST links); opaque long strings (data URIs, base64,
URLs over 160 chars) clipped to 64 chars plus their length; then the crush of uniform arrays (a port of
Headroom's SmartCrusher): an array of 5+ same-shape objects keeps about 15 position anchors spread
over its front, middle and back, plus every error row, structural outlier, numeric anomaly and change
point (so more than 15 rows can stay, and the first row is not guaranteed), and the dropped rows leave as
a `rows` part cited by `{"_ccr_dropped":"<<full=<path> N_rows_offloaded>>"}`; number and string arrays
are sampled with a `…N more of M omitted` element. With `targetBytes` set and the crushed body still
above it, two more stages run on its row arrays (arrays of objects): `trim` cuts the long prose
strings in the rows of every row array (over 340 chars, holding whitespace, not under an
`id`/`key`-named field) to their first 300 chars plus `… [+N chars]`, longest first across arrays,
until the body fits; `fit`, if it still does not, keeps an evenly spaced subset of the largest row
array's rows (first and last included) and moves the rest, as
their untrimmed originals, to another `rows` part cited the same way. Each leaves a warning (`trim: N
long strings cut to 300 chars`, `fit: N of M rows offloaded to meet targetBytes`), and a body that
still misses the target says so (`targetBytes T not met: B B`). Keys, numbers and short strings are
never touched; `spill` is the untouched input as always. It also unwraps a dominant markdown fence and a pure
MCP text-block envelope and slims what is inside; the prose around a fence counts against `targetBytes`. Never touches: error envelopes (`isError`, non-empty
`errors`/`userErrors`, `error`) — `passthrough` / `error-shape`; numbers `JSON.parse` cannot round-trip
— `passthrough` / `number-precision`. A result that is not smaller is `passthrough` / `no-gain`.

**jsonl** — the same pipeline over the rows of a JSON-lines stream, crushed as the array they are.

**log** — signal selection for log and build output (a port of Headroom's LogCompressor): keeps error
and fail lines with their context, stack traces (up to 3 traces of 20 lines; runtime frames collapse
first), summary lines, a few warnings; repeated warnings are deduplicated with a ` ×N` count; a
trailer counts the lines omitted per level. It selects lines, it never samples or rewrites one. Logs
under 50 lines pass through.

**html** — a page reduced to what a reader takes from it: `# <title>`, one `meta:` line
(`description`, `og:title`, `canonical`), the visible body text with h1–h6 as `#…`, list items as `- `
/ `1. `, `pre` fenced, inline `code` in backticks and table rows joined with ` | `; then `links (N):`
(`- <text> → <href>`, deduped by href, first text wins, at most 200 then `- … N more`) and `scripts (N):`
(every `<script src>` in page order). Dropped: script, style, svg, noscript, template, iframe and canvas
contents, comments, and the text of nav, footer, aside and aria-hidden subtrees (their links are still
listed). Entities are decoded. Malformed markup degrades to text.

**figma** — lossless compaction of Figma dev-mode design-context JSX: repeated `className` values move
to a `C17:` legend (repeated `var(--…)` tokens inside it to `$N`), `data-node-id` values become `#n17`
with the map leaving as an `ids` part (`ids=<path>` in the header), and identical sibling subtrees fold
to one exemplar plus a line listing what differed. The output starts with `<<slim-jsx>>` (a wire
format other plugins match).

**figma-nodes** — a Figma REST `GET /v1/files/:key/nodes` response as a markdown build tree, one line
per visible node: `[TYPE] "name" #id WxH @x,y`, then the TEXT content (in full), a `T<n>` type style
from a document-wide table, and the attributes (auto-layout, sizing, fills, strokes, radius, effects,
grids, constraints when not TOP/LEFT, named styles, component props).
Measurements round to 0.5 px. Dropped: vector geometry, `absoluteRenderBounds`, `exportSettings`,
thumbnails, the instance `overrides` array, and `visible:false` subtrees (counted). Adjacent siblings
identical apart from id, position, image ref and text fold into one exemplar with a `×N` mark and a
`folds ×N` block listing, per folded sibling, every id and what differed — so every visible node id and
every text value stays in the output. With `targetBytes` set and the tree above it, the deepest level
folds first, one level per pass, until the text fits: each node at the new last level keeps its line
plus `… N nodes deeper folded` under it, the `nodes:` header adds `· N below depth D folded to fit`,
the stage is `depth` and the warning `depth: N nodes below depth D folded to meet targetBytes`; the
ids and texts below depth D are then only in the original, and two siblings at depth D fold into one
exemplar only when what they folded is identical too, apart from ids and absolute position. It
never folds past the root's direct children; a tree that does not fit even then comes back whole.
With `hint.variables` a bound value reads `$Collection/Name (<node value>)` and the header says
`tokens: variables`; without it bindings read `$var:<short id>`. A variable whose modes resolve to
≥ 2 distinct values adds `; modes Desktop 20 · Mobile 15` inside the parentheses (first 4 modes, then
`· +N more`; an alias into another collection resolves in that collection's default mode; an
unresolvable or cyclic mode is left out) — never `/`, so `pad a/b/c/d` and `[size]/lh` keep their
separators. A dominant markdown fence around the response is unwrapped, its preamble and trailer
kept. The result carries `meta: { nodes, hidden,
folded }`; `figureLine(bytesIn, bytesOut, meta)` exported by `figma-nodes.cjs` prints
`figma-nodes: <in> B → <out> B (-NN.N%) nodes=N hidden=N folded=N`. The original's spill name ends
`.json`.

**adf** — a bare Atlassian document converted to markdown (media render as `_(media omitted)_`).

**text** — the plain-text window, the only thing slim ever does to code, diffs, test output or prose:
at or under `plainBytes` nothing happens; above it the head keeps whole lines up to a third of
`budgetBytes`, the tail fills the rest, and one marker line in between says
`[slim: <hidden> of <total> lines hidden (<bytes> B)]`. Fewer than 3 lines, a first/last line that
overflows its share, or whole lines that fill less than half of `budgetBytes`, falls back to a
character window with `[slim: <bytes> B hidden]`. No line is
rewritten.

## 4. Output

```ts
{
  v: 1,
  engine: 'json'|'jsonl'|'log'|'html'|'figma'|'figma-nodes'|'adf'|'text'|'binary'|'none',  // the engine that produced the text
  decision: 'compressed' | 'passthrough' | 'refused',
  reason?: string,      // why not compressed
  format?: string,      // diagnostic tag of a non-JSON passthrough (html | xml | broken-json | text)
  text: string,         // the compressed text; on passthrough the input as a string; '' when refused
  stats: { bytesIn, bytesOut, pct, ms, stages: string[] },   // pct = saved %, one decimal, may be negative
  spill?: { kind: 'original', payload, suggestedName },      // compressed only: the input, to keep
  parts?: [{ kind: 'rows' | 'ids', payload, suggestedName }],// payloads the text cites by path
  window?: { lines_total, lines_hidden, bytes_hidden },      // text engine only
  meta?: { nodes, hidden, folded },                         // figma-nodes only: visible, hidden-dropped, folded node counts
  warnings: string[],
}
```

`suggestedName` = `spillNames[kind] + sha256(payload)[0..16] + ('.json' | '.txt')`. The text cites a part
as `<spillDir>/<suggestedName>`, so a caller that stores parts under `spillDir` by those names makes
every handle resolve. What happens to `text`, `spill` and `parts` — a file, a database row, an HTTP
reply — is the caller's decision.

Passthrough reasons: `empty`, `engine-not-allowed`, `plain-gate`, `no-gain`, `non-json`, `error-shape`,
`number-precision`, `budget-exceeded`, `transform-error`, and per engine `non-log`, `non-figma`,
`non-figma-nodes`, `non-adf`. Refused reasons: `bad-input`, `bad-option`, `too-large`, `binary`.

## 5. Guarantees

- **Deterministic**: the same input and options give the same result, byte for byte, apart from
  `stats.ms` — and, when `maxMs` is positive, apart from whether the budget elapsed. With `maxMs: 0`
  the whole result except `stats.ms` is reproducible.
- **Never throws**: bad input or options come back `refused` with a reason; an engine failure comes back
  `passthrough` / `transform-error`.
- **No I/O**: no filesystem, network, environment, stdin/stdout, child processes or logging. `Date.now`
  is read only for `maxMs` and `stats.ms`; no timers are started; no global is touched.
- **Memory**: about 6× the input at peak (the text, its parse, and the per-stage copies).

## 5a. Media planning (`media.cjs`, beside compress())

Images and video are binary, so `compress()` refuses them (`binary`). `media.cjs` is a separate pure
module that only **plans** what a media file becomes for a model; a caller with a backend (ffmpeg,
sips) runs the plan. It reads no file and runs nothing.

- `kindOf(head: Buffer) → { kind: 'image'|'video', format } | null` from the first bytes (64 are
  enough): images `png`, `jpeg`, `gif`, `webp`; video `mp4`, `mov` (ISO-BMFF `ftyp`, still-image
  brands such as `heic`/`avif` excluded → `null`), `webm`, `mkv`, `avi`.
- `target(facts, opts) → rel | null`: the first output's path relative to the input's directory,
  from `kind`, `name` and `ext` alone (no probe, no bytes beyond the kind), so a caller can run its
  Write permission check on exactly the path the backend will write: an image is
  `<name>.<longEdge>.<ext>` where `<ext>` is the input's own extension lowercased when it is `png`,
  `jpg`, `jpeg` or `gif`, and `png` otherwise (WebP, no extension, anything else); a video is
  `<name>.frames/001.jpg`. `null` without a name or a media kind.
- `plan(facts, opts)` with `facts = { kind, format, name, ext, width, height, durationS, rotation }`
  (what a probe measured; `name` is the basename without its extension; `width × height` are the
  stored dimensions and a quarter-turn `rotation` in degrees, from a display matrix or EXIF
  orientation, swaps them to the displayed ones) and
  `opts = { longEdge = 1568, everyS = 2, maxFrames = 24, scene = false }`:
  - image → `{ kind, outputs: [{ rel: target(facts, opts) }], source: { w, h }, scale: { w, h },
    resized }` (`source` is the displayed size, `scale` the output size): long edge capped, aspect
    kept, never upscaled (an image already within the cap is still re-encoded, to drop its metadata).
  - video → `{ kind, dir: '<name>.frames', outputs: [{ rel: '<name>.frames/NNN.jpg', t }], source,
    scale, resized, interval, scene }`: one frame every `everyS` seconds from t = 0, at most
    `maxFrames`; a clip longer than `everyS × maxFrames` widens the interval to
    `duration / maxFrames` so the frames span the whole clip. `scene: true` lists `maxFrames` slots with `t: null` and `interval: null` (the
    backend writes as many as the cuts give).
  - missing or non-positive dimensions, or a video without a duration → `{ refused: 'no-probe' }`;
    a kind other than image / video → `{ refused: 'not-media' }`.
- `figureLine(bytesIn, bytesOut, frames)` → `media: <in> B → <out> B (-NN%) frames=N` (whole percent,
  `+` when the outputs outweigh the input; an image is `frames=1`).

## 5b. JSON narrowing (`jq.cjs`, beside compress())

A caller that wants one part of a JSON document asks `jq.cjs` for it before any engine runs (slim's
view tool does, for its `jq` argument). Pure; it requires only its siblings.

- `narrow(text, src)` →
  - `{ decision: 'narrowed', text, value, diags }`: `value` is what the expression selects and `text`
    is `JSON.stringify(value)`; `diags` name the terms that resolved nothing (each one `null` in the
    value);
  - `{ decision: 'whole' }`: the expression selects the whole document (`.`, `..`, `.[]`, `. | .`,
    `., .`), so there is nothing to narrow;
  - `{ decision: 'refused', reason, message }` with `reason` one of `jq-unsupported` (the message
    names the first unsupported token), `jq-not-json`, `number-precision` (the source holds integers
    `JSON.parse` would round, so a re-serialized value would carry different numbers) and `jq-miss`
    (no term resolved anything; the message names where the walk died and what was addressable
    there: `jq: 'issuez' not found at top level; keys: total, issues`).
- The source is JSON, JSON lines (an array of the rows) or one dominant markdown fence holding either.
- The grammar: `expr := term (',' term)*` — a multi-select answers with one array, one slot per
  term; `term := path ('|' filter)*`; `path` is a dot path (`.a.b`, `.a[0]`, `.a.[0]`, a leading
  `.` optional) with `[]` fan-out at any segment (an object fans out to its values);
  `filter := 'keys' | 'length' | a leading-dot path` (`.a | .b` ≡ `.a.b`). A filter after a fan-out
  applies per element. `keys` sorts an object's names and gives an array's indices; `length` counts
  elements, keys or code points, is a number's magnitude and 0 for null. A path segment names an
  object's own key or an array's index only (`.constructor`, `.__proto__` on an object without that
  key, or `.length` on an array or a string, is a miss). Inside a fan-out a missing key is `null`,
  as in jq. Recursive descent, `//`, `?`, function calls, quoted keys, literals and
  comparisons are refused, never guessed at.
- `parse(src)`, `whole(expr)` and `evaluate(root, expr)` are the steps `narrow` runs; `GRAMMAR` is
  the one-line grammar the refusal quotes.

## 5c. Data spans in a mixed text (`spans.cjs`, beside compress())

A caller holding text that mixes prose with pasted data (slim's prompt channel) asks `spans.cjs`
where the data is, compresses each span with `compress()`, and splices the results back. Pure.

- `spans(text, { min = 8192 }) → [{ start, end, kind }]`, ordered and non-overlapping, offsets in
  UTF-16 code units, each span at least `min` UTF-8 bytes; `kind` is
  - `json` — a `{` / `[` matched to its closer (string state tracked from the opener; a raw line
    break ends a string, since no JSON string spans one) that `JSON.parse` accepts;
  - `jsonl` — two or more consecutive lines that each parse as an object or array;
  - `html` — a line opening `<!doctype html` / `<html` through the end of the first `</html>` tag
    (text after the tag on its line stays outside);
  - `log` — a run of timestamp- or level-led lines that `log.cjs`'s detector scores at 0.5 or more.
    Stack frames (`    at fn (file:1:2)`, `  File "x.py", line 3`, `Caused by`, `... N more`) join
    and may end the run; a tab- or `...`-led line only joins it, and the run ends at its last log line
    or stack frame, so an indented line of prose after the paste is never inside it;
  - any of the four for the body of a fenced block (```` ``` ```` / `~~~`), by `sniff()`; the fence
    lines are not part of the span, and a fence whose body is anything else is not mined at all.
- Never a span: prose; anything under `min`; a span holding `<<full=`, a stub mark or a `slim:` stats
  line, or followed within 400 characters by
  such a stats line or handle (already compacted text); JSON after an opener of at least `min` bytes of
  remainder that never closes (a truncated paste).
- The JSON scan's work is bounded by `8 × text.length + 65536` steps; an adversarial text that
  exhausts it gives `[]`. `jsonBlobs(text, min) → { blobs: [{ start, end }], openAt, bailed }` is that
  scan alone (a caller re-checks its output with it: slim's prompt channel refuses a rewrite that
  still holds a parseable JSON span of `min` bytes).

## 6. Versioning

`Result.v` is the contract version. A new engine, a new option or a new result field is a minor change
and keeps `v: 1`; changing the meaning or shape of an existing field bumps `v`. A new suffix inside an
engine's rendered text is minor too: figma-nodes' `; modes …` on a bound value (slim 0.8.0) kept
`v: 1`. Adding an engine is one file exporting `{ id, run(text, opts, ctx) }` (`ctx.deadline`, `ctx.part(kind, payload) → citePath`,
`ctx.hint` — the input's hint, `{}` when absent),
one row in the `ENGINES` table of `index.cjs` and one rule in `sniff.cjs`.

## 7. Examples

A microservice — POST a body, get the result back as JSON. Save it as `server.mjs` in
`plugins/slim/scripts/` (or point the import at wherever `engines/` lives) and run `node server.mjs`
(`PORT` picks the port, 8080 by default):

<!-- example:server -->
```js
import http from 'node:http';
import { compress } from './engines/index.cjs';
http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const result = compress({ data: Buffer.concat(chunks), hint: { mime: req.headers['content-type'] } });
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
  });
}).listen(process.env.PORT ?? 8080, function () { console.log(`slim engines on :${this.address().port}`); });
```

`curl -s --data-binary @page.html localhost:8080 | jq -r .text` prints the reduced page.

slim's own Claude Code delivery (`plugins/slim/scripts/slim.cjs`) calls the library like this for a
Bash `curl` result, then stores `spill` and the cited `parts` under its spill root and appends the
recovery handle. Save it as `delivery.cjs` next to `engines/` and run `node delivery.cjs < page.html`:

<!-- example:delivery -->
```js
const fs = require('fs'), os = require('os'), path = require('path');
const { compress } = require('./engines/index.cjs');
const stdout = fs.readFileSync(0, 'utf8');
const dir = os.tmpdir();          // the spill root the parts are written to
const result = compress({ data: stdout }, {
  engine: 'html',                 // what the channel admits for this command
  budgetBytes: 12288, plainBytes: 65536, maxMs: 5000, spillDir: dir,
  spillNames: { original: 'slim-mcp-', rows: 'slim-crush-', ids: 'slim-jsx-ids-' },
});
if (result.decision !== 'compressed') process.stdout.write(stdout);
else {
  for (const s of [result.spill, ...(result.parts || [])]) fs.writeFileSync(path.join(dir, s.suggestedName), s.payload, { mode: 0o600 });
  process.stdout.write(`${result.text}\n\n<<full=${path.join(dir, result.spill.suggestedName)} original_result>>\n`);
}
```

## 8. Handles and trusted dirs (slim's delivery, not the library)

The library returns spills and parts; where they land and how text cites them is the caller's. slim's
Claude Code delivery uses this grammar, and slim itself treats a handle as real only when its path
names one of these files (a sibling plugin's untrusted-content rule uses the same set):

- `<<full=<abs path> original_result>>` — the whole original (a stats line sits right before it);
  `<<full=<abs path> original_block>>` — one block's original in a multi-block result;
  `<<full=<abs path> N_rows_offloaded>>` — the rows the crusher dropped; `ids=<abs path>` — Figma's
  id map; `full=<abs path>` — the line after a `<<slim stub>>` head and its stats line.
- Trusted dirs: the spill root (`SLIM_DIR`, else the OS temp dir), the host's
  `<config>/projects/<dir>/<session id>/tool-results/`, and the prompt channel's durable
  `<project root>/.claude/slim/prompt/` (the main checkout's root for a linked worktree; slim writes
  `.claude/slim/.gitignore` holding `*` when it creates the dir, and never overwrites one already there).
- Names: `slim-mcp-<sha16>[-<8 hex>].json|txt` (originals), `slim-crush-<sha16>.json` (rows; `.txt` for a view's compact text),
  `slim-jsx-ids-<sha16>.json` (id maps) in the spill root; `slim-prompt-<sha16>[-<8 hex>].json|txt`,
  `slim-prompt-rows-<sha16>.json`, `slim-prompt-ids-<sha16>.json` in the prompt dir; the report log
  is `slim-debug.log` in the spill root. These names are a wire format: other plugins
  key on these names, so a rename changes this section first.
- The spill root is absolute: a leading `~/` in `SLIM_DIR` is expanded, any other relative value falls
  back to the OS temp dir, so every handle names an absolute path.
- Stats line, right before a handle or as a stub's second line:
  `slim: compressed|stub <in> B → <out> B (−NN.N%)` (`+` when it grew; thousands with commas). The
  `→` figure is the exact byte size of the value it sits in. `<<slim-jsx>>` opens the figma
  engine's output (§3) and counts as already compact too.
- A `<<slim stub>>` names its recovery as `mcp__slim__view({ path: <full> })` (with
  `jq: "<jq-path>"` in §5b's grammar for JSON) or a windowed Read (offset/limit) of the `full=` file.
