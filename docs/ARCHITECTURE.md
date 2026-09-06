# fnd plugin — architecture

One repository, four agent hosts, one set of canonical behaviour. Everything the model reads
(skills, agents, references, hook context) and everything that runs (hooks, scripts) lives under
`plugins/fnd/`; each host gets a thin adapter that translates its own hook protocol into the
canonical one. The diagrams render natively on GitHub.

## 1. Layers

```mermaid
flowchart TB
  subgraph hosts["Agent hosts"]
    CC["Claude Code"]
    CU["Cursor"]
    CX["Codex CLI"]
    OC["OpenCode"]
  end

  subgraph wiring["Per-host wiring (the only host-specific code)"]
    W1["plugin.json hooks block"]
    W2["hooks-cursor.json → cursor-shim.cjs"]
    W3["hooks-codex.json → codex-mcp-shim.cjs"]
    W4["opencode/fnd-plugin.js"]
  end

  subgraph canon["Canonical hooks (plugins/fnd/hooks)"]
    H1["session context *.md"]
    H2["user-prompt.cjs"]
    H3["subagent-conventions.sh"]
    H4["no-ai-attribution.sh · no-verify-bypass.sh"]
    H5["scratch-path-guard.cjs · spill-access.sh"]
    H6["mcp-slim.cjs"]
    H7["host-trace.sh / .cjs"]
  end

  subgraph model["What the model reads"]
    S["skills/ (18)"]
    A["agents/ (7 readers, reviewers, one writer)"]
    R["references/ (26)"]
  end

  subgraph scripts["Scripts the skills invoke (plugins/fnd/scripts)"]
    P1["create-preview-theme.sh · theme-json.sh · worktree-setup.sh · shopify-admin-gql.sh"]
    P2["json-slim.cjs · log-slim.cjs · scratch-hygiene.cjs"]
    P3["md-to-adf.cjs · adf-to-md.cjs"]
    P4["doctor.cjs · domaine-env.cjs · env-file.cjs"]
  end

  subgraph gen["Generated per host (gen-host-adapters.cjs --check keeps them in sync)"]
    G1["agents-cursor/ · agents-codex/ · agents-opencode/"]
    G2["commands-opencode/ · rules/"]
  end

  CC --> W1 --> canon
  CU --> W2 --> canon
  CX --> W3 --> canon
  OC --> W4 --> canon
  canon --> H7
  S --> scripts
  A --> P3
  H6 --> P2
  A -.-> G1
  S -.-> G2
```

The rule behind the picture: a behaviour is implemented once, in `canon` or `scripts`, and every
host reaches it through its adapter. The adapters translate payload keys and response shapes and
never re-implement a decision; `tests/hooks-cursor-sim.sh`, `tests/hooks-codex-sim.sh` and
`tests/opencode-plugin-sim.mjs` replay the same fixtures through each dialect.

## 2. A session, hook by hook

```mermaid
sequenceDiagram
  autonumber
  participant Host
  participant Hooks as fnd hooks
  participant Model
  participant Tool as Tool / MCP server

  Host->>Hooks: SessionStart
  Hooks-->>Model: plugin root + conventions (comment discipline, lean code, task workspace, whale routing, untrusted content, store access)
  Host->>Hooks: UserPromptSubmit
  Hooks-->>Model: context-budget monitor, prompt-JSON guard (hands a pasted blob back as a file)
  Host->>Hooks: SubagentStart
  Hooks-->>Model: conventions for code-writing agents (readers skipped)
  Model->>Host: Bash(git commit …)
  Host->>Hooks: PreToolUse
  Note over Hooks: no-ai-attribution → no-verify-bypass<br/>exit 2 = deny (--no-verify, hooksPath, HUSKY=0, alias tricks)
  Hooks-->>Host: allow / deny + reason
  Model->>Host: mcp__…__take_screenshot(path)
  Host->>Hooks: PreToolUse
  Hooks-->>Host: deny when the path lands inside the checkout (scratch-path-guard)
  Model->>Host: mcp__…__getJiraIssue
  Host->>Tool: call
  Tool-->>Host: result
  Host->>Hooks: PostToolUse
  Hooks-->>Host: rewritten result (mcp-slim) or the original
  Model->>Host: Read / Grep / Bash on a spill file
  Host->>Hooks: PreToolUse
  Note over Hooks: spill-access records the read (measurement only)
```

