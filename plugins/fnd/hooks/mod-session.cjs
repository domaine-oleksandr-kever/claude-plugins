// The mods-module session marker, read side. On Claude Code the fnd mods module (hooks/mods/**)
// rewrites `<tmpdir>/fnd-mod-session-<sid>` at the top of every prompt; a marker touched within
// FRESH_MS means the band mod is live in this session and already shows ctx and model, so
// user-prompt.cjs skips its context monitor. Other hosts have no mods: always inactive.
// The mod cannot delete files, so markers outlive their session; the mtime window is what keeps a
// resumed session whose module no longer loads from being silenced by its old marker.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Covers the hooks between the mod's write and this read — prompt-slim's spawn alone may take 20 s.
const FRESH_MS = 60_000;

// Same sanitiser as context-stats.cjs's band file — the mod side strips the same set.
function markerPath(sessionId) {
  return path.join(os.tmpdir(), `fnd-mod-session-${String(sessionId).replace(/[^A-Za-z0-9_.-]/g, '')}`);
}

function active(input) {
  if (process.env.FND_HOST !== 'claude' || !input || !input.session_id) return false;
  try {
    return Date.now() - fs.statSync(markerPath(input.session_id)).mtimeMs < FRESH_MS;
  } catch (_) {
    return false;
  }
}

module.exports = { markerPath, active, FRESH_MS };
