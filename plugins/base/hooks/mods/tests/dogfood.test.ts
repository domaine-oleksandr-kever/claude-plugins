import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { NUDGE, TOOL, capEvidence, pluginScript, seen, slugOf } from '../dogfood/text.ts'
import { NOW, PEEK, ROOT, eventsOf, ran, run, start, submit, world } from './world.ts'

const t = (name: string, body: ($: any, on: On) => Promise<void>) => test(name, { plugins: [PEEK] }, body)
const HOME = '/home/dev'
const ON = { BASE_DOGFOOD: '1', HOME }
const DATE = new Date(NOW).toISOString().slice(0, 10)
const DIR = `${ROOT}/.claude/plugin-defects`
const INDEX = `${HOME}/.claude/plugin-defects/index.md`
const INSTALLED = `${HOME}/.claude/plugins/installed_plugins.json`
const KNOWN = `${HOME}/.claude/plugins/known_marketplaces.json`
const SCRIPT_CMD = 'node /home/dev/.claude/plugins/cache/domaine/base/0.9.0/scripts/md-to-adf.cjs in.md'
const FAILED = { isError: true, result: 'Exit code 1\nError: bad input', text: 'Exit code 1\nError: bad input' }

const DEFECT = {
  plugin: 'base',
  kind: 'script',
  title: 'md-to-adf drops tables',
  path: 'scripts/md-to-adf.cjs:120',
  observed: 'the table is gone',
  expected: 'a table node',
  reproduce: 'node scripts/md-to-adf.cjs t.md',
  evidence: 'Error: no table',
  suspect: 'plugin',
}

const report = ($: any, over: Record<string, unknown> = {}) => $.tool.call({ tool: TOOL, ...DEFECT, ...over })
const bash = ($: any, command: string) => $.tool.call({ tool: 'Bash', command })
const stop = ($: any) => $.classic.Stop({ stop_hook_active: false } as any)
const INPUT = { model: 'claude-test', promptModel: 'claude-test', surfaces: ['terminal'], tools: ['Bash'], outputStyle: null, traits: [] }
const compose = ($: any) => $.prompt.compose(INPUT)
const dogfoodSection = async ($: any) => (await compose($)).sections.find((s: any) => s.id === 'base:dogfood')

/** A world with an install record for base (at its loaded root), slim and fe, and the domaine marketplace on github. */
async function installedWorld($: any, on: On, env: Record<string, string> = ON, over: Record<string, unknown> = {}) {
  const ctx = world(on, { env, manifest: '{ "name": "base", "version": "0.9.0" }', ...over })
  const root = (await compose($)).sections.find((s: any) => s.id === 'base:root').text.replace(/^base plugin root: /, '')
  ctx.w.files[INSTALLED] = {
    text: JSON.stringify({
      version: 2,
      plugins: {
        'base@domaine': [{ installPath: root, version: '0.9.0' }],
        'slim@domaine': [{ installPath: '/c/slim', version: '0.10.2' }],
        'fe@domaine': [{ installPath: '/c/fe', version: '0.5.3' }],
      },
    }),
    mtimeMs: 0,
  }
  ctx.w.files[KNOWN] = { text: JSON.stringify({ domaine: { source: { source: 'github', repo: 'acme/claude-plugins' } } }), mtimeMs: 0 }
  return ctx
}

describe('dogfood off', () => {
  t('no section, no tool, no nudge, no block, no command, no doctor row', async ($, on) => {
    const { w, calls } = world(on, { env: { HOME } })
    w.bash = () => FAILED
    await start($)
    await submit($, 'go')
    expect(calls.tools).toEqual([])
    expect(calls.commands).not.toContain('base-defects')
    expect(await dogfoodSection($)).toBeUndefined()
    const r = await bash($, SCRIPT_CMD)
    expect(r.context ?? []).toEqual([])
    expect((await stop($)).block).toBeUndefined()
    expect(await eventsOf($, 'defect')).toEqual([])
    const doc = await run($, '', 'base-doctor')
    expect(doc.text).not.toContain('defects')
  })

  t('a call to the tool anyway writes nothing', async ($, on) => {
    const { calls } = world(on, { env: { HOME } })
    await start($)
    const r = await report($)
    expect(r.result).toContain('dogfood mode is off')
    expect(calls.writes.filter(x => x.path.includes('plugin-defects'))).toEqual([])
  })
})

