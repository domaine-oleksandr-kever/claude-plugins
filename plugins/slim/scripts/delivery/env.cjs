// slim's switches (SLIM_*), read straight from the process environment: the session env the host
// hands the hook or the module's spawn. The one host switch read is the Bash tool's inline limit.
'use strict';

const os = require('os');
const path = require('path');

const ENV = process.env;

// The spill root: SLIM_DIR when absolute (a leading `~/` expands to the home dir), else the system temp dir.
function spillRoot() {
  const raw = ENV.SLIM_DIR || '';
  const dir = raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(2)) : raw;
  return path.isAbsolute(dir) ? dir : os.tmpdir();
}
const ttlRaw = () => ENV.SLIM_TTL;

// `1|true|yes|on` = key events, an integer ≥ 2 = everything, anything else = off.
function debugLevel() {
  const raw = ENV.SLIM_DEBUG;
  if (!raw) return 0;
  const v = String(raw).trim();
  if (/^\d+$/.test(v) && Number(v) >= 2) return 2;
  return /^(1|true|yes|on)$/i.test(v) ? 1 : 0;
}

const BUDGET_MS_DEFAULT = 5000;
function budgetMs() {
  const raw = String(ENV.SLIM_BUDGET_MS ?? '').trim();
  if (raw === '0') return 0;
  const n = Number(raw);
  if (Number.isFinite(n) && n < 0) return -1;
  return Number.isFinite(n) && n > 0 ? n : BUDGET_MS_DEFAULT;
}

const STUB_CAP = 1200;
const STUB_BYTES_DEFAULT = 32768;
const stubEnabled = () => !(ENV.SLIM_STUB !== undefined && String(ENV.SLIM_STUB).trim() === '0');
// Whole-string Number, so `32k` falls back to the default instead of 32 bytes; floored at the stub's own cap.
function stubBytesOf(raw) {
  const n = Number(String(raw ?? '').trim());
  return Number.isFinite(n) && n > 0 ? Math.max(n, STUB_CAP) : STUB_BYTES_DEFAULT;
}
const stubBytes = () => stubBytesOf(ENV.SLIM_STUB_BYTES);
// The largest stub slim emits, plus the stub's own cap: the already-slim rule's bound.
const alreadySlimBound = () => stubBytes() + STUB_CAP;

const PLAIN_BYTES_DEFAULT = 65536;
const PLAIN_BYTES_FLOOR = 8192;
function plainBytes() {
  const raw = String(ENV.SLIM_PLAIN_BYTES ?? '').trim();
  if (!/^\d+$/.test(raw)) return PLAIN_BYTES_DEFAULT;
  return Math.max(Number(raw), PLAIN_BYTES_FLOOR);
}

const hintOn = () => ENV.SLIM_HINT !== '0' && ENV.SLIM_LOOKUP !== '0';

// The host's Bash tool shows this many characters of output inline and saves the rest to a file (its
// bashOutputMaxChars / BASH_MAX_OUTPUT_LENGTH default).
const BASH_INLINE_DEFAULT = 30000;
// `setting` = the merged settings' bashOutputMaxChars, which the host obeys as given. Without it,
// BASH_MAX_OUTPUT_LENGTH only lowers the default: newer hosts size just the read-back window with it.
function bashInline(setting) {
  if (Number.isInteger(setting) && setting > 0) return setting;
  const n = Number(String(ENV.BASH_MAX_OUTPUT_LENGTH ?? '').trim());
  return Number.isInteger(n) && n > 0 ? Math.min(n, BASH_INLINE_DEFAULT) : BASH_INLINE_DEFAULT;
}

module.exports = {
  spillRoot, ttlRaw, debugLevel, budgetMs, stubEnabled, stubBytes, alreadySlimBound, plainBytes, hintOn, bashInline,
  STUB_CAP, PLAIN_BYTES_DEFAULT,
};
