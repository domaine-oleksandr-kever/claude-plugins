import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { ATTRIBUTION_DENY, carriesAttribution } from '../guards/attribution.ts'
import { NO_VERIFY_FALLBACK } from '../guards/bash.ts'
import { DENY_FALLBACK, guardNote } from '../guards/scratch.ts'
import { NOW, PEEK, eventsOf, peek, ran, start, world } from './world.ts'

const t = (name: string, body: ($: any, on: On) => Promise<void>) => test(name, { plugins: [PEEK] }, body)
const bash = ($: any, command: string) => $.tool.call({ tool: 'Bash', command })
const NV_DENY = 'Domaine convention (references/commit-message-format.md): git hooks are quality gates — never …'

// The attribution rows of the commit-guard matrix: `block` must stay closed, `allow` must stay open.
const BLOCK: [string, string][] = [
  ['N01-trailer-multiline', 'git commit -m "feat: x\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>"'],
  ['N02-anthropic-email', 'git commit -m "fix" -m "Co-Authored-By: Bot <noreply@anthropic.com>"'],
  ['N03-generated-with', 'git commit -m "x\n\n🤖 Generated with [Claude Code]"'],
  ['N04-generated-bare', 'git commit -m "Generated with Claude"'],
  ['N05-C-option-gate', 'git -C . commit -m "x Co-Authored-By: Claude <noreply@anthropic.com>"'],
  ['N06-double-space-gate', 'git  commit -m "x Co-Authored-By: Claude <noreply@anthropic.com>"'],
  ['N07-heredoc-F', "git commit -F - <<'EOF'\nmsg\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nEOF"],
  ['N08-sh-wrap', 'sh -c "git commit -m \\"x Co-Authored-By: Claude <noreply@anthropic.com>\\""'],
  ['N09-amend-chain', 'git add -A && git commit --amend -m "x\n\nCo-Authored-By: Claude <noreply@anthropic.com>"'],
  ['N10-semicolon-in-msg', 'git commit -m "fix: a; b\n\nCo-Authored-By: Claude <noreply@anthropic.com>"'],
  ['N11-residual-mention-fp', "git commit -m 'docs: forbid Co-Authored-By: Claude trailers'"],
  ['N12-residual-postcmd-fp', 'git commit -m "ok"; git log --grep "Co-Authored-By: Claude"'],
  ['N13-addr-only', 'git commit -m "feat: x\n\nCo-Authored-By: Fable 5 <fable@anthropic.com>"'],
  ['N14-addr-upper', 'git commit -m "feat: x\n\nCo-Authored-By: Fable 5 <BOT@ANTHROPIC.COM>"'],
  ['N15-addr-subdomain', 'git commit -m "feat: x\n\nCo-Authored-By: Fable 5 <ai@mail.anthropic.com>"'],
  ['N16-genwith-wrapped', 'git commit -m "feat: x\n\n🤖 Generated\nwith [Claude Code](https://claude.com/claude-code)"'],
  ['N17-anthropic-only', 'git commit -m "wip" -m "noreply@anthropic.com"'],
  ['N18-git-c-option', 'git -c user.name=x commit -m "x\n\nCo-Authored-By: Claude <noreply@anthropic.com>"'],
  ['N19-lowercase', 'git commit -m "x\n\nco-authored-by: claude <noreply@anthropic.com>"'],
]
const ALLOW: [string, string][] = [
  ['M01-plain', 'git commit -m "safe change"'],
  ['M02-human-coauthor', 'git commit -m "pair work\n\nCo-Authored-By: Jane Doe <jane@corp.example>"'],
  ['M03-grep-before', 'grep -r "Co-Authored-By: Claude" plugins ; git commit -m "ok"'],
  ['M04-echo-before', 'echo "Co-Authored-By: Claude" > docs/note.md && git commit -m "ok"'],
  ['M05-heredoc-before', 'cat <<EOF > note.md\nCo-Authored-By: Claude <noreply@anthropic.com>\nEOF\ngit commit -m "ok"'],
  ['M06-log-grep', 'git log --grep "Co-Authored-By: Claude"'],
  ['M07-claude-mention', 'git commit -m "explain claude workflow"'],
  ['M08-prose-no-commit', 'echo Co-Authored-By: Claude is banned in commits'],
  ['M09-postcmd-and-chain', 'git commit -m "ok" && git log --grep "Co-Authored-By: Claude"'],
  ['M10-anthropic-sub', 'git commit -m "pair\n\nCo-Authored-By: Jane <jane@anthropic.example.com>"'],
  ['M11-not-anthropic', 'git commit -m "pair\n\nCo-Authored-By: Jane <jane@notanthropic.community>"'],
  ['M12-legit-commit', 'legit commit -m "x Co-Authored-By: Claude <noreply@anthropic.com>"'],
  ['M13-empty', ''],
]

