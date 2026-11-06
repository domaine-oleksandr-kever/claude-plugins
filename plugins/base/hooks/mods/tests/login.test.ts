import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { codeOf, isLoginCall, isStorefrontLogin } from '../guards/login.ts'
import { NOW, PEEK, eventsOf, peek, world } from './world.ts'

const t = (name: string, body: ($: any, on: On) => Promise<void>) => test(name, { plugins: [PEEK] }, body)
const PW = 'pw-test-9'
const RUN = 'mcp__plugin_base_playwright__browser_run_code_unsafe'
const EVAL = 'mcp__plugin_base_playwright__browser_evaluate'
const SCRIPT = 'mcp__plugin_base_chrome-devtools-mcp__evaluate_script'
const call = ($: any, tool: string, code: string, extra: Record<string, unknown> = {}) =>
  $.tool.call({ tool, ...(tool === RUN || tool.endsWith('run_code_unsafe') ? { code } : { function: code }), ...extra })

// Shapes of the transcripts' real calls (2026-11-03…05), store names and passwords replaced.
const LOGIN: [string, string][] = [
  ['L01-goto-locator-fill', `async (page) => {\n  await page.goto('https://shop-a.myshopify.com/password');\n  const pw = page.locator('input[type=password]');\n  if (await pw.count()) { await pw.first().fill('${PW}'); await pw.first().press('Enter'); await page.waitForLoadState('domcontentloaded'); }\n  return page.url();\n}`],
  ['L02-page-fill-click', `async (page) => {\n  await page.fill('input[name="password"]', '${PW}');\n  await Promise.all([page.waitForNavigation().catch(()=>{}), page.getByRole('button', { name: 'Enter' }).click()]);\n}`],
  ['L03-value-submit', `async () => { const i = document.querySelector('input[type=password]'); if (!i) return 'no form'; i.value = '${PW}'; i.form.submit(); return 'ok'; }`],
  ['L04-formdata-post', `async () => { const fd = new FormData(); fd.append('form_type','storefront_password'); fd.append('password','${PW}'); const r = await fetch('/password', {method:'POST', body:fd, credentials:'include'}); return r.status; }`],
  ['L05-evaluate-in-run-code', `async (page) => {\n  for (const [s,p] of [['shop-a','${PW}']]) {\n    await page.goto(\`https://\${s}.myshopify.com/password\`);\n    await page.evaluate(async (p) => { await fetch('/password', {method:'POST', body:new URLSearchParams({form_type:'storefront_password', password:p})}); }, p);\n  }\n}`],
  ['L06-id-fill-commit', `async (page) => {\n  await page.fill('#password', '${PW}');\n  await Promise.all([page.waitForNavigation(), page.click('button[name=commit]')]);\n}`],
  ['L07-form-action-set', `async () => { const f=document.querySelector('form[action*="password"]'); if(!f) return 'no form'; const fd=new FormData(f); fd.set('password','${PW}'); await fetch(f.action,{method:'POST',body:fd,credentials:'include'}); }`],
  ['L08-url-check-then-fill', `async (page) => {\n  await page.goto(base+'/collections/x');\n  if (page.url().includes('/password')) { await page.fill('input[type=password]','${PW}'); await page.press('input[type=password]','Enter'); }\n}`],
  ['L09-hidden-field', `async (page) => {\n  await page.goto(base + '/password', { waitUntil: 'load' });\n  await page.getByText('Enter using password').first().click();\n  const pw = page.locator('input[name=password]:visible').first();\n  await pw.fill('${PW}'); await pw.press('Enter');\n}`],
  ['L10-label', `async (page) => { await page.getByLabel('Password').fill('${PW}'); await page.keyboard.press('Enter'); }`],
  ['L11-gate-value-only', `() => { const f = document.querySelector('input[name="password"]').form; f.querySelector('input[name="password"]').value = '${PW}'; f.submit(); }`],
  ['L12-bare-name-attr', `async (page) => { await page.goto(base); await page.locator('[name="password"]').fill('${PW}'); await page.keyboard.press('Enter'); }`],
  ['L13-role-textbox', `async (page) => { await page.getByRole('textbox', { name: 'Password' }).fill('${PW}'); await page.keyboard.press('Enter'); }`],
]
const READ: [string, string][] = [
  ['R01-locked-check', `() => ({ locked: document.body.classList.contains('template-password') || location.pathname.startsWith('/password') || !!document.querySelector('form[action*="/password"]'), path: location.pathname })`],
  ['R02-has-field', `() => ({ path: location.pathname, hasForm: !!document.querySelector('form:has(input[value=storefront_password]) input[name=password]') })`],
  ['R03-gate-probe', `() => { const f = document.querySelector('form[action*="/password"]'); return { hidden: [...(f?.querySelectorAll('input[type=hidden]') || [])].map(i => i.name + '=' + i.value), inputs: [...(f?.querySelectorAll('input:not([type=hidden])') || [])].map(i => ({ type: i.type, name: i.name })) }; }`],
  ['R04-goto-gate-list-inputs', `async (page) => {\n  await page.goto('https://shop-a.myshopify.com/password', { waitUntil: 'domcontentloaded' });\n  return await page.evaluate(() => ({ inputs: [...document.querySelectorAll('input')].map(i => i.type + ':' + i.name) }));\n}`],
  ['R05-url-check-click-elsewhere', `async (page) => {\n  await page.goto(base + '/products/x', { waitUntil: 'load' });\n  if (page.url().includes('/password')) return 'password';\n  const btn = page.locator('button:visible').filter({ hasText: /try it on/i }).first();\n  await btn.click();\n}`],
  ['R06-mark-field', `() => { const i=document.querySelector('form:has(input[value=storefront_password]) input[name=password]'); if(i) i.setAttribute('data-qa','pw'); return {found:!!i}; }`],
  ['R07-locked-then-get', `async () => { const locked = location.pathname.startsWith('/password'); const j = await (await fetch('/collections/all/products.json?limit=250')).json(); return { locked, n: j.products.length }; }`],
  ['R08-fill-no-gate', `async (page) => { await page.fill('input[name=q]', 'lipstick'); await page.keyboard.press('Enter'); }`],
  ['R09-type-property', `() => [...document.forms].map(f => ({ action: f.action, inputs: [...f.elements].map(e => e.type + ':' + e.name) }))`],
  ['R10-empty', ''],
  ['R11-gate-check-then-cart-post', `async () => { if (document.querySelector('input[type=password]')) return 'locked'; await fetch('/cart/add.js', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({items:[{id:1,quantity:1}]})}); }`],
  ['R12-gate-count-then-search-fill', `async (page) => { if (await page.locator('input[type=password]').count()) return 'locked'; await page.fill('input[name=q]', 'x'); }`],
  ['R13-customer-account-login', `async (page) => { await page.goto(base + '/account/login'); await page.fill('input[type=email]', 'qa@example.com'); await page.fill('input[type=password]', '${PW}'); await page.click('button[type=submit]'); }`],
]
// references/storefront-login.md → Overlays and blocked clicks: the calls that carry scripts/storefront-overlay.js
// (its own code is checked against this guard's ACT list in tests/base-storefront-overlay.mjs).
const OVERLAY: [string, Record<string, unknown>][] = [
  ['O01-playwright-addScriptTag', { code: `async (page) => { await page.addScriptTag({ path: '/p/base/scripts/storefront-overlay.js' }); return await page.evaluate(o => storefrontOverlay(o), { hide: ['#region-selector-modal'], probe: '[data-carousel-next]' }); }` }],
  ['O02-devtools-sourcePath-uid', { sourcePath: '/p/base/scripts/storefront-overlay.js', args: ['1_4'], pageId: 1 }],
  ['O03-devtools-inline-after-script', { function: `() => storefrontOverlay({ hide: ['#region-selector-modal'], probe: 'form[action*="/password"] button' })`, pageId: 1 }],
]
const FILL_SUBMIT = `(el) => { el.value = '${PW}'; el.form.submit(); }`
// Element-scoped calls: Playwright's `target` (selector or snapshot ref) and `element`, chrome-devtools' `args` uids.
const SCOPED_LOGIN: [string, Record<string, unknown>][] = [
  ['E01-target-gate-selector', { function: FILL_SUBMIT, target: 'form[action*="/password"] input[name=password]' }],
  ['E02-target-ref', { function: FILL_SUBMIT, target: 'e12' }],
  ['E03-ref-element-names-password', { function: `(el) => { el.value = '${PW}'; }`, target: 'e12', element: 'Password field' }],
  ['E04-devtools-uid', { function: FILL_SUBMIT, args: ['1_4'], pageId: 1 }],
]
const SCOPED_READ: [string, Record<string, unknown>][] = [
  ['S01-ref-read', { function: '(el) => el.value', target: 'e12' }],
  ['S02-password-target-read', { function: '(el) => el.form.action', target: 'form[action*="/password"] input[name=password]' }],
  ['S03-uid-read', { function: '(el) => el.innerText', args: ['1_4'], pageId: 1 }],
]

