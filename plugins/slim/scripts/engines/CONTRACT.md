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
| `hint` | `{ mime?, filename?, source? }` | optional, carried for the caller. Detection is content-based and does not read it. |

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
| `targetBytes` | `null` | json / jsonl only: the size the caller can show. A body still above it after the crush runs the `trim` and `fit` stages (see **json**). Other engines ignore it. |
| `maxInputBytes` | `67108864` | larger input → `refused` / `too-large`. |
| `marker` | `'handle'` | `'ccr'` reproduces Headroom's content-hash crush marker; parity tests only. |

An option of the wrong type is `refused` / `bad-option`, with the field named in `warnings`.

## 2. Detection

`sniff(input)` → `{ engine, confidence, reason }`, where `engine` is one of `json | jsonl | log | html
| figma | adf | text | binary | none` and `confidence` is 0..1. Content only; first match wins:

1. **binary** — a Buffer starting with PNG, JPEG, GIF8, `%PDF-`, zip (`PK\x03\x04`), gzip (`1F 8B`),
   `RIFF…WEBP`, wasm (`\0asm`), ELF or Mach-O magic, or holding a NUL byte in its first 8192 bytes; a
   string holding a NUL there, or starting with `%PDF-` or `\u0089PNG`.
2. **none** — empty or whitespace only.
3. **json / adf** — the text (BOM stripped) opens with `{` or `[` and `JSON.parse` accepts it; a bare
   `{type:'doc', content:[…]}` Atlassian document is `adf`.
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
to one exemplar plus a line listing what differed. The output starts with `<<fnd-jsx-slim>>`.

**adf** — a bare Atlassian document converted to markdown (media render as `_(media omitted)_`).

**text** — the plain-text window, the only thing slim ever does to code, diffs, test output or prose:
at or under `plainBytes` nothing happens; above it the head keeps whole lines up to a third of
`budgetBytes`, the tail fills the rest, and one marker line in between says
`[slim: <hidden> of <total> lines hidden (<bytes> B)]`. Fewer than 3 lines, or a first/last line that
overflows its share, falls back to a character window with `[slim: <bytes> B hidden]`. No line is
rewritten.

## 4. Output

```ts
{
  v: 1,
  engine: 'json'|'jsonl'|'log'|'html'|'figma'|'adf'|'text'|'binary'|'none',  // the engine that produced the text
  decision: 'compressed' | 'passthrough' | 'refused',
  reason?: string,      // why not compressed
  format?: string,      // diagnostic tag of a non-JSON passthrough (html | xml | broken-json | text)
  text: string,         // the compressed text; on passthrough the input as a string; '' when refused
  stats: { bytesIn, bytesOut, pct, ms, stages: string[] },   // pct = saved %, one decimal, may be negative
  spill?: { kind: 'original', payload, suggestedName },      // compressed only: the input, to keep
  parts?: [{ kind: 'rows' | 'ids', payload, suggestedName }],// payloads the text cites by path
  window?: { lines_total, lines_hidden, bytes_hidden },      // text engine only
  warnings: string[],
}
```

`suggestedName` = `spillNames[kind] + sha256(payload)[0..16] + ('.json' | '.txt')`. The text cites a part
as `<spillDir>/<suggestedName>`, so a caller that stores parts under `spillDir` by those names makes
every handle resolve. What happens to `text`, `spill` and `parts` — a file, a database row, an HTTP
reply — is the caller's decision.

Passthrough reasons: `empty`, `engine-not-allowed`, `plain-gate`, `no-gain`, `non-json`, `error-shape`,
`number-precision`, `budget-exceeded`, `transform-error`, and per engine `non-log`, `non-figma`,
`non-adf`. Refused reasons: `bad-input`, `bad-option`, `too-large`, `binary`.

## 5. Guarantees

- **Deterministic**: the same input and options give the same result, byte for byte, apart from
  `stats.ms` — and, when `maxMs` is positive, apart from whether the budget elapsed. With `maxMs: 0`
  the whole result except `stats.ms` is reproducible.
- **Never throws**: bad input or options come back `refused` with a reason; an engine failure comes back
  `passthrough` / `transform-error`.
- **No I/O**: no filesystem, network, environment, stdin/stdout, child processes or logging. `Date.now`
  is read only for `maxMs` and `stats.ms`; no timers are started; no global is touched.
- **Memory**: about 6× the input at peak (the text, its parse, and the per-stage copies).

## 6. Versioning

`Result.v` is the contract version. A new engine, a new option or a new result field is a minor change
and keeps `v: 1`; changing the meaning or shape of an existing field bumps `v`. Adding an engine is one
file exporting `{ id, run(text, opts, ctx) }` (`ctx.deadline`, `ctx.part(kind, payload) → citePath`),
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
  spillNames: { original: 'fnd-mcp-slim-', rows: 'fnd-crush-', ids: 'fnd-jsx-ids-' },
});
if (result.decision !== 'compressed') process.stdout.write(stdout);
else {
  for (const s of [result.spill, ...(result.parts || [])]) fs.writeFileSync(path.join(dir, s.suggestedName), s.payload, { mode: 0o600 });
  process.stdout.write(`${result.text}\n\n<<full=${path.join(dir, result.spill.suggestedName)} original_result>>\n`);
}
```