describe('no AI attribution (matcher)', () => {
  for (const [label, cmd] of BLOCK) {
    test(`block ${label}`, async () => {
      expect(carriesAttribution(cmd)).toBe(true)
    })
  }
  for (const [label, cmd] of ALLOW) {
    test(`allow ${label}`, async () => {
      expect(carriesAttribution(cmd)).toBe(false)
    })
  }
})

describe('Bash guards (tool.call)', () => {
  t('an attribution trailer → denied before any spawn; one guard line; the tool never runs', async ($, on) => {
    const { calls } = world(on, { run: () => ran(0) })
    const r = await bash($, BLOCK[0]![1])
    expect(r).toEqual({ deny: ATTRIBUTION_DENY })
    expect(calls.runs.length).toBe(0)
    expect(calls.below.length).toBe(0)
    expect(await eventsOf($, 'guard')).toEqual([{ atMs: NOW, kind: 'guard', text: 'Bash: a commit message with AI attribution' }])
  })

  t('a git command runs the no-verify script: bash, the script under the plugin root, the event on stdin, 10 s', async ($, on) => {
    const { calls } = world(on, { run: () => ran(0) })
    const r = await bash($, 'git commit -m "safe change"')
    expect(r.result).toBe('ok')
    expect(calls.runs.length).toBe(1)
    const [run] = calls.runs
    expect(run!.argv[0]).toBe('bash')
    expect(run!.argv[1]).toEndWith('/hooks/no-verify-bypass.sh')
    expect(run!.argv.length).toBe(2)
    expect(run!.init?.timeoutMs).toBe(10_000)
    expect(JSON.parse(run!.init?.stdin ?? '')).toEqual({ tool_name: 'Bash', tool_input: { command: 'git commit -m "safe change"' } })
    expect(await eventsOf($, 'guard')).toEqual([])
  })

  t('exit 2 → denied with the script\'s stderr; one guard line; the tool never runs', async ($, on) => {
    const { calls } = world(on, { run: () => ran(2, '', `${NV_DENY}\n`) })
    expect(await bash($, 'git commit --no-verify -m x')).toEqual({ deny: NV_DENY })
    expect(calls.below.length).toBe(0)
    expect((await eventsOf($, 'guard')).map(ev => ev.text)).toEqual(['Bash: a git hooks bypass'])
  })

  t('exit 2 with no stderr → the fallback reason', async ($, on) => {
    world(on, { run: () => ran(2) })
    expect(await bash($, 'git push --no-verify')).toEqual({ deny: NO_VERIFY_FALLBACK })
  })

  for (const [name, answer] of [
    ['exit 0', () => ran(0)],
    ['exit 1', () => ran(1, '', 'boom')],
    ['a spawn that cannot start', () => null],
  ] as const) {
    t(`fails open on ${name}`, async ($, on) => {
      const { calls } = world(on, { run: answer })
      const r = await bash($, 'git commit -n -m x')
      expect(r.result).toBe('ok')
      expect(calls.runs.length).toBe(1)
      expect(calls.below.length).toBe(1)
    })
  }

  t('a command naming no git word → no spawn', async ($, on) => {
    const { calls } = world(on, { run: () => ran(2, '', 'x') })
    for (const cmd of ['ls -la', 'npm test', 'echo hello']) expect((await bash($, cmd)).result).toBe('ok')
    expect(calls.runs.length).toBe(0)
  })

  t('every trigger word of the script spawns it, ` am` included', async ($, on) => {
    const { calls } = world(on, { run: () => ran(0) })
    for (const cmd of ['git status', 'npm run commit', 'x merge', 'y pull', 'z am --no-verify', 'q\tam']) await bash($, cmd)
    expect(calls.runs.length).toBe(6)
  })

  t('BASE_GUARD=0 → neither guard runs', async ($, on) => {
    const { calls } = world(on, { env: { BASE_GUARD: '0' }, run: () => ran(2, '', 'x') })
    expect((await bash($, BLOCK[0]![1])).result).toBe('ok')
    expect((await bash($, 'git commit -n -m x')).result).toBe('ok')
    expect(calls.runs.length).toBe(0)
    expect(calls.below.length).toBe(2)
  })

  t('BASE_EVENT_LOG=0 → the deny stands, nothing logged', async ($, on) => {
    world(on, { env: { BASE_EVENT_LOG: '0' }, run: () => ran(2, '', 'nope') })
    expect(await bash($, 'git commit -n -m x')).toEqual({ deny: 'nope' })
    expect(await bash($, BLOCK[1]![1])).toEqual({ deny: ATTRIBUTION_DENY })
    expect((await peek($)).events).toEqual([])
  })
})