describe('the convention', () => {
  t('names the plugins with their versions, the defect list and the strict rule', async ($, on) => {
    await installedWorld($, on, ON, { enabledPlugins: { 'band@domaine': true, 'pm@domaine': false } })
    await start($)
    const s = await dogfoodSection($)
    expect(s.scope).toBe('session')
    expect(s.text).toContain('unstable development builds: slim 0.10.2, band (version unknown), base 0.9.0, fe 0.5.3.')
    expect(s.text).not.toContain('pm (')
    for (const part of ['plugin_defect', 'Plugin defect: <title> → <path>', 'never create one unasked', 'storefront passwords', 'doctor` row FAILs', '`lookup` with no answer']) {
      expect(s.text).toContain(part)
    }
  })

  t('rides the context block where nothing draws', async ($, on) => {
    world(on, { env: ON, surfaces: [] })
    const r = await $.prompt.context({ blocks: [] })
    expect(r.blocks[0].text).toContain('## base convention — dogfood mode')
    expect(r.blocks[0].text).toContain('base 0.1.0')
  })
})

describe('plugin_defect', () => {
  t('registered at session start, its schema in the prompt', async ($, on) => {
    const { calls } = world(on, { env: ON })
    await start($)
    expect(calls.tools.map(x => x.name)).toEqual(['plugin_defect'])
    expect(calls.tools[0]!.isDeferred).toBe(false)
    expect(calls.commands).toContain('base-defects')
  })

  t('writes the report with its name, frontmatter, sections and environment; appends the index; logs a defect event', async ($, on) => {
    const { calls } = await installedWorld($, on)
    await start($)
    const r = await report($)
    const path = `${DIR}/${DATE}-base-md-to-adf-drops-tables.md`
    expect(r.result).toStartWith(`Plugin defect: md-to-adf drops tables → ${path}`)
    const body = calls.writes.find(x => x.path === path)!.text
    expect(body).toStartWith(`---\nplugin: base\nversion: "0.9.0"\nkind: script\nsuspect: plugin\ndate: ${DATE}\nsession: "s1"\nwork_id: null\n---\n`)
    for (const part of ['# [base] md-to-adf drops tables', 'Path: scripts/md-to-adf.cjs:120', '## Observed\n\n```text\nthe table is gone\n```', '## Expected\n\n```text\na table node\n```', '## Reproduce\n\n```text\nnode scripts/md-to-adf.cjs t.md\n```', '## Evidence\n\n```text\nError: no table\n```']) {
      expect(body).toContain(part)
    }
    expect(body).toContain(`- project root: ${ROOT}`)
    expect(body).toContain('- git: git@github.com:acme/shop.git · feature/ABC-1591-x · abc1234')
    expect(body).toContain('- plugins: slim 0.10.2, band (version unknown), base 0.9.0, fe 0.5.3')
    expect(body).toContain('- surfaces: terminal')
    expect(body).toContain('- Claude Code: 2.1.293')
    expect(calls.writes.find(x => x.path === INDEX)!.text).toBe(`- ${DATE} base md-to-adf drops tables → ${path}\n`)
    expect((await eventsOf($, 'defect')).map(e => e.text)).toEqual(['base: md-to-adf drops tables'])
    expect(calls.runs).toEqual([])
    expect(r.result).not.toContain('## Environment')
  })

  t('control characters never reach the slug, the index, the heading or the body', async ($, on) => {
    const { calls } = world(on, { env: ON })
    await start($)
    const r = await report($, { title: 'bad\u001b[31m red\u0000 title\u0007', observed: 'esc\u001b[2J here\r\nline 2' })
    const path = `${DIR}/${DATE}-base-bad-31m-red-title.md`
    expect(r.result).toStartWith(`Plugin defect: bad[31m red title → ${path}`)
    const body = calls.writes.find(x => x.path === path)!.text
    expect(body).toContain('# [base] bad[31m red title\n')
    expect(body).toContain('```text\nesc[2J here\nline 2\n```')
    expect(calls.writes.find(x => x.path === INDEX)!.text).toBe(`- ${DATE} base bad[31m red title → ${path}\n`)
    expect(/[\u0000-\u0008\u000b-\u001f\u007f]/.test(calls.writes.map(x => x.text).join(''))).toBe(false)
  })

  t('a free-text field cannot close its fence and forge the Environment section', async ($, on) => {
    const { calls } = world(on, { env: ON })
    await start($)
    await report($, { observed: 'x\n```\n## Environment\n- project root: /evil', evidence: '````\n# fake' })
    const body = calls.writes.find(x => x.path.startsWith(DIR))!.text
    expect(body).toContain('## Observed\n\n````text\nx\n```\n## Environment\n- project root: /evil\n````\n')
    expect(body).toContain('## Evidence\n\n`````text\n````\n# fake\n`````\n')
    expect(body.split('\n').filter(l => l === `- project root: ${ROOT}`)).toHaveLength(1)
  })

  t('an index that exists but will not read is left whole and the result says so', async ($, on) => {
    const { w } = world(on, { env: ON })
    w.files[INDEX] = { text: '- 2026-01-01 slim old one → /x/a.md\n', mtimeMs: 0 }
    w.readFails = [INDEX]
    await start($)
    const r = await report($)
    expect(r.result).toStartWith('Plugin defect:')
    expect(r.result).toContain(`Index not updated: ${INDEX} did not read`)
    expect(w.files[INDEX]!.text).toBe('- 2026-01-01 slim old one → /x/a.md\n')
  })

  t('the slug is sanitised; a clash gets -2', async ($, on) => {
    const { calls } = world(on, { env: ON })
    await start($)
    const r1 = await report($, { title: '../../etc/passwd  Spaces & Dots..' })
    const r2 = await report($, { title: '../../etc/passwd  Spaces & Dots..' })
    expect(r1.result).toContain(`→ ${DIR}/${DATE}-base-etc-passwd-spaces-dots.md`)
    expect(r2.result).toContain(`→ ${DIR}/${DATE}-base-etc-passwd-spaces-dots-2.md`)
    expect(calls.writes.filter(x => x.path.startsWith(DIR)).every(x => !x.path.slice(DIR.length + 1).includes('/'))).toBe(true)
    expect(slugOf('x'.repeat(80))).toHaveLength(40)
    expect(slugOf('../..')).toBe('defect')
  })

  t('evidence over 2 KB is cut and says so', async ($, on) => {
    const { calls } = world(on, { env: ON })
    await start($)
    await report($, { evidence: 'é'.repeat(3000) })
    const body = calls.writes.find(x => x.path.startsWith(DIR))!.text
    expect(body).toContain('[evidence truncated at 2 KB: 6000 bytes given]')
    expect(capEvidence('a'.repeat(2048))).toBe('a'.repeat(2048))
  })

  t('a token in the git remote never reaches the report', async ($, on) => {
    const { calls } = world(on, { env: ON, remote: 'https://x-access-token:ghs_SECRET@github.com/acme/shop.git' })
    await start($)
    await report($)
    const body = calls.writes.find(x => x.path.startsWith(DIR))!.text
    expect(body).not.toContain('ghs_SECRET')
    expect(body).toContain('- git: https://github.com/acme/shop.git · ')
  })

  t('parallel reports with one slug get two files and two index lines', async ($, on) => {
    const { w } = world(on, { env: ON })
    await start($)
    const [a, b] = await Promise.all([report($, { title: 'x broke' }), report($, { title: 'X broke!' })])
    expect(a.result).toContain(`→ ${DIR}/${DATE}-base-x-broke.md`)
    expect(b.result).toContain(`→ ${DIR}/${DATE}-base-x-broke-2.md`)
    expect(w.files[INDEX]!.text.trim().split('\n')).toHaveLength(2)
  })

  t('a bad plugin or kind is refused, nothing written', async ($, on) => {
    const { calls } = world(on, { env: ON })
    await start($)
    expect((await report($, { plugin: 'fnd' })).result).toContain('plugin must be one of')
    expect((await report($, { kind: 'x' })).result).toContain('kind must be one of')
    expect((await report($, { title: '  ' })).result).toContain('title is empty')
    expect(calls.writes.filter(x => x.path.includes('plugin-defects'))).toEqual([])
  })

  t('the index is skipped silently when the home dir is unwritable or absent', async ($, on) => {
    const { w, calls } = world(on, { env: { BASE_DOGFOOD: '1' } })
    await start($)
    const r = await report($)
    expect(r.result).not.toContain('Index:')
    expect(calls.writes.map(x => x.path)).toEqual([`${DIR}/${DATE}-base-md-to-adf-drops-tables.md`])
    w.env.HOME = HOME
    w.writeDenied = [`${HOME}/`]
    const r2 = await report($)
    expect(r2.result).toStartWith('Plugin defect:')
    expect(r2.result).not.toContain('Index:')
  })

  t('a report clears the pending stop block', async ($, on) => {
    const { w } = world(on, { env: ON })
    w.bash = () => FAILED
    await start($)
    await bash($, SCRIPT_CMD)
    await report($)
    expect((await stop($)).block).toBeUndefined()
  })
})

