import fs from 'fs';
import path from 'path';
import { config } from '../config.js';

/**
 * AI providers, tried in the order of PROVIDERS: Claude (the PRIMARY provider) first, then Gemini, Grok and the rest.
 * PAID fallbacks are capped per day (AI_PAID_DAILY_LIMIT, default 20) so a broken key can never run up a bill; the
 * primary provider is not counted against that cap.
 * A provider that fails (bad key, quota used up, server error, unreadable answer) is skipped for a while and the
 * next one is tried. Usage is counted in data/ai-usage.json.
 *
 * To add or change a provider, edit PROVIDERS below. Keys live only in .env.
 */

export interface Provider {
  id: string;
  name: string;
  tier: 'primary' | 'free' | 'paid';
  /** .env variable holding the key. */
  keyEnv: string;
  /** Other .env names accepted for the key. */
  keyAliases?: string[];
  /** .env variable that overrides the model. */
  modelEnv: string;
  defaultModel: string;
  /** 'openai' = POST {baseUrl}/chat/completions with a Bearer key; 'anthropic' = Messages API. */
  api: 'openai' | 'anthropic';
  baseUrl: string;
  /** Where a person creates the key (shown in the app and the help page). */
  signup: string;
  /** Sends response_format {type:"json_object"} (only where the provider supports it). */
  jsonMode: boolean;
  extraHeaders?: Record<string, string>;
  /** Extra request fields this provider understands (e.g. turning reasoning down so answers are quick and short). */
  extraBody?: Record<string, unknown>;
  /** Accepts a screenshot with the text (OpenAI-style image_url data: URL, or an Anthropic image block). */
  vision: boolean;
}

export const PROVIDERS: Provider[] = [
  // ── Primary (tried first for every call; not capped by AI_PAID_DAILY_LIMIT) ──
  {
    id: 'anthropic', name: 'Anthropic Claude (primary)', tier: 'primary', keyEnv: 'ANTHROPIC_API_KEY', modelEnv: 'ANTHROPIC_MODEL', defaultModel: 'claude-sonnet-5-5',
    api: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', signup: 'https://console.anthropic.com/settings/keys', jsonMode: false, vision: true,
  },
  // ── Fallbacks, in this order. Free tiers checked against each provider's docs on 2026-10-21. ──
  {
    // Free tier: about 15 requests/min and ~500/day on Flash-Lite (Google shows exact numbers per project in AI Studio).
    // Note: Google may use free-tier prompts to improve its products.
    id: 'gemini', name: 'Google Gemini (free tier)', tier: 'free', keyEnv: 'GEMINI_API_KEY', modelEnv: 'GEMINI_MODEL', defaultModel: 'gemini-3.5-flash-lite',
    api: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', signup: 'https://aistudio.google.com/apikey', jsonMode: true, vision: true,
  },
  {
    // Pay per use; counted against AI_PAID_DAILY_LIMIT. GROK_API_KEY is accepted as well.
    id: 'xai', name: 'xAI Grok (paid)', tier: 'paid', keyEnv: 'XAI_API_KEY', keyAliases: ['GROK_API_KEY'], modelEnv: 'XAI_MODEL', defaultModel: 'grok-4.5',
    api: 'openai', baseUrl: 'https://api.x.ai/v1', signup: 'https://console.x.ai', jsonMode: true, vision: true,
  },
  {
    // Free plan: 30 requests/min, 1,000/day, 8K tokens/min. Does not keep prompts by default.
    id: 'groq', name: 'Groq (free tier)', tier: 'free', keyEnv: 'GROQ_API_KEY', modelEnv: 'GROQ_MODEL', defaultModel: 'openai/gpt-oss-120b',
    api: 'openai', baseUrl: 'https://api.groq.com/openai/v1', signup: 'https://console.groq.com/keys', jsonMode: true, vision: false,
    extraBody: { reasoning_effort: 'low' },
  },
  {
    // ":free" models: 20 requests/min, 50/day (1,000/day once 10 credits were ever bought). Only ":free" IDs are free.
    id: 'openrouter', name: 'OpenRouter (free models)', tier: 'free', keyEnv: 'OPENROUTER_API_KEY', modelEnv: 'OPENROUTER_MODEL', defaultModel: 'google/gemma-4-31b-it:free',
    api: 'openai', baseUrl: 'https://openrouter.ai/api/v1', signup: 'https://openrouter.ai/settings/keys', jsonMode: true, vision: false,
    extraHeaders: { 'HTTP-Referer': 'https://slshop.cloud', 'X-Title': 'SL QA' },
  },
  {
    // Free mode (no card): per-model limits and a monthly token cap shown in the Mistral console. Opt out of training in Admin → Privacy.
    id: 'mistral', name: 'Mistral (free mode)', tier: 'free', keyEnv: 'MISTRAL_API_KEY', modelEnv: 'MISTRAL_MODEL', defaultModel: 'mistral-small-latest',
    api: 'openai', baseUrl: 'https://api.mistral.ai/v1', signup: 'https://console.mistral.ai/api-keys', jsonMode: true, vision: false,
    extraBody: { reasoning_effort: 'none' },
  },
  // ── Paid (capped per day by AI_PAID_DAILY_LIMIT) ──
  {
    id: 'openai', name: 'OpenAI (paid)', tier: 'paid', keyEnv: 'OPENAI_API_KEY', modelEnv: 'OPENAI_MODEL', defaultModel: 'gpt-4.1-mini',
    api: 'openai', baseUrl: 'https://api.openai.com/v1', signup: 'https://platform.openai.com/api-keys', jsonMode: true, vision: true,
  },
  {
    // No lasting free tier: a one-time $5 trial (card required, expires after 30 days), then pay-as-you-go.
    id: 'cerebras', name: 'Cerebras (paid / trial credit)', tier: 'paid', keyEnv: 'CEREBRAS_API_KEY', modelEnv: 'CEREBRAS_MODEL', defaultModel: 'gpt-oss-120b',
    api: 'openai', baseUrl: 'https://api.cerebras.ai/v1', signup: 'https://cloud.cerebras.ai', jsonMode: true, vision: false,
  },
];

