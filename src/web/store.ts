import fs from 'fs';
import path from 'path';
import { config } from '../engine/config.js';
import type { CaseResult } from '../engine/context.js';
import type { TestCase } from '../engine/sources/cases.js';

/**
 * File-based storage for the MVP: one JSON file per suite and per run under data/.
 * Run artifacts (screenshots, downloads, report.md) live in runs/<run id>/.
 */

export interface Suite {
  id: string;
  name: string;
  /** 'site': one read-only case per crawled dashboard page, rebuilt from site-map.json (see apps/slshop/crawl.ts). */
  source: { kind: 'sheet'; url: string } | { kind: 'upload'; file: string } | { kind: 'manual' } | { kind: 'site' };
  pagePath: string;
  cases: TestCase[];
  /** IDs of sheet rows deleted in the app; re-reading the sheet leaves them out. */
  removed?: string[];
  syncedAt: string;
  createdAt: string;
}

/** One message in an Assistant chat. `cases` = test cases the AI proposed; `files` = repo files it was given. */
export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  at: string;
  cases?: TestCase[];
  files?: string[];
  /** Repo the answer used ("owner/repo@branch"), or the reason it could not be read. */
  repo?: string;
  repoError?: string;
  model?: string;
  error?: boolean;
  /** Made by Super QA (cases corrected against the real page); `checked` = what it looked at. */
  superQa?: boolean;
  checked?: string[];
}

export interface Chat {
  id: string;
  title: string;
  /** GitHub URL given as code context (kept for the next question). */
  repoUrl?: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
}

export type RunStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface Run {
  id: string;
  suiteId: string;
  suiteName: string;
  caseIds: string[];
  status: RunStatus;
  current?: { caseId: string; step: string };
  results: CaseResult[];
  error?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

const dir = (kind: string) => {
  const d = path.join(config.dataDir, kind);
  fs.mkdirSync(d, { recursive: true });
  return d;
};

function readAll<T>(kind: string): T[] {
  return fs
    .readdirSync(dir(kind))
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir(kind), f), 'utf8')) as T);
}

function write(kind: string, id: string, value: unknown): void {
  const file = path.join(dir(kind), `${id}.json`);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 1));
  fs.renameSync(`${file}.tmp`, file);
}

function read<T>(kind: string, id: string): T | undefined {
  if (!/^[\w-]+$/.test(id)) return undefined;
  const file = path.join(dir(kind), `${id}.json`);
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as T) : undefined;
}

export const newId = () => new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14) + Math.random().toString(36).slice(2, 6);

export const suites = {
  all: () => readAll<Suite>('suites').sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  get: (id: string) => read<Suite>('suites', id),
  save: (s: Suite) => write('suites', s.id, s),
  remove: (id: string) => fs.rmSync(path.join(dir('suites'), `${id}.json`), { force: true }),
};

export const runs = {
  all: () => readAll<Run>('runs').sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  get: (id: string) => read<Run>('runs', id),
  save: (r: Run) => write('runs', r.id, r),
  remove: (id: string) => {
    fs.rmSync(path.join(dir('runs'), `${id}.json`), { force: true });
    if (/^[\w-]+$/.test(id)) fs.rmSync(path.join(config.runsDir, id), { recursive: true, force: true });
  },
  forSuite: (suiteId: string) => runs.all().filter((r) => r.suiteId === suiteId),
};

export const chats = {
  all: () => readAll<Chat>('chats').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  get: (id: string) => read<Chat>('chats', id),
  save: (c: Chat) => write('chats', c.id, c),
  remove: (id: string) => {
    if (/^[\w-]+$/.test(id)) fs.rmSync(path.join(dir('chats'), `${id}.json`), { force: true });
  },
};

export const uploadsDir = () => dir('uploads');