const GUARDED = [
  'mcp__plugin_base_chrome-devtools-mcp__take_screenshot',
  'mcp__plugin_base_playwright__browser_take_screenshot',
  'mcp__plugin_base_chrome-devtools-mcp__take_snapshot',
  'mcp__plugin_base_chrome-devtools-mcp__get_network_request',
  'mcp__plugin_base_playwright__browser_run_code_unsafe',
]
const SHOT = GUARDED[0]!
const PROVIDER = { plugin: 'mcp:chrome-devtools', tier: 'user' } as any
const describeTool = ($: any, tool: string) => $.tool.describe({ tool, description: 'Take a screenshot.', provider: PROVIDER })
const denyJson = (reason?: string) =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', ...(reason === undefined ? {} : { permissionDecisionReason: reason }) } })

describe('scratch-path guard: tool.describe', () => {
  t('appends the note on all five tools; the note is constant and names the accepted dirs', async ($, on) => {
    world(on)
    for (const tool of GUARDED) expect((await describeTool($, tool)).description).toBe(`Take a screenshot.${guardNote(tool)}`)
    expect((await describeTool($, SHOT)).description).toBe((await describeTool($, SHOT)).description)
    expect(guardNote(SHOT)).toContain('.claude/tasks/<work-id>/tmp/')
    expect(guardNote(SHOT)).toContain('.claude/tmp/')
    expect(guardNote(SHOT)).toContain('base scratch-path guard:')
    expect(guardNote(SHOT)).toContain('OS temp dir')
    expect(guardNote(GUARDED[1]!)).not.toContain('OS temp dir')
    expect(guardNote(GUARDED[4]!)).not.toContain('OS temp dir')
  })

  t('other tools are unchanged', async ($, on) => {
    world(on)
    for (const tool of ['mcp__plugin_base_chrome-devtools-mcp__navigate_page', 'mcp__x__browser_take_screenshot_extra', 'Bash']) {
      expect((await describeTool($, tool)).description).toBe('Take a screenshot.')
    }
  })

  for (const [name, over] of [
    ['BASE_SCRATCH_GUARD=0 in the env', { env: { BASE_SCRATCH_GUARD: '0' } }],
    ['BASE_GUARD=0 in the env', { env: { BASE_GUARD: '0' } }],
    ['BASE_SCRATCH_GUARD=0 in the settings env', { settingsEnv: { BASE_SCRATCH_GUARD: '0' } }],
    ['BASE_GUARD=0 in the settings env', { settingsEnv: { BASE_GUARD: '0' } }],
  ] as const) {
    t(`${name} → unchanged`, async ($, on) => {
      world(on, over as any)
      expect((await describeTool($, SHOT)).description).toBe('Take a screenshot.')
    })
  }
})

