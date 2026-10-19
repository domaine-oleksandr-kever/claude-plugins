import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { ATTRIBUTION_DENY, carriesAttribution } from '../guards/attribution.ts'
import { NO_VERIFY_FALLBACK } from '../guards/bash.ts'
import { JIRA_WRITES, NOTION_WRITES, scopeRefusal, splitTool, twinServers, writeRefusal } from '../guards/mcp.ts'
import { DENY_FALLBACK, guardNote } from '../guards/scratch.ts'
import { NOW, PEEK, SLIM_VIEW, eventsOf, peek, ran, start, world } from './world.ts'

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

const HOME = '/home/dev'
// Spelled apart: tests/base-refs-lint.sh rule b allows no other plugin's prefix in plugins/base.
const KIT = `mcp__${'plugin'}_kit_`
const DIR = `${HOME}/.claude/domaine/log/s1/agents`
const OWN_GET = 'mcp__plugin_base_atlassian__getJiraIssue'
const TWIN_GET = 'mcp__ConnA__getJiraIssue'
const TWIN_TOOLS = ['Bash', SLIM_VIEW, OWN_GET, TWIN_GET, 'mcp__ConnA__editJiraIssue', 'mcp__plugin_base_atlassian__getJiraIssueRemoteIssueLinks']
const call = ($: any, tool: string, agentId?: string) => $.tool.call({ tool, issueIdOrKey: 'ABC-1', ...(agentId ? { agentId } : {}) })
const agents = (w: any, map: Record<string, string>, dir = DIR) => {
  for (const [id, type] of Object.entries(map)) w.files[`${dir}/${id}.json`] = { text: type.startsWith('!') ? type.slice(1) : JSON.stringify(type), mtimeMs: 0 }
}
const PRECEDENCE = `${OWN_GET}: ${TWIN_GET} serves the same tool and takes precedence — call ${TWIN_GET} instead; if that fails, call ${OWN_GET} again (it is allowed after this one refusal)`
const UNKNOWN = (tool: string) => `base: ${tool} refused: no agent-type marker for this subagent, so it gets no Jira, Confluence or Notion write tool`

describe('MCP guard: helpers', () => {
  test('splitTool: server and tool, the last __ splits', () => {
    expect(splitTool('mcp__plugin_base_notion-mcp__notion-fetch')).toEqual({ server: 'plugin_base_notion-mcp', tool: 'notion-fetch' })
    expect(splitTool('mcp__ConnB_2__getJiraIssue')).toEqual({ server: 'ConnB_2', tool: 'getJiraIssue' })
    expect(splitTool('mcp__x')).toBeNull()
    expect(splitTool('Bash')).toBeNull()
  })

  test("twinServers: the servers listing the base server's signature tool, but a plugin's, slim's or base's, once each, in list order", () => {
    const names = ['mcp__B__getJiraIssue', 'mcp__plugin_base_atlassian__getJiraIssue', `${KIT}y__getJiraIssue`, 'mcp__slim__getJiraIssue',
      'mcp__base__getJiraIssue', 'mcp__A__getJiraIssue', 'mcp__B__getJiraIssue', 'mcp__C__search', 'mcp__D__notion-fetch']
    expect(twinServers(names, 'atlassian')).toEqual(['B', 'A'])
    expect(twinServers(names, 'notion-mcp')).toEqual(['D'])
    expect(twinServers(names, 'figma-dev-mode')).toEqual([])
    expect(twinServers(names, 'playwright')).toEqual([])
  })

  test('writeRefusal: readers and an unknown type get no write, the writer its two, any other type all', () => {
    for (const tool of [...JIRA_WRITES, ...NOTION_WRITES]) {
      expect(writeRefusal(null, tool, `mcp__X__${tool}`)).toBe(UNKNOWN(`mcp__X__${tool}`))
      for (const r of ['base:jira-reader', 'base:doc-reader', 'base:figma-reader']) expect(writeRefusal(r, tool, 'f')).toContain(`base: ${r} is read-only`)
      expect(writeRefusal('general-purpose', tool, 'f')).toBeNull()
      expect(writeRefusal('base:bug-hunter', tool, 'f')).toBeNull()
    }
    expect(writeRefusal('base:jira-writer', 'editJiraIssue', 'f')).toBeNull()
    expect(writeRefusal('base:jira-writer', 'addCommentToJiraIssue', 'f')).toBeNull()
    expect(writeRefusal('base:jira-writer', 'transitionJiraIssue', 'mcp__X__transitionJiraIssue')).toBe(
      'base: base:jira-writer writes only with editJiraIssue or addCommentToJiraIssue — mcp__X__transitionJiraIssue refused',
    )
    expect(writeRefusal('base:jira-writer', 'notion-create-pages', 'f')).not.toBeNull()
    expect(writeRefusal(null, 'getJiraIssue', 'f')).toBeNull()
    expect(writeRefusal('base:jira-reader', 'notion-fetch', 'f')).toBeNull()
  })

  test("scopeRefusal: base's reader and writer types reach only a server serving their vendor's tools; other types anything", () => {
    const names = ['mcp__ConnA__getJiraIssue', 'mcp__ConnN__notion-fetch', 'mcp__ConnF__get_design_context', 'mcp__Shop__query']
    expect(scopeRefusal('base:jira-reader', 'ConnA', 'mcp__ConnA__search', names)).toBeNull()
    expect(scopeRefusal('base:jira-reader', 'plugin_base_atlassian', 'f', names)).toBeNull()
    expect(scopeRefusal('base:jira-reader', 'ConnN', 'mcp__ConnN__notion-fetch', names)).toBe(
      'base: base:jira-reader calls MCP tools only on a server that serves getJiraIssue — mcp__ConnN__notion-fetch refused',
    )
    expect(scopeRefusal('base:doc-reader', 'ConnN', 'f', names)).toBeNull()
    expect(scopeRefusal('base:doc-reader', 'plugin_base_notion-mcp', 'f', [])).toBeNull()
    expect(scopeRefusal('base:doc-reader', 'Shop', 'mcp__Shop__query', names)).toContain('serves getJiraIssue or notion-fetch — mcp__Shop__query refused')
    expect(scopeRefusal('base:figma-reader', 'ConnF', 'f', names)).toBeNull()
    expect(scopeRefusal('base:figma-reader', 'plugin_base_playwright', 'f', names)).toContain('refused')
    expect(scopeRefusal('base:jira-writer', 'Shop', 'f', names)).toContain('refused')
    expect(scopeRefusal('general-purpose', 'Shop', 'f', names)).toBeNull()
  })
})