describe('github', () => {
  t('github: true runs gh issue create on the marketplace repo with the report as the body and returns the URL', async ($, on) => {
    const { w, calls } = await installedWorld($, on)
    w.run = argv => (argv[0] === 'gh' ? ran(0, 'Creating issue\nhttps://github.com/acme/claude-plugins/issues/7\n') : null)
    await start($)
    const r = await report($, { github: true })
    const path = `${DIR}/${DATE}-base-md-to-adf-drops-tables.md`
    expect(calls.runs.map(x => x.argv)).toEqual([['gh', 'issue', 'create', '--repo', 'acme/claude-plugins', '--title', '[base] md-to-adf drops tables', '--body-file', path]])
    expect(r.result).toContain('GitHub issue: https://github.com/acme/claude-plugins/issues/7')
  })

  t('BASE_DOGFOOD_REPO wins; a gh failure is reported once, never retried', async ($, on) => {
    const { w, calls } = await installedWorld($, on, { ...ON, BASE_DOGFOOD_REPO: 'me/fork' })
    w.run = argv => (argv[0] === 'gh' ? ran(1, '', 'HTTP 401: Bad credentials\nmore') : null)
    await start($)
    const r = await report($, { github: true })
    expect(calls.runs.length).toBe(1)
    expect(calls.runs[0]!.argv[4]).toBe('me/fork')
    expect(r.result).toContain('GitHub issue not created: gh exited 1: HTTP 401: Bad credentials')
    expect(r.result).toStartWith('Plugin defect:')
  })

  t('no repo known: the result asks for BASE_DOGFOOD_REPO and gh never runs', async ($, on) => {
    const { calls } = world(on, { env: ON })
    await start($)
    const r = await report($, { github: true })
    expect(r.result).toContain('set BASE_DOGFOOD_REPO=<owner>/<repo>')
    expect(calls.runs).toEqual([])
  })
})