describe('scratch-path guard: tool.call', () => {
  t('a deny from the script denies with its reason; one guard line; the tool never runs', async ($, on) => {
    const { calls } = world(on, { run: () => ran(0, denyJson('base scratch-path guard: /etc/x.png is outside the project\nUse .claude/tmp/')) })
    const r = await $.tool.call({ tool: SHOT, filePath: '/etc/x.png' })
    expect(r).toEqual({ deny: 'base scratch-path guard: /etc/x.png is outside the project\nUse .claude/tmp/' })
    expect(calls.below.length).toBe(0)
    expect(await eventsOf($, 'guard')).toEqual([{ atMs: NOW, kind: 'guard', text: 'take_screenshot: /etc/x.png is outside the project' }])
  })

  t('a deny with no reason (or a blank one) gets the fallback text', async ($, on) => {
    let reason: string | undefined
    world(on, { run: () => ran(0, denyJson(reason)) })
    expect((await $.tool.call({ tool: GUARDED[4], code: 'x' })).deny).toBe(DENY_FALLBACK)
    reason = '  '
    expect((await $.tool.call({ tool: SHOT, filePath: '/etc/x.png' })).deny).toBe(DENY_FALLBACK)
    expect((await eventsOf($, 'guard')).map(ev => ev.text)).toEqual([
      'browser_run_code_unsafe: path outside the project',
      'take_screenshot: path outside the project',
    ])
  })

  for (const [name, answer] of [
    ['empty stdout', () => ran(0)],
    ['exit 2', () => ran(2, denyJson('x'))],
    ['garbage', () => ran(0, 'not json {')],
    ['an allow', () => ran(0, '{}')],
    ['a spawn that cannot start', () => null],
  ] as const) {
    t(`fails open on ${name}`, async ($, on) => {
      const { calls } = world(on, { run: answer })
      const r = await $.tool.call({ tool: SHOT, filePath: '/repo/.claude/tmp/x.png' })
      expect(r.result).toBe('ok')
      expect(calls.runs.length).toBe(1)
      expect(calls.below.length).toBe(1)
      expect(await eventsOf($, 'guard')).toEqual([])
    })
  }

  t('call shape: node, the script under the plugin root, the launch root latched at session.start, the MCP arguments alone', async ($, on) => {
    const { w, calls } = world(on, { run: () => ran(0) })
    w.root = '/launch'
    await start($)
    w.root = '/moved'
    await $.tool.call({ tool: SHOT, tool_use_id: 'toolu_1', filePath: '/tmp/a.png', format: 'png' })
    expect((await peek($)).guardRoot).toBe('/launch')
    expect(calls.runs.length).toBe(1)
    const run = calls.runs[0] as any
    const init = run.init
    expect(run.argv[0]).toBe('node')
    expect(run.argv[1]).toEndWith('/hooks/scratch-path-guard.cjs')
    expect(run.argv.length).toBe(2)
    expect(init.timeoutMs).toBe(10_000)
    expect(init.env.CLAUDE_PROJECT_DIR).toBe('/launch')
    expect(run.argv[1]).toBe(`${init.env.CLAUDE_PLUGIN_ROOT}/hooks/scratch-path-guard.cjs`)
    const stdin = JSON.parse(init.stdin)
    expect(stdin).toEqual({ hook_event_name: 'PreToolUse', tool_name: SHOT, tool_input: { filePath: '/tmp/a.png', format: 'png' }, cwd: '/moved' })
  })

  t('a second session.start keeps the first root; with none, the first call latches the live root', async ($, on) => {
    const { w, calls } = world(on, { run: () => ran(0) })
    w.root = '/live'
    await $.tool.call({ tool: SHOT, filePath: '/tmp/a.png' })
    w.root = '/moved'
    await start($)
    await $.tool.call({ tool: SHOT, filePath: '/tmp/a.png' })
    expect(calls.runs.map(r => r.init?.env?.CLAUDE_PROJECT_DIR)).toEqual(['/live', '/live'])
  })

  for (const env of [{ BASE_SCRATCH_GUARD: '0' }, { BASE_GUARD: '0' }]) {
    t(`${Object.keys(env)[0]}=0 → no spawn, the tool runs`, async ($, on) => {
      const { calls } = world(on, { env, run: () => ran(0, denyJson('x')) })
      expect((await $.tool.call({ tool: SHOT, filePath: '/etc/x.png' })).result).toBe('ok')
      expect(calls.runs.length).toBe(0)
      expect(calls.below.length).toBe(1)
    })
  }

  t('a tool outside the matcher → no spawn', async ($, on) => {
    const { calls } = world(on, { run: () => ran(0, denyJson('x')) })
    expect((await $.tool.call({ tool: 'mcp__plugin_base_chrome-devtools-mcp__navigate_page', url: 'https://x.test' })).result).toBe('ok')
    expect(calls.runs.length).toBe(0)
  })

  t('BASE_EVENT_LOG=0 → the deny stands, nothing logged', async ($, on) => {
    world(on, { env: { BASE_EVENT_LOG: '0' }, run: () => ran(0, denyJson('outside the project')) })
    expect((await $.tool.call({ tool: SHOT, filePath: '/etc/x.png' })).deny).toBe('outside the project')
    expect((await peek($)).events).toEqual([])
  })
})