/** A key may hold several keys separated by commas (e.g. two free Gemini projects); each is tried in turn. */
const keysOf = (p: Provider) => [p.keyEnv, ...(p.keyAliases ?? [])].map((k) => process.env[k] ?? '').join(',').split(',').map((k) => k.trim()).filter(Boolean);
/** On OpenRouter only ":free" model IDs cost nothing; a paid ID there would quietly bill the account. */
const safeModel = (p: Provider, m: string) => (p.id === 'openrouter' && !/:free$|^openrouter\/free$/.test(m) ? p.defaultModel : m);
const modelOf = (p: Provider) => safeModel(p, process.env[p.modelEnv]?.trim() || p.defaultModel);
export const paidDailyLimit = () => Math.max(0, Number(process.env.AI_PAID_DAILY_LIMIT ?? 20));

/** True when a provider that reads screenshots has a key (and AI_VISION is not off). */
export const visionAvailable = () => !/^(off|0|false|no)$/i.test(process.env.AI_VISION ?? '') && PROVIDERS.some((p) => p.vision && keysOf(p).length);

/** True when the primary provider (Claude) has a key. */
export const primaryAvailable = () => PROVIDERS.some((p) => p.tier === 'primary' && keysOf(p).length);

export function configured(): { provider: Provider; keys: number; model: string }[] {
  return PROVIDERS.filter((p) => keysOf(p).length).map((p) => ({ provider: p, keys: keysOf(p).length, model: modelOf(p) }));
}

// ── Usage and cool-downs (data/ai-usage.json) ───────────────────────────

interface Usage {
  day: string;
  calls: Record<string, { ok: number; failed: number }>;
  paidCalls: number;
  /** Provider+key index → time (ms) until which it is skipped, with the reason. */
  coolDown: Record<string, { until: number; reason: string }>;
  lastError: Record<string, string>;
}

const FILE = () => path.join(config.dataDir, 'ai-usage.json');
const today = () => new Date().toISOString().slice(0, 10);

export function usage(): Usage {
  let u: Usage;
  try {
    u = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
  } catch {
    u = { day: today(), calls: {}, paidCalls: 0, coolDown: {}, lastError: {} };
  }
  if (u.day !== today()) u = { day: today(), calls: {}, paidCalls: 0, coolDown: u.coolDown ?? {}, lastError: u.lastError ?? {} };
  return u;
}

function saveUsage(u: Usage): void {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(FILE(), JSON.stringify(u, null, 1));
}

export class AiError extends Error {
  constructor(message: string, readonly kind: 'auth' | 'quota' | 'server' | 'bad-answer' | 'network' | 'none' | 'paid-limit') {
    super(message);
  }
}

/** How long to skip a provider after this kind of failure. */
const COOL_DOWN: Record<AiError['kind'], number> = {
  auth: 6 * 3600_000, // bad or revoked key: no point retrying soon
  quota: 15 * 60_000, // free quota used up: per-minute limits recover fast, daily ones are retried later
  server: 2 * 60_000,
  network: 60_000,
  'bad-answer': 0,
  none: 0,
  'paid-limit': 0,
};

