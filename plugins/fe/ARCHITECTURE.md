# fe — architecture

What runs where and why each piece sits where it does. The README says what fe does for the person
using it; this file is for whoever changes it. The code wins when the two drift.

## 1. The pieces

```
plugins/fe/
├── .claude-plugin/plugin.json   dependencies: ["base"], types; no mcpServers, no classic `hooks` key
├── hooks/hooks.json             { "modules": ["./mods/register.ts"] } — the only hook wiring
├── hooks/mods/*.ts              the hooks module (Claude Code function hooks)
├── types/index.d.ts             fe's $.state contract: the `fe` key only
├── skills/<name>/SKILL.md       the 12 Shopify theme skills (`/fe:<name>`); fix-breaking-changes
│                                carries its script template, create-pull-request its REFERENCE.md
├── agents/theme-explorer.md     the read-only theme scout (`fe:theme-explorer`)
├── references/*.md              what fe's skills and agent read on demand (`<fe root>/references/…`)
└── scripts/                     the store scripts, project-profile.sh, worktree-theme.sh, doctor.cjs
```

The skills hand off to base by qualified names only (`/base:commit`, `base:jira-reader`, …) and cite
base's files as `<base root>/…`, the path on base's `base plugin root:` session line;
`tests/fe-refs-lint.sh` resolves every such name and path against `plugins/base`.

## 2. How base is required

`"dependencies": ["base"]` is the whole declaration. Each load from a folder the developer owns lays
the contract of every plugin the manifest reaches through `dependencies`, transitively, into
`.claude-plugin/types/<plugin>/index.d.ts`: base's and, through base, slim's. fe's own contract never
redeclares their keys.

At run time fe checks for base itself: the engine does not install a dependency, and nothing fails
loudly without it. `session.ts` looks for a command whose `plugin` is `base` in `$.command.list()`
(base's skills carry its name from its manifest on, so the answer is there at session start; slim's
way, a registered tool, does not apply, as base registers none). Absent → one toast and one `install`
line; a listing that fails says nothing.

## 3. The hooks module

`register.ts` calls one register function per file. Each file declares its own atoms and spells its
own env names: the engine's validator follows `$` only into functions declared in the same file, never
across an import, so `doctor.ts` repeats `diskOf` and the base lookup rather than importing them.

| File | Hooks | Writes |
|---|---|---|
| `session.ts` | `session.start {cwd:/^/}` start line, base check, profile decision started unawaited · `prompt.compose`: the `fe:<name>` sections · `classic.SubagentStart`: the subagents' share as `additionalContext` | `fe.started`, `fe.profile`, `fe.events` |
| `doctor.ts` | `session.start {cwd:/$/}` + `prompt.submit`: register `/fe-doctor` (every start, and a new session id) · `command.run fe-doctor` (passes `--log-dir` to `doctor.cjs`) | `fe.armed`, `fe.events` |

Pure helpers carry no `$`: `events.ts` (the 200-line cap and the `fe.jsonl` writer), `conventions/text.ts`
(the section texts, `<fe root>` filled in by `withRoot`).

**The profile** lives in `session.ts` with both of its readers. It is decided once per session id —
`FE_PROFILE` when it holds one of the three words, else `bash scripts/project-profile.sh <session root>`
through `$.process.run` with a 5 s timeout — stored in `fe.profile` with how it was decided and whether
the project root holds `shopify.theme.toml` or `.env` (the store-access gate), and logged once. A
module-local promise keyed by the session id keeps the start, a compose and a subagent from running the
probe twice; a /clear's new id decides again at its first compose. The decision never changes within a
session, so the sections repeat byte for byte (the prompt cache). The probe stays a script because
`worktree-theme.sh`, the doctor and the skills' fallback (no profile line in the session) read the same answer outside the module.

## 4. The atoms

`types/index.d.ts` declares `fe: { … }` only. Any plugin reads a fe atom; fe alone writes it.

- **`fe.events`** — `{ atMs, kind, text }`, oldest first, at most 200; kinds `start`, `install`,
  `profile`, `doctor` (9 cells at most, none of band's or slim's). `FE_EVENT_LOG=0` keeps it empty.
  band does not read it yet.
- **`fe.profile`** — `{ session, word, via, why, store }`; `via` is `FE_PROFILE`, `project-profile.sh` or
  `fallback` (then `word` is `none` and `why` says what failed).
- **`fe.started`**, **`fe.armed`** — the session id whose start line and base check ran, and whose
  `/fe-doctor` is registered: a module reload repeats neither the line nor the check.

## 5. The file log

Every line pushed to `fe.events` also goes to `events.ts`'s `logLine` with a `Disk` the writing file
builds from its own `$`: `<log dir>/<session-id>/fe.jsonl`, `plugin` the literal `fe`, `version` from fe's
own manifest, the start line first in each session's file and never twice, the session's lines kept
module-local and seeded from the file after a reload, every write behind one queue, at most 2000 lines
or 256 KB, never a throw into a hook, one toast per session on the first failed write. The log
directory is `DOMAINE_LOG_DIR` when absolute, else `$HOME/.claude/domaine/log`; neither, no file. fe
never sweeps: base owns the clean-up of old session folders.

## 6. The doctor

`scripts/doctor.cjs` answers what a node process can see (node, manifest, scripts and their `--help`,
base installed, the Shopify CLI, the profile probe, the store files' presence, `fe.jsonl`); `/fe-doctor`
adds `base-live` and `slim-live`, puts the session's own profile in place of the probe's row, and
turns a static `base` FAIL into a WARN when the session loaded base anyway (a `--plugin-dir` load has
no install record). Never a value from `.env` or `shopify.theme.toml`.

## 7. What stays a script

A script is what has to run outside the module: from a skill's Bash call, from a worktree's own
session, from a terminal by hand, or under a timeout the module must not inherit.

- **Store scripts** (`create-preview-theme.sh`, `theme-json.sh`, `shopify-admin-gql.sh`, sourcing
  `_shopify-common.sh`): they read the Theme Access token from `shopify.theme.toml` or `.env` inside
  their own process, so no secret reaches the model; the `store-access` section tells the session to
  use them instead of reading either file.
- **`session-theme.sh`**: one file holds both directions of the toml pin grammar — sourced by
  `create-preview-theme.sh` for the pin, run by `worktree-theme.sh` for the un-pin — so they cannot
  drift.
- **`worktree-theme.sh`**: base's `worktree-setup.sh` knows no theme; this is the Shopify half
  (un-pin once per worktree, a stamp in the worktree's git dir; the dev-server line with the port base
  recorded). `/fe:preview-theme` and `/fe:ship` run it.
- **`project-profile.sh`**, **`doctor.cjs`**: § 3 and § 6.

No script writes `fe.events` or `fe.jsonl`; only the module does. Every `scripts/*.sh` but the sourced
`_shopify-common.sh` answers `--help` with exit 0; the doctor's `scripts` row holds them to it
(`project-profile.sh` is probed by its `profile` row instead).