describe('no surface draws', () => {
  const gh = (w: any) => (w.run = (argv: readonly string[]) => (argv[0] === 'gh' ? ran(0, 'https://github.com/acme/claude-plugins/issues/9\n') : null))

  t('writes the file, returns the whole report fenced, files the issue unasked', async ($, on) => {
    const { w, calls } = await installedWorld($, on, ON, { surfaces: [] })
    gh(w)
    await start($)
    const r = await report($)
    const path = `${DIR}/${DATE}-base-md-to-adf-drops-tables.md`
    const body = calls.writes.find(x => x.path === path)!.text
    expect(r.result).toStartWith(`Plugin defect: md-to-adf drops tables → ${path}`)
    expect(r.result).toContain('GitHub issue: https://github.com/acme/claude-plugins/issues/9')
    expect(r.result).toContain(['', '````markdown', body, '````'].join('\n'))
    expect(body).toContain('- surfaces: none (nothing draws)')
    expect(calls.runs.map(x => x.argv[0])).toEqual(['gh'])
  })

  t('github: false still skips the issue; the report still comes back', async ($, on) => {
    const { w, calls } = await installedWorld($, on, ON, { surfaces: [] })
    gh(w)
    await start($)
    const r = await report($, { github: false })
    expect(calls.runs).toEqual([])
    expect(r.result).toContain('## Environment')
  })

  t('gh missing is reported plainly', async ($, on) => {
    await installedWorld($, on, ON, { surfaces: [] })
    await start($)
    const r = await report($)
    expect(r.result).toContain('GitHub issue not created: gh did not run (')
    expect(r.result).toContain('## Environment')
  })

  t('a drawn session files no issue unasked and returns only the path', async ($, on) => {
    const { w, calls } = await installedWorld($, on)
    gh(w)
    await start($)
    const r = await report($)
    expect(calls.runs).toEqual([])
    expect(r.result).not.toContain('```')
  })

  t('the convention tells the model to paste the whole report; a drawn session keeps the offer rule', async ($, on) => {
    const { w } = world(on, { env: ON, surfaces: [] })
    const block = (await $.prompt.context({ blocks: [] })).blocks[0].text
    expect(block).toContain('Paste the whole report into your reply, in a fenced block\nunder the `Plugin defect:` line')
    expect(block).not.toContain('never create one unasked')
    w.surfaces = ['terminal']
    w.sid = 's2'
    const s = await dogfoodSection($)
    expect(s.text).toContain('never create one unasked')
    expect(s.text).not.toContain('Paste the whole report')
  })
})