export interface Attempt { provider: string; model: string; ok: boolean; error?: string }

/** Free tiers allow only a few requests per minute; keep at least this gap between calls to the same free provider. */
const FREE_GAP_MS = 4_000;
const lastCall = new Map<string, number>();
async function pace(p: Provider): Promise<void> {
  if (p.tier !== 'free') return;
  const wait = (lastCall.get(p.id) ?? 0) + FREE_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall.set(p.id, Date.now());
}

/** Narrows the chain for one call: `only` = just these provider ids, `exclude` = all but these (e.g. a fallback try without Claude). `maxTokens` = longer answers (default 700). */
export interface ChainOptions { only?: string[]; exclude?: string[]; maxTokens?: number }

/**
 * Sends one request through the chain in PROVIDERS order (paid fallbacks within the daily cap).
 * `parse` validates the answer; an answer that does not parse counts as a failure and the next provider is tried.
 */
export async function complete<T>(system: string, user: string, parse: (text: string) => T, image?: string, opts: ChainOptions = {}): Promise<{ value: T; provider: Provider; model: string; attempts: Attempt[] }> {
  const u = usage();
  const attempts: Attempt[] = [];
  const chain = PROVIDERS.filter((p) => (!opts.only || opts.only.includes(p.id)) && !opts.exclude?.includes(p.id));
  if (!configured().length) throw new AiError('No AI key is set. Add ANTHROPIC_API_KEY (or a free key such as GEMINI_API_KEY) to .env and restart.', 'none');
  if (!chain.some((p) => keysOf(p).length)) throw new AiError(`No AI key is set for ${opts.only ? opts.only.join(', ') : 'the fallback providers'}.`, 'none');

  for (const p of chain) {
    const keys = keysOf(p);
    for (const [i, key] of keys.entries()) {
      const slot = `${p.id}#${i}`;
      const cd = u.coolDown[slot];
      if (cd && cd.until > Date.now()) {
        attempts.push({ provider: p.name, model: modelOf(p), ok: false, error: `skipped (${cd.reason}, retry after ${new Date(cd.until).toLocaleTimeString()})` });
        continue;
      }
      if (p.tier === 'paid' && u.paidCalls >= paidDailyLimit()) {
        attempts.push({ provider: p.name, model: modelOf(p), ok: false, error: `paid daily limit reached (${paidDailyLimit()} calls); free providers will be tried again tomorrow or after their cool-down` });
        continue;
      }
      const model = modelOf(p);
      try {
        if (p.tier === 'paid') u.paidCalls++;
        await pace(p);
        // A screenshot (base64 JPEG) goes only to providers that read images; the others get the text alone.
        const img = p.vision ? image : undefined;
        const said = img ? `${user}\n(A screenshot of the page as it is now is attached.)` : user;
        const text = p.api === 'anthropic' ? await callAnthropic(p, key, model, system, said, img, opts.maxTokens) : await callOpenAICompatible(p, key, model, system, said, img, opts.maxTokens);
        let value: T;
        try {
          value = parse(text);
        } catch {
          throw new AiError(`answer was not the expected JSON: ${text.slice(0, 100)}`, 'bad-answer');
        }
        (u.calls[p.id] ??= { ok: 0, failed: 0 }).ok++;
        delete u.coolDown[slot];
        attempts.push({ provider: p.name, model, ok: true });
        saveUsage(u);
        return { value, provider: p, model, attempts };
      } catch (e) {
        const err = e instanceof AiError ? e : new AiError((e as Error).message, 'network');
        (u.calls[p.id] ??= { ok: 0, failed: 0 }).failed++;
        u.lastError[p.id] = `${new Date().toISOString()} ${err.message.slice(0, 200)}`;
        if (COOL_DOWN[err.kind]) u.coolDown[slot] = { until: Date.now() + COOL_DOWN[err.kind], reason: err.kind === 'auth' ? 'key rejected' : err.kind === 'quota' ? 'free quota used up' : err.kind };
        attempts.push({ provider: p.name, model, ok: false, error: err.message.slice(0, 160) });
        saveUsage(u);
      }
    }
  }
  saveUsage(u);
  const summary = attempts.map((a) => `${a.provider}: ${a.error}`).join(' · ');
  throw new AiError(`Every AI provider failed. ${summary}`, 'none');
}

