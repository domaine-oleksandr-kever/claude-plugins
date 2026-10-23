# band

Band is a Claude Code plugin that draws a status row, a task checklist and an event log around the
prompt. It only draws; it has no other job. To install it, see
[Quick install (Claude Code)](../../README.md#quick-install-claude-code) in the root README.

Band draws three things:

- The **status band** above the prompt. It shows the account the session runs on (work or personal),
  the prompt-cache countdown, the model, the context use, every rate-limit window, the session's cost
  and the task digest. It also holds the Compact, Clear, Progress and Log buttons.
- The **Progress pane**, which shows the task checklist.
- The **event log pane**, which lists what the plugins did.

The figures come from the session itself. The checklist and most log lines come from the other
plugins in this marketplace, which publish them through `$.state`. base publishes the resolved task
and its own events. slim publishes its compression events. The team plugins on base (fe, qa, be, pm)
publish their own start, install and doctor lines. Band reads these lines; it never writes another
plugin's state.

Current release: **band v0.15.0**.

## Status

- Band runs on Claude Code only. It is a hooks module (mods), and other hosts do not run hooks
  modules. Band ships no Cursor, Codex or OpenCode adapter, and `scripts/install.sh --plugin band`
  exits 2.
- Band works alone. With base, it adds the task digest, the Progress pane and base's log lines. With
  slim, it adds slim's log lines. With a team plugin (fe, qa, be, pm), it adds that plugin's log
  lines. None of these plugins is a dependency.
- The drawing shows in the terminal and in the desktop app's Code tab. Some surfaces draw nothing: a
  cloud session, the VS Code chat panel and `claude -p`. There the hooks still run, and `/band-log`
  and `/band-progress` answer as text.

## Install

```
/plugin install band@domaine
```

To choose which plugins to install for which work, use the matrix in
[the root README](../../README.md#which-plugins-to-install).

## Status band

The band is one row, with the most important segment first. This example has 200 columns, a work
login (Claude Team), context at 47 %, three rate windows (the two weekly ones share one reset time),
and base resolving a task:

```text
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
work │ cache 42m │ fable-5-1 ▾ │ ctx 47% │ 5h 61% ↻2h05m · 7d 34% · 7d·fable 12% ↻3d4h │ cost $12.40 │ ELC-1591 3/5 ▶ Preview themes for QA review │ [ Compact ]  [ Clear ]  [ Progress ]  [ Log ]
```

The same session at 120 columns: the row needs 194 cells, so band drops the Log button first, then
Clear, then the reset times, then the account, then the digest:

```text
cache 42m │ fable-5-1 ▾ │ ctx 47% │ 5h 61% · 7d 34% · 7d·fable 12% │ cost $12.40 │ [ Compact ]  [ Progress ]
```

**When the band appears.** Band draws the row as soon as it holds one figure. At launch it reads the
model (the one the settings name, until the first response), the cache TTL and the first usage figures in its session start hook, so the row shows within a
second. A `/clear` opens a new session id. The host keeps plugin state per session id, so every band
figure starts empty again, and no session start hook runs. Band reads the same three things, and the
account, again a second after the session end a `/clear` fires, so the row returns within a second.
band registers no classic hook: on a Claude Team login the host withholds every classic event from
plugins. The 30 s refresh stays the fallback. What only the host's SessionStart event carries on a
resume or fork (the time since the last response) reaches band through a command hook,
`hooks/resume.cjs`, which writes it to `<log dir>/<session-id>/band-resume.json`; the next refresh
applies it.

At 60 columns, band also drops the rate windows (the least full one first) and then the model:

```text
cache 42m │ ctx 47% │ [ Compact ]  [ Progress ]
```

Band drops segments in this order:

1. The Log button (`/band-log` still opens the pane).
2. The Clear button (`/clear` still works).
3. The rate windows' reset times (the hover card still names them).
4. The account.
5. The digest.
6. The cost.
7. The rate windows other than the fullest one, the least full first.
8. The last rate window.
9. The model.
10. The Progress button.

Band never drops cache, ctx or Compact. As a backstop, the row's text truncates, so the band never
takes a second row.

| Segment | Shows | Rule |
|---|---|---|
| account | `work`, `personal` | Which claude.ai login the session runs on, for a Mac with two (a personal plan in `~/.claude`, a company Team in another `CLAUDE_CONFIG_DIR`). `work` is a Claude Team or Enterprise organization; `personal` is any other plan (Max, Pro, free). It comes from the login record the host writes: `oauthAccount.organizationType` in `<CLAUDE_CONFIG_DIR>/.claude.json`, or `~/.claude.json` when `CLAUDE_CONFIG_DIR` is unset. A record without `oauthAccount` falls back to the claude.ai profile endpoint (`/api/oauth/profile`), asked once per session and never awaited by the band. No claude.ai login (an API key, Bedrock, Vertex, a gateway), a login with no plan, or a failed read: no segment, silently. Read at session start and again every 5 min, so a later `/login`, or one that switches the account mid-session, shows up; a `/clear` reads it anew. A `~/` in `CLAUDE_CONFIG_DIR` stands for HOME; any other relative value is never taken for HOME's record, so only the profile endpoint can name the account. A dim word on the terminal, a glyph on the desktop (`🏢` work, `🏠` personal). The hover card reads `account: work (Claude Team) · email: … · org: … · role: … · config: ~/.claude-cloudcon · source: login record`, with `models: opus, sonnet, haiku (fable needs credits)` before `config` while the picker hides a family. `BAND_ACCOUNT` hides it (`0`) or forces the word (`work`, `personal`; the card then says `forced by BAND_ACCOUNT`). |
| cache | `cache 42m`, `<1m`, `cache cold`, `cache —`, `cache ●` | Minutes left of the prompt cache: the last main-thread response plus the TTL. `●` while a turn runs; `—` before the first response and after `/clear` or resume; `cold` once the TTL has passed, after a compaction (one the band learns of from a fill below half keeps it warm: the response that measured it wrote the cache again), or after a `/model` to another family, which forfeits the cache. A resumed or forked session takes its state from the time since the last response (by the next refresh), cold when the host says the cache likely expired. Hidden while any rate window is at or past 100 %: in overage the TTL is unknown. **It is an estimate.** The host reports no cache state, only the events it is derived from. |
| model | `fable-5-1`, `opus` | The model id as the session reports it, without the `claude-` prefix every id carries. Until the first response it shows the model the settings name (`opus`, `fable`: a bare alias, as `/model` saved it; nothing for `default` or no `model` key), because until a response binds the session it answers the process default rather than the configured model. The first response (its own model id) replaces it with the id; every later measurement re-reads it, so a switch made any other way shows by the next response. A `/clear` after a response re-reads the session's id. A `/model` (typed or from the picker) is caught as the command itself, on every login: the band reads the family from the command's own answer (``Set model to `Opus 5.5` …`` → `opus`), not from the settings, which can still name the old model at that moment, and shows it until the next response names the id. An alias of the family already shown leaves the id in place. A pick made in the dialog a bare `/model` opens (no such answer) shows by the next 30 s refresh, which re-reads the settings. The session still answers the old id for a moment after a switch to another family, and the measurements after it ignore that answer: they keep the answered family until the session answers something else. **On the terminal it is a picker:** the segment reads `fable-5-1 ▾` and is a button (hotkey `m` while the band holds the keyboard: ctrl+x tab, or a click). Pressed, the row folds its figures away and holds the models alone, in place: `model fable  opus  sonnet  haiku`: the families, not dated ids, since `/model <alias>` resolves to the family's newest model and the list never dates (plus the session's own id first when no alias stands for it, say a pinned `[1m]` id), the current one bright and the rest dim, each with its first letter as hotkey (`f`, `o`, `s`, `h`). A family the login cannot use is left out: one with any id (a `[1m]` one included) the login record lists in `additionalModelOptionsCache` that the record's `cachedGrowthBookFeatures.tengu_saffron_lattice` flag also bills to usage credits (plan-wide, or in its `perModel` entry for that model; say Fable on a Team plan) while extra usage is unusable there (`cachedExtraUsageDisabledReason` set, say `out_of_credits`, or `oauthAccount.hasExtraUsageEnabled` false), so picking it never opens the host's "runs on usage credits" dialog. A plan that includes the model (Fable on Max: the flag off) keeps it listed. The current model stays listed even then; a record without those keys hides nothing, and so does `BAND_ACCOUNT=0`, which reads no record. Letters are dealt after that, so each family keeps its own. Tab or a letter picks one; the pick runs `/model <alias>` as typed, toasts its output and folds the row back, which shows the pick's family once the run succeeds (an id of that family already shown stays) and turns the cache cold for another family. The current model only folds the row; so does the `×` button at its end (hotkey `x`: Clear is not drawn while the row is unfolded, so the letter is free), and a turn or `/clear` folds it too. The band never grows: its region clips anything drawn outside its own two rows, so no list can pop over the transcript. The desktop app has its own model menu, so there the segment stays text. |
| ctx | `ctx 47%`, `ctx —` | Context-window use. It is `—` on a fresh session until the first response. Right after a compaction it shows the engine's own count of what was kept over the window (`ctx 3%`), or `—` when the engine reported no count; that count holds until a response reports a measured fill, as a reading with no fill (only the window) keeps the last one. A compaction reaches the band two ways: the `session.compact` chain, and the readings themselves (`compact inferred`), for a login or a press whose compaction skips the chain (the Claude Team login's builtin security plugin, a Compact press on Claude Code 2.1.289). The engine drops the fill from a compaction until the next response, so a reading that loses its fill outside `/clear` and resume is applied as a compaction (`ctx —`, `cache cold`); a measured fill below half of the last one (from at least 20k tokens, or 5 % over the same window where a count is missing) is one whose fill-less moment no reading caught, and is only logged, the new fill standing as the ctx value. Reports within 30 s of each other are one compaction, whichever way they came, and after a compaction no reading is read as another until one reports a fill. **The readings are a heuristic:** a rewind (Esc Esc) that drops half the context reads as a compaction too. Mid-turn it refreshes on a 30 s tick. |
| rates | `5h 61% ↻2h05m · 7d 34% · 7d·fable 12% ↻3d4h` | **Every** window the host measures, in its order, then each window the claude.ai usage endpoint (`/api/oauth/usage`, the one `/usage` reads) adds, separated by a dim `·`. The host's measurement wins a window both report; the endpoint adds the per-model weekly windows the measurement never carries (`7d·sonnet`, `7d·fable`). On the desktop app the measurement reports no window at all, so there the endpoint supplies every one. band asks the endpoint at most once per 5 min (after a failure too), on a claude.ai login only: an API key, Bedrock, Vertex or a gateway gets none, and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` blocks the request. A failed request (or one unanswered after 10 s) keeps the last good windows, silently, until a window passes its reset time; logging out of claude.ai drops them. `five_hour` → `5h`, `seven_day` → `7d`, `spend_limit` → `$`; an unknown kind keeps a shortened raw name (`7d·fable`); past 100 % reads `>100%`. A window the API gives a reset time trails it dim after the percentage: `↻42m`, `↻2h05m`, `↻3d4h`. Adjacent windows whose resets lie within 60 s of each other (the weekly `7d` and the per-model `7d·…` windows reset together) show it once, after the last of them: `7d 34% · 7d·fable 12% ↻3d4h`; each window's hover card still names its own. The labels keep their prefix, so `7d·fable` always reads as a weekly window. The reset times are the first figures to go on a narrow row (after the Log and Clear buttons). Empty off a subscription and before the first reading. |
| cost | `cost $12.40` | Opt-in: drawn only with `BAND_COST=1` in the session's environment. What the session has cost at API prices, as `/cost` totals it (`usage().cost.usd`). A subscription is not billed per request, so there it is a measure of work, not a bill. Hidden while it is zero and where the host keeps no ledger. |
| digest | `ELC-1591 3/5 ▶ Preview themes` | The task base resolved, same on the terminal and the desktop: work id · checked/total rows of the workspace's `progress.md` · the current row as base writes it (cut to 28 characters); `ELC-1591 ✓ 5/5` when all are done; the bare id (`ELC-1588`) while the workspace has no `progress.md` yet, or while the ticket you named has no workspace at all. Hidden while the Progress pane is open, when base resolves nothing, and without base. |
| Compact | `[ Compact ]`, `c: Compact` | Always drawn first and always pressable, so the other buttons never shift: before the first reading, while a turn runs and at any context. From 80 % between turns it switches to the accent color. While the band holds the keyboard it reads `c: Compact`. A press runs `/compact` and toasts the result (`compacted 412,000 → 38,000 tokens`, or why it was skipped or refused). When the prompt cache is cold or ends within 5 min, the press first asks `Compact` / `Clear` / `Cancel` through the engine's own dialog (`Prompt cache is cold or ends within 5 min: compacting re-reads the whole conversation at full price. If this session is done, Clear is cheaper. Compact anyway?`); `Clear` runs `/clear` without the second Yes/No, a dismissed dialog is a Cancel. A typed `/compact` never asks. Where the engine refuses compaction from a plugin (a headless / SDK session such as the desktop app), the press runs the `/compact` slash command as if typed instead and toasts its output. Pressed while a turn runs it only toasts `turn is running — press Compact again when it ends`; nothing is queued. While base reports the task workspace stale (unless `BASE_AUTOSAVE=0`), a press or a typed `/compact` runs `/base:save-task-context` first, then the `/compact` slash command, so the compaction waits for the save's turn; a press toasts `saved, then ` and the command's output. The compaction always follows, as the person asked for it: when the save fails it toasts `save failed (<reason>) — compacted anyway`, and when base still reports the workspace stale after the save's turn (the turn wrote nothing, or wrote another task's workspace than the one base watches) it toasts `<work id> still stale after the save — compacted anyway` instead of `saved, then …`; a typed `/compact` toasts only these two. One save-then-compact chain runs at a time: a second press while one is still running only toasts `compact already queued`, and a typed `/compact` then answers the same. |
| Clear | `[ Clear ]`, `x: Clear` | Runs `/clear` behind the engine's own Yes/No dialog (`Clear the conversation?`), always: the dialog takes the keyboard, so a stray click or hotkey never clears, and a dismissed dialog is a No. Toasts the command's output. Pressed while a turn runs it only toasts `turn is running — press Clear again when it ends`. Dim at rest, `x: Clear` while the band holds the keyboard. |
| Progress | `[ Progress ]`, `p: Progress` | Drawn only while base resolves a task (its `base.progress` carries a work id). Opens or closes the [Progress pane](#progress-pane); dim at rest, `p: Progress` while the band holds the keyboard |
| Log | `[ Log ]`, `l: Log` | Drawn only while some event list (band's, base's, slim's or a team plugin's: fe's, qa's, be's, pm's) holds a line. Opens or closes the [event log pane](#event-log-pane); dim at rest, `l: Log` while the band holds the keyboard |

**Look.** On a terminal, a dim rule (`────`) separates the band from the transcript above it. The
desktop frames its panel itself, so band draws no rule there. On the desktop, the buttons sit on a
second row under the figures, left-aligned, with an empty row between the two rows and padding
around the panel. The reason: the desktop's native buttons are tall, and in the figures' row they
squashed the row and sat far right. The terminal keeps one row, because height is the scarce space
there. Each figure is a dim label and a bold value (`cache` dim, `42m` bold; the same for `ctx` and
each rate window). The account word is dim, with no value. The model id is plain; on the terminal it carries the picker's `▾` mark. The
digest's work id is bold, and the separators are dim.

**Colors.** Up to 30 %, ctx is green (the theme's `success`) and the rate windows are plain. Above
30 %, both use the theme's `warning` color, and from 80 % they use the alarm look. The cache is plain
at 10 min or more, `warning` below 10 min, and the alarm below 2 min. A 5 min TTL scales both
limits: `warning` below 2 min and the alarm below 24 s. Band uses only theme keys, so the band
follows light, dark and high-contrast themes. The alarm look is `warning` + bold + inverse until a
dedicated error key is proven to draw on every theme.

**Desktop and hover.** In the desktop app's Code tab, every segment carries a glyph instead of a word
(`🏢 │ ⏱ 42m │ 🤖 fable-5-1 │ 🧠 47% │ ⏳ 5h 61% ↻2h05m · 7d 34% · 7d·fable 12% ↻3d4h │ 💰 $12.40 │ 📋 ELC-1591 3/5 ▶ …`).
Compact, Clear, Progress and Log are native buttons there. The desktop draws proportional text, so
the width rules above do not apply: band drops nothing, and the row clips at the panel's edge. When
the pointer rests on the account, the cache, ctx, a rate window or the cost, a one-line card appears. Cards work
on the desktop and on terminals that pass the pointer through (kitty, Ghostty, iTerm2, WezTerm; tmux
passes none). The cards read:
`account: personal (Claude Max) · email: me@example.com · config: ~/.claude · source: login record`,
`prompt cache: ~42 min left (estimate: last response + 1 h TTL)`,
`context: 47% of 200,000 tokens, 94,000 used`, `5h window: 61% used, resets in 2h 05m`,
`session cost: $12.40 at API prices, as /cost counts it (a subscription is not billed per request)`.
The glyph labels, the native buttons and hover still need a live check (desktop and terminal paint).

**Toasts.** When a rate window first reaches 90 %, one toast shows that window's card for 8 s
(`5h window: 91% used, resets in 1h 05m`). The toast re-arms once every window is back under 90 %,
and after `/clear`. The savings toasts come from slim, not from band (`SLIM_TOAST`). In fullscreen,
toasts sit at the transcript's top-right; otherwise they sit on the notification line under the
prompt. Several toasts stack. A click removes a toast, and the pointer over a toast holds it (there
is no close button). Toasts never touch the transcript or what the model reads. They keep showing
while a pane is open, because a pane is not a dialog and does not hold toasts.

**Hotkeys.** `c`, `x`, `p`, `l` and `m` work only while the band holds the keyboard: after
**ctrl+x tab** or a click on the band. They never fire from the composer, so a typed `c` stays a `c`.
Band draws the letters only at that time too (`c: Compact  x: Clear  p: Progress  l: Log`). At rest
the buttons read `[ Compact ]  [ Clear ]  [ Progress ]  [ Log ]`, so the band never suggests a key
that the composer would swallow. The letters go away again on a press, when a turn starts and on
`/clear`. There is no focus-out event, so Esc alone leaves the letters until the next of those
events.

On a terminal, you mainly click the buttons (on pointer-capable terminals) or press ctrl+x tab and
then the letter. Esc gives the keyboard back to the prompt. To focus the band with a single chord,
rebind `abovePrompt:focus` (default ctrl+x tab) in `~/.claude/keybindings.json`, then press the
letter. On the desktop, the buttons are ordinary buttons with no hotkey at all: a desktop draws a
hotkey as a badge on its native button, and a click is the way to press it there.

ctrl+x ctrl+a collapses the band. While the band is collapsed, the engine shows one dim line above
the prompt: `plugin panel hidden · ctrl+x ctrl+a or click to show`. That chord or a click on the
line brings the band back. The collapsed state belongs to the engine and persists across reloads.
The plugin cannot reopen the band by itself, and it does not try.

**Debug.** `/band-debug` prints the raw figures behind the band: `band.info`, the session's `usage()`
answer, the cache state, the usage atom, the usage endpoint's last attempt (`endpoint: {"at":…,"ok":true,"status":200,"windows":[{"kind":"seven_day_fable","pct":12}, …]}`,
or its status or one-line error; never the body), the account atom and its last read
(`account: {"atom":{…,"hiddenModels":["fable"],"hiddenReason":"out_of_credits","label":"work","source":"login record"},"last":{"mode":"on","at":…,"source":"login record"}}`,
with `hiddenModels` the picker families hidden and `hiddenReason` why, or the last read's one-line error), the task that base resolved (work id and branch, or
`null`), the session root, and the last render's surface and measured columns. When a segment looks
wrong on some surface, paste this output.

## Progress pane

`p: Progress` or `/band-progress` opens a pane with the task that base resolved. The surface decides
where the pane goes: beside the transcript in a wide fullscreen terminal, inline otherwise. Esc or a
second press closes it.

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

The header shows the work id, the branch and checked/total, in bold. Below it come all rows of
`progress.md` and then the last three `- ` lines of `notes.md`, dimmed. The row marks are:

- `✓`: a done row, dimmed.
- `▶`: the digest's current row, in bold.
- `◌`: an unchecked row above `▶`, dimmed. Such a row waits on someone, not on the queue.
- `☐`: any other row.

A workspace without `progress.md` shows its id, the branch, one dim line
`no progress.md yet — /base:save-task-context` and the notes tail. A ticket you named that has no
workspace shows its id, the branch and `no task workspace — /base:save-task-context`.

- **Which task.** base decides the task, not band. base's resolver (pin, the ticket you named, the
  branch, the newest `progress.md`) publishes the result, and band draws it. The order is in
  [base's README](../base/README.md#workspace).
- **Pinning** stays base's command. `/base-progress <KEY>` pins a task, and `/base-progress -`
  clears the pin. `/band-progress` takes no argument.
- **No task.** Band does not draw the Progress button while base resolves nothing or is not
  installed. `/band-progress` then answers
  `No task checklist: base resolves no task or is not loaded (/base-progress <KEY> pins one).`
  and opens nothing. If the task goes away while the pane is open, the pane reads `no task checklist`.
- **Redraw.** The pane and the digest redraw each time base writes a new snapshot: after a Write or
  Edit under `.claude/tasks/`, on its 30 s tick, on a branch or directory change, and on a pin.
- When the surface cannot place the pane, the command toasts `progress pane not placed: <reason>`
  and answers with the same reason.
- Some surfaces draw no pane: a cloud session, the VS Code chat panel and `claude -p`. There
  `/band-progress` answers with the checklist as text: the header, one `✓` / `▶` / `◌` / `☐` line per
  row, and then the footer lines.

## Event log pane

Toasts show for a short time and then go. The event log pane keeps them. `l: Log` or `/band-log`
opens it. The pane shows what band, base, slim and the team plugins (fe, qa, be, pm) did or noticed,
one line per event, oldest first and newest last. Esc, a second press or the engine's close mark
closes it. The Progress pane and the log pane can be open at the same time: the engine shows one
and keeps the other as a tab. The button or the command of the pane behind the tab brings that pane
forward instead of closing it.

```text
14:02  band   session    start · band 0.2.0
14:02  base   start      base 0.1.0
14:05  base   workspace  ELC-1588
14:22  slim   slim       Bash: compressed 120 KB → 11 KB (−91%) · json
14:33  base   guard      Bash: --no-verify
14:40  band   compact    manual 412k → 38k
```

The pane merges the lists by time. Lines written in the same millisecond keep the order band → base
→ slim → fe → qa → be → pm. The plugin column, between the time and the kind, names the list that a
line came from (`band`, `base`, `slim`, `fe`, `qa`, `be`, `pm`, padded to 5). So a kind that several
plugins share (`guard`, `workspace`, `start`, `install`, `doctor`) still says whose line it is. The
time is local `HH:MM`. The time, plugin and kind are dim.

A line too long for the pane continues on the next row, under its own text column, on the terminal
and the desktop alike. When the pane is shorter than the log, its first line reads `… 12 earlier`
and the newest lines fill the rest, with wrapped rows counted. With no line anywhere, the pane reads
`no events yet`. A surface that cannot place the pane toasts `log pane not placed: <reason>`.

Some surfaces draw no pane: a cloud session (the browser at claude.ai/code, the Desktop app's cloud
sessions), the VS Code chat panel and `claude -p`. There `/band-log` answers with the log as text,
one line per event, and there is no `Log` button to press. The text holds the newest 40 lines. When
there are more, the first line counts the rest and points at the session's log folder (described
below): `… 12 earlier — full log: <log dir>/<session-id>/`. Where no folder is written, it reads just
`… 12 earlier`.

| Kind | Writer | Written when | Text |
|---|---|---|---|
| `session` | band | band's module starts at launch, on a resume or fork, and on `/clear`; a reload of the module in the same process (a `/config` change) writes none | `start · band <version>`, `resume`, `fork`, `clear` (a resume can log both `start` and `resume`) |
| `model` | band | A `/model` switch to another model | The family the `/model` answer names, `opus`; the full id, `claude-opus-5-5`, follows once a response or a measurement names it |
| `compact` | band | A compaction of the main thread | The trigger (`manual`, `auto`, `plugin` for the Compact button, `inferred` for one read off the readings, on a login whose hooks skip the compact events: a fill gone, or a measured fill below half of the last one; a rewind that drops as much reads the same) and the tokens before → after when the engine reports them (for an `inferred` drop, the two measured counts). One line per compaction, whichever of its reports (the `session.compact` chain, the readings) arrives first |
| `rate` | band | A rate window first reaches 90 % | The alarm toast's text, `5h window: 92% used, resets in 1h 05m` |
| `start` | base, slim, fe, qa, be, pm | The plugin's session start, once per session id | `<plugin> <version>`: `base <version>`, `slim <version>`, `qa <version>` |
| `install` | base, fe, qa, be, pm | base: a plugin it needs is missing, or one it conflicts with is loaded. A team plugin: base is not loaded | The install pointer, or the conflict advice; a team plugin's reads `needs the base plugin — claude plugin install base@domaine` |
| `profile` | fe | fe decides the project profile | The profile word and how it was decided, `theme (project-profile.sh)` |
| `workspace` | base | The task the plugin resolved differs from the last one logged | The work id, or `none` |
| `refuse` | base | base refuses a reader spawn because slim is missing | `<agent>: slim is not loaded` |
| `title` | base | base titles the session after the ticket key | The title |
| `doctor` | base, fe, qa, be, pm | The plugin's doctor runs (`/base-doctor`, `/fe-doctor`, `/qa-doctor`, `/be-doctor`, `/pm-doctor`) | The run's counts |
| `guard` | base | A guard of the plugin refuses a tool call | The tool and the first line of the reason |
| `slim` | slim | slim compresses or stubs a result | `<tool>: compressed … · <engine>`, a subagent's call prefixed with its agent type |
| `lookup` | slim | slim's `lookup` tool answers a question | `lookup: <question…> · <model> · <tokens>` |
| `view` | slim | slim's `view` tool returns a file, URL or command output | `view <source>: <size> → <size> (<saving>) · <engine>`, or `cached`, `narrowed by jq`, `refused (<reason>)`; a subagent's call prefixed with its agent type |

Each publisher keeps its own list of at most 200 lines. Past 200 lines, band, base and the team
plugins drop their oldest line. The pane reads the session's state, and the host keeps that state per session id. So the pane
starts empty on each new launch and after a `/clear`. The record that outlives the session is each
plugin's own file (see below). `session clear` is the last line of the session that a `/clear` ends;
it goes to that session's list and file, not to the new one. Each plugin has its own
switch for its lines, in the pane and in its file: `BAND_EVENT_LOG=0`, `BASE_EVENT_LOG=0`,
`SLIM_EVENT_LOG=0`, and a team plugin's `FE_EVENT_LOG=0`, `QA_EVENT_LOG=0`, `BE_EVENT_LOG=0`,
`PM_EVENT_LOG=0`. None of these switches changes the toasts.

### Event log on disk

Every Domaine plugin (slim, band, base, fe, qa, be, pm) writes the lines it publishes to its own
file. So each line carries its origin, written by that plugin, and nobody infers it from the pane.

- **Where:** `$HOME/.claude/domaine/log/<session-id>/<plugin>.jsonl` (`base.jsonl`, `band.jsonl`,
  `slim.jsonl`, and a team plugin's own file, such as `qa.jsonl`). `DOMAINE_LOG_DIR` (an absolute
  directory) replaces `$HOME/.claude/domaine/log`; the plugin still makes the `<session-id>/` folder
  under it. With neither (a cloud session), no file is written. The file is never under the project.
- **Line:** one JSON object per line, oldest first:
  `{"ts":"2026-10-08T12:34:56.789Z","plugin":"band","version":"0.2.0","session":"<id>","kind":"model","agent":"main","text":"claude-opus-5-5"}`.
  `ts` is the event's time in UTC. `plugin` and `version` are the writer's own name and release.
  `agent` is the subagent type that caused the line, or `main`. `kind` and `text` are the line as the
  pane shows it.
- **Start line:** the first line that a plugin writes for a session id is `start` /
  `<plugin> <version>`. This is also true under the new id that a `/clear` opens, where no session
  start runs. A session whose lines already hold a start line gets no second one: a module reload or
  a resume in a fresh process continues from the file.
- **band's lines:** `session`, `model`, `compact` and `rate`, with `agent` always `main`. The first
  line of a session is `start` / `band <version>` (the pane's `session` / `start · band <version>`).
  This is also true in the file that a `/clear` or a resume opens under the new session id, where no
  session start runs. `session clear` closes the old session's file. Beside it, `band-resume.json` is
  what `hooks/resume.cjs` wrote on the last resume or fork of that session id (`source`, `atMs`,
  `secondsSinceLastResponse`, `promptCacheLikelyExpired`); band applies each one once. Band writes `band.jsonl` only while the
  exit's short time limit has time left, and a failure there never toasts during `/clear`.
- **Writing:** band rewrites the whole file after every line, because the engine has no append. The
  file holds at most 2000 lines or 256 KB, and the oldest lines go first. A reload of the module (a
  `/config` change) picks up the file of the same session and continues. A failed write never
  reaches the hook. The first failure in a session toasts `band: event log not written: <reason>`.
- **Off:** `BAND_EVENT_LOG=0` stops both band's file and its pane lines.
- **Clean-up:** base sweeps session folders whose newest file is older than 7 days. Its
  `/base-doctor` row `event-log` names the folder and, for each file, the line count and newest
  time. The other plugins never delete.

## Settings (userConfig)

Band has two fields in `plugins/band/.claude-plugin/plugin.json` → `userConfig`. The engine
documents them as rows in `/config`; where they appear still needs a live check. The values are
stored in `~/.claude/settings.json` → `pluginConfigs` under the plugin's id. For a marketplace
install the id is `band@domaine`; band reads the bare `band` key only for a `--plugin-dir` load. A
change (in `/config` or in the file) reloads the module. The band then appears or goes at once, and
the reload writes no second `session start` line.

| Field | Default | Effect |
|---|---|---|
| `disabled` | `false` | `true` draws no band above the prompt. Everything else keeps running: the figures, the 30 s tick, the panes, `/band-log`, `/band-progress`, `/band-debug`, `band.info` and band's log lines, so flipping it back shows live figures at once. |
| `cacheTtl` | `auto` | The prompt-cache TTL behind the countdown. `auto` learns it from the session: a subagent result with 1 h cache writes proves 1 h. Until then the estimate is 1 h on a claude.ai account and 5 min when the session bills an API key or a cloud provider (a non-empty `ANTHROPIC_API_KEY`, or `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX` or `CLAUDE_CODE_USE_FOUNDRY` set to `1`, `true`, `yes` or `on` in the session's environment; `0` or empty is off). A 1 h learned in such a billed session is remembered for the next billed session; a claude.ai account starts at 1 h anyway and remembers nothing. Rate-limit windows arriving (measured or from the usage endpoint) also mean a subscription, so they set 1 h too, over the default and over a remembered value. A subscription in overage drops to 5 min, which the band cannot see; the cache segment is hidden while a window is at 100 %. `5m` or `1h` forces it. |

To hide the band for yourself, add this to `~/.claude/settings.json`:

```json
"pluginConfigs": { "band@domaine": { "options": { "disabled": true } } }
```

To turn off the whole plugin instead, panes and commands included, use `/plugin disable band@domaine`.

## State contract

The contract is `plugins/band/types/index.d.ts`. Any plugin can read band's keys; only band writes
them. Band reads the other plugins' keys through shapes that it types itself. Neither direction has a
`dependencies` key.

**band publishes** under `plugin: 'band'`:

- **`band.info`** — `{ v: 1, version, disabled }`. Band writes it at each of its session starts, with
  the version from band's manifest. A non-null value means that band is loaded.
- **`band.events`** — band's own log lines, `{ atMs, kind, text }`, with kind `session`, `model`,
  `compact` or `rate`. Oldest first, at most 200.
- **`band.account`** — `{ label, plan, email, org, role, configDir, source, hiddenModels, hiddenReason }`:
  the login the session runs on (`label` `work` / `personal`) and the picker families it cannot use
  (`hiddenModels`, `[]` when none; `hiddenReason` one word such as `out_of_credits`, else `null`). `label`
  is `null` when the plan is unknown but the record still hides a family; the atom is `null` without a
  claude.ai login, under `BAND_ACCOUNT=0`, or before the first read.
- **`band.usage`, `band.model`, `band.cache`, `band.tick`, `band.rateAlarmed`** — the figures that
  the band draws. **`band.paneShown`, `band.bandFocused`, `band.modelPicker`** — the drawing state.

**band reads** these keys. Each read is tolerant: an absent key reads as `null` or `[]`. Band drops
an entry that has no finite `atMs`, or no string `kind` or `text`.

| Key | Publisher | Used for |
|---|---|---|
| `base.progress` | base | the digest, the Progress button, the Progress pane, the Compact save gate (`stale`) |
| `base.events` | base | the event log pane |
| `slim.events` | slim | the event log pane |
| `fe.events`, `qa.events`, `be.events`, `pm.events` | fe, qa, be, pm | the event log pane |

`$.state` refs are literals, so band names each publisher in its code. A new publisher therefore
needs a new band release. The Progress pane draws a generic checklist shape:
`{ v: 1, title, subtitle?, rows: { mark: 'done' | 'current' | 'waiting' | 'todo', text }[], footer? }`.
Band maps base's snapshot into this shape: title = work id, subtitle = branch · done/total, footer =
the hint that names base's save skill, plus the notes tail.

## Known limits

- **`/plugin disable band` or `/plugin uninstall band` mid-session** leaves `band.info` set for the
  rest of the process. When you enable band again, it writes the key again.
- **Pane docking.** The panes are `band-log` and `band-progress`. The engine docks a pane beside the
  transcript from 144 columns, or from 110 columns once that pane id has been requested. So open each
  pane once on a wide terminal.
- **No argument to `/band-progress`.** To pin a task, use `/base-progress <KEY>`.

## Environment switches

band reads these switches through the module's `$.env`, so only the session environment reaches
them: the shell, or `~/.claude/settings.json` → `env`. The Domaine env files do not reach them.
`hooks/resume.cjs` reads `HOME` and `DOMAINE_LOG_DIR` from the environment the host gives its command hooks.
`tests/readme-checks.sh` fails when a `BAND_*` name under `plugins/band/` has no row here.

| Switch | Default | Effect |
|---|---|---|
| `BAND_ACCOUNT` | on | The account segment (`work` / `personal`). Unset or any other value reads the login; `0` hides the segment and reads nothing, so the model picker hides no family either; `work` or `personal` forces that word whatever the login (its card says `forced by BAND_ACCOUNT`) and still reads the login record for the families the picker hides (none when the record lacks the keys). Read at session start. |
| `BAND_COST` | off | `1` (or `true`/`yes`/`on`) adds the session-cost segment to the status band (`cost $12.40`, `💰 $12.40` on the desktop): the `/cost` total at API prices, a measure of work on a subscription. Read at session start. |
| `BAND_USAGE_ENDPOINT` | `1` | `0` stops band asking the claude.ai usage endpoint: the rate windows are then the host's measurement alone (none on the desktop app, no per-model weekly window anywhere). Read at session start. |
| `BAND_EVENT_LOG` | `1` | `0` stops band recording its own lines (`session`, `model`, `compact`, `rate`): none in the Log pane and no `band.jsonl`. base's, slim's and the team plugins' lines still show in `/band-log` unless their own switch is `0`. Toasts are untouched. |
| `DOMAINE_LOG_DIR` | `~/.claude/domaine/log` | Where every Domaine plugin (slim, band, base, fe, qa, be, pm) writes its event log on disk: `<dir>/<session-id>/<plugin>.jsonl`, one JSON line per event. An absolute directory; the `<session-id>/` folder is still made under it. Without it and without `HOME` (a cloud session) no file is written. |

## Tests

```
claude plugin validate --strict plugins/band
claude plugin test plugins/band
bash tests/mods-sim.sh             # both of the above for every plugin (local only; needs claude)
```