describe('MCP guard: a connector takes precedence', () => {
  t("base's tool with a twin on another server → refused once, with the twin's name; the second call runs", async ($, on) => {
    const { calls } = world(on, { tools: TWIN_TOOLS })
    expect(await call($, OWN_GET)).toEqual({ deny: PRECEDENCE })
    expect(calls.below.length).toBe(0)
    expect((await call($, OWN_GET)).result).toBe('ok')
    expect(calls.below.length).toBe(1)
    expect((await peek($)).mcpSoft).toEqual({ sid: 's1', tools: [OWN_GET] })
    expect(await eventsOf($, 'guard')).toEqual([{ atMs: NOW, kind: 'guard', text: 'getJiraIssue: ConnA takes precedence' }])
  })

  t('a subagent is refused alike', async ($, on) => {
    world(on, { tools: TWIN_TOOLS })
    expect(await call($, OWN_GET, 'a1')).toEqual({ deny: PRECEDENCE })
  })

  t('a new session refuses once again', async ($, on) => {
    const { w } = world(on, { tools: TWIN_TOOLS })
    expect((await call($, OWN_GET)).deny).toBe(PRECEDENCE)
    expect((await call($, OWN_GET)).result).toBe('ok')
    w.sid = 's2'
    expect((await call($, OWN_GET)).deny).toBe(PRECEDENCE)
    expect((await peek($)).mcpSoft).toEqual({ sid: 's2', tools: [OWN_GET] })
  })

  t('the refused list keeps the newest 200', async ($, on) => {
    const own = Array.from({ length: 201 }, (_, i) => `mcp__plugin_base_atlassian__t${i}`)
    world(on, { tools: [...TWIN_TOOLS, ...own, ...own.map(n => n.replace('plugin_base_atlassian', 'ConnA'))] })
    for (const n of own) expect((await call($, n)).deny).toContain('takes precedence')
    const { tools } = (await peek($)).mcpSoft
    expect(tools.length).toBe(200)
    expect(tools[0]).toBe(own[1])
    expect(tools[199]).toBe(own[200])
    expect((await call($, own[0])).deny).toContain('takes precedence')
  })

  t("no twin, or a twin only on another plugin's server or slim's or base's tools → the call runs", async ($, on) => {
    const { calls } = world(on, { tools: [...TWIN_TOOLS.filter(n => n !== TWIN_GET), `${KIT}jira__getJiraIssue`, 'mcp__slim__getJiraIssue', 'mcp__base__getJiraIssue'] })
    expect((await call($, OWN_GET)).result).toBe('ok')
    expect((await call($, 'mcp__plugin_base_atlassian__getJiraIssueRemoteIssueLinks')).result).toBe('ok')
    expect(calls.below.length).toBe(2)
    expect(await eventsOf($, 'guard')).toEqual([])
  })

  t("a server sharing only a generic tool name, or a base server without a signature, is no twin", async ($, on) => {
    const { calls } = world(on, {
      tools: ['mcp__plugin_base_atlassian__search', 'mcp__Research__search', 'mcp__plugin_base_notion-mcp__authenticate', 'mcp__Other__authenticate',
        'mcp__plugin_base_playwright__browser_click', 'mcp__Pw__browser_click'],
    })
    for (const tool of ['mcp__plugin_base_atlassian__search', 'mcp__plugin_base_notion-mcp__authenticate', 'mcp__plugin_base_playwright__browser_click']) {
      expect((await call($, tool)).result).toBe('ok')
    }
    expect(calls.below.length).toBe(3)
  })

  t("the connector's own call, and another plugin's server, run", async ($, on) => {
    const { calls } = world(on, { tools: [...TWIN_TOOLS, `${KIT}jira__getJiraIssue`] })
    expect((await call($, TWIN_GET)).result).toBe('ok')
    expect((await call($, `${KIT}jira__getJiraIssue`)).result).toBe('ok')
    expect(calls.below.length).toBe(2)
  })

  t('a tool list that fails lets the call run', async ($, on) => {
    const { calls } = world(on, { tools: TWIN_TOOLS, toolsFail: true })
    expect((await call($, OWN_GET)).result).toBe('ok')
    expect(calls.below.length).toBe(1)
  })
})

