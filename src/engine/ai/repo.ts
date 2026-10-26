import fs from 'fs';
import path from 'path';
import { config } from '../config.js';

/**
 * Code context for the Assistant: reads a GitHub repo through the public REST API and picks the source files most
 * likely to answer a question (routes, pages, components, controllers, API, validation, tests).
 * Only github.com URLs are accepted, and requests only go to api.github.com and raw.githubusercontent.com.
 * GITHUB_TOKEN (optional) reads private repos and raises the rate limit. The file list and the files read are
 * cached per repo and branch in data/repos/ for an hour.
 */

export interface RepoRef { owner: string; repo: string; branch?: string; dir?: string }

export interface RepoContext {
  /** "owner/repo@branch" */
  label: string;
  /** Path and text of each file given to the AI. */
  files: { path: string; text: string; truncated: boolean }[];
}

export class RepoError extends Error {}

const NAME = /^[A-Za-z0-9_.-]{1,100}$/;

/** "https://github.com/owner/repo[/tree/<branch>/<path>]" → its parts, or a RepoError saying what is wrong. */
export function parseRepoUrl(input: string): RepoRef {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    throw new RepoError('That is not a link. Paste a GitHub address such as https://github.com/owner/repo.');
  }
  if (u.protocol !== 'https:' || !/^(www\.)?github\.com$/i.test(u.hostname) || u.port || u.username || u.password) {
    throw new RepoError('Only https://github.com/… links can be used as code context.');
  }
  const parts = u.pathname.split('/').filter(Boolean).map((x) => decodeURIComponent(x));
  const [owner, rawRepo, kind, branch, ...rest] = parts;
  const repo = rawRepo?.replace(/\.git$/, '');
  if (!owner || !repo || !NAME.test(owner) || !NAME.test(repo) || owner.startsWith('.') || repo.startsWith('.')) {
    throw new RepoError('The link should look like https://github.com/owner/repo (optionally /tree/<branch>/<folder>).');
  }
  if (kind && kind !== 'tree' && kind !== 'blob') throw new RepoError('Link to the repo itself, or to a branch or folder (…/tree/<branch>/<folder>).');
  if (kind && (!branch || !/^[\w./-]{1,200}$/.test(branch) || branch.includes('..'))) throw new RepoError('The branch name in the link is not valid.');
  const dir = rest.join('/');
  if (dir.includes('..')) throw new RepoError('The folder in the link is not valid.');
  return { owner, repo, branch: kind ? branch : undefined, dir: dir || undefined };
}

const headers = (raw = false): Record<string, string> => {
  const h: Record<string, string> = { 'user-agent': 'sl-qa-assistant', accept: raw ? '*/*' : 'application/vnd.github+json' };
  const token = process.env.GITHUB_TOKEN?.trim();
  if (token) h.authorization = `Bearer ${token}`;
  return h;
};

async function get(url: string, raw = false): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20_000);
  try {
    // redirect: 'error' keeps every request on the two GitHub hosts named above.
    return await fetch(url, { headers: headers(raw), signal: ctl.signal, redirect: 'error' });
  } catch (e) {
    throw new RepoError((e as Error).name === 'AbortError' ? 'GitHub did not answer within 20 seconds. Try again.' : `Could not reach GitHub: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

async function api<T>(apiPath: string, what: string): Promise<T> {
  const res = await get(`https://api.github.com${apiPath}`);
  if (res.ok) return (await res.json()) as T;
  const remaining = res.headers.get('x-ratelimit-remaining');
  if ((res.status === 403 || res.status === 429) && (remaining === '0' || res.status === 429)) {
    const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
    const at = reset ? ` It resets at ${new Date(reset).toLocaleTimeString('en-GB', { timeStyle: 'short' })}.` : '';
    throw new RepoError(`GitHub's rate limit was reached.${at}${process.env.GITHUB_TOKEN ? '' : ' Set GITHUB_TOKEN in .env for a higher limit.'}`);
  }
  if (res.status === 401) throw new RepoError('GitHub rejected GITHUB_TOKEN. Check the token in .env.');
  if (res.status === 404 || res.status === 403) {
    throw new RepoError(`${what} was not found on GitHub.${process.env.GITHUB_TOKEN ? ' Check the link, and that GITHUB_TOKEN can read it.' : ' Check the link; a private repo needs GITHUB_TOKEN in .env.'}`);
  }
  throw new RepoError(`GitHub answered ${res.status} for ${what}.`);
}

// ── File choice ────────────────────────────────────────────────────────

const MAX_FILE_BYTES = 60_000;
const MAX_TOTAL_CHARS = 40_000;
const MAX_FILE_CHARS = 12_000;
const MAX_FILES = 14;

const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte|py|php|rb|go|java|kt|cs|rs|dart|swift|html|graphql|gql|prisma|sql|md)$/i;
const SKIP_DIR = /(^|\/)(node_modules|dist|build|out|coverage|vendor|\.next|\.nuxt|\.git|\.github|public|static|assets|images|img|fonts|icons|locales?|i18n|migrations|__snapshots__|storybook-static|generated)(\/|$)/i;
const SKIP_FILE = /(^|\/)(\.env[^/]*|.*\.(min|map|lock|d)\.\w+|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|.*\.(pem|key|p12|crt|svg|png|jpe?g|gif|webp|ico|woff2?|ttf|mp4|pdf|zip))$/i;
/** Kinds of file that say what a page does and what it accepts, with a weight each. */
const KINDS: [RegExp, number][] = [
  [/(^|\/)(routes?|router|pages?|app|views?|screens?)(\/|\.|$)/i, 4],
  [/(controller|handler|api|service|endpoint|resolver)s?(\/|\.|$)/i, 3],
  [/(valid|schema|rules?|dto|request|form)s?(\/|\.|$)/i, 3],
  [/(components?|features?|modules?)(\/|$)/i, 2],
  [/(\.|\/)(test|spec|e2e|cy)(\.|\/)/i, 2],
  [/(model|entity|types?)s?(\/|\.|$)/i, 1],
];
const STOP = new Set('the and for with that this what when where which how does are can you from into page test tests case cases generate write make give show about should would there their them they have has not but all any some other more most also just like than then use using used'.split(' '));

