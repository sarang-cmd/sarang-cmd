import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, checkTitle, hostMatches, initialState, isBlocking, localDayKey, normalizeDomain, parseSites, pendingCheckIn, permissionOrigins, timeLeft } from '../core.js';

const start = new Date(2026, 9, 28, 14, 0).getTime();
const minute = 60_000;
const command = (state, type, data, now = start) => applyCommand(state, { type, ...data }, now);
function withTask(options = {}) {
  return command(initialState(), 'UPSERT_TASK', { data: { title: 'Finish chemistry', topic: 'gas stoichiometry', ...options } });
}
function withSites(state, options = {}) {
  return command(state, 'SAVE_SETTINGS', { data: { blockedSites: ['youtube.com'], trackedSites: [], strict: true, ...options } });
}

test('site parsing uses exact domain boundaries and generates per-domain permission patterns', () => {
  assert.equal(normalizeDomain('https://www.YouTube.com/watch?v=1'), 'youtube.com');
  assert.deepEqual(parseSites('YouTube.com, youtube.com\nhttps://reddit.com/r/a'), ['youtube.com', 'reddit.com']);
  assert.equal(hostMatches('m.youtube.com', 'youtube.com'), true);
  assert.equal(hostMatches('m.youtube.com.', 'youtube.com'), true);
  assert.equal(hostMatches('notyoutube.com', 'youtube.com'), false);
  assert.equal(hostMatches('youtube.com.evil.test', 'youtube.com'), false);
  assert.deepEqual(permissionOrigins(['youtube.com']), ['*://*.youtube.com/*']);
  for (const value of ['localhost', 'https://user:pass@example.com/', 'javascript:alert(1)', '*.example.com', '127.0.0.1']) assert.throws(() => normalizeDomain(value));
});

test('session timers pause, resume, expire, and preserve elapsed time', () => {
  let s = withSites(withTask());
  s = command(s, 'START_SESSION', { minutes: 25 });
  assert.equal(isBlocking(s, start + minute), true);
  s = command(s, 'PAUSE_SESSION', {}, start + 5 * minute);
  assert.equal(timeLeft(s.session, start + 20 * minute), 20 * minute);
  assert.equal(isBlocking(s, start + 20 * minute), false);
  s = command(s, 'RESUME_SESSION', {}, start + 20 * minute);
  assert.equal(isBlocking(s, start + 20 * minute), true);
  s = command(s, 'TICK', {}, start + 41 * minute);
  assert.equal(s.session, null);
  assert.equal(s.sessions.length, 1);
  assert.equal(s.sessions[0].elapsedMs, 25 * minute);
  assert.equal(s.sessions[0].completed, true);
  assert.equal(s.sessions[0].endedAt, start + 40 * minute);
});

test('temporary allow lasts ten minutes at most and clears on pause', () => {
  let s = withSites(withTask());
  s = command(s, 'START_SESSION', { minutes: 25 });
  s = command(s, 'ALLOW_TEMPORARY', {}, start + minute);
  assert.equal(isBlocking(s, start + 10 * minute), false);
  assert.equal(isBlocking(s, start + 11 * minute), true);
  s = command(s, 'TICK', {}, start + 11 * minute);
  assert.equal(s.session.overrideUntil, null);
  s = command(s, 'ALLOW_TEMPORARY', {}, start + 12 * minute);
  s = command(s, 'PAUSE_SESSION', {}, start + 13 * minute);
  assert.equal(s.session.overrideUntil, null);
});

test('task URL cannot be placed behind the same site block', () => {
  let s = withSites(withTask({ url: 'https://www.youtube.com/watch?v=topic' }));
  assert.throws(() => command(s, 'START_SESSION', { minutes: 25 }), /task link/);
  s = command(s, 'SAVE_SETTINGS', { data: { blockedSites: [], trackedSites: [], strict: true } });
  s = command(s, 'START_SESSION', { minutes: 25 });
  assert.throws(() => command(s, 'SAVE_SETTINGS', { data: { blockedSites: ['youtube.com'], trackedSites: [], strict: true } }), /task link/);
});

