#!/usr/bin/env node
/*
 * resume.cjs — SessionStart command hook (matcher resume|fork|compact, hooks/hooks.json): hands band's mod what
 * no engine event carries there. A resumed or forked session gets the time since its last response:
 *   <log dir>/<session_id>/band-resume.json  {source, atMs, secondsSinceLastResponse, promptCacheLikelyExpired}
 * A compaction (the Team login's mods see no compact event) gets the transcript's compact_boundary record of
 * this compaction (one stamped within the last minute):
 *   <log dir>/<session_id>/band-compact.json {atMs, trigger, tokensBefore, tokensAfter} (null where unread)
 * where the log dir is DOMAINE_LOG_DIR when absolute, else $HOME/.claude/domaine/log (the mod's logDir rule).
 * The host can append that record only after its SessionStart hooks return: with none on disk yet, the hook
 * leaves a detached copy of itself (`resume.cjs --await-compact <transcript> <sinceMs> <out> <waitMs>`) that
 * polls for it and writes the file, with nulls after waitMs.
 * Prints nothing and always exits 0; a bad session id or an unwritable dir writes nothing.
 */
'use strict';

const fs = require('fs');
const path = require('path');

/** The compaction's restored files and listings follow its boundary record: the tail read covers them. */
const TAIL_BYTES = 4 * 1024 * 1024;
/** A boundary stamped this long before the hook ran still belongs to this compaction. */
const FRESH_MS = 60_000;
const WAIT_MS = 10_000;
const POLL_MS = 250;

const abs = v => (typeof v === 'string' && v.trim().startsWith('/') ? v.trim().replace(/\/+$/, '') : null);
const count = v => (typeof v === 'number' && v >= 0 ? v : null);

function logDir(sid) {
  if (typeof sid !== 'string' || !/^[\w.-]+$/.test(sid) || /^\.+$/.test(sid)) return null;
  const home = abs(process.env.HOME);
  const root = abs(process.env.DOMAINE_LOG_DIR) || (home && home + '/.claude/domaine/log');
  return root ? root + '/' + sid : null;
}

/** The compactMetadata of the last compact_boundary record in the transcript's tail stamped at or after sinceMs; null when none is read. */
function lastBoundary(file, sinceMs) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"compact_boundary"')) continue;
      try {
        const o = JSON.parse(lines[i]);
        if (o.subtype === 'compact_boundary') return Date.parse(o.timestamp) >= sinceMs ? o.compactMetadata || {} : null;
      } catch {}
    }
  } catch {
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return null;
}

const compactRecord = (m) => ({
  atMs: Date.now(),
  trigger: m.trigger === 'manual' || m.trigger === 'auto' ? m.trigger : null,
  tokensBefore: count(m.preTokens),
  tokensAfter: count(m.postTokens),
});

function record(e) {
  if (e.source === 'resume' || e.source === 'fork') {
    const secs = e.seconds_since_last_response;
    return ['band-resume.json', {
      source: e.source,
      atMs: Date.now(),
      secondsSinceLastResponse: typeof secs === 'number' && secs >= 0 ? secs : null,
      promptCacheLikelyExpired: e.prompt_cache_likely_expired === true,
    }];
  }
  if (e.source === 'compact') {
    const file = typeof e.transcript_path === 'string' && fs.existsSync(e.transcript_path) ? e.transcript_path : null;
    const since = Date.now() - FRESH_MS;
    const m = file && lastBoundary(file, since);
    if (file && !m) return ['band-compact.json', null, [file, String(since)]];
    return ['band-compact.json', compactRecord(m || {})];
  }
  return null;
}

const write = (out, data) => {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(data) + '\n');
};

/** --await-compact: poll the transcript for this compaction's boundary, then write band-compact.json. */
function awaitCompact([file, since, out, wait]) {
  const until = Date.now() + Number(wait);
  const nap = new Int32Array(new SharedArrayBuffer(4));
  let m = lastBoundary(file, Number(since));
  while (!m && Date.now() < until) {
    Atomics.wait(nap, 0, 0, POLL_MS);
    m = lastBoundary(file, Number(since));
  }
  write(out, compactRecord(m || {}));
}

try {
  if (process.argv[2] === '--await-compact') awaitCompact(process.argv.slice(3));
  else {
    const e = JSON.parse(fs.readFileSync(0, 'utf8'));
    const dir = logDir(e && e.session_id);
    const r = dir && record(e);
    if (r && r[1]) write(path.join(dir, r[0]), r[1]);
    else if (r) {
      require('child_process')
        .spawn(process.execPath, [__filename, '--await-compact', ...r[2], path.join(dir, r[0]), String(WAIT_MS)], { detached: true, stdio: 'ignore' })
        .unref();
    }
  }
} catch {}
