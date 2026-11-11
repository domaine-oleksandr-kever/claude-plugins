// The MCP guards in one tool.call hook, server-agnostic. A subagent of base's reader or writer types calls MCP tools
// only on a server serving its vendor's tools, and an Atlassian or Notion write only when its type allows it (an
// unknown type gets none). A server other than a plugin's that serves the same tools as one of base's own takes
// precedence: base's tool is refused once per session, then allowed. Storefront login code in a browser MCP's code tool
// on any server is refused once per session, then allowed (./login.ts). Each deny writes one `guard` event.
import { atom, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'
import type { BaseEvent } from '../../../types'
import { logDir, logLine, pushEvent, spareRoot } from '../events.ts'
import type { Disk } from '../events.ts'
import { LOGIN_TOOLS, isLoginCall, loginDenyText } from './login.ts'

/**
 * The write tools of the Atlassian MCP v2 by tool name on any server: every write_* and delete_* group of Atlassian's
 * supported-tools page (Jira, JSM, Confluence, Bitbucket, Teamwork Graph, Loom, Goals, Projects, Teams, Focus, Talent,
 * Capacity Planning, Jira Align), manage_jira's writes, and the two tools that run a deferred write. The two pages of
 * that list spell one tool updateCapacityPlanAllocation(s): both are here. tests/base-refs-lint.sh reads this list and
 * NOTION_WRITES from this file.
 */
export const JIRA_WRITES = [
  'createJiraIssue', 'editJiraIssue', 'transitionJiraIssue', 'addOrEditJiraIssueComment', 'addOrEditJiraIssueWorklog',
  'createJiraIssueLink', 'manageJiraProjectVersion', 'manageJiraProjectVersionRelatedWork', 'manageJiraSprint',
  'createJiraBoard', 'watchJiraIssue', 'uploadAttachmentToJiraIssue', 'editJiraEntityProperty',
  'createJiraIssueRemoteIssueLink', 'convertJiraIssueHierarchy', 'deleteJiraIssue', 'deleteJiraComment',
  'deleteJiraIssueAttachment', 'createJiraProject', 'updateJiraProject', 'updateJiraScreen', 'updateJsmOpsAlert',
  'approveJsmRequestResolverPlans', 'transitionJsmRequest', 'createJsmRequest', 'decideJsmRequestApproval',
  'setJsmAgentAvailability', 'createConfluenceContent', 'updateConfluenceContent', 'createConfluenceSpace',
  'setConfluenceSpaceInstructions', 'copyConfluenceContent', 'moveConfluenceContent', 'archiveConfluenceContent',
  'unarchiveConfluenceContent', 'restoreConfluenceContentVersion', 'convertConfluenceContentMode',
  'setConfluenceContentStatus', 'createConfluenceComment', 'updateConfluenceComment', 'updateConfluenceCommentResolution',
  'addConfluenceContentSuggestions', 'createConfluenceAttachment', 'addLabelsToConfluenceContent', 'addConfluenceReaction',
  'addConfluenceContentPermissions', 'removeConfluenceContentPermissions', 'replaceConfluenceContentPermissions',
  'setConfluenceContentRestrictionState', 'enableConfluencePublicLink', 'disableConfluencePublicLink',
  'completeConfluenceTask', 'reopenConfluenceTask', 'starConfluenceContent', 'unstarConfluenceContent',
  'starConfluenceSpace', 'unstarConfluenceSpace', 'watchConfluenceContent', 'unwatchConfluenceContent',
  'watchConfluenceSpace', 'unwatchConfluenceSpace', 'watchConfluenceLabel', 'unwatchConfluenceLabel',
  'createConfluenceInfographicForPage', 'editConfluenceInfographicForPage', 'createConfluenceMauiApp',
  'editConfluenceMauiApp', 'createBitbucketRepoPullRequest', 'updateBitbucketRepoPullRequest',
  'mergeBitbucketRepoPullRequest', 'approveBitbucketRepoPullRequest', 'requestChangesOnBitbucketRepoPullRequest',
  'addBitbucketRepoPullRequestComment', 'resolveBitbucketRepoPullRequestComment', 'reopenBitbucketRepoPullRequestComment',
  'createBitbucketRepoPullRequestTask', 'setBitbucketRepoPullRequestTaskState', 'createBitbucketRepoBranch',
  'createBitbucketRepoCommit', 'runBitbucketRepoPipeline', 'addTeamworkGraphContext', 'addLoomInteraction',
  'updateLoomObjectMetadata', 'updateLoomObjectVisibility', 'shareLoomObject', 'createLoomObjectUpload',
  'publishLoomObject', 'createLoomObjectFolder', 'moveLoomObjectToFolder', 'recoverLoomVideo', 'createGoal',
  'createGoalUpdate', 'addConnectionsToGoals', 'createProject', 'createProjectUpdate', 'addConnectionsToProjects',
  'createTeam', 'updateTeam', 'createFocusArea', 'updateFocusArea', 'createFocusAreaStatusUpdate', 'linkToFocusArea',
  'createTalentSkill', 'updateTalentWorkerSkillMappings', 'updateTalentPositionFocusAreaMappings',
  'updateCapacityPlanAllocation', 'updateCapacityPlanAllocations', 'createCapacityPlanNonProjectWork',
  'updateCapacityPlanNonProjectWork', 'createJiraAlignItem', 'updateJiraAlignItem', 'executeWrite', 'executeDestructive',
]
/**
 * Atlassian MCP v1 tool name → its v2 name, for a server still on v1 (Atlassian removes v1 on 2027-03-01): the guards
 * treat both names as one tool. Two v1 names mapping to one v2 name count as that tool for the writes, never as a twin.
 */
export const V1_RENAMES: Readonly<Record<string, string>> = {
  addCommentToJiraIssue: 'addOrEditJiraIssueComment',
  addWorklogToJiraIssue: 'addOrEditJiraIssueWorklog',
  createIssueLink: 'createJiraIssueLink',
  getJiraIssueRemoteIssueLinks: 'listJiraIssueRemoteIssueLinks',
  getTransitionsForJiraIssue: 'listJiraIssueTransitions',
  getVisibleJiraProjects: 'listJiraProjects',
  getJiraProjectIssueTypesMetadata: 'listJiraProjectIssueTypesMetadata',
  getIssueLinkTypes: 'listJiraIssueLinkTypes',
  getConfluencePage: 'getConfluenceContent',
  getConfluenceSpaces: 'listConfluenceSpaces',
  getPagesInConfluenceSpace: 'listConfluenceContent',
  getConfluencePageFooterComments: 'listConfluenceComments',
  getConfluencePageInlineComments: 'listConfluenceComments',
  searchConfluenceUsingCql: 'searchConfluence',
  createConfluencePage: 'createConfluenceContent',
  updateConfluencePage: 'updateConfluenceContent',
  createConfluenceFooterComment: 'createConfluenceComment',
  createConfluenceInlineComment: 'createConfluenceComment',
}
export const NOTION_WRITES = [
  'notion-create-pages', 'notion-update-page', 'notion-create-comment', 'notion-move-pages', 'notion-duplicate-page',
  'notion-create-database', 'notion-update-data-source', 'notion-create-view', 'notion-update-view',
  'notion-create-folder', 'notion-update-folder', 'notion-create-file-upload', 'notion-create-attachment',
  'notion-spawn-session', 'notion-send-message-to-session', 'notion-stop-session',
]
/** Per server of base's manifest: a tool only its vendor's servers serve, and the vendor. A server listing it serves the same tools. */
export const SIGNATURE: Record<string, readonly [tool: string, vendor: string]> = {
  atlassian: ['getJiraIssue', 'Atlassian'],
  'notion-mcp': ['notion-fetch', 'Notion'],
  'figma-dev-mode': ['get_design_context', 'Figma'],
}
const WRITES = new Set([...JIRA_WRITES, ...NOTION_WRITES])
/** SubagentStart's `agent_type` spelling of base's agents → the SIGNATURE servers whose vendor's servers are its only MCP servers. */
const SCOPE: Record<string, readonly string[]> = {
  'base:jira-reader': ['atlassian'],
  'base:doc-reader': ['atlassian', 'notion-mcp'],
  'base:figma-reader': ['figma-dev-mode'],
  'base:jira-writer': ['atlassian'],
}
const READERS = new Set(['base:jira-reader', 'base:doc-reader', 'base:figma-reader'])
const WRITER = 'base:jira-writer'
const WRITER_TOOLS = new Set(['editJiraIssue', 'addOrEditJiraIssueComment'])
const OWN = 'plugin_base_'
const SOFT_CAP = 200
/** The `mcpSoft` entry that marks this session's storefront-login refusal: no tool name has a space. */
const LOGIN_KEY = 'storefront login'

const soft = atom({ plugin: 'base', key: 'mcpSoft' } as const, { sid: '', tools: [] as string[] })
const events = atom({ plugin: 'base', key: 'events' } as const, [] as BaseEvent[])

type $ = EngineInterface

/** `tool`'s v2 name: its V1_RENAMES entry, else itself. */
export const v2Name = (tool: string): string => V1_RENAMES[tool] ?? tool

/** The names a twin server may list `tool` under: itself, then its name of the other Atlassian generation when one maps 1:1. */
export function aliases(tool: string): string[] {
  const back = Object.keys(V1_RENAMES).filter(k => V1_RENAMES[k] === tool)
  return [tool, ...(tool in V1_RENAMES ? [V1_RENAMES[tool]] : []), ...(back.length === 1 ? back : [])]
}

/** True when `names` list a tool of `server` under an Atlassian v1 name that v2 renamed: that server still speaks v1. */
export function onV1(names: readonly string[], server: string): boolean {
  return Object.keys(V1_RENAMES).some(t => names.includes(`mcp__${server}__${t}`))
}

/** `mcp__<server>__<tool>` → its server and tool; null for any other name. */
export function splitTool(name: string): { server: string; tool: string } | null {
  const at = name.lastIndexOf('__')
  return name.startsWith('mcp__') && at > 5 ? { server: name.slice(5, at), tool: name.slice(at + 2) } : null
}

/**
 * The servers in `names` that list the SIGNATURE tool of base's `server` and are no plugin's (nor slim's or base's
 * registered tools), in list order; none for a server without a signature.
 */
export function twinServers(names: readonly string[], server: string): string[] {
  const sig = SIGNATURE[server]?.[0]
  const out: string[] = []
  for (const n of names) {
    const s = splitTool(n)
    if (!sig || s?.tool !== sig || s.server.startsWith('plugin_') || s.server === 'slim' || s.server === 'base') continue
    if (!out.includes(s.server)) out.push(s.server)
  }
  return out
}

/** Why an agent of `type` (null = no marker entry) may not call the write tool `tool`; null when it may. */
export function writeRefusal(type: string | null, tool: string, full: string): string | null {
  if (!WRITES.has(v2Name(tool))) return null
  if (type === null) return `base: ${full} refused: no agent-type marker for this subagent, so it gets no Atlassian or Notion write tool`
  if (READERS.has(type)) return `base: ${type} is read-only toward Atlassian and Notion — ${full} refused`
  if (type === WRITER && !WRITER_TOOLS.has(v2Name(tool))) return `base: ${type} writes only with editJiraIssue or addOrEditJiraIssueComment — ${full} refused`
  return null
}

/** Why an agent of `type` may not call `full` on `server` while `names` are listed; null when it may or its type has no scope. */
export function scopeRefusal(type: string, server: string, full: string, names: readonly string[]): string | null {
  const scope = SCOPE[type]
  if (!scope || scope.some(k => server === OWN + k || names.includes(`mcp__${server}__${SIGNATURE[k][0]}`))) return null
  return `base: ${type} calls MCP tools only on a server that serves ${scope.map(k => SIGNATURE[k][0]).join(' or ')} — ${full} refused`
}

/** events.ts's file writer reaches `$` through this: the validator follows `$` only within one file. */
function diskOf($: $): Disk {
  return {
    session: () => $.session.id(),
    home: () => $.env.get('HOME'),
    override: () => $.env.get('DOMAINE_LOG_DIR'),
    manifest: () => $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`),
    read: path => $.fs.read(path),
    write: (path, text) => $.fs.write(path, text),
    toast: text => $.ui.toast(text),
  }
}

async function logGuard($: $, text: string): Promise<void> {
  try {
    if ((await $.env.get('BASE_EVENT_LOG')) === '0') return
    const ev: BaseEvent = { atMs: await $.clock.now(), kind: 'guard', text }
    await update($, events, l => pushEvent(l, ev))
    await logLine(diskOf($), ev)
  } catch {}
}

/**
 * The type hooks/conventions.cjs recorded for subagent `id` in `<log dir or spare dir>/<session>/agents/<id>.json`:
 * null when no file names it, undefined when a probe failed.
 */
async function agentType($: $, id: string): Promise<string | null | undefined> {
  if (!/^[\w.-]+$/.test(id) || /^\.+$/.test(id)) return null
  let failed = false
  try {
    const sid = String(await $.session.id())
    const dirs = [logDir(await $.env.get('HOME'), await $.env.get('DOMAINE_LOG_DIR'), sid), logDir(undefined, spareRoot(await $.env.get('TMPDIR')), sid)]
    for (const dir of dirs) {
      if (dir === null) continue
      const file = `${dir}/agents/${id}.json`
      let text: string
      try {
        if (!(await $.fs.exists(file))) continue
        text = await $.fs.read(file)
      } catch {
        failed = true
        continue
      }
      try {
        const type = JSON.parse(text) as unknown
        if (typeof type === 'string' && type) return type
      } catch {}
    }
  } catch {
    return undefined
  }
  return failed ? undefined : null
}

/** True the first time this session asks for `key`; marks it, so the next ask answers false. */
async function firstRefusal($: $, key: string): Promise<boolean> {
  const sid = String(await $.session.id())
  let fresh = false
  await update($, soft, s => {
    const tools = s.sid === sid ? s.tools : []
    fresh = !tools.includes(key)
    return fresh ? { sid, tools: [...tools, key].slice(-SOFT_CAP) } : s
  })
  return fresh
}

/**
 * The one refusal per session of base's own `full` while another server serves the same tool (under either Atlassian
 * generation's name); null when none applies.
 */
async function precedence($: $, full: string, name: { server: string; tool: string }, names: readonly string[]): Promise<string | null> {
  let other = ''
  let twin = ''
  for (const s of twinServers(names, name.server.slice(OWN.length))) {
    const tool = aliases(name.tool).find(t => names.includes(`mcp__${s}__${t}`))
    if (tool) {
      other = `mcp__${s}__${tool}`
      twin = s
      break
    }
  }
  if (!other || !(await firstRefusal($, full))) return null
  await logGuard($, `${name.tool}: ${twin} takes precedence`)
  return `${full}: ${other} serves the same tool and takes precedence — call ${other} instead; if that fails, call ${full} again (it is allowed after this one refusal)`
}

export function registerMcpGuards(on: On): void {
  on('tool.call', { tool: /^mcp__(?!slim__|base__)/ }, async ($, e, next) => {
    const name = splitTool(e.tool)
    if (!name || (await $.env.get('BASE_GUARD')) === '0') return next(e)
    let listed: string[] | null | undefined
    const names = async () => (listed !== undefined ? listed : (listed = await $.tool.list().then(l => l.map(t => t.name), () => null)))
    if (e.agentId !== undefined) {
      const type = await agentType($, e.agentId)
      const write = type === undefined ? null : writeRefusal(type, name.tool, e.tool)
      if (write) {
        await logGuard($, `${name.tool}: ${type ?? 'a subagent of unknown type'} may not write`)
        return { deny: write }
      }
      const scoped = type && SCOPE[type] ? await names() : null
      const scope = type && scoped ? scopeRefusal(type, name.server, e.tool, scoped) : null
      if (scope) {
        await logGuard($, `${name.tool}: ${type} may not call ${name.server}`)
        return { deny: scope }
      }
    }
    if (LOGIN_TOOLS.test(name.tool) && isLoginCall(e as unknown as Record<string, unknown>) && (await firstRefusal($, LOGIN_KEY))) {
      await logGuard($, `${name.tool}: storefront login code`)
      return { deny: loginDenyText($.plugin.root) }
    }
    const list = name.server.startsWith(OWN) ? await names() : null
    const deny = list ? await precedence($, e.tool, name, list) : null
    return deny ? { deny } : next(e)
  })
}