test('settings, task and library reject malformed and executable inputs', () => {
  assert.throws(() => command(initialState(), 'UPSERT_TASK', { data: { title: '', url: '' } }), /name/);
  assert.throws(() => command(initialState(), 'UPSERT_TASK', { data: { title: 'x', url: 'javascript:alert(1)' } }), /HTTP/);
  assert.throws(() => command(initialState(), 'UPSERT_TASK', { data: { title: 'x', plannedStart: start, plannedEnd: start - minute } }), /work window/);
  assert.throws(() => command(initialState(), 'SAVE_SETTINGS', { data: { activityEnabled: true, trackedSites: [] } }), /at least one/);
  assert.throws(() => command(initialState(), 'SAVE_RESOURCE', { data: { title: 'x', url: 'data:text/html,x' } }), /HTTP/);
  const s = command(initialState(), 'SAVE_RESOURCE', { data: { title: 'A real resource', url: 'https://example.com/watch', creator: 'A teacher' } });
  assert.equal(s.resources[0].creator, 'A teacher');
  assert.equal(s.resources[0].thumbnail, '');
});

test('activity only records opted-in matching foreground observations in a planned window', () => {
  let s = withTask({ plannedStart: start, plannedEnd: start + 30 * minute });
  const taskId = s.currentTaskId;
  const sample = (state, host, at) => command(state, 'RECORD_OBSERVATION', { data: { taskId, host } }, at);
  s = sample(s, 'youtube.com', start);
  assert.equal(s.observation, null);
  s = withSites(s, { trackedSites: ['youtube.com'], activityEnabled: true });
  s = sample(s, 'notyoutube.com', start);
  assert.equal(s.observation, null);
  s = sample(s, 'm.youtube.com', start + minute);
  s = sample(s, 'm.youtube.com', start + 2 * minute);
  s = command(s, 'RECORD_OBSERVATION', { data: null }, start + 2.5 * minute);
  assert.deepEqual(s.intervals.map(({ host, start: a, end }) => [host, a, end]), [['m.youtube.com', start + minute, start + 2.5 * minute]]);
  s = sample(s, 'youtube.com', start + 31 * minute);
  assert.equal(s.observation, null);
});

test('observations do not inflate after a sleeping or terminated browser', () => {
  let s = withTask({ plannedStart: start, plannedEnd: start + 60 * minute });
  s = withSites(s, { trackedSites: ['youtube.com'], activityEnabled: true });
  const taskId = s.currentTaskId;
  s = command(s, 'RECORD_OBSERVATION', { data: { taskId, host: 'youtube.com' } }, start);
  s = command(s, 'RECORD_OBSERVATION', { data: null }, start + 40 * minute);
  assert.equal(s.intervals[0].end - s.intervals[0].start, 75_000);
});

test('a check-in requires real five-minute overlap yesterday, correct time, and can be skipped', () => {
  const yesterday = new Date(2026, 9, 28, 14).getTime();
  const todayBefore = new Date(2026, 9, 29, 8, 59).getTime();
  const todayAfter = new Date(2026, 9, 29, 9, 1).getTime();
  let s = withSites(withTask(), { trackedSites: ['youtube.com'], activityEnabled: true, reminderTime: '09:00' });
  s.intervals = [{ taskId: s.currentTaskId, taskTitle: 'Finish chemistry', host: 'youtube.com', start: yesterday, end: yesterday + 4 * minute }];
  assert.equal(pendingCheckIn(s, todayAfter), null);
  s.intervals[0].end += minute;
  assert.equal(pendingCheckIn(s, todayBefore), null);
  assert.equal(pendingCheckIn(s, todayAfter)?.day, localDayKey(yesterday));
  s = command(s, 'SAVE_REFLECTION', { day: localDayKey(yesterday), skipped: true }, todayAfter);
  assert.equal(pendingCheckIn(s, todayAfter), null);
});

