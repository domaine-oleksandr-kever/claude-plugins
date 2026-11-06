// Browser snippet for references/storefront-login.md → Overlays and blocked clicks: removes known consent overlays
// and the caller's own, reports what still covers the page, and probes one blocked click target. Runs in the page.
// One function declaration and nothing else, so the file is both a classic script (Playwright's addScriptTag defines
// the global) and a function source (chrome-devtools' evaluate_script sourcePath calls it).
// opts: { hide: [selector…], probe: selector } or an Element (a chrome-devtools args uid) to probe; both optional.
function storefrontOverlay(opts) {
  const KNOWN = ['#onetrust-consent-sdk', '#CybotCookiebotDialog']
  const o = opts && opts.nodeType === 1 ? { probe: opts } : opts || {}
  const ident = v => /^[A-Za-z_][\w-]*$/.test(v)
  const count = s => { try { return document.querySelectorAll(s).length } catch (err) { return 0 } }
  // A selector naming this element alone, so passing it back in `hide` removes nothing else.
  const name = el => {
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(ident).slice(0, 2) : []
    const s = el.tagName.toLowerCase() + (ident(el.id) ? '#' + el.id : '') + cls.map(c => '.' + c).join('')
    if (count(s) === 1) return s
    const path = []
    for (let a = el; a.parentElement; a = a.parentElement) {
      if (a !== el && ident(a.id) && count('#' + a.id) === 1) { path.unshift('#' + a.id); break }
      if (a === document.body) { path.unshift('body'); break }
      path.unshift((a === el ? s : a.tagName.toLowerCase()) + `:nth-child(${[...a.parentElement.children].indexOf(a) + 1})`)
    }
    return path.join(' > ')
  }
  const style = el => getComputedStyle(el)
  const shown = el => {
    const s = style(el), r = el.getBoundingClientRect()
    return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0 && r.width > 0 && r.height > 0
  }
  const removed = [], kept = []
  for (const sel of KNOWN.concat(o.hide || [])) {
    let els, n = 0
    try { els = [...document.querySelectorAll(sel)] } catch (err) { kept.push(sel + ' (invalid selector)'); continue }
    for (const el of els) {
      // An over-broad project selector must not take the storefront's password gate with it.
      if (el.querySelector('form[action*="/password"]') || el.closest('form[action*="/password"]')) kept.push(sel + ' (holds the password gate)')
      else { el.remove(); n++ }
    }
    if (n) removed.push(n > 1 ? `${sel} ×${n}` : sel)
  }
  const vw = innerWidth, vh = innerHeight
  const covering = []
  for (const el of document.querySelectorAll('body *')) {
    if (covering.some(c => c.contains(el)) || !shown(el)) continue
    const s = style(el), r = el.getBoundingClientRect()
    const full = s.position === 'fixed' && s.pointerEvents !== 'none' &&
      r.left <= vw * 0.1 && r.left + r.width >= vw * 0.9 && r.top <= vh * 0.1 && r.top + r.height >= vh * 0.9
    const modal = el.matches('dialog[open], [aria-modal="true"]')
    if (full || modal) covering.push(el)
  }
  const report = { removed, kept, covering: covering.map(name) }
  if (!o.probe) return report
  let el
  try { el = typeof o.probe === 'string' ? document.querySelector(o.probe) : o.probe } catch (err) {
    return { ...report, probe: { target: o.probe, found: false, error: 'invalid selector' } }
  }
  const p = { target: typeof o.probe === 'string' ? o.probe : name(el) }
  if (!el) return { ...report, probe: { ...p, found: false } }
  p.found = true
  p.disabled = el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true' || style(el).pointerEvents === 'none'
  p.hidden = !shown(el)
  if (!p.hidden) {
    const r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2
    // A centre outside a clipping ancestor (a carousel track) is out of view even inside the viewport.
    let clipped = false
    for (let a = el.parentElement; a && a !== document.body && !clipped; a = a.parentElement) {
      const s = style(a), q = a.getBoundingClientRect()
      clipped = (s.overflowX !== 'visible' || s.overflowY !== 'visible') &&
        (x < q.left || x >= q.left + q.width || y < q.top || y >= q.top + q.height)
    }
    if (clipped || x < 0 || y < 0 || x >= vw || y >= vh) p.offscreen = true
    else {
      const hit = document.elementFromPoint(x, y)
      // A hit on the target's own ancestor is the target taking no pointer events, not a cover.
      p.covered = !!hit && !hit.contains(el) && !el.contains(hit)
      if (p.covered) {
        let top = hit
        for (let a = hit; a && a !== document.body; a = a.parentElement) if (style(a).position === 'fixed' && !a.contains(el)) top = a
        p.by = name(hit)
        if (top !== hit) p.layer = name(top)
      }
    }
  }
  return { ...report, probe: p }
}
