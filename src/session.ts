import fs from 'fs';
import path from 'path';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { config } from './config.js';
import { Api } from './api.js';

export interface Session {
  browser: Browser;
  api: Api;
  token: string;
  storeId: number;
  newContext(opts?: { loggedOut?: boolean }): Promise<BrowserContext>;
  close(): Promise<void>;
}

interface Auth { token: string; storeId: number }

export async function startSession(headed = false): Promise<Session> {
  const browser = await chromium.launch({ headless: !headed });
  let auth = readAuth();
  if (!auth || !(await tokenWorks(auth))) {
    await login(browser);
    auth = readAuth();
  }
  if (!auth) throw new Error('Logged in, but the app did not store an auth token.');
  const { token, storeId } = auth;

  return {
    browser,
    token,
    storeId,
    api: new Api(token, storeId),
    async newContext(opts = {}) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        storageState: opts.loggedOut ? undefined : config.authFile,
        acceptDownloads: true,
        permissions: ['clipboard-read', 'clipboard-write'],
      });
      // tsx compiles functions passed to page.evaluate with a __name helper that does not exist in the page.
      await context.addInitScript('globalThis.__name = (fn) => fn;');
      // Keep a copy of anything the page copies, so clipboard checks work even where the real clipboard is unavailable.
      await context.addInitScript(() => {
        const w = window as unknown as { __btbClipboard: string[] };
        w.__btbClipboard = [];
        const clip = navigator.clipboard;
        if (clip) {
          const original = clip.writeText.bind(clip);
          clip.writeText = (text: string) => {
            w.__btbClipboard.push(text);
            return original(text).catch(() => undefined);
          };
        }
      });
      return context;
    },
    close: () => browser.close(),
  };
}

async function login(browser: Browser): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${config.baseUrl}/dashboard`, { waitUntil: 'networkidle' });
  await page.getByText('Phone', { exact: true }).click();
  await page.locator('input[name=identifier]').fill(config.phone);
  await page.locator('input[name=password]').fill(config.password);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 });
  await page.waitForLoadState('networkidle');
  fs.mkdirSync(path.dirname(config.authFile), { recursive: true });
  await context.storageState({ path: config.authFile });
  await context.close();
}

function readAuth(): Auth | null {
  if (!fs.existsSync(config.authFile)) return null;
  const state = JSON.parse(fs.readFileSync(config.authFile, 'utf8'));
  const storage: { name: string; value: string }[] =
    state.origins?.find((o: { origin: string }) => o.origin === config.baseUrl)?.localStorage ?? [];
  const token = storage.find((x) => x.name === 'auth_token')?.value;
  const storeId = Number(storage.find((x) => x.name === 'store_id')?.value);
  return token && storeId ? { token, storeId } : null;
}

async function tokenWorks({ token, storeId }: Auth): Promise<boolean> {
  const res = await fetch(`${config.apiUrl}/auth/me`, {
    headers: { Authorization: `Bearer ${token}`, 'X-Store-Id': String(storeId), Accept: 'application/json' },
  });
  return res.ok;
}