test('check-in splits an interval at local midnight instead of attributing the whole visit to yesterday', () => {
  const midnight = new Date(2026, 9, 29).getTime();
  const now = new Date(2026, 9, 29, 10).getTime();
  let s = withSites(withTask(), { trackedSites: ['youtube.com'], activityEnabled: true });
  s.intervals = [{ taskId: s.currentTaskId, taskTitle: 'Task', host: 'youtube.com', start: midnight - 2 * minute, end: midnight + 20 * minute }];
  assert.equal(pendingCheckIn(s, now), null);
});

test('keyword comparison is transparent about uncertainty and does not pretend to infer relevance', () => {
  const task = { title: 'Chemistry', topic: 'gas stoichiometry' };
  assert.equal(checkTitle(task, 'How Teflon is made: chemistry').status, 'uncertain');
  assert.match(checkTitle(task, 'How Teflon is made: chemistry').message, /does not necessarily/);
  assert.deepEqual(checkTitle(task, 'Stoichiometry for gas reactions').matched, ['gas', 'stoichiometry']);
});

test('due dates and work windows reject impossible dates and non-finite timestamps', () => {
  assert.throws(() => command(initialState(), 'UPSERT_TASK', { data: { title: 'Task', dueDate: '2026-02-30' } }), /valid due date/);
  assert.throws(() => command(initialState(), 'UPSERT_TASK', { data: { title: 'Task', plannedStart: 'nope', plannedEnd: 'also nope' } }), /work window/);
});

test('retention removes old observations, sessions and reflections when the app next runs', () => {
  const now = new Date(2026, 9, 29, 12).getTime();
  const day = 24 * 60 * minute;
  let s = withTask();
  s.intervals = [
    { host: 'example.test', taskId: s.currentTaskId, taskTitle: 'Task', start: now - 9 * day, end: now - 8 * day },
    { host: 'example.test', taskId: s.currentTaskId, taskTitle: 'Task', start: now - 8 * day, end: now - 6 * day }
  ];
  s.sessions = [{ endedAt: now - 91 * day }, { endedAt: now - day }];
  s.reflections = [{ createdAt: now - 91 * day }, { createdAt: now - day }];
  s = command(s, 'TICK', {}, now);
  assert.equal(s.intervals.length, 1);
  assert.equal(s.intervals[0].start, now - 7 * day);
  assert.equal(s.sessions.length, 1);
  assert.equal(s.reflections.length, 1);
});

test('next-day reminder uses local wall time across daylight-saving transitions', () => {
  const oldTZ = process.env.TZ;
  process.env.TZ = 'Europe/Berlin';
  try {
    for (const date of [[2026, 2, 29], [2026, 9, 25]]) {
      const todayNine = new Date(date[0], date[1], date[2], 9).getTime();
      const yesterday = new Date(date[0], date[1], date[2] - 1, 15).getTime();
      let s = withSites(withTask(), { trackedSites: ['youtube.com'], activityEnabled: true, reminderTime: '09:00' });
      s.intervals = [{ taskId: s.currentTaskId, taskTitle: 'Task', host: 'youtube.com', start: yesterday, end: yesterday + 6 * minute }];
      assert.equal(pendingCheckIn(s, todayNine - 1), null);
      assert.ok(pendingCheckIn(s, todayNine));
    }
  } finally {
    if (oldTZ === undefined) delete process.env.TZ; else process.env.TZ = oldTZ;
  }
});

test('standalone preview can run a timer without pretending site blocking exists', () => {
  const s = withSites(withTask({ url: 'https://www.youtube.com/watch?v=work' }));
  const preview = applyCommand(s, { type: 'START_SESSION', minutes: 25 }, start, { blockingAvailable: false });
  assert.equal(preview.session.status, 'running');
  assert.equal(preview.session.strict, false);
  assert.equal(isBlocking(preview, start), false);
});

test('a fresh profile has strict focus selected but does not record activity or invent tasks', () => {
  const s = initialState();
  assert.equal(s.settings.strict, true);
  assert.equal(s.settings.activityEnabled, false);
  assert.deepEqual(s.settings.blockedSites, []);
  assert.deepEqual(s.tasks, []);
  assert.deepEqual(s.resources, []);
  assert.deepEqual(s.intervals, []);
});
