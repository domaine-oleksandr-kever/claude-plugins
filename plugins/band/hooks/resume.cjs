#!/usr/bin/env node
/*
 * resume.cjs — SessionStart command hook (matcher resume|fork, hooks/hooks.json): hands band's mod what no
 * engine event carries, the time since the last response of a resumed or forked session.
 * Writes <log dir>/<session_id>/band-resume.json
 *   {source, atMs, secondsSinceLastResponse, promptCacheLikelyExpired}
 * where the log dir is DOMAINE_LOG_DIR when absolute, else $HOME/.claude/domaine/log (the mod's logDir rule).
 * Prints nothing and always exits 0; a bad session id or an unwritable dir writes nothing.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const abs = v => (typeof v === 'string' && v.trim().startsWith('/') ? v.trim().replace(/\/+$/, '') : null);

function logDir(sid) {
  if (typeof sid !== 'string' || !/^[\w.-]+$/.test(sid) || /^\.+$/.test(sid)) return null;
  const home = abs(process.env.HOME);
  const root = abs(process.env.DOMAINE_LOG_DIR) || (home && home + '/.claude/domaine/log');
  return root ? root + '/' + sid : null;
}

try {
  const e = JSON.parse(fs.readFileSync(0, 'utf8'));
  const dir = logDir(e && e.session_id);
  if (dir && (e.source === 'resume' || e.source === 'fork')) {
    fs.mkdirSync(dir, { recursive: true });
    const secs = e.seconds_since_last_response;
    fs.writeFileSync(
      path.join(dir, 'band-resume.json'),
      JSON.stringify({
        source: e.source,
        atMs: Date.now(),
        secondsSinceLastResponse: typeof secs === 'number' && secs >= 0 ? secs : null,
        promptCacheLikelyExpired: e.prompt_cache_likely_expired === true,
      }) + '\n',
    );
  }
} catch {}
