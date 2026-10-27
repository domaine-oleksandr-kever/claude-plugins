import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { NUDGE, TOOL, bashText, capEvidence, crashedIn, defectBody, deniedNotRun, designedRefusal, dogfoodAccounts, errorLine, failureLine, pluginScript, pluginScripts, priorErrors, scriptLast, seen, slugOf, startVersion, syncedRoot, versionsLine, versionsOf } from '../dogfood/text.ts'
import { NOW, PEEK, ROOT, TEXT, eventsOf, peek, ran, run, start, submit, world } from './world.ts'

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
/** `error=` reasons the fe, base and be scripts print for a caller's mistake, a guard, a designed degrade or a credential not set up: silent. */
const REFUSALS = [
  'usage (get needs --theme and --file)', 'usage: session-theme.sh unpin <toml> (--help prints usage)', 'unknown_arg arg=--x (--help prints usage)',
  'unknown_command cmd=x', 'unknown arg: --x (--help prints usage)', 'missing_value flag=--theme', 'missing value for --name', 'create requires --name "<new theme name>"',
  'no_store (pass --store)', "invalid_store store='x'", 'ambiguous_env envs=a,b toml=t', 'env_not_found env=x toml=t', "bad_theme_id value='x'",
  'bad_file path=../x', 'file_not_writable path=x', 'theme_not_found theme=1', 'dev_theme_not_found dev_theme=1', 'file_not_found_or_not_text file=x theme=1',
  'not_applied engine=gql theme=1 file=x', 'upload_rejected theme=1 file=x reason=y', 'dev_theme_write_refused theme=1', 'live_theme_write_refused theme=1', 'from_file_refused file=.env',
  'invalid_variables_json (--variables must be valid JSON)', 'variables_file_not_found file=v.json', 'no_such_dir dir=x', 'invalid_engine engine=x',
  'invalid_cloud_id value=x', 'settings_drift', 'overlay_store_mismatch store=x', 'theme_limit — store is at its theme cap', 'worktree_dirty path=x',
  'branch_checked_out_elsewhere branch=b', 'not_a_git_repo — run this from the project repo', 'no_jira_credentials (JIRA_EMAIL + JIRA_API_TOKEN)',
  'no_admin_token', 'no_theme_token (themecli)', 'no_figma_token (FIGMA_TOKEN, from the environment or .env)',
  '--env requires --pin-toml', '--copy needs a path (usage: worktree-setup.sh <KEY> [--copy <path>])', '--port needs a value', 'from_file_invalid_json file=x',
]
/** `error=` reasons that are a failure: a tool, the plugin's own file, a credential set but rejected, a remote call or the script's machinery broke. */
const FAILURES = [
  'cli_list_failed store=x token_source=env', 'cli_list_unreadable theme=1', 'invalid_admin_token source=env', 'cli_pull_failed theme=1 store=x token_source=toml',
  'cli_push_failed theme=1 store=x token_source=env',
  'store_execute_failed (no app)', 'store_execute_failed_mutation (x)', 'http_401 url=x', 'http_status http=503 host=x', 'gql_errors log=x',
  'non_json_response log=x', 'cli_push_reported_errors file=x', 'upsert_user_errors x', 'build_failed (npm run build):', 'shopify_cli_not_found',
  'jq_not_found', 'curl_not_found', 'runner_not_found path=x', 'common_lib_not_found path=x', 'session_lib_not_found path=x', 'jq not found on PATH',
  'shopify CLI not found on PATH', 'strip_needs_perl', 'refresh_unverifiable theme=1', 'reuse_unverifiable name=x', 'theme_unverifiable theme=1',
  'verify_read_failed engine=gql theme=1 file=x', 'out_write_failed out=x', 'refresh_push_failed', 'overlay_pull_failed',
  'code push succeeded but could not parse theme id from --json', 'invalid_figma_token source=env', 'token_rejected http=403', 'rate_limited http=429',
]

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
/** The newest failure the Stop command hook would block on: the script of the mirrored `errors` of this session's id after its report. */
function armed(w: any): string | null {
  return unreported(w).at(-1)?.script ?? null
}
/** The mirrored `errors` of this session's id after its report: what the Stop command hook counts. */
function unreported(w: any): { script: string; line: string; ms: number }[] {
  const f = w.files[`${HOME}/.claude/domaine/log/${w.sid}/dogfood-state.json`]
  if (!f) return []
  const s = JSON.parse(f.text)
  return s.sid === w.sid && Array.isArray(s.errors) ? s.errors.filter((e: any) => e.ms > s.reportMs) : []
}
/** $.plugin.root as the doctor's first line names it; the doctor's own spawn leaves no trace in `calls`. */
async function pluginRoot($: any, calls: any): Promise<string> {
  const text = (await run($, '', 'base-doctor')).text as string
  calls.runs.length = 0
  return text.split('\n')[0]!.replace(/^base doctor — plugin root: /, '')
}

