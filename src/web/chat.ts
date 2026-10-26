import type http from 'http';
import { Marked, type Tokens } from 'marked';
import { answer, casesCsv, MAX_MESSAGE } from '../engine/ai/chat.js';
import { parseRepoUrl, RepoError } from '../engine/ai/repo.js';
import { configured } from '../engine/ai/providers.js';
import { chats, newId, suites, type Chat, type ChatMessage } from './store.js';
import { esc, layout, notFound } from './views.js';

/**
 * The Assistant pages: /chat (new chat + recent chats), /chat/<id> (one conversation), and the actions on a
 * proposed set of test cases (save as a suite, download CSV). Plain forms; a small script adds Enter-to-send.
 */

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
  const rows = cases.map((c) => `<tr>
    <td class="nowrap"><b>${esc(c.id)}</b></td><td><code>${esc(c.url)}</code></td><td>${esc(c.title)}</td><td>${esc(c.priority)}</td><td>${esc(c.preconditions)}</td>
    <td><ol class="cells">${c.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol></td><td>${esc(c.testData)}</td>
    <td><ul class="cells">${c.expected.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></td></tr>`).join('');
  const name = `Assistant: ${chat.title}`.slice(0, 120);
  return `<div class="chat-cases">
    <div class="table-wrap"><table><thead><tr><th>TC ID</th><th>URL</th><th>Test Case</th><th>Priority</th><th>Preconditions</th><th>Test Steps</th><th>Test Data</th><th>Expected Result</th></tr></thead><tbody>${rows}</tbody></table></div>
    <form method="post" action="/chat/${chat.id}/cases/${i}/save" class="toolbar">
      <label class="inline-label">Suite name <input name="name" value="${esc(name)}" maxlength="120" required></label>
      <button class="primary">Save as new suite</button>
      <a class="button" href="/chat/${chat.id}/cases/${i}.csv" download>⬇ Download CSV</a>
    </form>
  </div>`;
}

function message(chat: Chat, m: ChatMessage, i: number): string {
  if (m.role === 'user') return `<div class="msg user"><div class="bubble">${esc(m.text).replace(/\n/g, '<br>')}</div><div class="sub">${when(m.at)}${m.repo ? ` · code: ${esc(m.repo)}` : ''}</div></div>`;
  const files = m.files?.length
    ? `<details class="files"><summary>${m.files.length} file${m.files.length === 1 ? '' : 's'} used from ${esc(m.repo ?? 'the repo')}</summary><ul>${m.files.map((f) => `<li><code>${esc(f)}</code></li>`).join('')}</ul></details>`
    : '';
  return `<div class="msg assistant${m.error ? ' error' : ''}">
    ${m.repoError ? `<div class="alert" role="alert">Code context not used: ${esc(m.repoError)}</div>` : ''}
    <div class="bubble report">${renderMarkdown(m.text)}</div>
    ${m.cases?.length ? casesTable(chat, i, m) : ''}
    ${files}
    <div class="sub">${when(m.at)}${m.model ? ` · ${esc(m.model)}` : ''}</div>
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
      ${chat ? '<div class="toolbar"><a class="button" href="/chat">＋ New chat</a></div>' : ''}</div>
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
      .files ul { margin:4px 0; font-size:12.5px; } .spin.dark { border-color:var(--muted); border-right-color:transparent; vertical-align:middle; }
    </style>`,
    { section: 'chat' },
  );
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
