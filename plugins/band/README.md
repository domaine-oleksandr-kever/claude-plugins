# band

Band draws what a Claude Code session shows around the prompt: the **status band** above the
prompt (prompt-cache countdown, model, context use, every rate-limit window, the session's cost,
the task digest and the Compact / Clear / Progress / Log buttons), the **Progress pane** with the
task checklist and the **event log pane**. It draws and nothing else. The figures come from the
session itself; the checklist and most log lines come from the other plugins in this marketplace,
which publish them through `$.state`: base (or fnd, on an install that has not moved to base yet)
publishes the resolved task and its own events, slim publishes its compression events, and the team
plugins on base (fe, qa, be, pm) publish their own start, install and doctor lines. Band reads them;
it never writes another plugin's state.

Current release: **band v0.4.0**.

## Status

- Claude Code only: band is a hooks module (mods), which other hosts do not run. It ships no
  Cursor, Codex or OpenCode adapter, and `scripts/install.sh --plugin band` exits 2.
- Works alone. With base or fnd it adds the task digest, the Progress pane and that plugin's log
  lines; with slim it adds slim's log lines; with a team plugin (fe, qa, be, pm) that plugin's log
  lines. None of them is a dependency.
- The drawing shows in the terminal and in the desktop app's Code tab. Where nothing draws (a cloud
  session, the VS Code chat panel, `claude -p`) the hooks still run and `/band-log` and
  `/band-progress` answer as text.

## Install

```
/plugin install band@domaine
```