/** A world with an install record for base (at its loaded root), slim and fe, and the domaine marketplace on github. */
async function installedWorld($: any, on: On, env: Record<string, string> = ON, over: Record<string, unknown> = {}) {
  const ctx = world(on, { env, manifest: '{ "name": "base", "version": "0.9.0" }', ...over })
  const root = await pluginRoot($, ctx.calls)
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
    const r = await bash($, SCRIPT_CMD)
    expect(r.context ?? []).toEqual([])
    expect(armed(w)).toBeNull()
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

describe('dogfood by account', () => {
  const ACCOUNT = '7111e876-2a12-474b-87aa-fb87ec35aa2c'
  /** A world whose dogfood.json lists ACCOUNT. */
  async function accountWorld($: any, on: On, env: Record<string, string>) {
    const ctx = world(on, { env })
    const root = await pluginRoot($, ctx.calls)
    ctx.w.files[`${root}/dogfood.json`] = { text: JSON.stringify({ accounts: { [ACCOUNT]: 'Owner' } }), mtimeMs: 0 }
    return ctx
  }

  t('a listed account turns the mode on without BASE_DOGFOOD: tool, section, command, doctor row', async ($, on) => {
    const { w, calls } = await accountWorld($, on, { HOME, CLAUDE_CODE_ACCOUNT_UUID: ACCOUNT })
    await start($)
    await submit($, 'go')
    expect(calls.tools.map(x => x.name)).toEqual(['plugin_defect'])
    expect(calls.commands).toContain('base-defects')
    expect((await run($, '', 'base-doctor')).text).toContain('PASS  defects')
  })

  t('BASE_DOGFOOD=0 keeps a listed account off', async ($, on) => {
    const { w, calls } = await accountWorld($, on, { HOME, CLAUDE_CODE_ACCOUNT_UUID: ACCOUNT, BASE_DOGFOOD: '0' })
    await start($)
    expect(calls.tools).toEqual([])
    expect((await report($)).result).toContain('dogfood mode is off')
  })

  t('an unlisted account stays off; a listed one without the file stays off', async ($, on) => {
    const { w, calls } = await accountWorld($, on, { HOME, CLAUDE_CODE_ACCOUNT_UUID: 'ffffffff-0000-0000-0000-000000000000' })
    await start($)
    expect(calls.tools).toEqual([])
  })

  t('without CLAUDE_CODE_ACCOUNT_UUID the login file decides, as in the command hook', async ($, on) => {
    const { w, calls } = await accountWorld($, on, { HOME })
    w.files[`${HOME}/.claude.json`] = { text: JSON.stringify({ oauthAccount: { accountUuid: ACCOUNT } }), mtimeMs: 0 }
    await start($)
    expect(calls.tools.map(x => x.name)).toEqual(['plugin_defect'])
  })

  t('CLAUDE_CONFIG_DIR moves the login file', async ($, on) => {
    const { w } = await accountWorld($, on, { HOME, CLAUDE_CONFIG_DIR: `${HOME}/.claude-work` })
    w.files[`${HOME}/.claude.json`] = { text: JSON.stringify({ oauthAccount: { accountUuid: ACCOUNT } }), mtimeMs: 0 }
    expect((await report($)).result).toContain('dogfood mode is off')
    w.files[`${HOME}/.claude-work/.claude.json`] = { text: JSON.stringify({ oauthAccount: { accountUuid: ACCOUNT } }), mtimeMs: 0 }
    expect((await report($)).result).not.toContain('dogfood mode is off')
  })

  t('no file: a listed-looking account stays off', async ($, on) => {
    const { w, calls } = world(on, { env: { HOME, CLAUDE_CODE_ACCOUNT_UUID: ACCOUNT } })
    await start($)
    expect(calls.tools).toEqual([])
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
    expect(body).toMatch(/\n- base root: \/\S+\n/)
    expect(body).not.toContain('claude.ai-synced')
    expect(body).toContain('- surfaces: terminal')
    expect(body).toContain('- Claude Code: 2.1.293')
    expect(calls.writes.find(x => x.path === INDEX)!.text).toBe(`- ${DATE} base md-to-adf drops tables → ${path}\n`)
    expect((await eventsOf($, 'defect')).map(e => e.text)).toEqual(['base: md-to-adf drops tables'])
    expect(calls.runs).toEqual([])
    expect(r.result).not.toContain('## Environment')
  })

  t('a plugin that loaded another copy than its install record: the start line version, the record beside it', async ($, on) => {
    const { w, calls } = await installedWorld($, on)
    w.files[`${HOME}/.claude/domaine/log/s1/fe.jsonl`] = { text: '{"plugin":"fe","version":"0.4.0","kind":"start"}\n{"plugin":"fe","kind":"x"}\n', mtimeMs: 0 }
    await start($)
    await report($, { plugin: 'fe' })
    const body = calls.writes.find(x => x.path.startsWith(`${DIR}/${DATE}-fe-`))!.text
    expect(body).toContain('version: "0.4.0"')
    expect(body).toContain('- plugins: slim 0.10.2, band (version unknown), base 0.9.0, fe 0.4.0 (installed 0.5.3)')
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
    expect(armed(w)).toBeNull()
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

  t('a terminal session gets no dogfood block from the mod: the command hook carries the section', async ($, on) => {
    world(on, { env: ON })
    expect((await $.prompt.context({ blocks: [] })).blocks).toEqual([])
  })
})

describe('subagents', () => {
  t('the mod adds no subagent context: the SubagentStart command hook carries it', async ($, on) => {
    world(on, { env: ON })
    expect((await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'general-purpose' })).additionalContext ?? []).toEqual([])
  })

  t('a subagent\'s failed plugin script still nudges and logs, and never arms the main stop block', async ($, on) => {
    const { w } = world(on, { env: ON })
    w.bash = () => FAILED
    await start($)
    expect((await $.tool.call({ tool: 'Bash', command: SCRIPT_CMD, agentId: 'a1' })).context).toEqual([NUDGE])
    expect((await eventsOf($, 'defect')).map(e => e.text)).toEqual(['script failed: md-to-adf.cjs'])
    expect(armed(w)).toBeNull()
  })
})

describe('nudge and stop', () => {
  t('a failed plugin script gets the nudge and a defect event; the stop is blocked once, then not again', async ($, on) => {
    const { w, clock } = world(on, { env: ON })
    w.bash = () => FAILED
    await start($)
    const r = await bash($, SCRIPT_CMD)
    expect(r.context).toEqual([NUDGE])
    expect(NUDGE).toContain('(not among your tools: in your reply)')
    expect((await eventsOf($, 'defect')).map(e => e.text)).toEqual(['script failed: md-to-adf.cjs'])
    expect(armed(w)).toBe('md-to-adf.cjs')
    await clock.advance(1000)
    await bash($, 'bash plugins/base/scripts/review-scope.sh')
    expect(armed(w)).toBe('review-scope.sh')
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
    expect(armed(w)).toBeNull()
  })

  t('a failing grep or cat over a plugin script path gets no nudge and never blocks', async ($, on) => {
    const { w } = world(on, { env: ON })
    w.bash = () => FAILED
    await start($)
    expect((await bash($, 'grep -n nothing plugins/base/scripts/doctor.cjs')).context ?? []).toEqual([])
    expect((await bash($, 'cat plugins/slim/scripts/nope.cjs')).context ?? []).toEqual([])
    expect(await eventsOf($, 'defect')).toEqual([])
    expect(armed(w)).toBeNull()
  })

  t('a session without a failure is never blocked; a new session id forgets the old failure', async ($, on) => {
    const { w } = world(on, { env: ON })
    expect(armed(w)).toBeNull()
    w.bash = () => FAILED
    await start($)
    await bash($, SCRIPT_CMD)
    w.sid = 's2'
    await submit($, 'next')
    expect(armed(w)).toBeNull()
  })
  t('a compound line the script does not end: an exit code without Error is not the script\'s', async ($, on) => {
    const { w } = world(on, { env: ON })
    const doc = Array.from({ length: 10 }, (_, i) => `doc line ${i + 1}`).join('\n')
    w.bash = () => ({ isError: true, result: `Exit code 1\n${doc}\n(eval):1: ==== not found` })
    await start($)
    const cmd = 'cat /x/review-flow.md; echo =====; /home/dev/.claude/plugins/cache/domaine/base/0.9.1/scripts/review-scope.sh --ws .claude/tasks/ELC-584; echo =====; cat marker'
    expect((await bash($, cmd)).context ?? []).toEqual([])
    expect(await eventsOf($, 'defect')).toEqual([])
    expect(armed(w)).toBeNull()
  })

  t('a compound line the script does not end, with a stack naming the script: nudge, event, the stop blocked', async ($, on) => {
    const { w } = world(on, { env: ON })
    w.bash = () => ({ isError: true, result: 'Exit code 1\nError: boom\n    at Object.<anonymous> (/x/plugins/base/scripts/x.cjs:12:3)' })
    await start($)
    expect((await bash($, 'node plugins/base/scripts/x.cjs --ws x; echo done')).context).toEqual([NUDGE])
    expect((await eventsOf($, 'defect')).map(e => e.text)).toEqual(['script failed: x.cjs'])
    expect(unreported(w).map(e => [e.script, e.line])).toEqual([['x.cjs', 'Error: boom']])
  })

  t('a compound line the script does not end, with a shell trace naming the script: nudge', async ($, on) => {
    const { w } = world(on, { env: ON })
    w.bash = () => ({ isError: true, result: 'Exit code 127\n/x/plugins/base/scripts/review-scope.sh: line 12: foo: command not found' })
    await start($)
    expect((await bash($, 'bash plugins/base/scripts/review-scope.sh --check && git status')).context).toEqual([NUDGE])
    expect((await eventsOf($, 'defect')).map(e => e.text)).toEqual(['script failed: review-scope.sh'])
  })

  t('a compound line the script does not end, another command\'s Error (a husky tsc hook): no nudge, no event, no block', async ($, on) => {
    const { w } = world(on, { env: ON })
    const out = [
      'Exit code 1',
      'marker=fresh branch=fix/x marker_hash=b6b6d398',
      "src/x.test.ts(3,20): error TS7016: Could not find a declaration file for module 'y'.",
      'Error: Command failed with exit code 2: tsc --noEmit',
      'husky - pre-commit script failed (code 2)',
    ].join('\n')
    w.bash = () => ({ isError: true, result: out })
    await start($)
    const cmd = 'bash /home/dev/.claude/plugins/cache/domaine/base/0.9.3/scripts/review-scope.sh --check && git add -A && git commit -m x'
    expect((await bash($, cmd)).context ?? []).toEqual([])
    expect(await eventsOf($, 'defect')).toEqual([])
    expect(armed(w)).toBeNull()
  })

  t('a crash in the second plugin script of a compound line: nudge, event', async ($, on) => {
    const { w } = world(on, { env: ON })
    w.bash = () => ({ isError: true, result: 'TypeError: boom\n    at Object.<anonymous> (/r/plugins/base/scripts/md-to-adf.cjs:40:3)' })
    await start($)
    const cmd = 'bash plugins/base/scripts/review-scope.sh --check && node plugins/base/scripts/md-to-adf.cjs < x.md; echo done'
    expect((await bash($, cmd)).context).toEqual([NUDGE])
    expect((await eventsOf($, 'defect')).length).toBe(1)
  })

  t('a failing script whose output quotes a denial phrase mid-text: still a nudge', async ($, on) => {
    const { w } = world(on, { env: ON })
    w.bash = () => ({ isError: true, result: 'comment: denied by the Claude Code auto mode classifier\nPermission to x denied\nexit 1' })
    await start($)
    expect((await bash($, 'node plugins/base/scripts/md-to-adf.cjs < comment.md')).context).toEqual([NUDGE])
  })

  for (const denial of [
    'Permission for this action was denied by the Claude Code auto mode classifier. Reason: x',
    "The user doesn't want to proceed with this tool use. The tool use was rejected.",
    'This command requires approval',
    'Error: This command requires approval',
    "Claude requested permissions to use Bash, but you haven't granted it yet.",
  ])
    t(`a denied call that never ran (${denial.slice(0, 24)}…): no nudge, no event, no block`, async ($, on) => {
      const { w } = world(on, { env: ON })
      w.bash = () => ({ isError: true, result: denial })
      await start($)
      expect((await bash($, 'bash plugins/base/scripts/review-scope.sh --check')).context ?? []).toEqual([])
      expect(await eventsOf($, 'defect')).toEqual([])
      expect(armed(w)).toBeNull()
    })

  t('a headless approval refusal not flagged as an error: no nudge, no event, no block', async ($, on) => {
    const { w } = world(on, { env: ON })
    w.bash = () => ({ result: 'This command requires approval' })
    await start($)
    expect((await bash($, 'node /x/plugins/base/scripts/md-to-adf.cjs /nonexistent/x.md')).context ?? []).toEqual([])
    expect(await eventsOf($, 'defect')).toEqual([])
    expect(armed(w)).toBeNull()
  })

  t('a host `Error: Exit code N` line with no Error of the script: the stop names the script\'s own line', async ($, on) => {
    const { w } = world(on, { env: ON })
    w.bash = () => ({ isError: true, result: 'Error: Exit code 1\n\nfailed to open /nonexistent/x.md' })
    await start($)
    expect((await bash($, 'node plugins/base/scripts/md-to-adf.cjs /nonexistent/x.md')).context).toEqual([NUDGE])
    expect(unreported(w).map(e => [e.script, e.line])).toEqual([['md-to-adf.cjs', 'failed to open /nonexistent/x.md']])
  })

  t('a base die behind the host\'s `Error: Exit code 1` line is a designed refusal: no nudge, no block', async ($, on) => {
    const { w } = world(on, { env: ON })
    w.bash = () => ({ isError: true, result: "Error: Exit code 1\nmd-to-adf: cannot read input: ENOENT: no such file or directory, open '/nonexistent/x.md'" })
    await start($)
    expect((await bash($, 'node plugins/base/scripts/md-to-adf.cjs /nonexistent/x.md')).context ?? []).toEqual([])
    expect(armed(w)).toBeNull()
  })

  t('the script last after cd, with a trailing 2>&1: nudge, event, the stop blocked once', async ($, on) => {
    const { w } = world(on, { env: ON })
    w.bash = () => FAILED
    await start($)
    expect((await bash($, 'cd /repo && node plugins/base/scripts/md-to-adf.cjs in.md 2>&1')).context).toEqual([NUDGE])
    expect((await eventsOf($, 'defect')).map(e => e.text)).toEqual(['script failed: md-to-adf.cjs'])
    expect(armed(w)).toBe('md-to-adf.cjs')
  })

  t('a designed refusal (base die, fe error= line) gets no nudge, no event, no block', async ($, on) => {
    const { w } = world(on, { env: ON })
    w.bash = cmd => cmd.includes('qa-stores')
      ? { isError: true, result: { stdout: '', stderr: 'qa-stores: no store matches that selector (qa-stores.cjs list)' } }
      : { isError: true, result: 'Exit code 2\nnote=engine=token\nerror=no_store (pass --store)\nhint=…' }
    await start($)
    expect((await bash($, 'node /home/dev/.claude/plugins/cache/domaine/base/0.9.1/scripts/qa-stores.cjs get elc-us-mc-dev')).context ?? []).toEqual([])
    expect((await bash($, 'bash plugins/fe/scripts/shopify-admin-gql.sh --query q.graphql')).context ?? []).toEqual([])
    expect(await eventsOf($, 'defect')).toEqual([])
    expect(armed(w)).toBeNull()
  })

  for (const reason of REFUSALS)
    t(`error=${reason.split(' ')[0]}: a refusal — no nudge, no event, no block`, async ($, on) => {
      const { w } = world(on, { env: ON })
      w.bash = () => ({ isError: true, result: `Exit code 2\nerror=${reason}` })
      await start($)
      expect((await bash($, 'bash plugins/fe/scripts/theme-json.sh get --theme 1 --file x')).context ?? []).toEqual([])
      expect(await eventsOf($, 'defect')).toEqual([])
      expect(armed(w)).toBeNull()
    })

  for (const reason of FAILURES)
    t(`error=${reason.split(' ')[0]}: a failure — nudge, event, the stop blocked`, async ($, on) => {
      const { w } = world(on, { env: ON })
      w.bash = () => ({ isError: true, result: `Exit code 5\nnote=x\nerror=${reason}` })
      await start($)
      expect((await bash($, 'bash plugins/fe/scripts/theme-json.sh get --theme 1 --file x')).context).toEqual([NUDGE])
      expect((await eventsOf($, 'defect')).map(e => e.text)).toEqual(['script failed: theme-json.sh'])
      expect(armed(w)).toBe('theme-json.sh')
    })

  t('a failure line among refusal lines is a failure', async ($, on) => {
    const { w } = world(on, { env: ON })
    w.bash = () => ({ isError: true, result: 'Exit code 5\nerror=theme_not_found theme=1\nerror=gql_errors log=x' })
    await start($)
    expect((await bash($, 'bash plugins/fe/scripts/theme-json.sh get --theme 1 --file x')).context).toEqual([NUDGE])
  })

  t('a compound line the script does not end: a failure line nudges and blocks even at exit 0; a refusal line stays silent', async ($, on) => {
    const { w } = world(on, { env: ON })
    w.bash = cmd => ({ result: { stdout: cmd.includes('gql') ? 'error=gql_errors log=x' : 'error=theme_not_found theme=1', stderr: '' } })
    await start($)
    expect((await bash($, 'bash plugins/fe/scripts/shopify-admin-gql.sh --query q.graphql 2>&1 | head -20')).context).toEqual([NUDGE])
    expect((await bash($, 'bash plugins/fe/scripts/theme-json.sh get --theme 1 --file x 2>&1 | tail -5')).context ?? []).toEqual([])
    expect((await eventsOf($, 'defect')).map(e => e.text)).toEqual(['script failed: shopify-admin-gql.sh'])
    expect(unreported(w).map(e => [e.script, e.line])).toEqual([['shopify-admin-gql.sh', 'error=gql_errors log=x']])
  })

  t('the script ends the line and exits 0 with a failure line: nudge and the stop blocked; a refusal line at exit 0 stays silent', async ($, on) => {
    const { w } = world(on, { env: ON })
    w.bash = cmd => ({ result: { stdout: cmd.includes('gql') ? 'ok=1\nerror=gql_errors log=x' : 'error=theme_not_found theme=1', stderr: '' } })
    await start($)
    expect((await bash($, 'bash /home/dev/.claude/plugins/cache/domaine/fe/0.9.1/scripts/shopify-admin-gql.sh --query q.graphql')).context).toEqual([NUDGE])
    expect((await bash($, 'bash /home/dev/.claude/plugins/cache/domaine/fe/0.9.1/scripts/theme-json.sh get --theme 1 --file x')).context ?? []).toEqual([])
    expect(unreported(w).map(e => e.script)).toEqual(['shopify-admin-gql.sh'])
  })

  t('a synced copy and a second config dir are plugin scripts too', async ($, on) => {
    const { w } = world(on, { env: ON })
    w.bash = () => ({ isError: true, result: 'Exit code 5\nerror=gql_errors log=x' })
    await start($)
    expect((await bash($, 'bash /root/.claude/plugins/synced/acct_user/fe~g2/scripts/theme-json.sh get')).context).toEqual([NUDGE])
    expect((await bash($, 'node /home/dev/.claude-work/plugins/cache/domaine/base/0.12.0/scripts/md-to-adf.cjs x.md')).context).toEqual([NUDGE])
    expect(unreported(w).map(e => e.script)).toEqual(['theme-json.sh', 'md-to-adf.cjs'])
  })

  t('a compound line the script does not end, failing with a refusal line and no Error: silent', async ($, on) => {
    const { w } = world(on, { env: ON })
    w.bash = () => ({ isError: true, result: 'Exit code 2\nerror=usage (get needs --theme and --file)' })
    await start($)
    expect((await bash($, 'bash plugins/fe/scripts/theme-json.sh get; echo done')).context ?? []).toEqual([])
    expect(await eventsOf($, 'defect')).toEqual([])
  })

  t('a refusal line followed by Error still nudges', async ($, on) => {
    const { w } = world(on, { env: ON })
    w.bash = () => ({ isError: true, result: 'Exit code 1\nerror=push_failed\nError: ECONNRESET' })
    await start($)
    expect((await bash($, 'bash plugins/fe/scripts/push-theme.sh')).context).toEqual([NUDGE])
    expect((await eventsOf($, 'defect')).map(e => e.text)).toEqual(['script failed: push-theme.sh'])
  })
})

describe('the dogfood-state.json mirror', () => {
  const FILE = `${HOME}/.claude/domaine/log/s1/dogfood-state.json`
  const mirrored = (w: any, path = FILE) => JSON.parse(w.files[path]?.text ?? 'null')

  t('armed at start, the failure in the main loop, then the report: each update mirrored, one JSON line', async ($, on) => {
    const { w, clock } = world(on, { env: ON })
    w.bash = () => FAILED
    await start($)
    expect(w.files[FILE]!.text).toBe('{"sid":"s1","failMs":0,"script":"","reportMs":0,"errors":[]}\n')
    await clock.advance(1000)
    await bash($, SCRIPT_CMD)
    const first = { script: 'md-to-adf.cjs', line: 'Error: bad input', ms: NOW + 1000 }
    expect(mirrored(w)).toEqual({ sid: 's1', failMs: NOW + 1000, script: 'md-to-adf.cjs', reportMs: 0, errors: [first] })
    await clock.advance(1000)
    await bash($, 'bash plugins/fe/scripts/theme-json.sh get')
    expect(mirrored(w).errors).toEqual([first, { script: 'theme-json.sh', line: 'Error: bad input', ms: NOW + 2000 }])
    await clock.advance(1000)
    await report($)
    expect(mirrored(w)).toEqual({ sid: 's1', failMs: NOW + 2000, script: 'theme-json.sh', reportMs: NOW + 3000, errors: [] })
    const { errors: _, ...state } = mirrored(w)
    expect((await peek($)).dogfood).toEqual(state)
    await clock.advance(1000)
    await bash($, SCRIPT_CMD)
    expect(unreported(w).map(e => e.ms)).toEqual([NOW + 4000])
  })

  t('a new session id gets its own file; DOMAINE_LOG_DIR moves it', async ($, on) => {
    const { w } = world(on, { env: { ...ON, DOMAINE_LOG_DIR: '/var/log/domaine' } })
    await start($)
    w.sid = 's2'
    await submit($, 'after a clear')
    expect(mirrored(w, '/var/log/domaine/s1/dogfood-state.json').sid).toBe('s1')
    expect(mirrored(w, '/var/log/domaine/s2/dogfood-state.json')).toEqual({ sid: 's2', failMs: 0, script: '', reportMs: 0, errors: [] })
    expect(w.files[FILE]).toBeUndefined()
  })

  t('a log dir the session cannot write: the nudge and the event still come', async ($, on) => {
    const { w } = world(on, { env: ON, writeDenied: [`${HOME}/.claude/domaine/`] })
    w.bash = () => FAILED
    await start($)
    expect((await bash($, SCRIPT_CMD)).context).toEqual([NUDGE])
    expect((await eventsOf($, 'defect')).map(e => e.text)).toEqual(['script failed: md-to-adf.cjs'])
    expect(w.files[FILE]).toBeUndefined()
  })

  t('off: no file', async ($, on) => {
    const { w } = world(on, { env: { HOME } })
    w.bash = () => FAILED
    await start($)
    await bash($, SCRIPT_CMD)
    expect(w.files[FILE]).toBeUndefined()
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
  test('startVersion: the last start line of that plugin', () => {
    const jsonl = ['{"plugin":"fe","version":"0.3.0","kind":"start"}', 'not json "kind":"start"', '{"plugin":"fe","version":"0.4.0","kind":"start"}', '{"plugin":"qa","version":"9","kind":"start"}', '{"plugin":"fe","kind":"tool"}'].join('\n')
    expect(startVersion(jsonl, 'fe')).toBe('0.4.0')
    expect(startVersion(jsonl, 'be')).toBeNull()
    expect(startVersion(null, 'fe')).toBeNull()
  })

  test('syncedRoot and the Environment block: a synced base root is marked', () => {
    expect(syncedRoot('/u/.claude/plugins/synced/org_user/base~g2')).toBe(true)
    expect(syncedRoot('/u/.claude/plugins/cache/domaine/base/0.15.0')).toBe(false)
    const env = { root: '/r', remote: null, branch: null, commit: null, versions: 'base 0.12.0 (installed 0.15.0)', surfaces: 'desktop', claudeCode: null, session: 's', workId: null }
    const d = { plugin: 'base', kind: 'doctor', title: 't', path: '', observed: '', expected: '', reproduce: '', evidence: '', suspect: 'unsure' } as any
    const m = { version: '0.12.0', date: '2026-10-27', session: 's', workId: null }
    expect(defectBody(d, m, { ...env, pluginRoot: '/u/.claude/plugins/synced/org_user/base~g2' })).toContain('- base root: /u/.claude/plugins/synced/org_user/base~g2 (the claude.ai-synced copy)\n')
    expect(defectBody(d, m, { ...env, pluginRoot: '/c/base/0.15.0' })).toContain('- base root: /c/base/0.15.0\n')
  })

  test('versionsOf: the start line beats the install record, slim\'s own info beats both', () => {
    const installed = JSON.stringify({ plugins: { 'fe@domaine': [{ version: '0.11.4' }], 'slim@domaine': [{ version: '0.15.2' }], 'band@domaine': [{ version: '0.15.0' }] } })
    const v = versionsOf(installed, '/s/base~g2', '0.12.0', '0.14.1', [], { fe: '0.9.1', slim: '0.1.0', band: '0.15.0' })
    expect(versionsLine(v)).toBe('slim 0.14.1 (installed 0.15.2), band 0.15.0, base 0.12.0, fe 0.9.1 (installed 0.11.4)')
  })

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
    expect(pluginScript('node plugins/qa/scripts/qa-stores.cjs>/tmp/s.txt; cat /tmp/s.txt')).toBe('qa-stores.cjs')
    expect(pluginScript('x=`plugins/be/scripts/c.sh`')).toBe('c.sh')
    expect(pluginScripts('bash plugins/base/scripts/a.sh && node ~/.claude/plugins/cache/domaine/fe/0.6.1/scripts/b.cjs | head').sort()).toEqual(['a.sh', 'b.cjs'])
  })

  test('pluginScript: the cache of any config dir and the synced copy', () => {
    expect(pluginScript('node /u/.claude-work/plugins/cache/domaine/fe/0.9.1/scripts/a.cjs')).toBe('a.cjs')
    expect(pluginScript('bash ~/.claude/plugins/synced/acct_user/base~g2/scripts/b.sh')).toBe('b.sh')
    expect(pluginScript('bash ~/.claude/plugins/synced/acct_user/base/scripts/b.sh')).toBe('b.sh')
    expect(pluginScript('bash ~/.claude/plugins/synced/acct_user/acme/scripts/b.sh')).toBeNull()
    expect(pluginScript('cat ~/.claude/plugins/synced/acct_user/base/scripts/b.sh')).toBeNull()
  })

  test('errorLine: the first failing error= line, else the first Error line, else the first line, never the host exit line, capped', () => {
    expect(errorLine('note=x\nerror=theme_not_found theme=1\nerror=gql_errors log=x')).toBe('error=gql_errors log=x')
    expect(errorLine('Exit code 1\n  TypeError: boom\n    at x')).toBe('TypeError: boom')
    expect(errorLine('Exit code 1')).toBe('')
    expect(errorLine('Error: Exit code 1')).toBe('')
    expect(errorLine('Error: Exit code 1\n\nmd-to-adf: cannot read input: ENOENT')).toBe('md-to-adf: cannot read input: ENOENT')
    expect(errorLine('Exit code 2\nwarn: x\nTypeError: boom')).toBe('TypeError: boom')
    expect(errorLine(`Exit code 1\n${'y'.repeat(300)}`).length).toBe(160)
    expect(errorLine(`error=gql_errors ${'x'.repeat(300)}`).length).toBe(160)
  })

  test('priorErrors: this session\'s well-formed entries after the report; [] for another session or bad JSON', () => {
    const json = JSON.stringify({ sid: 's1', errors: [{ script: 'a', line: '', ms: 5 }, { script: 'b', line: 'x', ms: 9 }, { script: 'c', ms: 10 }, null] })
    expect(priorErrors(json, 's1', 5)).toEqual([{ script: 'b', line: 'x', ms: 9 }])
    expect(priorErrors(json, 's2', 0)).toEqual([])
    expect(priorErrors('{', 's1', 0)).toEqual([])
    expect(priorErrors(null, 's1', 0)).toEqual([])
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

  test('crashedIn: Error with a stack frame naming the script, or a shell trace naming it', () => {
    expect(crashedIn('Error: boom\n    at Object.<anonymous> (/x/plugins/base/scripts/x.cjs:12:3)', 'x.cjs')).toBe(true)
    expect(crashedIn('/x/plugins/base/scripts/x.cjs:12\n  throw new Error("boom")', 'x.cjs')).toBe(true)
    expect(crashedIn('review-scope.sh: line 12: foo: command not found', 'review-scope.sh')).toBe(true)
    expect(crashedIn('/x/scripts/review-scope.sh: line 3: jq: command not found', 'review-scope.sh')).toBe(true)
    expect(crashedIn('TypeError: x\n    at f (/x/plugins/base/scripts/x.cjs:3:1)', 'x.cjs')).toBe(true)
    expect(crashedIn('SyntaxError: Unexpected end of JSON input\n    at JSON.parse (<anonymous>)\n    at Object.<anonymous> (/x/plugins/base/scripts/x.cjs:1:6)', 'x.cjs')).toBe(true)
    expect(crashedIn('Error: boom', 'x.cjs')).toBe(false)
    expect(crashedIn('Error: tsc failed\n    at run (/r/node_modules/tsc/lib/tsc.js:4:1)', 'x.cjs')).toBe(false)
    expect(crashedIn('see x.cjs:12 for the flag', 'x.cjs')).toBe(false)
    expect(crashedIn('Error in xxcjs:1', 'x.cjs')).toBe(false)
  })

  test('deniedNotRun: the permission layer\'s denials, never a script\'s output', () => {
    for (const t of [
      'Permission for this action was denied by the Claude Code auto mode classifier. Reason: x',
      'Permission for this tool use was denied. The tool use was rejected.',
      'Permission to use Bash with command rm -rf x has been denied.',
      "The user doesn't want to proceed with this tool use. The tool use was rejected.",
      'This command requires approval',
      'Error: This command requires approval',
      "Claude requested permissions to use Bash, but you haven't granted it yet.",
      "Claude requested permissions to write to /x/y.md, but you haven't granted it yet.",
    ]) expect(deniedNotRun(t)).toBe(true)
    for (const t of ['out\nThis command requires approval', 'bash: ./x.sh: Permission denied', 'out\ndenied by the Claude Code auto mode classifier', 'remote:\nPermission to o/r.git denied to u.', 'Error: EACCES: permission denied', 'marker=fresh', ''])
      expect(deniedNotRun(t)).toBe(false)
  })

  test('dogfoodAccounts: the keys of accounts; [] for null, bad JSON, an array or a missing key', () => {
    expect(dogfoodAccounts('{"accounts":{"a":"A","b":"B"}}')).toEqual(['a', 'b'])
    expect(dogfoodAccounts(null)).toEqual([])
    expect(dogfoodAccounts('{')).toEqual([])
    expect(dogfoodAccounts('{"accounts":["a"]}')).toEqual([])
    expect(dogfoodAccounts('{}')).toEqual([])
  })

  test('seen: a path once, the index title first, newest first', () => {
    const list = seen('- 2026-10-01 base A → /p/2026-10-01-base-a.md\n', '/p', ['2026-10-01-base-a.md', '2026-10-05-fe-b.md', 'notes.txt'])
    expect(list.map(s => s.title)).toEqual(['b', 'A'])
  })

  test('scriptLast: the script ends the line, redirects allowed', () => {
    expect(scriptLast('node plugins/base/scripts/x.cjs')).toBe(true)
    expect(scriptLast('node plugins/base/scripts/x.cjs 2>&1')).toBe(true)
    expect(scriptLast('cd /repo && bash plugins/base/scripts/review-scope.sh --ws a 2>&1')).toBe(true)
    expect(scriptLast('VAR=1 node plugins/base/scripts/x.cjs')).toBe(true)
    expect(scriptLast(SCRIPT_CMD)).toBe(true)
    expect(scriptLast('node plugins/base/scripts/x.cjs | head')).toBe(false)
    expect(scriptLast('node plugins/base/scripts/x.cjs; echo done')).toBe(false)
    expect(scriptLast('cat a; node plugins/base/scripts/x.cjs; cat b')).toBe(false)
    expect(scriptLast('node plugins/base/scripts/x.cjs && echo ok')).toBe(false)
    expect(scriptLast('node plugins/base/scripts/x.cjs\necho next')).toBe(false)
    expect(scriptLast('echo hi')).toBe(false)
  })

  test('designedRefusal: refusal error= lines, or a stem line without any, never with Error', () => {
    expect(designedRefusal('md-to-adf: no input file', 'md-to-adf.cjs')).toBe(true)
    expect(designedRefusal('Exit code 1\nmd-to-adf: no input file', 'md-to-adf.cjs')).toBe(true)
    expect(designedRefusal('Error: Exit code 1\nmd-to-adf: no input file', 'md-to-adf.cjs')).toBe(true)
    expect(designedRefusal('note=x\nerror=no_store', 'shopify-admin-gql.sh')).toBe(true)
    expect(designedRefusal('Exit code 3\nnote=engine=token\nerror=no_admin_token\nhint=Set SHOPIFY_ADMIN_TOKEN or run shopify app dev', 'shopify-admin-gql.sh')).toBe(true)
    expect(designedRefusal('note=engine=token\nerror=invalid_admin_token source=env', 'shopify-admin-gql.sh')).toBe(false)
    expect(designedRefusal('error=no_admin_token\nError: ECONNRESET', 'shopify-admin-gql.sh')).toBe(false)
    expect(designedRefusal('Exit code 3\nerror=no_admin_token\nerror=shopify_cli_not_found\nhint=themecli_unavailable (no shopify CLI on PATH)', 'theme-json.sh')).toBe(false)
    expect(designedRefusal('x: half\nerror=gql_errors', 'x.sh')).toBe(false)
    expect(designedRefusal('pin_error=refresh_unverifiable', 'create-preview-theme.sh')).toBe(false)
    expect(designedRefusal('error=push_failed\nError: ECONNRESET', 'push-theme.sh')).toBe(false)
    expect(designedRefusal('error=usage\nError: ECONNRESET', 'theme-json.sh')).toBe(false)
    expect(designedRefusal('md-to-adf: Error: boom', 'md-to-adf.cjs')).toBe(false)
    expect(designedRefusal('other-script: nope', 'md-to-adf.cjs')).toBe(false)
    expect(designedRefusal('see md-to-adf: nope', 'md-to-adf.cjs')).toBe(false)
    expect(designedRefusal('aXb: nope', 'a.b.cjs')).toBe(false)
    expect(designedRefusal('a.b: nope', 'a.b.cjs')).toBe(true)
  })

  test('the two classes: every refusal reason is silent, every failure reason is a failure line', () => {
    for (const r of REFUSALS) {
      expect([r, designedRefusal(`Exit code 2\nerror=${r}`, 'theme-json.sh'), failureLine(`error=${r}`)]).toEqual([r, true, false])
    }
    for (const r of FAILURES) {
      expect([r, designedRefusal(`Exit code 5\nerror=${r}`, 'theme-json.sh'), failureLine(`error=${r}`)]).toEqual([r, false, true])
    }
    expect(failureLine('no error line here')).toBe(false)
    expect(failureLine('  "error=gql_errors"')).toBe(false)
  })

  test('bashText: a string result, stdout + stderr, the text fallback', () => {
    expect(bashText({ result: 'Exit code 1\nboom' })).toBe('Exit code 1\nboom')
    expect(bashText({ result: { stdout: 'out', stderr: 'err' } })).toBe('out\nerr')
    expect(bashText({ result: { stdout: '', stderr: 'err' } })).toBe('\nerr')
    expect(bashText({ result: { stderr: 'err' } })).toBe('err')
    expect(bashText({ text: 'fallback' })).toBe('fallback')
    expect(bashText({})).toBe('')
  })
})