const keywords = (question: string) => [...new Set(question.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? [])].filter((w) => !STOP.has(w)).slice(0, 20);

interface TreeEntry { path: string; type: string; size?: number }

function score(file: string, words: string[]): number {
  const lower = file.toLowerCase();
  let s = KINDS.reduce((n, [re, w]) => n + (re.test(file) ? w : 0), 0);
  for (const w of words) if (lower.includes(w) || (w.endsWith('s') && lower.includes(w.slice(0, -1)))) s += 6;
  // Short, shallow paths are usually the entry points.
  return s - file.split('/').length * 0.3;
}

// ── Cache (data/repos/<owner>__<repo>__<branch>.json) ───────────────────

interface Cache { at: number; branch: string; tree: TreeEntry[]; truncated: boolean; files: Record<string, string> }
const TTL = 3600_000;
const cacheFile = (r: RepoRef, branch: string) => {
  const d = path.join(config.dataDir, 'repos');
  fs.mkdirSync(d, { recursive: true });
  return path.join(d, `${r.owner}__${r.repo}__${branch}`.replace(/[^\w.-]+/g, '_') + '.json');
};
function readCache(file: string): Cache | undefined {
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8')) as Cache;
    return Date.now() - c.at < TTL ? c : undefined;
  } catch {
    return undefined;
  }
}

/** Reads the repo (or the cached copy) and returns the files most relevant to the question, within ~40k characters. */
export async function repoContext(url: string, question: string): Promise<RepoContext> {
  const ref = parseRepoUrl(url);
  const base = `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`;
  const branch = ref.branch ?? (await api<{ default_branch: string }>(base, `The repo ${ref.owner}/${ref.repo}`)).default_branch;
  const file = cacheFile(ref, branch);
  let cache = readCache(file);
  if (!cache) {
    const tree = await api<{ tree: TreeEntry[]; truncated: boolean }>(`${base}/git/trees/${encodeURIComponent(branch)}?recursive=1`, `Branch "${branch}" of ${ref.owner}/${ref.repo}`);
    cache = { at: Date.now(), branch, tree: tree.tree.filter((e) => e.type === 'blob').map(({ path, type, size }) => ({ path, type, size })), truncated: tree.truncated, files: {} };
  }

  const words = keywords(question);
  const inDir = (p: string) => !ref.dir || p === ref.dir || p.startsWith(`${ref.dir.replace(/\/$/, '')}/`);
  const candidates = cache.tree
    .filter((e) => inDir(e.path) && CODE.test(e.path) && !SKIP_DIR.test(e.path) && !SKIP_FILE.test(e.path) && (e.size ?? 0) <= MAX_FILE_BYTES)
    // A README is only useful when the question is about the project in general.
    .filter((e) => !/\.md$/i.test(e.path) || /(^|\/)readme\.md$/i.test(e.path))
    .map((e) => ({ path: e.path, s: score(e.path, words) }))
    .sort((a, b) => b.s - a.s || a.path.localeCompare(b.path));
  if (!candidates.length) throw new RepoError(`No source files were found in ${ref.owner}/${ref.repo}${ref.dir ? `/${ref.dir}` : ''} on branch "${branch}".`);

  const picked = candidates.slice(0, MAX_FILES * 2);
  const missing = picked.filter((c) => cache!.files[c.path] === undefined);
  await Promise.all(missing.map(async (c) => {
    const res = await get(`https://raw.githubusercontent.com/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/${encodeURIComponent(branch)}/${c.path.split('/').map(encodeURIComponent).join('/')}`, true);
    cache!.files[c.path] = res.ok ? await res.text() : '';
  }));
  fs.writeFileSync(file, JSON.stringify(cache));

  const files: RepoContext['files'] = [];
  let total = 0;
  for (const c of picked) {
    const text = cache.files[c.path];
    if (!text || files.length >= MAX_FILES || total >= MAX_TOTAL_CHARS) continue;
    const room = Math.min(MAX_FILE_CHARS, MAX_TOTAL_CHARS - total);
    if (room < 800) break;
    files.push({ path: c.path, text: text.slice(0, room), truncated: text.length > room });
    total += Math.min(text.length, room);
  }
  if (!files.length) throw new RepoError(`The files of ${ref.owner}/${ref.repo} could not be read.`);
  return { label: `${ref.owner}/${ref.repo}@${branch}${ref.dir ? `/${ref.dir}` : ''}`, files };
}