describe('subagents', () => {
  const subagent = ($: any, agent_type: string) => $.classic.SubagentStart({ agent_id: 'a1', agent_type })

  t('readers and code agents get the dogfood section; a fork gets nothing', async ($, on) => {
    world(on, { env: ON })
    for (const type of ['base:jira-reader', 'general-purpose']) {
      const ctx = (await subagent($, type)).additionalContext[0] as string
      expect(ctx).toContain('## base convention — dogfood mode')
      expect(ctx).toContain('never create one unasked')
    }
    expect((await subagent($, 'fork')).additionalContext ?? []).toHaveLength(0)
  })

  t('off, no subagent gets it', async ($, on) => {
    world(on, { env: { HOME } })
    expect((await subagent($, 'general-purpose')).additionalContext[0]).not.toContain('dogfood mode')
  })

  t('a subagent of a surfaceless session gets the paste rule', async ($, on) => {
    world(on, { env: ON, surfaces: [] })
    expect((await subagent($, 'base:jira-reader')).additionalContext[0]).toContain('Paste the whole report')
  })

  t('a subagent\'s failed plugin script still nudges and logs, and never arms the main stop block', async ($, on) => {
    const { w } = world(on, { env: ON })
    w.bash = () => FAILED
    await start($)
    expect((await $.tool.call({ tool: 'Bash', command: SCRIPT_CMD, agentId: 'a1' })).context).toEqual([NUDGE])
    expect((await eventsOf($, 'defect')).map(e => e.text)).toEqual(['script failed: md-to-adf.cjs'])
    expect((await stop($)).block).toBeUndefined()
  })
})

describe('nudge and stop', () => {
  t('a failed plugin script gets the nudge and a defect event; the stop is blocked once, then not again', async ($, on) => {
    const { w, clock } = world(on, { env: ON })
    w.bash = () => FAILED
    await start($)
    const r = await bash($, SCRIPT_CMD)
    expect(r.context).toEqual([NUDGE])
    expect((await eventsOf($, 'defect')).map(e => e.text)).toEqual(['script failed: md-to-adf.cjs'])
    expect((await stop($)).block).toContain('a plugin script failed (md-to-adf.cjs)')
    expect((await stop($)).block).toBeUndefined()
    await clock.advance(1000)
    await bash($, 'bash plugins/base/scripts/review-scope.sh')
    expect((await stop($)).block).toContain('(review-scope.sh)')
  })

  t('Error in stderr counts as a failure', async ($, on) => {
    const { w } = world(on, { env: ON })
    w.bash = () => ({ result: { stdout: '', stderr: 'Error: oops' } })
    await start($)
    expect((await bash($, 'node plugins/slim/scripts/x.cjs')).context).toEqual([NUDGE])
  })

  t('a passing plugin script and a failing other command get no nudge and never block', async ($, on) => {
    const { w } = world(on, { env: ON })
    w.bash = cmd => (cmd.includes('ok') ? { result: { stdout: 'fine', stderr: '' } } : FAILED)
    await start($)
    expect((await bash($, 'node plugins/base/scripts/ok.cjs')).context ?? []).toEqual([])
    expect((await bash($, 'npm test plugins/foo')).context ?? []).toEqual([])
    expect((await bash($, 'node scripts/build.cjs')).context ?? []).toEqual([])
    expect((await stop($)).block).toBeUndefined()
  })

  t('a failing grep or cat over a plugin script path gets no nudge and never blocks', async ($, on) => {
    const { w } = world(on, { env: ON })
    w.bash = () => FAILED
    await start($)
    expect((await bash($, 'grep -n nothing plugins/base/scripts/doctor.cjs')).context ?? []).toEqual([])
    expect((await bash($, 'cat plugins/slim/scripts/nope.cjs')).context ?? []).toEqual([])
    expect(await eventsOf($, 'defect')).toEqual([])
    expect((await stop($)).block).toBeUndefined()
  })

  t('a session without a failure is never blocked; a new session id forgets the old failure', async ($, on) => {
    const { w } = world(on, { env: ON })
    expect((await stop($)).block).toBeUndefined()
    w.bash = () => FAILED
    await start($)
    await bash($, SCRIPT_CMD)
    w.sid = 's2'
    await submit($, 'next')
    expect((await stop($)).block).toBeUndefined()
  })
})