Every hook appends one metadata line to `fnd-host-trace.log` when `FND_HOST_TRACE=1`;
`doctor.cjs --trace` renders it as an event/hook × host matrix — the proof the hooks fired on
a host, from disk rather than from the model's own report.

## 3. MCP result compression (mcp-slim + json-slim)

```mermaid
flowchart LR
  R["MCP result"] --> G{"> 4 KB?"}
  G -- no --> PT["passthrough"]
  G -- yes --> ERR{"error envelope?"}
  ERR -- yes --> PT
  ERR -- no --> SHAPE["shape rails<br/>fenced payload unwrap · text-block envelope · JSONL → profile<br/>Figma JSX · log-slim"]
  SHAPE --> STAGES["JSON stages, in order<br/>adf → noise → truncate → crush"]
  STAGES --> GAIN{"smaller, and lossless<br/>where it must be?"}
  GAIN -- yes --> C["compressed result<br/>+ full= spill handle for whales"]
  GAIN -- no, big --> STUB["spill-and-stub<br/>byte-exact original on disk, stub in context"]
  GAIN -- no, small --> PT
  R -. "over the platform limit" .-> OVF["platform-overflow spill<br/>(host hands the model a path)"]
  OVF --> CLI["json-slim.cjs &lt;path&gt;<br/>same pipeline, from the CLI"]
  C & STUB & PT & CLI --> LOG["fnd-mcp-slim-debug.log"]
  LOG --> REP["doctor.cjs --report<br/>bytes saved per tool / project,<br/>missed whales, CLI runs"]
```

Two guards sit around the pipeline: a no-gain memo refuses to re-run the same file for two hours
when the first run gained nothing, and the whale-guide is a one-shot instruction layer that tells
the model how to read a spill (the `mcp-whale.md` session context is the trigger, json-slim's own
stdout is the recipe). Spill files carry a TTL and are swept by the hook itself.

Per host, the result rewrite is a capability of the host, not of the plugin:

| Host | Session context | Prompt hook | Subagent conventions | Shell guards | Screenshot guard | Spill access | MCP result rewrite |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Claude Code | hook | yes | yes | yes | yes | yes | **yes** — compressed or stubbed in place |
| OpenCode | adapter (store projects) | yes | no event on this host | yes | yes | yes | **yes** — the adapter rewrites `output.content` |
| Codex CLI | hook | yes | yes | yes | yes | yes | stub only — the shim forwards the spill handle as `additionalContext`; a compressed copy would grow the context |
| Cursor | rules + shim | shim | shim (unverified) | shim | shim | shell reads only | **no** — `afterMCPExecution` has no response schema; the shim only logs that it fired |

## 4. Skills, agents and the ship pipeline

```mermaid
flowchart TB
  subgraph solo["Solo skills (one conversation, developer in the loop)"]
    D["develop-feature-or-fix"]
    PV["preview-theme"]
    WT["worktree"]
    CM["commit"]
    PR["create-pull-request"]
    PCR["pre-commit-review"]
    QA["qa-feature-or-fix"]
    STT["write-steps-to-test"]
    TA["write-technical-approach"]
    MISC["preflight-checks · smoke-test · save-task-context · update-translations<br/>fix-accessibility-issue · get/fix-breaking-changes · report-plugin-issue"]
  end

  subgraph ship["/fnd:ship — auto mode (conductor + phase agents)"]
    S0["Step 0 readiness"] --> S1["Step 1 ingest<br/>(parallel readers)"] --> S2["Step 2 interview"] --> S3["Step 3 contract ✋"] --> S4["Step 4 autonomous run"]
  end

  subgraph agents["Agents (read-only toward their source, except jira-writer)"]
    JR["jira-reader"]
    FR["figma-reader"]
    DR["doc-reader"]
    TE["theme-explorer"]
    CR["change-reviewer"]
    BH["bug-hunter"]
    JW["jira-writer"]
  end

  subgraph store["Store-facing scripts"]
    CPT["create-preview-theme.sh<br/>session theme, overlay, refresh"]
    TJ["theme-json.sh<br/>settings / templates read-write"]
    GQL["shopify-admin-gql.sh<br/>metafields, metaobjects"]
    WS["worktree-setup.sh<br/>parallel ship"]
  end

  S1 --> JR & FR & DR & TE
  S4 --> D & PV & PCR & CM & PR & QA
  PCR --> CR & BH
  STT & TA --> JW
  D --> TE
  PV --> CPT
  D --> TJ & GQL
  WT --> WS
  CM & PR -. "review marker .git/.fnd-review" .-> PCR
```

