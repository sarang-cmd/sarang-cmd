/** BrowserBuddy's storage format and pure domain logic. No browser APIs are used here. */
export const STORAGE_KEY = 'browserbuddy.local.v1';
export const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const MAX_SITES = 30;
const MAX_OBSERVATION_GAP = 75_000;
const STOP_WORDS = new Set(['about', 'after', 'also', 'and', 'are', 'before', 'chapter', 'class', 'complete', 'course', 'finish', 'for', 'from', 'homework', 'how', 'into', 'learn', 'lesson', 'make', 'notes', 'page', 'practice', 'read', 'review', 'study', 'task', 'that', 'the', 'their', 'then', 'this', 'with', 'work', 'your']);

export function initialState() {
  return {
    version: 1,
    tasks: [],
    currentTaskId: null,
    settings: { strict: true, blockedSites: [], activityEnabled: false, trackedSites: [], reminderTime: '09:00' },
    session: null,
    sessions: [],
    intervals: [],
    observation: null,
    reflections: [],
    resources: []
  };
}

export function normalizeState(raw) {
  const fresh = initialState();
  if (!raw || typeof raw !== 'object' || raw.version !== 1) return fresh;
  return {
    ...fresh,
    ...raw,
    settings: { ...fresh.settings, ...(raw.settings || {}) },
    tasks: Array.isArray(raw.tasks) ? raw.tasks : [],
    sessions: Array.isArray(raw.sessions) ? raw.sessions : [],
    intervals: Array.isArray(raw.intervals) ? raw.intervals : [],
    reflections: Array.isArray(raw.reflections) ? raw.reflections : [],
    resources: Array.isArray(raw.resources) ? raw.resources : []
  };
}

const id = () => globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const clean = (value, max) => String(value ?? '').trim().slice(0, max);
const fail = message => { throw new Error(message); };