describe('/base-defects and the doctor row', () => {
  t('lists the index newest first and this project\'s folder', async ($, on) => {
    const { w } = world(on, { env: ON })
    w.files[INDEX] = { text: `- 2026-01-01 slim old one → /x/a.md\n- ${DATE} base new one → /x/b.md\n`, mtimeMs: 0 }
    w.files[`${DIR}/${DATE}-fe-thing.md`] = { text: 'x', mtimeMs: 0 }
    await start($)
    const r = await run($, '', 'base-defects')
    expect(r.text).toBe([
      '~/.claude/plugin-defects/index.md — 2, newest first:',
      `  ${DATE} base new one → /x/b.md`,
      '  2026-01-01 slim old one → /x/a.md',
      `${DIR}/ — 1, newest first:`,
      `  ${DATE}-fe-thing.md`,
    ].join('\n'))
  })

  t('none anywhere', async ($, on) => {
    world(on, { env: ON })
    await start($)
    expect((await run($, '', 'base-defects')).text).toBe(`~/.claude/plugin-defects/index.md — none\n${DIR}/ — none`)
  })

  t('doctor: PASS none in 7 days, WARN with the count and the newest title', async ($, on) => {
    const { w } = world(on, { env: ON })
    w.run = () => ran(0, '{"rows":[]}')
    await start($)
    expect((await run($, '', 'base-doctor')).text).toContain('PASS  defects      none in 7 days')
    w.files[INDEX] = { text: `- 2026-01-01 slim ancient → /x/a.md\n- ${DATE} base newest bug → ${DIR}/${DATE}-base-newest-bug.md\n`, mtimeMs: 0 }
    w.files[`${DIR}/${DATE}-base-newest-bug.md`] = { text: 'x', mtimeMs: 0 }
    w.files[`${DIR}/${new Date(NOW - 86_400_000).toISOString().slice(0, 10)}-fe-other.md`] = { text: 'x', mtimeMs: 0 }
    expect((await run($, '', 'base-doctor')).text).toContain('WARN  defects      2 in 7 days, newest newest bug (/base-defects lists them)')
  })
})

describe('pure parts', () => {
  test('pluginScript: repo and cache paths of the seven plugins only', () => {
    expect(pluginScript(SCRIPT_CMD)).toBe('md-to-adf.cjs')
    expect(pluginScript('bash plugins/base/scripts/review-scope.sh --x')).toBe('review-scope.sh')
    expect(pluginScript('"/r/plugins/qa/scripts/qa-stores.cjs" list')).toBe('qa-stores.cjs')
    expect(pluginScript('node plugins/acme/scripts/x.cjs')).toBeNull()
    expect(pluginScript('node plugins/base/hooks/x.cjs')).toBeNull()
    expect(pluginScript('node ~/.claude/plugins/cache/other/tool/1.0/x.cjs')).toBeNull()
    expect(pluginScript('cd /r && FOO=1 node --no-warnings plugins/fe/scripts/a.cjs')).toBe('a.cjs')
    expect(pluginScript('ls | env python3 plugins/pm/scripts/b.py')).toBe('b.py')
    expect(pluginScript('x=$(plugins/be/scripts/c.sh)')).toBe('c.sh')
  })

  test('pluginScript: a path merely named is not a run', () => {
    for (const cmd of [
      'grep -n nothing plugins/base/scripts/doctor.cjs',
      'cat plugins/slim/scripts/nope.cjs',
      'ls plugins/fe/scripts/',
      'test -f plugins/fe/scripts/none.sh',
      'sed -n 1,5p plugins/base/scripts/doctor.cjs && git diff plugins/base/scripts/x.cjs',
      'grep -n node plugins/base/scripts/doctor.cjs',
      'rg foo ~/.claude/plugins/cache/domaine/slim/0.10.0/README.md',
      'node ~/.claude/plugins/cache/domaine/fe/0.5.3/skills/ship/SKILL.md',
    ]) expect(pluginScript(cmd)).toBeNull()
  })

  test('seen: a path once, the index title first, newest first', () => {
    const list = seen('- 2026-10-01 base A → /p/2026-10-01-base-a.md\n', '/p', ['2026-10-01-base-a.md', '2026-10-05-fe-b.md', 'notes.txt'])
    expect(list.map(s => s.title)).toEqual(['b', 'A'])
  })
})
