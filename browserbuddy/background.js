import { STORAGE_KEY, applyCommand, hostMatches, initialState, isBlocking, normalizeState, permissionOrigins } from './core.js';

const HEARTBEAT = 'buddy-heartbeat';
const SESSION_END = 'buddy-session-end';
const OVERRIDE_END = 'buddy-override-end';
const MENU_ID = 'buddy-check-page';
let queue = Promise.resolve();
let idleListening = false;

// All state mutations and rule changes share a single queue, including tab events.
function serial(fn) {
  const result = queue.then(fn, fn);
  queue = result.catch(error => console.error('BrowserBuddy:', error));
  return result;
}
async function load() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return normalizeState(result[STORAGE_KEY]);
}
async function activityPermission() {
  return chrome.permissions.contains({ permissions: ['tabs', 'idle'] });
}
async function missingSites(sites) {
  const missing = [];
  for (const site of sites) {
    if (!await chrome.permissions.contains({ origins: permissionOrigins([site]) })) missing.push(site);
  }
  return missing;
}
async function metadata(state) {
  return { mode: 'extension', missingSites: await missingSites(state.settings.blockedSites), activityPermission: await activityPermission() };
}
function rulesFor(state) {
  if (!isBlocking(state)) return [];
  return state.settings.blockedSites.map((site, index) => {
    const escaped = site.replaceAll('.', '\\.');
    return {
      id: index + 1,
      priority: 1,
      action: { type: 'redirect', redirect: { regexSubstitution: `${chrome.runtime.getURL('blocked.html')}#\\0` } },
      condition: { regexFilter: `^https?://(?:[^/?#]+\\.)?${escaped}\\.?(?::[0-9]+)?(?:[/?#].*)?$`, resourceTypes: ['main_frame'] }
    };
  });
}
async function syncRules(state) {
  const desired = rulesFor(state);
  const current = await chrome.declarativeNetRequest.getSessionRules();
  const simplify = list => JSON.stringify(list.map(({ id, priority, action, condition }) => ({ id, priority, action, condition })).sort((a, b) => a.id - b.id));
  if (simplify(current) !== simplify(desired)) {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: current.map(rule => rule.id), addRules: desired });
  }
}
async function oneShot(name, when) {
  const old = await chrome.alarms.get(name);
  if (!when) {
    if (old) await chrome.alarms.clear(name);
  } else if (!old || Math.abs(old.scheduledTime - when) > 1000) {
    await chrome.alarms.create(name, { when });
  }
}
async function syncAlarms(state) {
  const needed = Boolean(state.session || state.settings.activityEnabled);
  const heartbeat = await chrome.alarms.get(HEARTBEAT);
  if (needed && !heartbeat) await chrome.alarms.create(HEARTBEAT, { periodInMinutes: 0.5 });
  if (!needed && heartbeat) await chrome.alarms.clear(HEARTBEAT);
  await oneShot(SESSION_END, state.session?.status === 'running' ? state.session.endsAt : null);
  await oneShot(OVERRIDE_END, state.session?.status === 'running' && state.session.overrideUntil > Date.now() ? state.session.overrideUntil : null);
}
async function redirectOpenTabs(state) {
  if (!isBlocking(state)) return;
  // Host permission reveals URLs only for sites the user approved. Existing pages are
  // redirected too; otherwise a page open before a session could remain usable.
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map(async tab => {
    if (!tab.id || tab.incognito || !tab.url) return;
    try {
      const url = new URL(tab.url);
      if (!['http:', 'https:'].includes(url.protocol) || !state.settings.blockedSites.some(site => hostMatches(url.hostname.toLowerCase(), site))) return;
      await chrome.tabs.update(tab.id, { url: `${chrome.runtime.getURL('blocked.html')}#${tab.url}` });
    } catch { /* Browser-restricted or closing tabs cannot be updated. */ }
  }));
}
async function commit(before, next, redirect = true) {
  try {
    await syncRules(next);
    await syncAlarms(next);
    await chrome.storage.local.set({ [STORAGE_KEY]: next });
  } catch (error) {
    // Never leave a session claiming protection after rule or storage failure.
    try { await syncRules(before); await syncAlarms(before); } catch (rollbackError) { console.error('BrowserBuddy rollback:', rollbackError); }
    throw error;
  }
  if (redirect) await redirectOpenTabs(next);
  return next;
}
async function ensurePermissions(next, command) {
  if (next.session?.status === 'running' && next.session.strict && ['START_SESSION', 'RESUME_SESSION', 'SAVE_SETTINGS'].includes(command.type)) {
    const missing = await missingSites(next.settings.blockedSites);
    if (missing.length) throw new Error(`Site access is needed to block: ${missing.join(', ')}. Allow it in Settings and try again.`);
  }
  if (command.type === 'SAVE_SETTINGS' && next.settings.activityEnabled && !await activityPermission()) {
    throw new Error('Allow the optional tabs and idle permissions before enabling activity tracking.');
  }
}
async function mutate(command, now = Date.now()) {
  const before = await load();
  // Close the last sample at the moment a task, selection, or recording policy changes.
  // This prevents a newly shortened work window from inheriting a stale observation.
  const closesObservation = new Set(['UPSERT_TASK', 'SELECT_TASK', 'TOGGLE_TASK', 'DELETE_TASK', 'SAVE_SETTINGS', 'CLEAR_ACTIVITY']);
  const base = before.observation && closesObservation.has(command.type)
    ? applyCommand(before, { type: 'RECORD_OBSERVATION', data: null }, now)
    : before;
  const next = applyCommand(base, command, now);
  await ensurePermissions(next, command);
  await commit(before, next);
  return next;
}
async function reconcile() {
  const before = await load();
  let next = applyCommand(before, { type: 'TICK' });
  // If a permission was revoked outside the app, stop rather than imply strict
  // protection is still working. An idle permission loss also turns tracking off.
  if (next.session?.status === 'running' && next.session.strict && (await missingSites(next.settings.blockedSites)).length) {
    next = applyCommand(next, { type: 'PAUSE_SESSION' });
  }
  if (next.settings.activityEnabled && !await activityPermission()) {
    next = applyCommand(next, { type: 'RECORD_OBSERVATION', data: null });
    next = applyCommand(next, { type: 'SAVE_SETTINGS', data: { ...next.settings, activityEnabled: false } });
  }
  await commit(before, next);
  return next;
}
async function foregroundObservation(state, now) {
  if (!state.settings.activityEnabled || !await activityPermission()) return null;
  if (await chrome.idle.queryState(60) !== 'active') return null;
  const focused = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
  if (!focused?.focused || focused.incognito || focused.id == null) return null;
  const [tab] = await chrome.tabs.query({ active: true, windowId: focused.id });
  if (!tab || tab.incognito || !tab.url) return null;
  let url;
  try { url = new URL(tab.url); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  const host = url.hostname.toLowerCase();
  if (!state.settings.trackedSites.some(site => hostMatches(host, site))) return null;
  const planned = state.tasks.filter(task => !task.completed && task.plannedStart && task.plannedEnd && task.plannedStart <= now && task.plannedEnd > now);
  const preferredId = state.session?.taskId || state.currentTaskId;
  const task = planned.find(item => item.id === preferredId) || (!state.session && planned.length === 1 ? planned[0] : null);
  return task ? { taskId: task.id, host } : null;
}
async function sample() {
  const before = await load();
  let next = applyCommand(before, { type: 'TICK' });
  if (next.settings.activityEnabled && !await activityPermission()) {
    next = applyCommand(next, { type: 'RECORD_OBSERVATION', data: null });
    next = applyCommand(next, { type: 'SAVE_SETTINGS', data: { ...next.settings, activityEnabled: false } });
  } else if (next.settings.activityEnabled || next.observation) {
    const now = Date.now();
    let observation = null;
    try { observation = await foregroundObservation(next, now); } catch (error) { console.error('BrowserBuddy sampling:', error); }
    next = applyCommand(next, { type: 'RECORD_OBSERVATION', data: observation }, now);
  }
  await commit(before, next);
  return next;
}
function listenForIdle() {
  if (idleListening || !chrome.idle?.onStateChanged) return;
  try {
    chrome.idle.onStateChanged.addListener(() => { serial(sample); });
    idleListening = true;
  } catch { /* Optional permission may not be granted yet. */ }
}
function openDashboard() {
  return chrome.tabs.create({ url: chrome.runtime.getURL('index.html') });
}
async function createMenu() {
  // The callback form also works in Chrome 120-122, before the Promise API.
  await new Promise((resolve, reject) => chrome.contextMenus.removeAll(() => chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve()));
  await new Promise((resolve, reject) => chrome.contextMenus.create({ id: MENU_ID, title: 'Check this page against my BrowserBuddy task', contexts: ['page'] }, () => chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve()));
}

chrome.runtime.onInstalled.addListener(() => { serial(async () => { await createMenu(); await reconcile(); listenForIdle(); }); });
chrome.runtime.onStartup.addListener(() => { serial(async () => { await reconcile(); await sample(); listenForIdle(); }); });
chrome.action.onClicked.addListener(() => { openDashboard(); });
chrome.alarms.onAlarm.addListener(alarm => {
  if ([HEARTBEAT, SESSION_END, OVERRIDE_END].includes(alarm.name)) serial(async () => { await reconcile(); await sample(); });
});
chrome.tabs.onActivated.addListener(() => { serial(sample); });
chrome.tabs.onUpdated.addListener((_id, change) => { if (change.url || change.status === 'complete') serial(sample); });
chrome.windows.onFocusChanged.addListener(() => { serial(sample); });
chrome.permissions.onAdded.addListener(() => { listenForIdle(); serial(reconcile); });
chrome.permissions.onRemoved.addListener(() => { serial(reconcile); });
listenForIdle();

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab || tab.incognito) return;
  serial(async () => {
    const state = await reconcile();
    const task = state.tasks.find(item => item.id === (state.session?.taskId || state.currentTaskId));
    const reviewId = crypto.randomUUID();
    // Session storage is memory-only and is removed on dismissal/restart.
    await chrome.storage.session.set({ [`review-${reviewId}`]: { title: String(tab.title || '').slice(0, 500), tabId: tab.id, windowId: tab.windowId, task: task ? { title: task.title, topic: task.topic, url: task.url } : null } });
    await chrome.tabs.create({ url: `${chrome.runtime.getURL('review.html')}?id=${encodeURIComponent(reviewId)}` });
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return false;
  serial(async () => {
    if (message?.type === 'GET_STATE') {
      const state = await reconcile();
      return { state, meta: await metadata(state) };
    }
    if (message?.type === 'COMMAND') {
      const allowed = new Set(['UPSERT_TASK', 'SELECT_TASK', 'TOGGLE_TASK', 'DELETE_TASK', 'SAVE_SETTINGS', 'START_SESSION', 'PAUSE_SESSION', 'RESUME_SESSION', 'ALLOW_TEMPORARY', 'RESTORE_BLOCKING', 'END_SESSION', 'CLEAR_ACTIVITY', 'SAVE_REFLECTION', 'CLEAR_REFLECTIONS', 'SAVE_RESOURCE', 'DELETE_RESOURCE', 'TICK']);
      if (!allowed.has(message.command?.type)) throw new Error('That action is not available.');
      const state = await mutate(message.command);
      return { state, meta: await metadata(state) };
    }
    if (message?.type === 'RESET') {
      const before = await load();
      await commit(before, initialState(), false);
      return { state: initialState(), meta: await metadata(initialState()) };
    }
    if (message?.type === 'GET_REVIEW' && sender.url.startsWith(chrome.runtime.getURL('review.html'))) {
      const key = `review-${String(message.id || '')}`;
      return { review: (await chrome.storage.session.get(key))[key] || null };
    }
    if (message?.type === 'DISMISS_REVIEW' && sender.url.startsWith(chrome.runtime.getURL('review.html'))) {
      const key = `review-${String(message.id || '')}`;
      const review = (await chrome.storage.session.get(key))[key];
      await chrome.storage.session.remove(key);
      if (message.back && review?.tabId) {
        try { await chrome.tabs.update(review.tabId, { active: true }); await chrome.windows.update(review.windowId, { focused: true }); } catch { /* Original tab may have closed. */ }
      }
      if (sender.tab?.id) await chrome.tabs.remove(sender.tab.id);
      return {};
    }
    throw new Error('Unknown BrowserBuddy request.');
  }).then(result => sendResponse({ ok: true, ...result }), error => sendResponse({ ok: false, error: error.message || 'Something went wrong.' }));
  return true;
});
