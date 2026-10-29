/**
 * Optional end-to-end tests against an installed, unpacked Chromium binary.
 * The extension profile below grants test-domain permissions in its disposable
 * Preferences file so the native permissions prompt does not block headless CI.
 * This tests behavior AFTER consent, not the browser's own consent UI.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';

const executablePath = process.env.CHROMIUM_PATH;
if (!executablePath) {
  console.error('Set CHROMIUM_PATH to an installed Chromium/Chrome for Testing executable, then run npm run test:browser.');
  process.exit(1);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const axePath = require.resolve('axe-core/axe.min.js');
const dir = await mkdtemp(path.join(tmpdir(), 'browserbuddy-e2e-'));
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://test.invalid').pathname);
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep)) throw new Error('Invalid path');
    const content = await readFile(file);
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });
    res.end(content);
  } catch { res.writeHead(404); res.end('Not found'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
const testSite = `http://buddy.test:${port}`;
const commonArgs = ['--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server'];
let context;

async function axe(page, label) {
  const result = await page.evaluate(() => globalThis.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } }));
  assert.deepEqual(result.violations.map(item => `${item.id}: ${item.nodes.map(node => node.html).join(', ')}`), [], `Accessibility violations on ${label}`);
}
function acceptDialogs(page) { page.on('dialog', dialog => dialog.accept()); }
function localDateTime(timestamp) {
  const date = new Date(timestamp), pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
async function waitForState(worker, predicate, message) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const value = await worker.evaluate(async () => (await chrome.storage.local.get('browserbuddy.local.v1'))['browserbuddy.local.v1']);
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${message}.`);
}
async function rules(worker) { return worker.evaluate(() => chrome.declarativeNetRequest.getSessionRules()); }

try {
  // Standalone browser: real local persistence, no claim of extension connectivity.
  const browser = await chromium.launch({ executablePath, args: commonArgs, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  const remoteRequests = [];
  page.on('request', request => { if (request.url().startsWith('https://example.org/')) remoteRequests.push(request.url()); });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  acceptDialogs(page);
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.addScriptTag({ path: axePath });
  await axe(page, 'empty dashboard');
  assert.match(await page.locator('#mode-banner').innerText(), /not connected to the extension/);
  await page.locator('.skip-link').focus(); await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'main', 'Skip link should focus the main content');
  await page.getByRole('button', { name: 'Add your first task' }).click();
  await axe(page, 'task dialog');
  await page.locator('#task-form [name=title]').fill('Finish gas stoichiometry');
  await page.locator('#task-form [name=topic]').fill('gas stoichiometry');
  await page.locator('#task-form [name=url]').fill('https://example.org/work');
  await page.locator('#task-form button[type=submit]').click();
  await page.getByRole('heading', { name: 'Finish gas stoichiometry' }).waitFor();
  assert.equal(new URL(page.url()).search, '', 'Task form should never put user input in the URL');
  await page.reload();
  await page.getByRole('heading', { name: 'Finish gas stoichiometry' }).waitFor();
  await page.getByRole('link', { name: 'Set up a focus session' }).click();
  await page.getByRole('button', { name: 'Start focus session' }).click();
  await page.locator('[data-countdown]').waitFor();
  assert.match(await page.locator('[data-protection-copy]').innerText(), /Timer only/);
  await page.getByRole('button', { name: 'Pause session' }).click();
  assert.match(await page.locator('.timer-caption').innerText(), /PAUSED/);
  await page.getByRole('button', { name: 'Resume session' }).click();
  await page.locator('#keyword-form input').fill('How Teflon is made: chemistry');
  await page.getByRole('button', { name: 'Check keywords' }).click();
  assert.match(await page.locator('#keyword-result').innerText(), /does not necessarily/);
  await page.getByRole('button', { name: 'End session', exact: true }).click();
  await page.getByRole('link', { name: 'Library', exact: true }).click();
  await page.getByRole('button', { name: 'Save a resource' }).click();
  await page.locator('#resource-form [name=title]').fill('A lesson I chose');
  await page.locator('#resource-form [name=url]').fill('https://example.org/video');
  await page.locator('#resource-form [name=topic]').fill('chemistry');
  await page.locator('#resource-form [name=note]').fill('<img src=x onerror=window.unwanted=true>');
  await page.locator('#resource-form [name=thumbnail]').setInputFiles(path.join(root, 'assets', 'icons', 'icon128.png'));
  await page.locator('#resource-form button[type=submit]').click();
  await page.getByRole('link', { name: 'A lesson I chose' }).waitFor();
  assert.match(await page.locator('.resource-thumb img').getAttribute('src'), /^data:image\//);
  assert.equal(await page.locator('.resource-note img').count(), 0, 'Saved notes must not become HTML');
  assert.equal(await page.evaluate(() => window.unwanted), undefined);
  await page.getByRole('searchbox', { name: 'Search saved resources' }).fill('unrelated');
  assert.match(await page.locator('#resource-results').innerText(), /No saved resources match/);
  await page.getByRole('searchbox', { name: 'Search saved resources' }).fill('chemistry');
  await page.getByRole('link', { name: 'A lesson I chose' }).waitFor();
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  assert.equal(await page.locator('#settings-form [name=activityEnabled]').isDisabled(), true);
  await page.locator('#settings-form [name=blockedSites]').fill('youtube.com\nreddit.com');
  await page.locator('#settings-form button[type=submit]').click();
  await page.getByText('Settings saved.').waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Mobile layout must not overflow');
  // The axe script was removed by reload, so re-inject before the mobile scan.
  await page.addScriptTag({ path: axePath });
  await axe(page, 'mobile settings');
  assert.deepEqual(errors, []);
  assert.deepEqual(remoteRequests, [], 'Saved links must not be fetched without a user click');
  await browser.close();
  console.log('PASS: standalone task, timer, persistence, keyword, library, settings, mobile and accessibility flows');

  // The native prompt cannot be clicked in headless Chromium. Pre-grant ONLY a
  // test domain and optional APIs in a fresh temporary profile, as if consented.
  const profile = path.join(dir, 'profile');
  const extensionArgs = [...commonArgs, '--host-resolver-rules=MAP buddy.test 127.0.0.1, MAP buddy.test. 127.0.0.1, MAP *.buddy.test 127.0.0.1', `--disable-extensions-except=${root}`, `--load-extension=${root}`, '--headless=new'];
  const options = { executablePath, args: extensionArgs, ignoreDefaultArgs: ['--disable-extensions'], headless: true };
  context = await chromium.launchPersistentContext(profile, options);
  let worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  await context.close(); context = null;
  const prefPath = path.join(profile, 'Default', 'Preferences');
  const prefs = JSON.parse(await readFile(prefPath, 'utf8'));
  const entry = prefs.extensions.settings[extensionId];
  for (const field of ['active_permissions', 'granted_permissions']) {
    entry[field].explicit_host = ['*://*.buddy.test/*'];
    entry[field].api = [...new Set([...entry[field].api, 'tabs', 'idle'])];
  }
  await writeFile(prefPath, JSON.stringify(prefs));
  context = await chromium.launchPersistentContext(profile, options);
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionErrors = [];
  worker.on('console', message => { if (message.type() === 'error') extensionErrors.push(message.text()); });
  let dashboard = await context.newPage();
  dashboard.on('pageerror', error => extensionErrors.push(error.message));
  acceptDialogs(dashboard);
  await dashboard.goto(`chrome-extension://${extensionId}/index.html`);
  await dashboard.getByRole('button', { name: 'Add your first task' }).click();
  await dashboard.locator('#task-form [name=title]').fill('Write an essay');
  await dashboard.locator('#task-form [name=topic]').fill('climate science');
  await dashboard.locator('#task-form [name=url]').fill('https://example.org/work');
  await dashboard.locator('#task-form [name=plannedStart]').fill(localDateTime(Date.now() - 120_000));
  await dashboard.locator('#task-form button[type=submit]').click();
  await dashboard.getByRole('heading', { name: 'Write an essay' }).waitFor();
  await dashboard.getByRole('link', { name: 'Settings', exact: true }).click();
  await dashboard.locator('#settings-form [name=blockedSites]').fill('buddy.test');
  await dashboard.locator('#settings-form button[type=submit]').click();
  await waitForState(worker, value => value?.settings?.blockedSites.length === 1, 'site settings');
  const existing = await context.newPage();
  await existing.goto(`${testSite}/?already=open`);
  await dashboard.bringToFront();
  await dashboard.getByRole('link', { name: 'Focus session', exact: true }).click();
  await dashboard.getByRole('button', { name: 'Start focus session' }).click();
  await waitForState(worker, value => value?.session?.status === 'running', 'session start');
  assert.equal((await rules(worker)).length, 1);
  await existing.waitForURL(/blocked\.html/);
  await existing.getByText('Write an essay', { exact: true }).waitFor();
  assert.equal(await existing.getByRole('link', { name: 'Continue to site' }).isVisible(), false);
  const dotted = await context.newPage();
  await dotted.goto(`http://buddy.test.:${port}/?dotted=1`);
  await dotted.waitForURL(/blocked\.html/);
  const subdomain = await context.newPage();
  await subdomain.goto(`http://sub.buddy.test:${port}/?subdomain=1`);
  await subdomain.waitForURL(/blocked\.html/);
  const other = await context.newPage();
  await other.goto(base);
  await other.evaluate(url => { const link = document.createElement('a'); link.textContent = 'Follow test link'; link.href = url; document.body.append(link); }, `${testSite}/?from=other`);
  await other.getByRole('link', { name: 'Follow test link' }).click();
  await other.waitForURL(/blocked\.html/);
  const fresh = await context.newPage();
  await fresh.goto(`${testSite}/?fresh=1`);
  await fresh.waitForURL(/blocked\.html/);
  await fresh.getByRole('button', { name: 'Allow sites for 10 minutes' }).click();
  await fresh.waitForURL(`${testSite}/?fresh=1`);
  assert.equal((await rules(worker)).length, 0);
  assert.ok((await waitForState(worker, value => value?.session?.overrideUntil > Date.now(), 'temporary allowance')).session);
  await dashboard.bringToFront(); await dashboard.reload();
  await dashboard.getByRole('button', { name: 'Resume blocking' }).click();
  await waitForState(worker, value => value?.session?.overrideUntil === null, 'restored blocking');
  await fresh.waitForURL(/blocked\.html/);
  // Shorten a second allowance in the disposable profile to verify its alarm
  // restores blocking even with the dashboard closed.
  await dashboard.getByRole('button', { name: 'Temporarily allow sites' }).click();
  await waitForState(worker, value => value?.session?.overrideUntil > Date.now(), 'second allowance');
  await worker.evaluate(async () => {
    const key = 'browserbuddy.local.v1';
    const saved = (await chrome.storage.local.get(key))[key];
    saved.session.overrideUntil = Date.now() + 1500;
    await chrome.storage.local.set({ [key]: saved });
  });
  await dashboard.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_STATE' }));
  await dashboard.close();
  const temporarilyAllowed = await context.newPage();
  await temporarilyAllowed.goto(`${testSite}/?temporary=1`);
  await waitForState(worker, value => value?.session?.overrideUntil === null, 'automatic allowance expiry');
  assert.equal((await rules(worker)).length, 1);
  await temporarilyAllowed.waitForURL(/blocked\.html/);
  dashboard = await context.newPage(); acceptDialogs(dashboard);
  await dashboard.goto(`chrome-extension://${extensionId}/index.html#focus`);
  await dashboard.getByRole('button', { name: 'Pause session' }).click();
  await waitForState(worker, value => value?.session?.status === 'paused', 'pause');
  assert.equal((await rules(worker)).length, 0);
  await existing.getByRole('link', { name: 'Continue to site' }).waitFor();
  await dashboard.getByRole('button', { name: 'Resume session' }).click();
  await waitForState(worker, value => value?.session?.status === 'running', 'resume');
  assert.equal((await rules(worker)).length, 1);
  console.log('PASS: real MV3 selected-site redirects, existing tabs, temporary allowance and expiry, pause and resume');

  // Session rules disappear at browser shutdown and must be reconstructed.
  await context.close(); context = null;
  context = await chromium.launchPersistentContext(profile, options);
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  dashboard = await context.newPage(); acceptDialogs(dashboard);
  await dashboard.goto(`chrome-extension://${extensionId}/index.html#focus`);
  await dashboard.getByRole('button', { name: 'Pause session' }).waitFor();
  assert.equal((await rules(worker)).length, 1);
  // Shorten a disposable test session and close its dashboard to exercise the
  // real service-worker alarm rather than the visible countdown's interval.
  await worker.evaluate(async () => {
    const key = 'browserbuddy.local.v1';
    const saved = (await chrome.storage.local.get(key))[key];
    saved.session.endsAt = Date.now() + 1500;
    saved.session.remainingMs = 1500;
    await chrome.storage.local.set({ [key]: saved });
  });
  await dashboard.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_STATE' }));
  await dashboard.close();
  await waitForState(worker, value => value?.session === null && value?.sessions?.length > 0, 'service-worker timer alarm');
  assert.equal((await rules(worker)).length, 0);
  dashboard = await context.newPage(); acceptDialogs(dashboard);
  await dashboard.goto(`chrome-extension://${extensionId}/index.html#focus`);
  await dashboard.getByRole('button', { name: 'Start focus session' }).click();
  await waitForState(worker, value => value?.session?.status === 'running', 'second session');
  await dashboard.locator('#keyword-title').fill('a title I am still typing');
  await worker.evaluate(() => chrome.permissions.remove({ origins: ['*://*.buddy.test/*'] }));
  await waitForState(worker, value => value?.session?.status === 'paused', 'revoked site permission');
  assert.equal((await rules(worker)).length, 0);
  await dashboard.getByRole('button', { name: 'Resume session' }).waitFor();
  assert.equal(await dashboard.locator('#keyword-title').inputValue(), 'a title I am still typing', 'Session updates must preserve the title-check draft');
  console.log('PASS: restart restores rules, the worker alarm ends a session, and revocation pauses protection');

  await dashboard.reload();
  await dashboard.getByRole('button', { name: 'End session', exact: true }).click();
  await dashboard.getByRole('link', { name: 'Settings', exact: true }).click();
  await dashboard.locator('#settings-form [name=trackedSites]').fill('buddy.test');
  await dashboard.locator('#settings-form [name=activityEnabled]').check();
  await dashboard.locator('#settings-form [name=strict]').uncheck();
  await dashboard.locator('#settings-form button[type=submit]').click();
  await waitForState(worker, value => value?.settings?.activityEnabled, 'activity opt-in');
  await dashboard.getByRole('link', { name: 'Focus session', exact: true }).click();
  await dashboard.getByRole('button', { name: 'Start focus session' }).click();
  const activeSession = await waitForState(worker, value => value?.session?.status === 'running', 'nonblocking session');
  const sessionTaskId = activeSession.session.taskId;
  await dashboard.getByRole('link', { name: 'Today', exact: true }).click();
  await dashboard.getByRole('button', { name: 'Add a task', exact: true }).click();
  await dashboard.locator('#task-form [name=title]').fill('A different overlapping task');
  await dashboard.locator('#task-form [name=plannedStart]').fill(localDateTime(Date.now() - 120_000));
  await dashboard.locator('#task-form button[type=submit]').click();
  await waitForState(worker, value => value?.currentTaskId !== sessionTaskId, 'different next task');
  await dashboard.getByRole('link', { name: 'Settings', exact: true }).click();
  await dashboard.locator('#settings-form [name=blockedSites]').fill('unsaved.example');
  const foreground = await context.newPage();
  await foreground.goto(`${testSite}/?track=1`); await foreground.bringToFront();
  await waitForState(worker, value => value?.observation?.host === 'buddy.test', 'foreground activity sample');
  await foreground.waitForTimeout(1200); await dashboard.bringToFront();
  const recorded = await waitForState(worker, value => value?.observation === null && value?.intervals?.length > 0, 'foreground activity closing');
  assert.equal(await dashboard.locator('#settings-form [name=blockedSites]').inputValue(), 'unsaved.example', 'Background updates must not discard a settings draft');
  assert.equal(recorded.intervals[0].host, 'buddy.test');
  assert.equal(recorded.intervals[0].taskId, sessionTaskId, 'A different selected task must not steal an active session’s observation');
  assert.ok(recorded.intervals[0].end > recorded.intervals[0].start);
  assert.ok(!('url' in recorded.intervals[0]) && !('pageTitle' in recorded.intervals[0]));
  const count = recorded.intervals.length;
  await dashboard.waitForTimeout(500);
  assert.equal((await waitForState(worker, value => value?.observation === null, 'background exclusion')).intervals.length, count);
  console.log('PASS: opt-in activity records only the foreground domain and stops when the tab changes');

  // A disposable synthetic interval tests next-day UI without waiting a day.
  await worker.evaluate(async () => {
    const key = 'browserbuddy.local.v1';
    const saved = (await chrome.storage.local.get(key))[key];
    const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1); yesterday.setHours(14, 0, 0, 0);
    const task = saved.tasks.find(item => item.id === saved.currentTaskId);
    task.plannedStart = yesterday.getTime(); task.plannedEnd = task.plannedStart + 60 * 60_000;
    saved.settings.reminderTime = '00:00'; saved.observation = null;
    saved.intervals.push({ host: 'buddy.test', taskId: task.id, taskTitle: task.title, start: task.plannedStart + 60_000, end: task.plannedStart + 7 * 60_000 });
    await chrome.storage.local.set({ [key]: saved });
  });
  await dashboard.goto(`chrome-extension://${extensionId}/index.html#today`);
  await dashboard.getByRole('button', { name: /Reflect, if you like/ }).click();
  await dashboard.locator('#reflection-form [name=answer]').fill('It helped me find a useful source.');
  await dashboard.locator('#reflection-form button[type=submit]').click();
  await waitForState(worker, value => value?.reflections?.some(item => item.answer.includes('useful source')), 'saved reflection');
  await dashboard.getByRole('link', { name: 'Check-ins', exact: true }).click();
  await dashboard.getByText('It helped me find a useful source.').waitFor();
  assert.deepEqual(extensionErrors, []);
  console.log('PASS: next-day reflection UI with an explicitly synthetic test fixture');
} finally {
  if (context) await context.close();
  await new Promise(resolve => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