/** Accept a domain or HTTP(S) URL, then always operate on the domain and subdomains. */
export function normalizeDomain(input) {
  const value = clean(input, 500);
  if (!value || /\s/.test(value)) fail('Enter a valid website domain, such as youtube.com.');
  let url;
  try { url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`); }
  catch { fail(`“${value}” is not a valid website domain.`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail(`“${value}” is not a valid HTTP or HTTPS site.`);
  const host = url.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  const parts = host.split('.');
  if (parts.length < 2 || host.length > 253 || /^\d+(?:\.\d+){3}$/.test(host) || parts.some(part => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))) {
    fail(`“${value}” needs a public domain, such as example.com.`);
  }
  return host;
}

export function parseSites(input) {
  const values = Array.isArray(input) ? input : String(input ?? '').split(/[\n,]+/);
  const result = [...new Set(values.map(value => String(value).trim()).filter(Boolean).map(normalizeDomain))];
  if (result.length > MAX_SITES) fail(`Choose no more than ${MAX_SITES} sites per list.`);
  return result;
}

export const hostMatches = (host, domain) => {
  const normalized = String(host).toLowerCase().replace(/\.$/, '');
  return normalized === domain || normalized.endsWith(`.${domain}`);
};
export function permissionOrigins(sites) {
  return parseSites(sites).map(site => `*://*.${site}/*`);
}
export function httpUrl(input, required = false) {
  const value = clean(input, 2048);
  if (!value) {
    if (required) fail('Add a link starting with https:// or http://.');
    return '';
  }
  let url;
  try { url = new URL(value); } catch { fail('Enter a valid link starting with https:// or http://.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail('Only HTTP and HTTPS links are supported.');
  return url.href;
}

export function timeLeft(session, now = Date.now()) {
  if (!session) return 0;
  return Math.max(0, session.status === 'running' ? session.endsAt - now : session.remainingMs);
}
export function isBlocking(state, now = Date.now()) {
  const s = state.session;
  return Boolean(s && s.status === 'running' && timeLeft(s, now) > 0 && s.strict && state.settings.blockedSites.length && !(s.overrideUntil > now));
}
export function isOverridden(state, now = Date.now()) {
  return Boolean(state.session?.status === 'running' && state.session.overrideUntil > now && timeLeft(state.session, now) > 0);
}

function completeSession(state, at) {
  const session = state.session;
  if (!session) return;
  const remaining = timeLeft(session, at);
  state.sessions.unshift({
    id: session.id, taskId: session.taskId, taskTitle: session.taskTitle,
    startedAt: session.startedAt, endedAt: at,
    elapsedMs: Math.max(0, session.totalMs - remaining),
    completed: remaining === 0
  });
  state.sessions = state.sessions.slice(0, 200);
  state.session = null;
}
function expireSession(state, now) {
  if (state.session?.status === 'running' && state.session.endsAt <= now) completeSession(state, state.session.endsAt);
  if (state.session?.overrideUntil && state.session.overrideUntil <= now) state.session.overrideUntil = null;
}
function prune(state, now) {
  const cutoff = now - 7 * DAY;
  state.intervals = state.intervals.filter(item => item.end > cutoff).map(item => item.start < cutoff ? { ...item, start: cutoff } : item).slice(-5000);
  state.reflections = state.reflections.filter(item => item.createdAt > now - 90 * DAY).slice(-200);
  state.sessions = state.sessions.filter(item => item.endedAt > now - 90 * DAY).slice(0, 200);
}
function taskById(state, taskId) {
  const task = state.tasks.find(item => item.id === taskId);
  if (!task) fail('That task is no longer available.');
  return task;
}
function sessionRequired(state) {
  if (!state.session) fail('There is no active session.');
  return state.session;
}
function assertTaskUrlNotBlocked(state, task, strict) {
  if (!strict || !task.url) return;
  const host = new URL(task.url).hostname.toLowerCase();
  if (state.settings.blockedSites.some(site => hostMatches(host, site))) {
    fail('Your task link is on a blocked site. Remove that site from the block list before starting.');
  }
}

function upsertTask(state, data, now) {
  const title = clean(data.title, 120);
  if (!title) fail('Give your task a name.');
  const topic = clean(data.topic, 120);
  const url = httpUrl(data.url);
  const dueDate = clean(data.dueDate, 10);
  if (dueDate) {
    const parsedDue = new Date(`${dueDate}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || !Number.isFinite(parsedDue.getTime()) || parsedDue.toISOString().slice(0, 10) !== dueDate) fail('Enter a valid due date.');
  }
  const hasStart = data.plannedStart != null && data.plannedStart !== '';
  const hasEnd = data.plannedEnd != null && data.plannedEnd !== '';
  const plannedStart = hasStart ? Number(data.plannedStart) : null;
  const plannedEnd = hasEnd ? Number(data.plannedEnd) : null;
  if (hasStart !== hasEnd || (hasStart && (!Number.isFinite(plannedStart) || !Number.isFinite(plannedEnd) || plannedEnd <= plannedStart || plannedEnd - plannedStart > 24 * 60 * MINUTE))) {
    fail('Choose a valid work window up to 24 hours long.');
  }
  const existing = data.id ? taskById(state, data.id) : null;
  if (existing && state.session?.taskId === existing.id && state.session.strict) {
    assertTaskUrlNotBlocked(state, { url }, true);
  }
  const task = { id: existing?.id || id(), title, topic, url, dueDate, plannedStart, plannedEnd, completed: existing?.completed || false, createdAt: existing?.createdAt || now, updatedAt: now };
  if (existing) state.tasks[state.tasks.findIndex(item => item.id === existing.id)] = task;
  else state.tasks.unshift(task);
  if (!state.currentTaskId || !existing) state.currentTaskId = task.id;
  if (state.session?.taskId === task.id) {
    state.session.taskTitle = title;
    state.session.taskUrl = url;
  }
}

function saveSettings(state, data) {
  const blockedSites = parseSites(data.blockedSites);
  const trackedSites = parseSites(data.trackedSites);
  const reminderTime = clean(data.reminderTime || '09:00', 5);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(reminderTime)) fail('Choose a valid check-in time.');
  const strict = data.strict !== false;
  const activityEnabled = Boolean(data.activityEnabled);
  if (activityEnabled && !trackedSites.length) fail('Choose at least one site before turning on activity tracking.');
  if (state.session?.strict && state.session.taskUrl) {
    const host = new URL(state.session.taskUrl).hostname.toLowerCase();
    if (blockedSites.some(site => hostMatches(host, site))) fail('Your current task link is on that list. Remove it from the block list first.');
  }
  state.settings = { strict, blockedSites, trackedSites, activityEnabled, reminderTime };
  if (!activityEnabled) state.observation = null;
}

/** Close the previous sampled foreground interval, then optionally begin another. */
function recordObservation(state, data, now) {
  const previous = state.observation;
  if (previous) {
    const end = Math.min(now, previous.lastSeenAt + MAX_OBSERVATION_GAP, previous.windowEnd);
    if (end > previous.since) {
      const interval = { taskId: previous.taskId, taskTitle: previous.taskTitle, host: previous.host, start: previous.since, end };
      const last = state.intervals.at(-1);
      if (last && last.taskId === interval.taskId && last.host === interval.host && Math.abs(last.end - interval.start) <= 1000) last.end = interval.end;
      else state.intervals.push(interval);
    }
  }
  state.observation = null;
  if (!state.settings.activityEnabled || !data || !data.host || !data.taskId) return;
  const host = String(data.host).toLowerCase();
  const task = state.tasks.find(item => item.id === data.taskId);
  if (!task || task.completed || !task.plannedStart || !task.plannedEnd || now < task.plannedStart || now >= task.plannedEnd || !state.settings.trackedSites.some(site => hostMatches(host, site))) return;
  state.observation = { taskId: task.id, taskTitle: task.title, host, since: now, lastSeenAt: now, windowEnd: task.plannedEnd };
}

export function applyCommand(raw, command, now = Date.now(), options = {}) {
  const state = structuredClone(normalizeState(raw));
  expireSession(state, now);
  prune(state, now);
  switch (command?.type) {
    case 'TICK': break;
    case 'UPSERT_TASK': upsertTask(state, command.data || {}, now); break;
    case 'SELECT_TASK': taskById(state, command.id); state.currentTaskId = command.id; break;
    case 'TOGGLE_TASK': {
      const task = taskById(state, command.id);
      if (state.session?.taskId === task.id) fail('End this task’s active session first.');
      task.completed = !task.completed;
      task.updatedAt = now;
      break;
    }
    case 'DELETE_TASK': {
      taskById(state, command.id);
      if (state.session?.taskId === command.id) fail('End this task’s active session first.');
      state.tasks = state.tasks.filter(task => task.id !== command.id);
      if (state.currentTaskId === command.id) state.currentTaskId = state.tasks.find(task => !task.completed)?.id || state.tasks[0]?.id || null;
      if (state.observation?.taskId === command.id) state.observation = null;
      break;
    }
    case 'SAVE_SETTINGS': saveSettings(state, command.data || {}); break;
    case 'START_SESSION': {
      if (state.session) fail('End the current session before starting another.');
      const task = taskById(state, command.taskId || state.currentTaskId);
      if (task.completed) fail('Reopen this task before starting a session.');
      const minutes = Number(command.minutes);
      if (!Number.isInteger(minutes) || minutes < 5 || minutes > 180) fail('Choose a session between 5 and 180 minutes.');
      const strict = state.settings.strict && options.blockingAvailable !== false;
      assertTaskUrlNotBlocked(state, task, strict);
      state.currentTaskId = task.id;
      state.session = { id: id(), taskId: task.id, taskTitle: task.title, taskUrl: task.url, startedAt: now, totalMs: minutes * MINUTE, remainingMs: minutes * MINUTE, endsAt: now + minutes * MINUTE, status: 'running', strict, overrideUntil: null };
      break;
    }
    case 'PAUSE_SESSION': {
      const session = sessionRequired(state);
      if (session.status !== 'running') fail('The session is already paused.');
      session.remainingMs = timeLeft(session, now);
      session.status = 'paused';
      session.endsAt = null;
      session.overrideUntil = null;
      break;
    }
    case 'RESUME_SESSION': {
      const session = sessionRequired(state);
      if (session.status !== 'paused') fail('The session is already running.');
      const task = taskById(state, session.taskId);
      assertTaskUrlNotBlocked(state, task, session.strict);
      session.status = 'running';
      session.endsAt = now + session.remainingMs;
      break;
    }
    case 'ALLOW_TEMPORARY': {
      const session = sessionRequired(state);
      if (session.status !== 'running' || !session.strict || !state.settings.blockedSites.length) fail('There are no active site rules to temporarily allow.');
      session.overrideUntil = Math.min(now + 10 * MINUTE, session.endsAt);
      break;
    }
    case 'RESTORE_BLOCKING': {
      const session = sessionRequired(state);
      session.overrideUntil = null;
      break;
    }
    case 'END_SESSION': sessionRequired(state); completeSession(state, now); break;
    case 'RECORD_OBSERVATION': recordObservation(state, command.data, now); break;
    case 'CLEAR_ACTIVITY': state.intervals = []; state.observation = null; break;
    case 'SAVE_REFLECTION': {
      const day = clean(command.day, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) fail('That check-in is no longer available.');
      state.reflections = state.reflections.filter(item => item.day !== day);
      state.reflections.push({ day, answer: clean(command.answer, 500), skipped: Boolean(command.skipped), createdAt: now });
      break;
    }
    case 'CLEAR_REFLECTIONS': state.reflections = []; break;
    case 'SAVE_RESOURCE': {
      const data = command.data || {};
      const title = clean(data.title, 160);
      if (!title) fail('Give your resource a title.');
      const url = httpUrl(data.url, true);
      const existing = data.id ? state.resources.find(resource => resource.id === data.id) : null;
      if (data.id && !existing) fail('That resource is no longer available.');
      let thumbnail = data.thumbnail || '';
      if (thumbnail && (!/^data:image\/(?:png|jpeg|webp);base64,[a-z\d+/=]+$/i.test(thumbnail) || thumbnail.length > 350_000)) fail('Choose a smaller PNG, JPEG, or WebP thumbnail.');
      const resource = { id: existing?.id || id(), title, url, creator: clean(data.creator, 100), topic: clean(data.topic, 100), note: clean(data.note, 500), thumbnail, createdAt: existing?.createdAt || now };
      if (existing) state.resources[state.resources.findIndex(item => item.id === existing.id)] = resource;
      else {
        if (state.resources.length >= 50) fail('Your local library can hold up to 50 resources.');
        state.resources.unshift(resource);
      }
      break;
    }
    case 'DELETE_RESOURCE': state.resources = state.resources.filter(resource => resource.id !== command.id); break;
    default: fail('Unknown action.');
  }
  return state;
}

export function localDayKey(timestamp) {
  const date = new Date(timestamp);
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** A next-day prompt is available only for recorded overlap, never inferred browsing. */
export function pendingCheckIn(state, now = Date.now()) {
  if (!state.settings.activityEnabled) return null;
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  const day = localDayKey(yesterday);
  if (state.reflections.some(item => item.day === day)) return null;
  const [hour, minute] = (state.settings.reminderTime || '09:00').split(':').map(Number);
  const reminder = new Date(today); reminder.setHours(hour, minute, 0, 0);
  if (now < reminder.getTime()) return null;
  const groups = new Map();
  for (const interval of state.intervals) {
    const start = Math.max(interval.start, yesterday.getTime());
    const end = Math.min(interval.end, today.getTime());
    if (end <= start) continue;
    const key = `${interval.taskId}\n${interval.host}`;
    const group = groups.get(key) || { taskId: interval.taskId, taskTitle: interval.taskTitle, host: interval.host, duration: 0, firstAt: start };
    group.duration += end - start;
    group.firstAt = Math.min(group.firstAt, start);
    groups.set(key, group);
  }
  const largest = [...groups.values()].filter(group => group.duration >= 5 * MINUTE).sort((a, b) => b.duration - a.duration)[0];
  return largest ? { ...largest, day } : null;
}

/** Deliberately a keyword comparison, not a relevance classifier or AI. */
export function checkTitle(task, title) {
  const source = clean(task?.topic || task?.title, 120).toLocaleLowerCase();
  const words = [...new Set((source.match(/[\p{L}\p{N}]+/gu) || []).filter(word => word.length >= 3 && !STOP_WORDS.has(word)))];
  const pageWords = new Set((clean(title, 500).toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) || []));
  const matched = words.filter(word => pageWords.has(word));
  if (!words.length) return { status: 'uncertain', matched: [], message: 'Add a more specific topic to your task for a useful keyword check.' };
  if (matched.length) return { status: 'match', matched, message: `This title shares ${matched.length === 1 ? 'a keyword' : 'keywords'} with your task: ${matched.join(', ')}.` };
  return { status: 'uncertain', matched: [], message: 'No task keywords appeared in this title. That does not necessarily mean the page is off-task.' };
}