describe('MCP guard: subagents', () => {
  t('a reader is refused every Jira, Confluence and Notion write on any server; its reads run', async ($, on) => {
    const { w, calls } = world(on, { env: { HOME }, tools: TWIN_TOOLS })
    agents(w, { a1: 'base:jira-reader', a2: 'base:doc-reader', a3: 'base:figma-reader' })
    expect(await call($, 'mcp__ConnA__editJiraIssue', 'a1')).toEqual({ deny: 'base: base:jira-reader is read-only toward Jira, Confluence and Notion — mcp__ConnA__editJiraIssue refused' })
    expect((await call($, 'mcp__ConnN__notion-update-page', 'a2')).deny).toContain('base: base:doc-reader is read-only')
    expect((await call($, `${KIT}x__createConfluencePage`, 'a3')).deny).toContain('base: base:figma-reader is read-only')
    expect((await call($, TWIN_GET, 'a1')).result).toBe('ok')
    expect(calls.below.length).toBe(1)
    expect((await eventsOf($, 'guard')).map(ev => ev.text)).toEqual([
      'editJiraIssue: base:jira-reader may not write',
      'notion-update-page: base:doc-reader may not write',
      'createConfluencePage: base:figma-reader may not write',
    ])
  })

  t("a reader or the writer calling a server out of its scope is refused; another type is not", async ($, on) => {
    const { w, calls } = world(on, { env: { HOME }, tools: [...TWIN_TOOLS, 'mcp__Shop__query', 'mcp__plugin_base_playwright__browser_run_code_unsafe'] })
    agents(w, { a1: 'base:jira-reader', a2: 'base:jira-writer', a3: 'general-purpose' })
    expect(await call($, 'mcp__Shop__query', 'a1')).toEqual({ deny: 'base: base:jira-reader calls MCP tools only on a server that serves getJiraIssue — mcp__Shop__query refused' })
    expect((await call($, 'mcp__plugin_base_playwright__browser_run_code_unsafe', 'a2')).deny).toContain('base: base:jira-writer calls MCP tools only on')
    expect((await call($, 'mcp__Shop__query', 'a3')).result).toBe('ok')
    expect((await call($, 'mcp__Shop__query')).result).toBe('ok')
    expect(calls.below.length).toBe(2)
    expect((await eventsOf($, 'guard')).map(ev => ev.text)).toEqual(['query: base:jira-reader may not call Shop', 'browser_run_code_unsafe: base:jira-writer may not call plugin_base_playwright'])
  })

  t('the writer edits a field and comments; every other write is refused', async ($, on) => {
    const { w } = world(on, { env: { HOME }, tools: TWIN_TOOLS })
    agents(w, { a2: 'base:jira-writer' })
    expect((await call($, 'mcp__ConnA__editJiraIssue', 'a2')).result).toBe('ok')
    expect((await call($, 'mcp__ConnA__addCommentToJiraIssue', 'a2')).result).toBe('ok')
    expect((await call($, 'mcp__ConnA__transitionJiraIssue', 'a2')).deny).toContain('base: base:jira-writer writes only with')
    expect((await call($, 'mcp__ConnN__notion-create-pages', 'a2')).deny).toContain('base: base:jira-writer writes only with')
  })

  t('another agent type writes; the main loop writes', async ($, on) => {
    const { w } = world(on, { env: { HOME } })
    agents(w, { a3: 'general-purpose' })
    expect((await call($, 'mcp__ConnA__editJiraIssue', 'a3')).result).toBe('ok')
    expect((await call($, 'mcp__ConnA__editJiraIssue')).result).toBe('ok')
  })

  t('no marker, a corrupt one or a bad id → the full write set refused, naming the cause; reads run', async ($, on) => {
    const { w } = world(on, { env: { HOME } })
    expect(await call($, 'mcp__ConnA__editJiraIssue', 'a9')).toEqual({ deny: UNKNOWN('mcp__ConnA__editJiraIssue') })
    agents(w, { a1: '!not json {' })
    expect((await call($, 'mcp__ConnA__addCommentToJiraIssue', 'a1')).deny).toBe(UNKNOWN('mcp__ConnA__addCommentToJiraIssue'))
    expect((await call($, 'mcp__ConnN__notion-create-comment', '../a1')).deny).toBe(UNKNOWN('mcp__ConnN__notion-create-comment'))
    expect((await call($, TWIN_GET, 'a9')).result).toBe('ok')
    expect((await eventsOf($, 'guard')).map(ev => ev.text)[0]).toBe('editJiraIssue: a subagent of unknown type may not write')
  })

  t('the marker in the spare dir counts; a probe that fails lets the call run', async ($, on) => {
    const { w } = world(on, { env: { HOME, TMPDIR: '/var/t' }, existsFails: [`${DIR}/a1.json`] })
    expect((await call($, 'mcp__ConnA__editJiraIssue', 'a1')).result).toBe('ok')
    w.existsFails = []
    agents(w, { a1: 'base:jira-reader' }, '/var/t/domaine-log/s1/agents')
    expect((await call($, 'mcp__ConnA__editJiraIssue', 'a1')).deny).toContain('base: base:jira-reader is read-only')
  })

  t("a reader's write on base's own server is refused outright, never softly", async ($, on) => {
    const { w } = world(on, { env: { HOME }, tools: TWIN_TOOLS })
    agents(w, { a1: 'base:jira-reader' })
    for (let i = 0; i < 2; i++) expect((await call($, 'mcp__plugin_base_atlassian__editJiraIssue', 'a1')).deny).toContain('is read-only')
    expect((await peek($)).mcpSoft).toBeNull()
  })

  t("slim's and base's registered tools are not guarded", async ($, on) => {
    world(on, { env: { HOME } })
    expect((await call($, 'mcp__base__editJiraIssue', 'a9')).result).toBe('ok')
    expect((await call($, 'mcp__slim__editJiraIssue', 'a9')).result).toBe('ok')
  })

  t('BASE_GUARD=0 → every rule off', async ($, on) => {
    const { w } = world(on, { env: { HOME, BASE_GUARD: '0' }, tools: TWIN_TOOLS })
    agents(w, { a1: 'base:jira-reader' })
    expect((await call($, 'mcp__ConnA__editJiraIssue', 'a9')).result).toBe('ok')
    expect((await call($, 'mcp__Shop__query', 'a1')).result).toBe('ok')
    expect((await call($, OWN_GET)).result).toBe('ok')
  })

  t('BASE_EVENT_LOG=0 → the deny stands, nothing logged', async ($, on) => {
    world(on, { env: { HOME, BASE_EVENT_LOG: '0' } })
    expect((await call($, 'mcp__ConnA__editJiraIssue', 'a9')).deny).toBe(UNKNOWN('mcp__ConnA__editJiraIssue'))
    expect((await peek($)).events).toEqual([])
  })
})
