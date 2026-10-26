import fs from 'fs';
import path from 'path';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { config } from './config.js';
import { Api } from './apps/slshop/api.js';

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
  // Small containers (e.g. Render's free 512 MB plan) have a tiny /dev/shm; these flags keep Chromium within it.
  const browser = await chromium.launch({ headless: !headed, args: ['--disable-dev-shm-usage', '--disable-gpu'] });
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
      // Each test starts on the default store, whatever a previous test switched to (only on the first load of a tab,
      // so a store switch inside a test survives reloads).
      if (!opts.loggedOut) {
        await context.addInitScript(`try { if (!sessionStorage.getItem('btb-store')) { localStorage.setItem('store_id', '${storeId}'); sessionStorage.setItem('btb-store', '1'); } } catch {}`);
      }
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
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
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