Update fnd first: an fnd release older than the one that yields to band (0.134.0 and earlier) still
draws its own band, and only one plugin's band can show above the prompt, so load order decides which.
A current fnd sees band loaded and stops drawing (see [Next to fnd](#next-to-fnd)).

fnd's `FND_BAND_COST` does not carry over: set `BAND_COST=1` in `~/.claude/settings.json` → `env` to
keep the cost segment. Which plugins to install for what is the matrix in
[the root README](../../README.md#which-plugins-to-install).

## Status band

One row, most important first. 170 columns, context at 47 %, an account reporting three
windows, base resolving a task:

```text
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
cache 42m │ fable-5-1 │ ctx 47% │ 5h 61% · 7d 34% · 7d·fable 12% │ cost $12.40 │ ELC-1591 3/5 ▶ Preview themes for QA review │ [ Compact ]  [ Clear ]  [ Progress ]  [ Log ]
```

120 columns, same session. The row is 172 cells, so the Log button goes first, then Clear, then the digest:

```text
cache 42m │ fable-5-1 │ ctx 47% │ 5h 61% · 7d 34% · 7d·fable 12% │ cost $12.40 │ [ Compact ]  [ Progress ]
```

60 columns. The rate windows go next, the least full one first, then the model:

```text
cache 42m │ ctx 47% │ [ Compact ]  [ Progress ]
```

The full drop order is: the Log button (`/band-log` still opens the pane), the Clear button (`/clear`
still works), the digest, the cost, then the rate windows beyond the fullest (least full first), then
the last window, then the model, then the Progress button. Cache, ctx and Compact are never dropped.
The row's text truncates as a backstop, so the band never takes a second row.

| Segment | Shows | Rule |
|---|---|---|
| cache | `cache 42m`, `<1m`, `cache cold`, `cache —`, `cache ●` | Minutes left of the prompt cache: the last main-thread response plus the TTL. `●` while a turn runs; `—` before the first response and after `/clear` or resume; `cold` once the TTL has passed, after a compaction, or after a `/model` switch that forfeits the cache (another model, or the host reports it cold). A resumed session takes its state from the time since the last response. Hidden while any rate window is at or past 100 %: in overage the TTL is unknown. **It is an estimate.** The host reports no cache state, only the events it is derived from. |
| model | `fable-5-1` | The model id as the session reports it, without the `claude-` prefix every id carries. A `/model` switch updates it from the switch event itself; every measurement re-reads it, so a switch the event missed shows by the next response. **On the terminal it is a picker:** the segment reads `fable-5-1 ▾` and is a button (hotkey `m` while the band holds the keyboard: ctrl+x tab, or a click). Pressed, the row folds its figures away and holds the models alone, in place: `model fable-5-1  opus-5-5  sonnet-5-5  haiku-4-5-20251001` (plus the session's own id first when it is none of these, say a pinned `[1m]` id), the current one bright and the rest dim, each with its first letter as hotkey (`f`, `o`, `s`, `h`). Tab or a letter picks one; the pick runs `/model <id>` as typed, toasts its output and folds the row back, which then follows the switch event. The current model only folds the row; a turn or `/clear` folds it too. The band never grows: its region clips anything drawn outside its own two rows, so no list can pop over the transcript. The desktop app has its own model menu, so there the segment stays text. |
| ctx | `ctx 47%`, `ctx —` | Context-window use. It is `—` on a fresh session until the first response. Right after a compaction it shows the engine's own count of what was kept over the window (`ctx 3%`), or `—` when the engine reported no count; that count holds until a response reports a measured fill, as a reading with no fill (only the window) keeps the last one. A compaction reaches the band two ways, the `session.compact` chain and the engine's own `PostCompact` report (the settings-hook event, which arrives even when the chain skips the mod, as it did for a Compact press on Claude Code 2.1.289); reports within 30 s of each other are one compaction. Mid-turn it refreshes on a 30 s tick. |
| rates | `5h 61% · 7d 34% · 7d·fable 12%` | **Every** window the API reports, in its order, separated by a dim `·`: `five_hour` → `5h`, `seven_day` → `7d`, `spend_limit` → `$`; an unknown kind keeps a shortened raw name (`7d·fable`); past 100 % reads `>100%`. Empty off a subscription and before the first reading. |
| cost | `cost $12.40` | Opt-in: drawn only with `BAND_COST=1` in the session's environment. What the session has cost at API prices, as `/cost` totals it (`usage().cost.usd`). A subscription is not billed per request, so there it is a measure of work, not a bill. Hidden while it is zero and where the host keeps no ledger. |
| digest | `ELC-1591 3/5 ▶ Preview themes` | The task base (or fnd) resolved, same on the terminal and the desktop: work id · checked/total rows of the workspace's `progress.md` · the current row as the publisher writes it (cut to 28 characters); `ELC-1591 ✓ 5/5` when all are done; the bare id (`ELC-1588`) while the workspace has no `progress.md` yet, or while the ticket you named has no workspace at all. Hidden while the Progress pane is open, when the publisher resolves nothing, and without base or fnd. |
| Compact | `[ Compact ]`, `c: Compact` | Always drawn first and always pressable, so the other buttons never shift: before the first reading, while a turn runs and at any context. From 80 % between turns it switches to the accent color. While the band holds the keyboard it reads `c: Compact`. A press runs `/compact` and toasts the result (`compacted 412,000 → 38,000 tokens`, or why it was skipped or refused). Where the engine refuses compaction from a plugin (a headless / SDK session such as the desktop app), the press runs the `/compact` slash command as if typed instead and toasts its output. Pressed while a turn runs it only toasts `turn is running — press Compact again when it ends`; nothing is queued. |
| Clear | `[ Clear ]`, `x: Clear` | Runs `/clear` behind the engine's own Yes/No dialog (`Clear the conversation?`), always: the dialog takes the keyboard, so a stray click or hotkey never clears, and a dismissed dialog is a No. Toasts the command's output. Pressed while a turn runs it only toasts `turn is running — press Clear again when it ends`. Dim at rest, `x: Clear` while the band holds the keyboard. |
| Progress | `[ Progress ]`, `p: Progress` | Drawn only while base or fnd resolves a task (its `base.progress` or `fnd.progress` carries a work id). Opens or closes the [Progress pane](#progress-pane); dim at rest, `p: Progress` while the band holds the keyboard |
| Log | `[ Log ]`, `l: Log` | Drawn only while some event list (band's, base's, fnd's, slim's or a team plugin's: fe's, qa's, be's, pm's) holds a line. Opens or closes the [event log pane](#event-log-pane); dim at rest, `l: Log` while the band holds the keyboard |

**Look.** On a terminal a dim rule (`────`) separates the band from the transcript above it; the
desktop frames its panel itself, so no rule is drawn there. The desktop draws the buttons on a second
row under the figures, left-aligned, with a row of air between the two and padding around the panel:
its native buttons are tall, and in the figures' row they squashed it and sat far right. The terminal
keeps one row, as its height is the scarce side there. Each figure is a dim label and a bold value
(`cache` dim, `42m` bold; the same for `ctx` and each rate window), the model id is plain (on the
terminal with the picker's `▾` mark), the digest's work id is bold and the separators are dim.

**Colors.** ctx is green (the theme's `success`) up to 30 %; the rate windows are plain there. Both
use the theme's `warning` color above 30 % and the alarm look from 80 %. The cache is plain at
10 min or more, `warning` below 10 min and the alarm below 2 min (a 5 min TTL scales both: warning
below 2 min, the alarm below 24 s). Only theme keys are used, so the band follows light, dark and
high-contrast themes. The alarm look is `warning` + bold + inverse until a dedicated error key is
proven to draw on every theme.

**Desktop and hover.** In the desktop app's Code tab every segment carries a glyph instead of a word
(`⏱ 42m │ 🤖 fable-5-1 │ 🧠 47% │ ⏳ 5h 61% · 7d 34% │ 💰 $12.40 │ 📋 ELC-1591 3/5 ▶ …`), and
Compact / Clear / Progress / Log are native buttons. The desktop draws proportional text, so the
width model above does not apply there: nothing is dropped, the row clips at the panel's edge. When
the pointer rests on the cache, ctx, a rate window or the cost, a one-line card appears. This is
meant for desktop and for terminals that pass the pointer through (kitty, Ghostty, iTerm2, WezTerm;
tmux passes none). The cards read:
`prompt cache: ~42 min left (estimate: last response + 1 h TTL)`,
`context: 47% of 200,000 tokens, 94,000 used`, `5h window: 61% used, resets in 2h 05m`,
`session cost: $12.40 at API prices, as /cost counts it (a subscription is not billed per request)`.
The glyph labels, the native buttons and hover are still a live check (desktop and terminal paint).

**Toasts.** When a rate window first reaches 90 %, one toast shows that window's card for 8 s
(`5h window: 91% used, resets in 1h 05m`). It re-arms once every window is back under the line, and
after `/clear`. The savings toasts are fnd's and slim's, not band's (`FND_SLIM_TOAST`, `SLIM_TOAST`).
Toasts sit at the transcript's top-right in fullscreen, or on the notification line under the prompt
otherwise. Several toasts stack; a click takes one off and the pointer over it holds it (there is no
close button). They never touch the transcript or what the model reads. They keep showing while a
pane is open (a pane is not a dialog and does not hold toasts).

**Hotkeys.** `c`, `x`, `p`, `l` and `m` work only while the band holds the keyboard: after
**ctrl+x tab** or a click on the band. They never fire from the composer, so typing a `c` is just a
`c`. The letters are drawn only then too (`c: Compact  x: Clear  p: Progress  l: Log`): at rest the
buttons read `[ Compact ]  [ Clear ]  [ Progress ]  [ Log ]`, so the band never suggests a key the
composer would swallow. The letters go away again on a press, when a turn starts and on `/clear`
(there is no focus-out event, so Esc alone leaves them until the next of those). On a terminal the
buttons are mainly clicked (pointer-capable terminals) or reached as ctrl+x tab then the letter, and
Esc gives the keyboard back to the prompt. To focus the band with a single chord, rebind
`abovePrompt:focus` (default ctrl+x tab) in `~/.claude/keybindings.json`, then press the letter. On
desktop they are ordinary buttons with no hotkey at all (a desktop draws a hotkey as a badge on its
native button, and a click is the way there). ctrl+x ctrl+a collapses the band; while it is collapsed
the engine shows one dim line above the prompt, `plugin panel hidden · ctrl+x ctrl+a or click to show`,
and that chord or a click on the line brings it back. The collapsed state is the engine's and persists
across reloads; the plugin cannot and does not reopen the band by itself.

**Debug.** `/band-debug` prints the raw figures behind the band: `band.info`, the session's `usage()`
answer, the cache state, the usage atom, the task the publisher resolved (work id and branch, or
`null`), the publisher (`base`, `fnd` or `none`), the session root and the last render's surface and
measured columns. Paste its output when a segment looks wrong on some surface.

## Progress pane

`p: Progress`, or `/band-progress`, opens a pane with the task base or fnd resolved: docked beside the
transcript in a wide fullscreen terminal, inline otherwise (the surface decides). Esc or a second
press closes it.

```text
ELC-1591 · feature/ELC-1591-preview-themes · 3/5
✓ Read the ticket
✓ Plan approved
✓ Header markup
▶ Preview themes for QA review
☐ Steps to Test
- preview theme 141234567890 created for QA
- decision: keep the old toggle behind a setting
- open: confirm the empty-state copy with design
```

The header is the work id · branch · checked/total, in bold. Below it come every `progress.md` row
(✓ done dimmed, ▶ the digest's current row in bold, ◌ unchecked rows above ▶ dimmed — they wait on
someone, not the queue — ☐ the rest) and the last three `- ` lines of `notes.md`, dimmed. A workspace
without `progress.md` shows its id, the branch, one dim line
`no progress.md yet — /base:save-task-context` and the notes tail. A ticket you named that has no
workspace shows its id, the branch and `no task workspace — /base:save-task-context`. The hint names
the publisher's own skill: under fnd it reads `/fnd:save-task-context`.

- **Whose task.** band takes `base.progress` when it holds a value, else `fnd.progress`. base and fnd
  never run together, so one of them publishes; with both loaded, base's value wins, even one that
  resolves no task.
- **Which task** is the publisher's decision, not band's: its resolver (pin, the ticket you named, the
  branch, the newest `progress.md`) publishes the result and band draws it. base's order is in
  [base's README](../base/README.md#workspace), fnd's in the root README's
  [Progress pane](../../README.md#progress-pane) section.
- **Pinning** stays the publisher's command: `/base-progress <KEY>` (fnd: `/fnd-progress <KEY>`) pins
  a task, `/base-progress -` (fnd: `/fnd-progress -`) clears the pin. `/band-progress` takes no
  argument.
- **No task.** The Progress button is not drawn while the publisher resolves nothing (or neither base
  nor fnd is installed), and `/band-progress` then answers
  `No task checklist: none of the loaded plugins publishes one (with base: /base-progress <KEY> pins one; with fnd: /fnd-progress <KEY>).`
  and opens nothing. If the task goes away while the pane is open, the pane reads `no task checklist`.
- **Redraw.** The pane and the digest redraw whenever the publisher writes a new snapshot (a Write or
  Edit under `.claude/tasks/`, its 30 s tick, a branch or directory change, a pin).
- Where the surface cannot place the pane, the command toasts `progress pane not placed: <reason>` and
  answers with the same reason.
- Where nothing draws a pane (a cloud session, the VS Code chat panel, `claude -p`), `/band-progress`
  answers with the checklist as text: the header, one `✓` / `▶` / `◌` / `☐` line per row, then the
  footer lines.

## Event log pane

Toasts flash and go. `l: Log`, or `/band-log`, opens a pane that keeps them: what band, base, fnd,
slim and the team plugins (fe, qa, be, pm) did or noticed, one line each, oldest first and newest last. Esc, a second press or the engine's
close mark closes it. The Progress pane and the log pane can be open at once; the engine shows one and
keeps the other as a tab. Pressing the button or running the command of the pane behind the tab
brings that pane forward instead of closing it.

```text
14:02  band   session    start · band 0.2.0
14:02  base   start      base 0.1.0
14:05  base   workspace  ELC-1588
14:21  fnd    fnd-slim   getJiraIssue: compressed 118,203 B → 29,412 B (−75.1%)
14:22  slim   slim       Bash: compressed 120 KB → 11 KB (−91%) · json
14:33  base   guard      Bash: --no-verify
14:40  band   compact    manual 412k → 38k
```

The lists are merged by time; lines written in the same millisecond keep the order band → base → fnd
→ slim → fe → qa → be → pm. The plugin column, between the time and the kind, names the list a line
came from (`band`, `base`, `fnd`, `slim`, `fe`, `qa`, `be`, `pm`, padded to 5), so a kind several
plugins share (`guard`, `workspace`, `start`, `install`, `doctor`) still says whose it is. The time is local `HH:MM`; time, plugin and kind are dim. A line too long for the pane continues on the next row, under its own text column, on the
terminal and the desktop alike. When the pane is shorter than the log, its first line reads
`… 12 earlier` and the newest lines fill the rest, wrapped rows counted. With no line anywhere the pane
reads `no events yet`. A surface that cannot place the pane toasts `log pane not placed: <reason>`.
Where nothing draws a pane — a cloud session (the browser at claude.ai/code, the
Desktop app's cloud sessions), the VS Code chat panel, `claude -p` — `/band-log` answers with the log
as text instead, one line per event, and the `Log` button is not there to press.

| Kind | Writer | Written when | Text |
|---|---|---|---|
| `session` | band | band's module starts at launch, on a resume or fork, and on `/clear`; a reload of the module in the same process (a `/config` change) writes none | `start · band <version>` (the version names the drawer: fnd's own line reads `start`), `resume`, `fork`, `clear` (a resume can log both `start` and `resume`) |
| `model` | band | A `/model` switch to another model | The full model id, `claude-opus-5-5` |
| `compact` | band | A compaction of the main thread | The trigger (`manual`, `auto`, `plugin` for the Compact button) and the tokens before → after when the engine reports them. One line per compaction, whichever of its two reports (the `session.compact` chain, the `PostCompact` event) arrives first |
| `rate` | band | A rate window first reaches 90 % | The alarm toast's text, `5h window: 92% used, resets in 1h 05m` |
| `start` | base, slim, fe, qa, be, pm | The plugin's session start, once per session id | `<plugin> <version>`: `base <version>`, `slim <version>`, `qa <version>` |
| `install` | base, fe, qa, be, pm | base: slim is missing, or fnd is loaded beside base. A team plugin: base is not loaded | The install pointer, or the advice to uninstall fnd; a team plugin's reads `needs the base plugin — claude plugin install base@domaine` |
| `profile` | fe | fe decides the project profile | The profile word and how it was decided, `theme (project-profile.sh)` |
| `workspace` | base, fnd | The task the plugin resolved differs from the last one logged | The work id, or `none` |
| `refuse` | base | base refuses a reader spawn because slim is missing | `<agent>: slim is not loaded` |
| `title` | base | base titles the session after the ticket key | The title |
| `doctor` | base, fe, qa, be, pm | The plugin's doctor runs (`/base-doctor`, `/fe-doctor`, `/qa-doctor`, `/be-doctor`, `/pm-doctor`) | The run's counts |
| `fnd-slim` | fnd | fnd's own MCP slimming finds a savings figure | As fnd writes it; the kind reads `slim` while slim has written no line, `fnd-slim` once it has |
| `prompt` | fnd | fnd rewrites a pasted JSON prompt | The toast's figure |
| `guard` | base, fnd | A guard of the plugin refuses a tool call | The tool and the first line of the reason |
| `slim` | slim | slim compresses or stubs a result | `<tool>: compressed … · <engine>`, a subagent's call prefixed with its agent type |
| `lookup` | slim | slim's `lookup` tool answers a question | `lookup: <question…> · <model> · <tokens>` |
| `view` | slim | slim's `view` tool returns a file, URL or command output | `view <source>: <size> → <size> (<saving>) · <engine>`, or `cached`, `narrowed by jq`, `refused (<reason>)`; a subagent's call prefixed with its agent type |

base or fnd lines of kind `session`, `model`, `compact` or `rate` are not shown: those kinds are band's,
and an fnd that still writes them (a release that does not yield, or the moment before fnd sees band
loaded) would show each one twice.

Each publisher keeps its own list of at most 200 lines. Past 200, band, base and the team plugins drop
their oldest line; fnd drops its oldest `slim` or `prompt` line first. The pane reads the session's state, so a new launch
starts it empty; the record that outlives the session is each plugin's own file, below. `/clear` keeps
the lines and adds `session clear` where the conversation restarted. Each plugin gates its own lines,
in the pane and in its file: `BAND_EVENT_LOG=0`, `BASE_EVENT_LOG=0`, `FND_EVENT_LOG=0`,
`SLIM_EVENT_LOG=0`, and a team plugin's `FE_EVENT_LOG=0`, `QA_EVENT_LOG=0`, `BE_EVENT_LOG=0`,
`PM_EVENT_LOG=0`. Toasts are unchanged by any of them.

### Event log on disk

Every Domaine plugin (slim, band, base, fe, qa, be, pm) writes the lines it publishes itself to its
own file, so the origin of a line is on the line, written by that plugin, not inferred from the pane:

- **Where:** `$HOME/.claude/domaine/log/<session-id>/<plugin>.jsonl` (`base.jsonl`, `band.jsonl`,
  `slim.jsonl`, and a team plugin's own, such as `qa.jsonl`). `DOMAINE_LOG_DIR` (an absolute directory) replaces `$HOME/.claude/domaine/log`; the
  `<session-id>/` folder is still made under it. With neither (a cloud session) no file is written.
  Never under the project.
- **Line:** one JSON object per line, oldest first:
  `{"ts":"2026-10-08T12:34:56.789Z","plugin":"band","version":"0.2.0","session":"<id>","kind":"model","agent":"main","text":"claude-opus-5-5"}`.
  `ts` is the event's time in UTC, `plugin` and `version` the writer's own name and release, `agent`
  the subagent type that caused the line or `main`, `kind` and `text` the line as the pane shows it.
- **Start line:** the first line a plugin writes for a session id is `start` / `<plugin> <version>`,
  also under the new id a `/clear` opens, where no session start runs. A session whose lines already
  hold a start line gets no second one: a module reload or a resume in a fresh process goes on from
  the file.
- **band's lines:** `session`, `model`, `compact` and `rate`, `agent` always `main`. The first line
  of a session is `start` / `band <version>` (the pane's `session` / `start · band <version>`), also
  in the file a `/clear` or a resume opens under the new session id, where no session start runs.
  `session clear` closes the old session's file; it is written only while the exit's short bound has
  time left, and a failure there never toasts mid-`/clear`.
- **Writing:** the whole file is rewritten after every line (the engine has no append), at most 2000
  lines or 256 KB, oldest dropped first. A reload of the module (a `/config` change) picks up the
  file of the same session and goes on. A write that fails never reaches the hook; the first failure
  in a session toasts `band: event log not written: <reason>`.
- **Off:** `BAND_EVENT_LOG=0` stops band's file and its pane lines alike.
- **Clean-up:** base sweeps session folders whose newest file is older than 7 days, and its
  `/base-doctor` row `event-log` names the folder and each file's line count and newest time. The other
  plugins never delete.

## Settings (userConfig)

Two fields in `plugins/band/.claude-plugin/plugin.json` → `userConfig`. The engine documents them as
rows in `/config`; where they appear is still a live check. They are stored in `~/.claude/settings.json`
→ `pluginConfigs` under the plugin's id, `band@domaine` for a marketplace install (the bare `band` key
is read only for a `--plugin-dir` load). A change (in `/config` or in the file) reloads the module: the
band appears or goes at once, and the reload writes no second `session start` line.

| Field | Default | Effect |
|---|---|---|
| `disabled` | `false` | `true` draws no band above the prompt and writes no session marker, so fnd's classic context monitor speaks again. Everything else keeps running: the figures, the 30 s tick, the panes, `/band-log`, `/band-progress`, `/band-debug`, `band.info` and band's log lines, so flipping it back shows live figures at once. |
| `cacheTtl` | `auto` | The prompt-cache TTL behind the countdown. `auto` learns it from the session: a `/model` switch reports it, and a subagent result with 1 h cache writes proves 1 h. A learned 1 h is remembered across sessions; a reported 5 min is not (the host reports 5 min before it has seen a 1 h cache write, so remembered it would outlive the session that made it). Until then the estimate is 1 h on a claude.ai account and 5 min when the session bills an API key or a cloud provider (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX` or `CLAUDE_CODE_USE_FOUNDRY` present in the session's environment; only their presence is read). Rate-limit windows arriving also mean a subscription, so they set 1 h too, over the default and over a remembered value, and a 5 min report on a subscription is ignored. A subscription in overage drops to 5 min, which the band cannot see; the cache segment is hidden while a window is at 100 %. `5m` or `1h` forces it. |

To hide the band for yourself, add this to `~/.claude/settings.json`:

```json
"pluginConfigs": { "band@domaine": { "options": { "disabled": true } } }
```

`/plugin disable band@domaine` turns the whole plugin off instead, panes and commands included.

## Session marker

At the top of every prompt band rewrites an empty `<tmpdir>/fnd-mod-session-<session id>` (the temp
dir from `TMPDIR`, `TMP` or `TEMP`, else `/tmp`; the session id keeps only `A-Z a-z 0-9 _ . -`). The
classic UserPromptSubmit hook of fnd, `plugins/fnd/hooks/mod-session.cjs`, reads it: while the marker is
under a minute old it skips its context monitor, because the band shows ctx and model. The name keeps
the `fnd-` prefix because that classic hook is a node process that cannot read `$.state` and trusts
that name. `disabled: true` writes no marker. Without band, fnd's own module writes the same file. A
module cannot delete files, so old 0-byte markers stay in the temp dir until the OS clears it.

## State contract

The contract is `plugins/band/types/index.d.ts`. Any plugin can read band's keys; only band writes them.
Band reads the other plugins' keys through shapes it types itself, with no `dependencies` key in either
direction.

**band publishes** under `plugin: 'band'`:

- **`band.info`** — `{ v: 1, version, disabled }`, written at every session start of band (version from
  band's manifest). Non-null means band is loaded; fnd reads it to stand down.
- **`band.events`** — band's own log lines, `{ atMs, kind, text }` with kind `session`, `model`,
  `compact` or `rate`, oldest first, at most 200.
- **`band.usage`, `band.model`, `band.cache`, `band.tick`, `band.rateAlarmed`** — the figures the band
  draws; `band.paneShown`, `band.bandFocused`, `band.modelPicker` — drawing state.

**band reads** (each read is tolerant: an absent key reads as `null` or `[]`, and an entry missing a
finite `atMs` or a string `kind` or `text` is dropped):

| Key | Publisher | Used for |
|---|---|---|
| `base.progress` | base | the digest, the Progress button, the Progress pane (before `fnd.progress`) |
| `base.events` | base | the event log pane |
| `fnd.progress` | fnd | the digest, the Progress button, the Progress pane (when `base.progress` is null) |
| `fnd.events` | fnd | the event log pane |
| `slim.events` | slim | the event log pane |
| `fe.events`, `qa.events`, `be.events`, `pm.events` | fe, qa, be, pm | the event log pane |

`$.state` refs are literals, so band names each publisher in its code: a new publisher is a band
release. The Progress pane draws a generic checklist shape,
`{ v: 1, title, subtitle?, rows: { mark: 'done' | 'current' | 'waiting' | 'todo', text }[], footer? }`;
band maps the publisher's snapshot into it (title = work id, subtitle = branch · done/total, footer =
the hint naming the publisher's skill and the notes tail). base and fnd write the same snapshot shape.

## Next to fnd

fnd checks `band.info`. While it is non-null:

- fnd draws no band, no Progress or Log button and writes no session marker, whatever its own
  `statusBand` option says. Band's `disabled` decides whether a band shows at all.
- fnd's band figures stand down (no `fnd.usage` writes, no rate toast, no `session` / `model` /
  `compact` / `rate` lines in `fnd.events`). That starts once fnd reads `band.info`: band writes it at
  its own session start, so an fnd hook that runs first may still log `session start` and seed its
  figures once. The event log pane never shows those kinds from fnd's list, so nothing shows twice.
- `/fnd-log` answers `band draws the panes now: /band-log`, `/fnd-progress` (no argument) answers
  `band draws the panes now: /band-progress`, `/fnd-band` answers `band draws the band now: /band-debug`.
- `/fnd-progress <KEY>` still pins the task and `/fnd-progress -` still clears the pin; band redraws
  from the new snapshot.

Without band, fnd draws the band and the panes itself, as before; the root README's
[Mods](../../README.md#mods-claude-code-function-hooks) section lists its own names.

## Known limits

- **The learned 1 h TTL starts over once.** `$.store` is per plugin, so a 1 h TTL fnd learned is not
  band's; band learns it again (a claude.ai account starts at 1 h anyway, and the first rate-limit
  reading sets it).
- **`/plugin disable band` or `/plugin uninstall band` mid-session** leaves `band.info` set for the rest
  of the process, so fnd keeps standing down: no band shows, and `/fnd-log` and `/fnd-progress` keep
  pointing at `/band-log` and `/band-progress`, which left with band, so no pane opens until the next
  session. Re-enabling band writes `band.info` again.
- **The marker follows the plugin, not the drawing.** Band writes the session marker wherever it is
  loaded and not `disabled`, a cloud session or `claude -p` included, where nothing draws: there the
  classic context monitor stays silent and no band shows ctx either.
- **New pane ids.** The panes are `band-log` and `band-progress`. The engine docks a pane beside the
  transcript from 144 columns, or from 110 once that id has been asked for; band's ids start without
  that history, so open each once on a wide terminal.
- **No argument to `/band-progress`.** Pinning a task is `/base-progress <KEY>` (fnd: `/fnd-progress <KEY>`).
- **An fnd that does not yield** (0.134.0 and earlier) draws its band and writes the marker too;
  only one band can show, and load order decides which. Update fnd first.

## Environment switches

band reads these through the module's `$.env`, so only the session environment reaches them (the
shell, or `~/.claude/settings.json` → `env`); the Domaine env files do not. `tests/readme-checks.sh`
fails on a `BAND_*` name under `plugins/band/` without a row here.

| Switch | Default | Effect |
|---|---|---|
| `BAND_COST` | off | `1` (or `true`/`yes`/`on`) adds the session-cost segment to the status band (`cost $12.40`, `💰 $12.40` on the desktop): the `/cost` total at API prices, a measure of work on a subscription. Read at session start. |
| `BAND_EVENT_LOG` | `1` | `0` stops band recording its own lines (`session`, `model`, `compact`, `rate`): none in the Log pane and no `band.jsonl`. base's, fnd's, slim's and the team plugins' lines still show in `/band-log` unless their own switch is `0`. Toasts are untouched. |
| `DOMAINE_LOG_DIR` | `~/.claude/domaine/log` | Where every Domaine plugin (slim, band, base, fe, qa, be, pm) writes its event log on disk: `<dir>/<session-id>/<plugin>.jsonl`, one JSON line per event. An absolute directory; the `<session-id>/` folder is still made under it. Without it and without `HOME` (a cloud session) no file is written. |

## Tests

```
claude plugin validate --strict plugins/band
claude plugin test plugins/band
bash tests/mods-sim.sh             # both of the above for every plugin (local only; needs claude)
```