describe('storefront login (matcher)', () => {
  for (const [label, code] of LOGIN) test(`login ${label}`, async () => expect(isStorefrontLogin(code)).toBe(true))
  for (const [label, code] of READ) test(`passes ${label}`, async () => expect(isStorefrontLogin(code)).toBe(false))
  for (const [label, args] of SCOPED_LOGIN) test(`login ${label}`, async () => expect(isLoginCall(args)).toBe(true))
  for (const [label, args] of SCOPED_READ) test(`passes ${label}`, async () => expect(isLoginCall(args)).toBe(false))
  for (const [label, args] of OVERLAY) test(`passes ${label}`, async () => expect(isLoginCall(args)).toBe(false))
  test("codeOf: Playwright's code and function, chrome-devtools' function; anything else none", () => {
    expect(codeOf({ code: 'a' })).toBe('a')
    expect(codeOf({ function: 'b', pageId: 1 })).toBe('b')
    expect(codeOf({ code: 7, element: 'x' })).toBe('')
  })
})

describe('storefront login (tool.call)', () => {
  t('login code → refused once with the whole route and no password; the next login call runs', async ($, on) => {
    const { calls } = world(on)
    const r = await call($, RUN, LOGIN[0]![1])
    expect(typeof r.deny).toBe('string')
    for (const n of ['scripts/qa-stores.cjs get <store> --field password', 'https://<domain>/password', '`form[action*="/password"] input[name=password]`',
      'browser_type (Playwright) or fill (chrome-devtools)', 'still on /password', '/references/storefront-login.md', 'once per session']) {
      expect(r.deny).toContain(n)
    }
    expect(r.deny).toMatch(/`node \/\S+\/scripts\/qa-stores\.cjs/)
    expect(r.deny).not.toContain(PW)
    expect(calls.below.length).toBe(0)
    expect((await call($, RUN, LOGIN[0]![1])).result).toBe('ok')
    expect(calls.below.length).toBe(1)
    const ev = await eventsOf($, 'guard')
    expect(ev).toEqual([{ atMs: NOW, kind: 'guard', text: 'browser_run_code_unsafe: storefront login code' }])
    expect(JSON.stringify(await peek($))).not.toContain(PW)
  })

  t('one refusal per session across tools and servers; a new session refuses again', async ($, on) => {
    const { w } = world(on)
    expect((await call($, SCRIPT, LOGIN[2]![1])).deny).toContain('storefront login code refused')
    expect((await call($, EVAL, LOGIN[3]![1])).result).toBe('ok')
    expect((await call($, 'mcp__Pw__browser_run_code_unsafe', LOGIN[1]![1])).result).toBe('ok')
    w.sid = 's2'
    expect((await call($, 'mcp__Pw__browser_run_code_unsafe', LOGIN[1]![1])).deny).toContain('storefront login code refused')
  })

  t("any server's code tool is checked: a connector's Playwright and a subagent's call", async ($, on) => {
    const { w } = world(on)
    expect((await call($, 'mcp__Pw__browser_evaluate', LOGIN[2]![1], { agentId: 'a1' })).deny).toContain('storefront login code refused')
    w.sid = 's2'
    expect((await call($, 'mcp__Chrome__evaluate_script', LOGIN[6]![1])).deny).toContain('storefront login code refused')
  })

  t('read-only code runs and leaves the refusal for real login code', async ($, on) => {
    const { calls } = world(on)
    for (const [, code] of READ) expect((await call($, SCRIPT, code)).result).toBe('ok')
    expect(calls.below.length).toBe(READ.length)
    expect(await eventsOf($, 'guard')).toEqual([])
    expect((await call($, RUN, LOGIN[0]![1])).deny).toContain('storefront login code refused')
  })

  t('the overlay helper calls run on both MCPs and leave the refusal for real login code', async ($, on) => {
    const { calls } = world(on)
    expect((await $.tool.call({ tool: RUN, ...OVERLAY[0]![1] })).result).toBe('ok')
    for (const [, args] of OVERLAY.slice(1)) expect((await $.tool.call({ tool: SCRIPT, ...args })).result).toBe('ok')
    expect(calls.below.length).toBe(OVERLAY.length)
    expect(await eventsOf($, 'guard')).toEqual([])
    expect((await call($, RUN, LOGIN[0]![1])).deny).toContain('storefront login code refused')
  })

  t("the MCP's own fill and other tools run, login text or not", async ($, on) => {
    const { calls } = world(on)
    expect((await $.tool.call({ tool: 'mcp__plugin_base_playwright__browser_type', ref: 'e12', text: PW, submit: true })).result).toBe('ok')
    expect((await $.tool.call({ tool: 'mcp__plugin_base_chrome-devtools-mcp__fill', uid: '1_4', value: PW })).result).toBe('ok')
    expect((await $.tool.call({ tool: 'mcp__Shop__query', function: LOGIN[2]![1] })).result).toBe('ok')
    expect(calls.below.length).toBe(3)
  })

  t("code acting on the element the call hands it is checked: Playwright's target, chrome-devtools' uids", async ($, on) => {
    const { w, calls } = world(on)
    expect((await $.tool.call({ tool: EVAL, ...SCOPED_LOGIN[1]![1] })).deny).toContain('storefront login code refused')
    w.sid = 's2'
    expect((await $.tool.call({ tool: SCRIPT, ...SCOPED_LOGIN[3]![1] })).deny).toContain('storefront login code refused')
    w.sid = 's3'
    expect((await $.tool.call({ tool: EVAL, ...SCOPED_READ[0]![1] })).result).toBe('ok')
    expect(calls.below.length).toBe(1)
  })

  t('BASE_GUARD=0 → login code runs', async ($, on) => {
    const { calls } = world(on, { env: { BASE_GUARD: '0' } })
    expect((await call($, RUN, LOGIN[0]![1])).result).toBe('ok')
    expect(calls.below.length).toBe(1)
  })

  t('BASE_EVENT_LOG=0 → still refused, no event', async ($, on) => {
    world(on, { env: { BASE_EVENT_LOG: '0' } })
    expect((await call($, RUN, LOGIN[0]![1])).deny).toContain('storefront login code refused')
    expect(await eventsOf($, 'guard')).toEqual([])
  })
})
