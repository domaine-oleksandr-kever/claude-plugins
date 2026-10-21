/*
 * edit-delegation.cjs — which model the main session hands file changes to, decided once from the login record
 * (`.claude.json`) and BASE_EDIT_MODEL. Read by hooks/conventions.cjs (the `edit-delegation` convention and the rules
 * marker's `edit` field) and scripts/doctor.cjs (the `delegate` row). billedToCredits / creditGate / modelFamily /
 * planName are ported from plugins/band/hooks/mods/lib.ts; loginFile is base's own rule (hooks/mods/dogfood/text.ts).
 * Keep the copies in step. No CLI; never throws.
 */
'use strict';

const fs = require('fs');

/** Model families, cheapest first. */
const FAMILIES = ['haiku', 'sonnet', 'opus', 'fable'];
const MODEL_ALIASES = ['fable', 'opus', 'sonnet', 'haiku'];

const isRecord = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/** `claude-opus-5-5[1m]` → `opus`, `sonnet` → `sonnet`; null for a non-string. */
function modelFamily(id) {
  if (typeof id !== 'string') return null;
  return id.replace(/^claude-/, '').replace(/\[1m\]$/, '').split('-')[0];
}

/** True when `family` is a known family no dearer than `model`. */
const atOrBelow = (family, model) => FAMILIES.indexOf(family) !== -1 && FAMILIES.indexOf(family) <= FAMILIES.indexOf(model);

const abs = (p) => (typeof p === 'string' && p.trim().startsWith('/') ? p.trim().replace(/\/+$/, '') : '');

/** The login file: `$HOME/.claude.json` for the default (or a relative / empty) config dir, else `<CLAUDE_CONFIG_DIR>/.claude.json`; null with neither. */
function loginFile(home, configDir) {
  const h = abs(home);
  const c = abs(configDir);
  return c && c !== h + '/.claude' ? c + '/.claude.json' : h ? h + '/.claude.json' : null;
}

/** The parsed login record; null for a missing, unreadable, malformed or non-object file. */
function readRecord(file) {
  if (typeof file !== 'string' || !file) return null;
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isRecord(v) ? v : null;
  } catch {
    return null;
  }
}

function fact(x) {
  if (typeof x !== 'string') return null;
  const v = x.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return v ? [...v].slice(0, 120).join('') : null;
}

/** Whether the host bills `id` to usage credits (the record's `tengu_saffron_lattice` flag). */
function billedToCredits(json, id) {
  const flags = json.cachedGrowthBookFeatures;
  const lattice = isRecord(flags) ? flags.tengu_saffron_lattice : undefined;
  if (!isRecord(lattice)) return false;
  const family = modelFamily(id.replace(/\[1m\]$/, ''));
  if (isRecord(lattice.perModel)) {
    const key = Object.keys(lattice.perModel).find((k) => modelFamily(k.replace(/\[1m\]$/, '')) === family);
    const per = key === undefined ? undefined : lattice.perModel[key];
    if (isRecord(per)) return per.enabled === true;
  }
  if (lattice.enabled === false) return false;
  return lattice.overageConsentRequired === true || lattice.planLimitsEndDate !== undefined;
}

/** The record's credit-gated families `{ hiddenModels, hiddenReason }` (MODEL_ALIASES order; none for missing or malformed keys). */
function creditGate(json) {
  const none = { hiddenModels: [], hiddenReason: null };
  if (!isRecord(json)) return none;
  const reason = fact(json.cachedExtraUsageDisabledReason) ?? (isRecord(json.oauthAccount) && json.oauthAccount.hasExtraUsageEnabled === false ? 'extra_usage_off' : null);
  if (reason === null || !Array.isArray(json.additionalModelOptionsCache)) return none;
  const gated = new Set(
    json.additionalModelOptionsCache.flatMap((o) =>
      isRecord(o) && typeof o.value === 'string' && billedToCredits(json, o.value) ? [modelFamily(o.value.replace(/\[1m\]$/, ''))] : [],
    ),
  );
  const hiddenModels = MODEL_ALIASES.filter((a) => gated.has(a));
  return hiddenModels.length ? { hiddenModels, hiddenReason: reason } : none;
}

/** `claude_max` → `Claude Max`. */
function planName(plan) {
  return plan
    .split('_')
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

/** BASE_EDIT_MODEL: `{ value: 'opus'|'sonnet'|'haiku'|'off'|null, invalid }`; any case, trimmed; '' is unset, anything else invalid. */
function parseOverride(raw) {
  const t = (raw ?? '').toString().trim().toLowerCase();
  if (t === '') return { value: null, invalid: false };
  if (t === '0') return { value: 'off', invalid: false };
  if (t === 'opus' || t === 'sonnet' || t === 'haiku') return { value: t, invalid: false };
  return { value: null, invalid: true };
}

/**
 * The decision `{ model, kind, plan, source, gated, record, invalid }`: model opus|sonnet|haiku, null when off; kind
 * override|off|work|personal|api-key|synced sandbox|unknown; source BASE_EDIT_MODEL|login record|default; invalid the
 * raw override read as unset, else null. Only the presence of ANTHROPIC_API_KEY is read, never its value.
 */
function editDelegation({ env = {}, home, configDir, root } = {}) {
  const raw = env.BASE_EDIT_MODEL;
  const o = parseOverride(raw);
  const invalid = o.invalid ? String(raw) : null;
  const d = (model, kind, source, extra = {}) => ({ model, kind, plan: null, source, gated: false, record: false, invalid, ...extra });
  try {
    if (o.value === 'off') return d(null, 'off', 'BASE_EDIT_MODEL');
    if (o.value) return d(o.value, 'override', 'BASE_EDIT_MODEL');
    const rec = readRecord(loginFile(home, configDir));
    const record = rec !== null;
    const acct = rec && isRecord(rec.oauthAccount) ? rec.oauthAccount : null;
    const plan = acct && typeof acct.organizationType === 'string' ? acct.organizationType : null;
    const at = { plan, record };
    if (!acct && typeof env.ANTHROPIC_API_KEY === 'string' && env.ANTHROPIC_API_KEY.trim()) return d('sonnet', 'api-key', 'default', at);
    if (/^claude_(team|enterprise)$/.test(plan)) return d('sonnet', 'work', 'login record', at);
    if (creditGate(rec).hiddenModels.includes('opus')) return d('sonnet', 'personal', 'login record', { ...at, gated: true });
    if (/^claude_(max|pro)$/.test(plan)) return d('opus', 'personal', 'login record', at);
    if (!plan && typeof root === 'string' && root.includes('/plugins/synced/')) return d('opus', 'synced sandbox', 'default', at);
    return d('opus', 'unknown', 'default', at);
  } catch {
    return d('opus', 'unknown', 'default');
  }
}

/** Why the decision picked its model, as the convention and the doctor print it. */
function whyText(d) {
  switch (d.kind) {
    case 'override': return 'BASE_EDIT_MODEL';
    case 'off': return 'BASE_EDIT_MODEL=0';
    case 'work': return 'work login, ' + (d.plan ? planName(d.plan) : 'no plan');
    case 'personal': return 'personal login' + (d.plan ? ', ' + planName(d.plan) : '') + (d.gated ? ', opus needs credits' : '');
    case 'api-key': return 'api-key session';
    case 'synced sandbox': return 'synced sandbox, no plan in the login record';
    default: return d.record ? 'login record names no plan' : 'no login record';
  }
}

module.exports = { FAMILIES, modelFamily, atOrBelow, loginFile, readRecord, billedToCredits, creditGate, planName, parseOverride, editDelegation, whyText };