The review flow is one mechanism shared by `pre-commit-review`, `commit` and
`create-pull-request`: a marker in `.git/.fnd-review` records which diff was reviewed, so the
commit and PR skills re-run the reviewers only when the diff drifted
(`plugins/fnd/references/review-flow.md`). Every ticket-tied piece of work keeps its memory in
`.claude/tasks/<work-id>/` — reader outputs, approved plans, decisions — so a new session or a
compaction loses nothing (`plugins/fnd/references/task-workspace.md`).

## 5. Bundled MCP servers

`plugins/fnd/mcp.json` ships six servers: `atlassian` (Jira and Confluence), `figma-dev-mode`,
`notion-mcp`, `shopify-dev-mcp`, `chrome-devtools-mcp`, `playwright`. Jira and Confluence
rich text is written as ADF through `md-to-adf.cjs` and read back through `adf-to-md.cjs`
(round-trip fixtures in `tests/adf-md-fixtures.mjs`). Hosts with a tool cap get
`plugins/fnd/mcp.pruned.json`.

## 6. Configuration and switches

```mermaid
flowchart LR
  ENV["process env"] --> P["project .claude/domaine.env"] --> GL["~/.config/domaine/env"]
  GL --> READ["env-file.cjs load()<br/>(env > project > global)"]
  READ --> HOOKS["hooks and scripts"]
  DE["domaine-env.cjs set KEY=VALUE"] --> GL
  NOTE["global-only switches never read the project file<br/>(FND_HOST_TRACE)"] -.-> READ
```

Every `FND_*` switch is listed in README → Environment switches; each is read through the
same loader, and the hooks pre-gate on the cheap ones in the wiring so a disabled feature spawns
no process.

## 7. Tests, release, install

```mermaid
flowchart LR
  subgraph tests["tests/ (dependency-free, hermetic)"]
    T1["hooks-sim.sh · no-verify-bypass-matrix.sh"]
    T2["hooks-cursor-sim.sh · hooks-codex-sim.sh · opencode-plugin-sim.mjs"]
    T3["scripts-sim.sh (stub runner + PATH shims)"]
    T4["json-slim-fixtures.mjs · adf-md-fixtures.mjs"]
    T5["doctor-sim · install-sim · garden-sim · readme-checks · lints"]
  end
  CI["GitHub Actions: macOS + Ubuntu"] --> tests
  CI --> GEN["gen-host-adapters.cjs --check"]
  REL["bump-version.cjs → chore(release): vX.Y.Z"] --> PUSH["push to main"]
  PUSH --> I1["Claude Code: plugin marketplace update + plugin update"]
  PUSH --> I2["Codex: plugin marketplace upgrade"]
  PUSH --> I3["Cursor / OpenCode: scripts/install.sh --target …<br/>(symlinked dev checkout)"]
  I1 & I2 & I3 --> DOC["doctor.cjs --target <host>"]
  DOC --> SMOKE["/fnd:smoke-test in a session<br/>row 8 = doctor --trace"]
```

The plugin installs from the GitHub remote, so an unpushed commit is invisible to every host.
`doctor.cjs` says whether a host will load the checkout; `smoke-test` proves what a script cannot
reach from inside a session; `doctor.cjs --trace` and `--report` read the two logs back.
