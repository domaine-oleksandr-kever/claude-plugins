# slim

Slim is the universal tool-result compression proxy for Claude Code. One `tool.call` handler sees
every tool result — MCP, Bash, Read, WebFetch, WebSearch, Grep, Glob and Agent — and shrinks the
large ones before they reach the context. It decides by content, never by tool name: JSON goes to
the JSON compressor, a log to the log engine, an HTML page to the HTML engine, Figma design-context
JSX to the JSX compactor, and plain text (code, diffs, test output) is at most windowed. A `lookup`
tool answers one question about a page, a command's output or a file without loading it whole. The
hooks run wherever the plugin loads; the drawing (the ToolResult line, the ToolGroup suffix and the
toast) shows in the terminal and the desktop app.

Current release: **slim v0.4.0**.

## Status

- **Functional** for MCP, Bash, Read, WebFetch, WebSearch, Grep, Glob and Agent results, plus the
  `lookup` tool.
- Claude Code only: slim is a hooks module (mods), which other hosts do not run. It never runs as
  a classic PostToolUse hook.
- @-mentioned file attachments are observed, not rewritten (see [Not covered](#not-covered)).

## Install

```
/plugin install slim@domaine
```

## How it works

The module (`plugins/slim/hooks/mods/intake.ts`) lets the tool run first. It then measures the
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

### Channels

| Channel | Candidate when | What slim does |
|---|---|---|
| MCP (`mcp__*`) | result over 4,096 B, or the host's overflow notice | JSON engines, else spill-and-stub (below) |
| Bash | stdout over 4,096 B that is JSON, JSONL or (for a fetch command) HTML; over 16,384 B from a log command; over `SLIM_PLAIN_BYTES`; or any output the host saved to a file | stdout only; stderr and the other fields are kept |
| Read | a whole-file read of a `.log`, `.jsonl` or `.ndjson` file over 32,768 B, or of a `.json` data file the host cut at its token cap | the file view is compressed; see the Read rules below |
| WebFetch | result over 16,384 B that is JSON or HTML, or over `SLIM_PLAIN_BYTES` | JSON, JSONL and HTML engines, else a window |
| WebSearch | a result string over `SLIM_PLAIN_BYTES` | that string is windowed; the others are untouched |
| Grep, Glob | listing over 16,384 B | window with an 8,192 B budget; `numFiles`, `numLines` and `numMatches` never change |
| Agent | a completed subagent's text block over `SLIM_PLAIN_BYTES` | that block is windowed |

Calls a subagent makes go through the same handler; their events carry the agent type.

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
- a Bash command that runs slim's or fnd's own compressor CLIs (`own-cli`);
- a Bash command or a Read that names a spill file or a host tool-results file (`spill-read`) —
  this is how the model follows a `<<full=` handle, so it must see the bytes as they are;
- a Read with `offset`, `limit` or `pages` (`windowed-read`), and every Read the rules below do
  not admit (`read-guard`);
- a result that already carries a slim or fnd mark (`already-slim`).

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

The handle names a spill copy of the original, not the file itself, so fnd's handle rule holds
unchanged.

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
  spilled and replaced by a ~1 KB stub that opens `<<slim stub>> <tool> returned <N> B (format=…)`
  and gives `node …/plugins/slim/scripts/json-slim.cjs <file> …` recovery recipes. On the other
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

Spill files keep fnd's `fnd-*` name prefixes, so fnd's handle rules and its spill-access hook treat
slim's handles exactly like their own.

## Lookup

`mcp__slim__lookup({ url | command | path, question })` answers one question without loading the
source into context:

- `url` (http or https): slim asks WebFetch itself, with the question and a request to quote the
  supporting passage, and returns WebFetch's answer. Every WebFetch rule applies — permissions,
  other plugins' PreToolUse hooks, the auto-mode classifier, the org's web-fetch policy and
  WebFetch's own redirect checks — and slim adds no model call.
- `path`: slim first reads one line through Read, so every PreToolUse hook (fnd's guard included)
  rules on the path; the core then distills the file that Read actually opened (a hook that
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

## Next to fnd

fnd's `FND_COMPRESSION` switch (root README) decides who compresses MCP results:

- **`proxy`** — fnd hands MCP compression to slim. fnd's classic `mcp-slim` hook exits before node,
  and fnd's module passes MCP results through untouched while slim's `slim.info` lists the `mcp`
  channel. If slim is missing, disabled, older than 0.3.0 or has `SLIM_MCP=0`, fnd keeps
  compressing and says so once per session. fnd's scratch-file sweep still runs once per session.
- **`builtin`** (the default) — fnd compresses MCP results, slim sees a result fnd has already
  slimmed and stands down with `already-slim`. Up to the largest stub size it is fnd's own rule (a
  stub mark, or a stats line beside a `<<full=` handle). A bigger result counts only when it ends in
  the compressed tail or opens with the stub head, its stats line's `→` figure is the result's exact
  size, and its handle names a regular file this user owns in a spill directory or this session's
  host tool-results. A result over 4 KB that fnd passed through is run through slim again.
  One exception follows from module order, which the engine leaves unspecified between two
  user-installed plugins: a result the host cut at its token limit reaches both modules as the
  host's short notice. When slim's module sits beneath fnd's, slim expands and compresses it first,
  and the model sees slim's label; fnd's module checks for slim's labels before it looks for a host
  notice, so it then passes the result through rather than expanding a quote of the notice inside
  slim's output.

fnd compresses only MCP tool results (and JSON pasted into a prompt), so the other channels are
slim's in both modes.

Both plugins use one spill directory and one report log. Each sweeps with its own throttle
marker; slim's sweep prunes only the names it writes, which fnd writes too, so the longer of
`SLIM_TTL` and `FND_MCP_SLIM_TTL` decides. Keep `SLIM_DIR` unset or equal to `FND_MCP_SLIM_DIR`:
fnd trusts `<<full=` handles only there and in system temp.

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
  for the other channels), e.g. `searchJiraIssuesUsingJql: compressed 118 KB → 29 KB (−75%) · json`.
  `SLIM_TOAST=0` silences it; `SLIM_TOAST_MS` sets how long it stays.

## State other plugins read

slim owns three `$.state` keys under `plugin: 'slim'`. Any plugin reads them; only slim writes them.
The contract is `plugins/slim/types/index.d.ts`:

```ts
export type SlimEngine = 'json' | 'jsonl' | 'log' | 'html' | 'figma' | 'adf' | 'text' | 'stub'
export type SlimChannel = 'mcp' | 'bash' | 'read' | 'webfetch' | 'websearch' | 'grep' | 'glob' | 'agent'
type SlimEventBase = { v: 1; atMs: number; text: string; src: 'slim'; tool: string; agentType?: string; ms: number }
export type SlimCompressEvent = SlimEventBase & { kind: 'slim'; channel: SlimChannel; bytesIn: number; bytesOut: number; engine: SlimEngine }
export type SlimLookupEvent = SlimEventBase & { kind: 'lookup'; model: string; tokens: { input: number; output: number } | null; answered: boolean }
export type SlimEvent = SlimCompressEvent | SlimLookupEvent
export type SlimInfo = { v: 1; version: string; channels: SlimChannel[] }
```

- **`slim.info`** — a snapshot written at session start: slim's version (read from its manifest)
  and the channels whose switch is on. A plugin that finds it non-null knows slim is loaded; fnd's
  `FND_COMPRESSION=proxy` reads it.
- **`slim.events`** — one event per compressed or stubbed result and per lookup, oldest first, at
  most 200. `text` is one line, e.g. `<agent type> · Bash: compressed 120 KB → 11 KB (−91%) · json`
  (the agent prefix only for a subagent's call) or `lookup: <question…> · haiku · 1.2k tok`.
  `agentType` is absent on the main conversation, the subagent's type (`fnd:jira-reader`) when it is
  listed, and `agent` when it is not. `SLIM_EVENT_LOG=0` stops the writes, and the list stays `[]`.
  fnd's Log pane merges these events with its own.
- **`slim.rows`** — one member per compressed tool_use_id; internal to the ToolResult line and the
  ToolGroup suffix.

## Report log

slim writes to the same report log as fnd: `fnd-mcp-slim-debug.log` in the spill root. Each of its
lines carries `src: 'slim'` and its `channel`, plus `tool_use_id`, the decision, reason, engine,
bytes in/out (and `bytes_seen` where the host showed less), % and ms — never any payload.

- `SLIM_DEBUG=1` writes one line per call slim handles; `2` adds the `size-gate`, `already-slim`,
  `plain-gate`, `read-guard` and other stand-downs the module sends. A Bash or Read call under its
  channel's gate is not a slim invocation and writes nothing at any level.
- Error lines (`decision: 'error'`, `entry: 'hook'` from the core, `entry: 'mod'` when the module's
  spawn failed) and lookup lines are written at every level, including off.
- The module's own stand-downs are logged only when the level is set in the session's environment
  (shell, `~/.claude/settings.json` → `env`).

Read the totals with:

```
node plugins/slim/scripts/slim.cjs --report [logfile] [--since <ISO>]
```

It prints the totals plus a `by src:` line (`fnd … · slim …`), a `by channel:` line and, when
lookup ran, a `lookup:` line (calls, answered, tokens in and out, models). A group whose summaries are
bigger than what the model would have seen — Bash outputs the host saved to a file, where the
baseline is its 2 KB preview — reads as a grown view rather than a negative saving:

```
bash: 2 results, 560,779 B of output summarised into 14,935 B (host preview would have shown 4,646 B; the view grew ×3.2)
```

Below ×1.1 the growth is given in bytes, and results that passed through untouched are counted apart
(`+ 1 passed through (500 B)`).

## Layout

slim has two layers with a hard boundary between them.

- **Engines** — `plugins/slim/scripts/engines/`: a host-independent compression library. Pure Node
  modules (no environment, no filesystem, no process, no timers): text or an object in, a result
  object out. An engine returns what should be spilled; it never writes it. Any Node program can
  embed it — a microservice, a CLI, a hook on another harness. The versioned contract — input,
  detection rules, each engine's algorithm, output, guarantees and runnable examples — is
  `plugins/slim/scripts/engines/CONTRACT.md`.
  How the layers fit together, with diagrams of one tool result's path, the five destinations and the
  lookup rungs: `plugins/slim/ARCHITECTURE.md`.
- **Delivery** — `plugins/slim/scripts/slim.cjs` and `plugins/slim/scripts/delivery/`: the only
  Claude Code-specific code. It knows the channel envelopes (`plugins/slim/scripts/delivery/channels.cjs`),
  host overflow files, the `SLIM_*` switches, spill files and their sweep, the shared report log and
  the stats and stub text. Besides the hook mode, `slim.cjs` has `--distill` (the lookup tool's
  fetch-and-distill step), `--record` (a lookup report line), `--error`, `--report` and `--help`.
- **Module** — `plugins/slim/hooks/mods/`: the intake, the lookup tool, the description note, the
  `slim.info` snapshot and the drawing.
- **Evals** — `plugins/slim/evals/`: the eval suite below; `plugins/slim/evals/_shared/` holds the
  deterministic generators that write its inputs (and the committed `tests/fixtures/page.html` and
  `tests/fixtures/app.log`).

The older single-file compressors — `json-slim.cjs`, `log-slim.cjs`, `figma-node-slim.cjs`,
`adf-to-md.cjs`, `adf-colors.cjs` and `env-file.cjs` in `plugins/slim/scripts/` — stay in place,
untouched, until a later cleanup made with the live data in hand. Delivery still uses `env-file.cjs`
(so the shared report log resolves the way fnd's does), and the stub's recovery recipes still name
`json-slim.cjs`. `figma-node-slim.cjs` (the Figma REST node-tree compactor) is not on the dispatch
path and has no engine: REST node trees are JSON and go through the JSON engine. The `figma` engine
is the design-context JSX compactor.

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

## Not covered

- **Grep and Glob on native builds.** The native 2.1.289 build does not register Grep or Glob as
  tools; slim matches them by name where they exist. The host already caps both (Grep at 20,000
  characters and 250 entries, Glob at 100 files), so the channel rarely fires.
- **@-mentioned file attachments.** The attachment is the host's framed, line-numbered rendering of
  the file, and rewriting it is unproven, so slim never touches it. At `SLIM_DEBUG=2` an attachment
  over 32 KB writes one report line (channel `attachment`, reason `not-covered`, its shape as
  `format`) to measure the case.
- **Raw HTML from WebFetch.** WebFetch hands back its own model's answer, not the page; slim only
  sees large answers.
- **Source JSON and files you edit through Read** — see the Read rules.
- **A Read over the host's size limit.** The host refuses it before slim sees a result.
- **Images, PDFs and binary output** pass through.
- **A `.json` file the host showed whole.** A Read under the host's token cap is left as is, and
  under fnd's `FND_COMPRESSION=proxy` fnd's session note on running `json-slim` over big local dumps
  is gone too, so a 40–75 KB JSON export read whole reaches the model raw. Ask a question about it
  with `lookup({ path, question })` instead.

## Environment switches

slim's switches — `SLIM_MCP`, `SLIM_BASH`, `SLIM_READ`, `SLIM_WEB`, `SLIM_GREP`, `SLIM_AGENT`,
`SLIM_PLAIN_BYTES`, `SLIM_DIR`, `SLIM_TTL`, `SLIM_DEBUG`, `SLIM_STUB`, `SLIM_STUB_BYTES`,
`SLIM_BUDGET_MS`, `SLIM_TOAST`, `SLIM_TOAST_MS`, `SLIM_EVENT_LOG`, `SLIM_LOOKUP`,
`SLIM_LOOKUP_MODEL`, `SLIM_HINT` and `SLIM_CURL` — are documented in
[the root README's Environment switches table](../../README.md#environment-switches), next to fnd's.

The channel switches (`SLIM_MCP`, `SLIM_BASH`, `SLIM_READ`, `SLIM_WEB` for WebFetch and WebSearch,
`SLIM_GREP` for Grep and Glob, `SLIM_AGENT`) take `0` to turn one channel off; an off channel writes
no report line. The core reads `SLIM_DIR`, `SLIM_TTL` and `SLIM_DEBUG` directly and falls back to
`FND_MCP_SLIM_DIR`, `FND_MCP_SLIM_TTL` and `FND_MCP_SLIM_DEBUG` when the slim name is unset.
`FND_MCP_SLIM_STUB_BYTES` also widens the size bound of the `already-slim` check, so a raised fnd
stub threshold is still recognised.

`SLIM_*` are read from the process environment only, never from the Domaine env files — set them in
`~/.claude/settings.json` → `env`.

## Tests

```
node tests/slim-engines.mjs        # the engines as pure functions on the real fixtures, and the library contract
node tests/html-slim-fixtures.mjs  # the HTML engine
node tests/slim-fixtures.mjs       # delivery end to end: every channel's decisions, restored shapes, --report
bash tests/mods-sim.sh             # validate --strict + the module's kit tests (local only; needs claude)
```

## Licence

`plugins/slim/scripts/engines/json.cjs` and `plugins/slim/scripts/engines/log.cjs` (and the older
`json-slim.cjs` and `log-slim.cjs`) are Apache-2.0 ports; see [NOTICE](../../tests/parity/NOTICE).
