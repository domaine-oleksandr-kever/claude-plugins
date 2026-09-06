# Hoisted orchestration — one-level hosts

Read from `pipeline-phases.md` → Orchestration when the host runs one level of subagents
(Cursor; OpenCode without a raised `subagent_depth`; Codex) — or none at all. Where subagents run
nested, as on Claude Code, the phase briefs run as written and this file is never read.

- **The conductor is the only spawner.** Same phases, same order, same briefs, same artifacts
  and ticks; each phase runs as ONE subagent.
- **Every nested spawn a brief names is hoisted to the conductor**, which runs it at its own
  level and passes the findings *into* the phase brief: `bug-hunter` alongside the qa agent,
  `change-reviewer` before the finalize agent commits, the conformance and correctness passes
  before the create-pr agent drafts. Gate semantics do not move — a blocking finding still
  stops the phase, and the phase agent still dispositions every finding it is handed. A phase
  agent that needs a helper it cannot spawn and was handed nothing `ESCALATE`s; it never
  improvises a nested spawn and never substitutes its own read of the diff for a missing pass.
- **Fan out where the host runs threads concurrently** — Codex's
  `max_concurrent_threads_per_session` makes the hoisted helpers genuinely parallel and is the
  closest a non-Claude host gets to the Claude fan-out; Cursor and OpenCode may serialize them,
  which costs wall-clock, not coverage.
- **No usable spawning at all** (a host or a mode without subagents) → the phase runs inline in
  the conductor session, following the skill its row maps to (`ship` → Relationship to the
  series): the sequential skill chain workflows 2–6 already encode. Same artifacts, same ticks;
  the fresh-lens property of the qa and review agents is lost, so say so in the final report.

Honest losses off Claude Code, in every shape above: **no adversarial verify fan-out** — one
pass per lens is the whole review, so what it misses stays missed; **no per-phase workflow
telemetry** — `pipeline.md` ticks plus each phase's ≤20-line report are the entire run trace;
and on one-level hosts the conductor carries the findings tables that would otherwise have
stayed inside a phase agent, so keep them to tables, never file dumps.