function classify(status: number, message: string): AiError['kind'] {
  if (/api.?key|unauthori[sz]ed|authentication|permission/i.test(message) && status < 500 && status !== 429) return 'auth';
  if (status === 401 || status === 403) return /quota|limit|exceed/i.test(message) ? 'quota' : 'auth';
  // 402: free monthly usage used up (Mistral) or no credit left.
  if (status === 429 || status === 402 || /quota|rate.?limit|exhausted|insufficient|credit|billing/i.test(message)) return 'quota';
  // A model this key cannot use (retired, enterprise-only, typo): treat like a bad key for this provider.
  if (status === 404 || status === 400) return /model/i.test(message) ? 'auth' : 'server';
  return 'server';
}

/** Free tiers sometimes queue a request for minutes; give up quickly and use the next provider instead. */
const TIMEOUT_MS = { primary: 45_000, free: 20_000, paid: 45_000 };
/** Long answers (chat) take longer to write: double the wait for them. */
const timeoutFor = (p: Provider, maxTokens: number) => TIMEOUT_MS[p.tier] * (maxTokens > 700 ? 2 : 1);

async function post(url: string, headers: Record<string, string>, body: unknown, timeoutMs = TIMEOUT_MS.paid): Promise<{ status: number; json: any }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctl.signal });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  } catch (e) {
    const slow = (e as Error).name === 'AbortError';
    throw new AiError(slow ? `no answer within ${Math.round(timeoutMs / 1000)}s (busy)` : `network error: ${(e as Error).message}`, slow ? 'server' : 'network');
  } finally {
    clearTimeout(timer);
  }
}

async function callOpenAICompatible(p: Provider, key: string, model: string, system: string, user: string, image?: string, maxTokens = 700): Promise<string> {
  const content = image ? [{ type: 'text', text: user }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image}` } }] : user;
  const body: Record<string, unknown> = { model, temperature: 0, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content }] };
  if (p.jsonMode) body.response_format = { type: 'json_object' };
  Object.assign(body, p.extraBody ?? {});
  const { status, json } = await post(`${p.baseUrl}/chat/completions`, { authorization: `Bearer ${key}`, ...(p.extraHeaders ?? {}) }, body, timeoutFor(p, maxTokens));
  const err = Array.isArray(json) ? json[0]?.error : json?.error;
  const msg = String(err?.message ?? json?.message ?? '');
  if (status >= 300) throw new AiError(`${p.name} ${status}: ${msg || 'request failed'}`, classify(status, msg));
  const text = json?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) throw new AiError(`${p.name}: empty answer`, 'bad-answer');
  return text;
}

async function callAnthropic(p: Provider, key: string, model: string, system: string, user: string, image?: string, maxTokens = 700): Promise<string> {
  const content = image ? [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } }, { type: 'text', text: user }] : user;
  const { status, json } = await post(`${p.baseUrl}/messages`, { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, { model, max_tokens: maxTokens, temperature: 0, system, messages: [{ role: 'user', content }] }, timeoutFor(p, maxTokens));
  const msg = String(json?.error?.message ?? '');
  if (status >= 300) throw new AiError(`${p.name} ${status}: ${msg || 'request failed'}`, classify(status, msg));
  const text = (json?.content ?? []).filter((c: { type: string }) => c.type === 'text').map((c: { text: string }) => c.text).join('');
  if (!text.trim()) throw new AiError(`${p.name}: empty answer`, 'bad-answer');
  return text;
}


/** Per-provider status for the AI keys page: set or not, model, today's calls, cool-down, last error. */
export function status(): { provider: Provider; set: boolean; keys: number; model: string; ok: number; failed: number; coolingUntil?: string; coolReason?: string; lastError?: string }[] {
  const u = usage();
  return PROVIDERS.map((p) => {
    const keys = keysOf(p).length;
    const cds = Object.entries(u.coolDown).filter(([k, v]) => k.startsWith(`${p.id}#`) && v.until > Date.now());
    const cd = cds.sort((a, b) => b[1].until - a[1].until)[0]?.[1];
    return {
      provider: p, set: keys > 0, keys, model: modelOf(p), ok: u.calls[p.id]?.ok ?? 0, failed: u.calls[p.id]?.failed ?? 0,
      coolingUntil: cd ? new Date(cd.until).toLocaleTimeString() : undefined, coolReason: cd?.reason, lastError: u.lastError[p.id],
    };
  });
}

/** Clears cool-downs (after fixing a key, so it is tried again straight away). */
export function resetCoolDowns(): void {
  const u = usage();
  u.coolDown = {};
  saveUsage(u);
}
