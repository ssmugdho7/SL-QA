import type http from 'http';
import { Marked, type Tokens } from 'marked';
import { answer, casesCsv, MAX_MESSAGE } from '../engine/ai/chat.js';
import { parseRepoUrl, RepoError } from '../engine/ai/repo.js';
import { configured } from '../engine/ai/providers.js';
import { superQa, superQaMissing } from '../engine/ai/superqa.js';
import { chats, newId, suites, type Chat, type ChatMessage } from './store.js';
import { esc, layout, notFound } from './views.js';
import { knownPages } from '../engine/pages.js';
import type { TestCase } from '../engine/sources/cases.js';

/**
 * The Assistant pages: /chat (new chat + recent chats), /chat/<id> (one conversation), and the actions on a
 * proposed set of test cases (save as a suite, download CSV, Super QA). Plain forms; a small script adds Enter-to-send.
 */

/** Only one Super QA at a time (each one opens a browser and takes up to a minute and a half). */
let superQaBusy = false;

// ── Markdown from the AI: no raw HTML, only http(s), mailto and relative links ──

const md = new Marked({
  async: false,
  gfm: true,
  renderer: {
    html: (t: Tokens.HTML | Tokens.Tag) => esc(t.text),
    image: (t: Tokens.Image) => esc(t.text || t.href),
  },
  walkTokens: (t) => {
    if (t.type === 'link' && !/^(https?:|mailto:|\/(?!\/)|#)/i.test((t as Tokens.Link).href.trim())) (t as Tokens.Link).href = '#';
  },
});
export const renderMarkdown = (text: string) => md.parse(text) as string;

const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

// ── Views ──────────────────────────────────────────────────────────────

function casesTable(chat: Chat, i: number, m: ChatMessage): string {
  const cases = m.cases ?? [];
  const base = `/chat/${chat.id}/cases/${i}`;
  const rows = cases.map((c, k) => `<tr>
    <td class="nowrap"><b>${esc(c.id)}</b>${c.edited ? ' <span class="tag-edited">edited</span>' : ''}<div class="row-actions"><a href="${base}/${k}/edit">Edit</a>
      <form method="post" action="${base}/${k}/delete" class="inline" onsubmit="return confirm('Delete case ${esc(c.id)}?')"><button class="link danger" aria-label="Delete case ${esc(c.id)}">Delete</button></form></div></td><td><code>${esc(c.url)}</code></td><td>${esc(c.title)}</td><td>${esc(c.priority)}</td><td>${esc(c.preconditions)}</td>
    <td><ol class="cells">${c.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol></td><td>${esc(c.testData)}</td>
    <td><ul class="cells">${c.expected.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></td></tr>`).join('');
  const name = `Assistant: ${chat.title}`.slice(0, 120);
  return `<div class="chat-cases" id="cases-${i}">
    <div class="table-wrap"><table><thead><tr><th>TC ID</th><th>URL</th><th>Test Case</th><th>Priority</th><th>Preconditions</th><th>Test Steps</th><th>Test Data</th><th>Expected Result</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="toolbar"><a class="button" href="${base}/new/edit">＋ Add case</a></div>
    <form method="post" action="/chat/${chat.id}/cases/${i}/save" class="toolbar">
      <label class="inline-label">Suite name <input name="name" value="${esc(name)}" maxlength="120" required></label>
      <button class="primary">Save as new suite</button>
      <a class="button" href="/chat/${chat.id}/cases/${i}.csv" download>⬇ Download CSV</a>
    </form>
    <form method="post" action="/chat/${chat.id}/cases/${i}/superqa" class="toolbar superqa-form" onsubmit="const b=this.querySelector('button');b.disabled=true;this.querySelector('.sub').hidden=false">
      <button title="Opens the cases' pages in a logged-in browser and asks a stronger model to correct the cases">🔎 Use Super QA</button>
      <span class="sub" hidden><i class="spin dark"></i> Super QA is checking the real page… (30–90 s)</span>
    </form>
  </div>`;
}

function delMsg(chat: Chat, i: number, pair: boolean): string {
  return `<form method="post" action="/chat/${chat.id}/messages/${i}/delete" class="inline" onsubmit="return confirm('${pair ? 'Delete this message and the reply to it?' : 'Delete this message?'}')"><button class="link danger" aria-label="Delete message">Delete</button></form>`;
}

function message(chat: Chat, m: ChatMessage, i: number): string {
  if (m.role === 'user') return `<div class="msg user"><div class="bubble">${esc(m.text).replace(/\n/g, '<br>')}</div><div class="sub">${when(m.at)}${m.repo ? ` · code: ${esc(m.repo)}` : ''} · ${delMsg(chat, i, chat.messages[i + 1]?.role === 'assistant')}</div></div>`;
  const files = m.files?.length
    ? `<details class="files"><summary>${m.files.length} file${m.files.length === 1 ? '' : 's'} used from ${esc(m.repo ?? 'the repo')}</summary><ul>${m.files.map((f) => `<li><code>${esc(f)}</code></li>`).join('')}</ul></details>`
    : '';
  const checked = m.checked?.length
    ? `<details class="files"${m.superQa ? ' open' : ''}><summary>What Super QA checked</summary><ul>${m.checked.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></details>`
    : '';
  return `<div class="msg assistant${m.error ? ' error' : ''}">
    ${m.superQa ? '<span class="badge-superqa">Super QA</span>' : ''}
    ${m.repoError ? `<div class="alert" role="alert">Code context not used: ${esc(m.repoError)}</div>` : ''}
    <div class="bubble report">${renderMarkdown(m.text)}</div>
    ${m.cases?.length ? casesTable(chat, i, m) : ''}
    ${files}${checked}
    <div class="sub">${when(m.at)}${m.model ? ` · ${esc(m.model)}` : ''} · ${delMsg(chat, i, false)}</div>
  </div>`;
}

function askForm(action: string, repoUrl = '', text = ''): string {
  return `<form method="post" action="${action}" class="chat-form stack" id="ask">
    <label>Message <textarea name="message" rows="3" maxlength="${MAX_MESSAGE}" required placeholder="Ask about a dashboard page, or: generate test cases for the POS page">${esc(text)}</textarea>
      <span class="hint">Enter sends, Shift+Enter for a new line. Up to ${MAX_MESSAGE} characters.</span></label>
    <details${repoUrl ? ' open' : ''}><summary>Code context (optional)</summary>
      <label>GitHub repo <input name="repo" value="${esc(repoUrl)}" placeholder="https://github.com/owner/repo or …/tree/branch/folder" inputmode="url">
      <span class="hint">The Assistant reads the most relevant source files (routes, pages, components, validation, tests). A private repo needs GITHUB_TOKEN in .env.</span></label>
    </details>
    <div><button class="primary" id="send">Send</button> <span class="sub" id="thinking" hidden><i class="spin dark"></i> Thinking… (up to a minute with code context)</span></div>
  </form>
  <script>
    (function () {
      const form = document.getElementById('ask');
      const box = form.querySelector('textarea');
      box.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (box.value.trim()) form.requestSubmit(); } });
      form.addEventListener('submit', () => { document.getElementById('send').disabled = true; document.getElementById('thinking').hidden = false; });
      const log = document.getElementById('log');
      if (log) window.scrollTo(0, document.body.scrollHeight);
      box.focus();
    })();
  </script>`;
}

function recentList(all: Chat[], current?: string): string {
  if (!all.length) return '<p class="sub">No chats yet.</p>';
  return `<ul class="chat-list">${all.slice(0, 30).map((c) => `<li${c.id === current ? ' aria-current="true"' : ''}>
    <a href="/chat/${c.id}">${esc(c.title)}</a><span class="sub"> · ${when(c.updatedAt)}</span>
    <form method="post" action="/chat/${c.id}/delete" class="inline" onsubmit="return confirm('Delete this chat?')"><button class="link" aria-label="Delete chat ${esc(c.title)}">Delete</button></form></li>`).join('')}</ul>`;
}

const noKey = () => (configured().length ? '' : '<div class="alert info" role="status">No AI key is set yet. Add one on <a href="/settings/ai">AI keys</a> (a free Gemini key is enough), then restart SL QA.</div>');

export function chatPage(all: Chat[], chat?: Chat, error?: string, typed?: { text: string; repo: string }): string {
  const body = chat
    ? `<div id="log" class="chat-log">${chat.messages.map((m, i) => message(chat, m, i)).join('')}</div>`
    : `<div class="empty"><b>Ask anything about the slshop.cloud dashboard.</b><br>For example: <i>What can I do on the Inventory page?</i> · <i>Generate test cases for the POS page</i> · <i>Which fields does Add Product validate?</i> (with the app's repo as code context)</div>`;
  return layout(
    chat ? chat.title : 'Assistant',
    `<div class="page-head"><div><h1>${chat ? esc(chat.title) : 'Assistant'}</h1><p class="sub">Answers from the crawled site map, your suites and (optionally) the app's code. It says when it doesn't know.</p></div>
      ${chat ? `<div class="toolbar"><a class="button" href="/chat">＋ New chat</a></div>` : ''}</div>
    ${chat ? `<form method="post" action="/chat/${chat.id}/rename" class="toolbar"><label class="inline-label">Rename <input name="title" value="${esc(chat.title)}" maxlength="120" required></label><button>Rename</button></form>` : ''}
    ${noKey()}
    <div class="chat-grid">
      <div>
        ${body}
        ${error ? `<div class="alert" role="alert">${esc(error)}</div>` : ''}
        <section class="card">${askForm(chat ? `/chat/${chat.id}` : '/chat', typed?.repo ?? chat?.repoUrl, typed?.text)}</section>
      </div>
      <aside class="card"><h2>Recent chats</h2>${recentList(all, chat?.id)}</aside>
    </div>
    <style>
      .chat-grid { display:grid; grid-template-columns:minmax(0,1fr) 260px; gap:20px; align-items:start; } .chat-grid aside { margin-top:0; position:sticky; top:70px; }
      @media (max-width:900px) { .chat-grid { grid-template-columns:1fr; } .chat-grid aside { position:static; } }
      .chat-log { display:grid; gap:14px; }
      .msg .bubble { border:1px solid var(--line); border-radius:8px; padding:10px 14px; background:var(--card); overflow-wrap:anywhere; }
      .msg.user { justify-self:end; max-width:80%; text-align:right; } .msg.user .bubble { text-align:left; background:color-mix(in srgb, var(--brand) 8%, var(--card)); }
      .msg.assistant .bubble.report { padding:4px 16px; } .msg.error .bubble { border-color:color-mix(in srgb, var(--fail) 40%, var(--line)); }
      .msg .sub { margin-top:3px; } .chat-cases { margin-top:10px; } .chat-cases td { font-size:12.5px; } ol.cells, ul.cells { margin:0; padding-left:16px; }
      .chat-list { list-style:none; padding:0; margin:0; display:grid; gap:6px; } .chat-list li[aria-current] a { font-weight:600; } .chat-list form { display:inline; }
      .tag-edited { font-size:11px; color:var(--muted); border:1px solid var(--line); border-radius:4px; padding:0 4px; } .row-actions { display:flex; gap:8px; font-size:12px; margin-top:4px; } .row-actions form { display:inline; }
      .files ul { margin:4px 0; font-size:12.5px; } .spin.dark { border-color:var(--muted); border-right-color:transparent; vertical-align:middle; }
      .badge-superqa { display:inline-block; font-size:11px; font-weight:600; color:var(--brand); border:1px solid var(--brand); border-radius:4px; padding:0 6px; margin-bottom:4px; }
    </style>`,
    { section: 'chat' },
  );
}

export function caseEditPage(chat: Chat, n: number, k: number | null, c: Partial<TestCase>, error?: string): string {
  const v = (x?: string) => esc(x ?? '');
  const options = knownPages().map((pg) => `<option value="${esc(pg.path)}">${esc(pg.title || pg.label)}</option>`).join('');
  return layout(
    k === null ? 'Add case' : 'Edit case',
    `<div class="page-head"><div><h1>${k === null ? 'Add a case' : `Edit ${v(c.id)}`}</h1><p class="sub">Part of "${esc(chat.title)}". One step or expected result per line.</p></div></div>
    ${error ? `<div class="alert" role="alert">${esc(error)}</div>` : ''}
    <form method="post" action="/chat/${chat.id}/cases/${n}/${k ?? 'new'}/edit" class="card stack">
      <label>TC ID <input name="id" value="${v(c.id)}" maxlength="30" required></label>
      <label>URL <input name="url" value="${v(c.url)}" list="pages" maxlength="300" placeholder="/dashboard/products"><datalist id="pages">${options}</datalist></label>
      <label>Test Case <input name="title" value="${v(c.title)}" maxlength="200" required></label>
      <label>Priority <select name="priority">${['High', 'Medium', 'Low'].map((o) => `<option${o === c.priority ? ' selected' : ''}>${o}</option>`).join('')}</select></label>
      <label>Preconditions <textarea name="preconditions" rows="2" maxlength="1000">${v(c.preconditions)}</textarea></label>
      <label>Test Steps <textarea name="steps" rows="6" maxlength="4000">${v(c.steps?.join('\n'))}</textarea></label>
      <label>Test Data <textarea name="testData" rows="2" maxlength="1000">${v(c.testData)}</textarea></label>
      <label>Expected Result <textarea name="expected" rows="5" maxlength="4000">${v(c.expected?.join('\n'))}</textarea></label>
      <div><button class="primary">Save</button> <a class="button" href="/chat/${chat.id}#cases-${n}">Cancel</a></div>
    </form>`,
    { section: 'chat' },
  );
}

const lines = (s: string) => s.split(/\r?\n/).map((x) => x.replace(/^\s*(\d+[.)]|[•\-*])\s*/, '').trim()).filter(Boolean);

/** Reads the edit form into a case, or returns the reason it is invalid. */
function caseFromForm(f: Form, base: Partial<TestCase>): TestCase | string {
  const id = field(f, 'id').replace(/\s+/g, '-').replace(/[^\w.-]/g, '').slice(0, 30);
  const url = field(f, 'url');
  const title = field(f, 'title');
  const steps = lines(field(f, 'steps'));
  const expected = lines(field(f, 'expected'));
  const priority = ['High', 'Medium', 'Low'].includes(field(f, 'priority')) ? field(f, 'priority') : 'Medium';
  if (!id) return 'TC ID is required.';
  if (!title) return 'Test Case title is required.';
  if (url && !/^\/dashboard(?:[/?#][^\s'"<>]*)?$/.test(url)) return 'URL must be empty or start with /dashboard (for example /dashboard/products).';
  if (!steps.length && !expected.length) return 'Add at least one test step or expected result.';
  if (steps.length > 40 || expected.length > 40) return 'At most 40 steps and 40 expected results.';
  if ([...steps, ...expected].some((x) => x.length > 500)) return 'Each step or expected result can be at most 500 characters.';
  return { scenario: '', type: 'Test', automation: '', ...base, id, url, title, priority, preconditions: field(f, 'preconditions').slice(0, 1000), steps, testData: field(f, 'testData').slice(0, 1000), expected, edited: true, manual: true };
}

// ── Routes ─────────────────────────────────────────────────────────────

type Form = { fields: Record<string, string[]> };
type Ctx = { send: (status: number, html: string) => void; redirect: (to: string) => void; form: () => Promise<Form> };

const field = (f: Form, k: string) => (f.fields[k]?.[0] ?? '').trim();

/** Handles /chat routes; returns false when the path is not one of them. */
export async function handleChat(req: http.IncomingMessage, res: http.ServerResponse, p: string, ctx: Ctx): Promise<boolean> {
  const post = req.method === 'POST';
  let m: RegExpMatchArray | null;

  if (p === '/chat' && !post) return ctx.send(200, chatPage(chats.all())), true;

  if ((m = p.match(/^\/chat\/([\w-]+)$/)) && !post) {
    const chat = chats.get(m[1]);
    ctx.send(chat ? 200 : 404, chat ? chatPage(chats.all(), chat) : notFound('chat'));
    return true;
  }

  if ((m = p.match(/^\/chat(?:\/([\w-]+))?$/)) && post) {
    const existing = m[1] ? chats.get(m[1]) : undefined;
    if (m[1] && !existing) return ctx.send(404, notFound('chat')), true;
    const form = await ctx.form();
    const text = field(form, 'message').replace(/\r\n/g, '\n');
    const repo = field(form, 'repo');
    const again = (status: number, error: string) => ctx.send(status, chatPage(chats.all(), existing, error, { text, repo }));
    if (!text) return again(422, 'Type a message first.'), true;
    if (text.length > MAX_MESSAGE) return again(422, `The message is ${text.length} characters; the limit is ${MAX_MESSAGE}.`), true;
    if (repo) {
      try {
        parseRepoUrl(repo);
      } catch (e) {
        if (e instanceof RepoError) return again(422, e.message), true;
        throw e;
      }
    }
    const now = new Date().toISOString();
    const chat: Chat = existing ?? { id: newId(), title: text.split('\n')[0].slice(0, 70), messages: [], createdAt: now, updatedAt: now };
    chat.repoUrl = repo || undefined;
    const history = chat.messages.filter((x) => !x.error).map((x) => ({ role: x.role, text: x.text }));
    let reply: ChatMessage;
    try {
      const a = await answer(history, text, { repoUrl: chat.repoUrl, suites: suites.all().map((s) => ({ name: s.name, titles: s.cases.map((c) => c.title) })) });
      reply = { role: 'assistant', text: a.reply, at: new Date().toISOString(), cases: a.cases.length ? a.cases : undefined, files: a.files.length ? a.files : undefined, repo: a.repo, repoError: a.repoError, model: a.model };
    } catch (e) {
      reply = { role: 'assistant', text: `The AI could not answer: ${(e as Error).message}\n\nCheck [AI keys](/settings/ai) and try again.`, at: new Date().toISOString(), error: true };
    }
    chat.messages.push({ role: 'user', text, at: now, repo: chat.repoUrl ? reply.repo ?? chat.repoUrl : undefined }, reply);
    chat.updatedAt = reply.at;
    chats.save(chat);
    ctx.redirect(`/chat/${chat.id}`);
    return true;
  }

  if ((m = p.match(/^\/chat\/([\w-]+)\/delete$/)) && post) {
    chats.remove(m[1]);
    ctx.redirect('/chat');
    return true;
  }

  if ((m = p.match(/^\/chat\/([\w-]+)\/rename$/)) && post) {
    const chat = chats.get(m[1]);
    if (!chat) return ctx.send(404, notFound('chat')), true;
    const title = field(await ctx.form(), 'title').slice(0, 120);
    if (title) {
      chat.title = title;
      chats.save(chat);
    }
    ctx.redirect(`/chat/${chat.id}`);
    return true;
  }

  if ((m = p.match(/^\/chat\/([\w-]+)\/messages\/(\d+)\/delete$/)) && post) {
    const chat = chats.get(m[1]);
    const n = Number(m[2]);
    if (!chat || n >= chat.messages.length) return ctx.send(404, notFound('message')), true;
    chat.messages.splice(n, chat.messages[n].role === 'user' && chat.messages[n + 1]?.role === 'assistant' ? 2 : 1);
    chats.save(chat);
    ctx.redirect(`/chat/${chat.id}`);
    return true;
  }

  if ((m = p.match(/^\/chat\/([\w-]+)\/cases\/(\d+)\/(\d+|new)\/(edit|delete)$/))) {
    const chat = chats.get(m[1]);
    const n = Number(m[2]);
    const msg = chat?.messages[n];
    const k = m[3] === 'new' ? null : Number(m[3]);
    if (!chat || !msg?.cases || (k !== null && k >= msg.cases.length) || (k === null && m[4] === 'delete')) return ctx.send(404, notFound('test case')), true;
    const back = `/chat/${chat.id}#cases-${n}`;
    if (m[4] === 'delete') {
      if (!post) return false;
      msg.cases.splice(k!, 1);
      if (!msg.cases.length) msg.cases = undefined;
      chats.save(chat);
      ctx.redirect(back);
      return true;
    }
    const used = new Set(msg.cases.map((c) => c.id));
    let fresh = msg.cases.length + 1;
    while (used.has(`TC-${fresh}`)) fresh++;
    const current: Partial<TestCase> = k === null ? { id: `TC-${fresh}`, priority: 'Medium' } : msg.cases[k];
    if (!post) return ctx.send(200, caseEditPage(chat, n, k, current)), true;
    const form = await ctx.form();
    const c = caseFromForm(form, current);
    const dup = typeof c !== 'string' && msg.cases.some((o, j) => j !== k && o.id === c.id);
    if (typeof c === 'string' || dup) {
      const typed = { ...current, id: field(form, 'id'), url: field(form, 'url'), title: field(form, 'title'), priority: field(form, 'priority'), preconditions: field(form, 'preconditions'), steps: lines(field(form, 'steps')), testData: field(form, 'testData'), expected: lines(field(form, 'expected')) };
      return ctx.send(422, caseEditPage(chat, n, k, typed, typeof c === 'string' ? c : `Another case already uses ${c.id}.`)), true;
    }
    if (k === null) msg.cases.push(c);
    else msg.cases[k] = c;
    chats.save(chat);
    ctx.redirect(back);
    return true;
  }

  if ((m = p.match(/^\/chat\/([\w-]+)\/cases\/(\d+)\/superqa$/)) && post) {
    const chat = chats.get(m[1]);
    const n = Number(m[2]);
    const msg = chat?.messages[n];
    if (!chat || !msg?.cases?.length) return ctx.send(404, notFound('set of test cases')), true;
    if (superQaBusy) return ctx.send(409, chatPage(chats.all(), chat, 'Super QA is already checking another set of cases. Try again in a minute.')), true;
    const missing = superQaMissing();
    if (missing) return ctx.send(422, chatPage(chats.all(), chat, missing)), true;
    // The request these cases answer: the last user message before them.
    const request = chat.messages.slice(0, n).reverse().find((x) => x.role === 'user')?.text ?? chat.title;
    const history = chat.messages.slice(0, n).filter((x) => !x.error).map((x) => ({ role: x.role, text: x.text }));
    superQaBusy = true;
    let reply: ChatMessage;
    try {
      const r = await superQa(request, history, msg.cases);
      reply = { role: 'assistant', text: `${r.reply}\n\n_Checked against the real pages in ${r.seconds}s._`, at: new Date().toISOString(), cases: r.cases, model: r.model, superQa: true, checked: r.checked };
    } catch (e) {
      reply = { role: 'assistant', text: `Super QA could not finish: ${(e as Error).message}\n\nCheck [AI keys](/settings/ai) and try again.`, at: new Date().toISOString(), error: true, superQa: true };
    } finally {
      superQaBusy = false;
    }
    // Saved on the chat as it is now (it may have changed while Super QA ran).
    const latest = chats.get(chat.id) ?? chat;
    latest.messages.push(reply);
    latest.updatedAt = reply.at;
    chats.save(latest);
    ctx.redirect(`/chat/${chat.id}#cases-${latest.messages.length - 1}`);
    return true;
  }

  if ((m = p.match(/^\/chat\/([\w-]+)\/cases\/(\d+)(\/save|\.csv)$/))) {
    const chat = chats.get(m[1]);
    const msg = chat?.messages[Number(m[2])];
    if (!chat || !msg?.cases?.length) return ctx.send(404, notFound('set of test cases')), true;
    if (m[3] === '.csv' && !post) {
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="sl-qa-assistant-${chat.id}-${m[2]}.csv"` });
      res.end(`﻿${casesCsv(msg.cases)}`);
      return true;
    }
    if (m[3] === '/save' && post) {
      const form = await ctx.form();
      const id = newId();
      const created = new Date().toISOString();
      const pagePath = msg.cases.find((c) => c.url)?.url.split('?')[0] || '/dashboard';
      suites.save({ id, name: field(form, 'name').slice(0, 120) || `Assistant: ${chat.title}`, source: { kind: 'manual' }, pagePath, cases: structuredClone(msg.cases), syncedAt: created, createdAt: created });
      ctx.redirect(`/suites/${id}?msg=${encodeURIComponent(`Saved ${msg.cases.length} case${msg.cases.length === 1 ? '' : 's'} from the Assistant. Check how the bot reads them, then Run.`)}`);
      return true;
    }
  }
  return false;
}
