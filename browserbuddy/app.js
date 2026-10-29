import { STORAGE_KEY, checkTitle, hostMatches, initialState, isBlocking, isOverridden, localDayKey, parseSites, pendingCheckIn, permissionOrigins, timeLeft } from './core.js';
import { dispatch, getState, inExtension, reset } from './backend.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const icon = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
let state = initialState();
let meta = { mode: inExtension ? 'extension' : 'web', missingSites: [], activityPermission: false };
let route = 'today';
let selectedMinutes = 25;
let libraryQuery = '';
let expirationPending = false;
let toastTimer;
let bannerVisible = !inExtension;
let settingsDirty = false;
let renderPending = false;
let renderedCheckInDay = '';

function safeLink(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? escapeHtml(url.href) : '';
  } catch { return ''; }
}
function currentTask() {
  if (state.session) return state.tasks.find(item => item.id === state.session.taskId) || null;
  return state.tasks.find(item => item.id === state.currentTaskId && !item.completed) || state.tasks.find(item => !item.completed) || null;
}
function fmtDuration(ms) {
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return 'less than a minute';
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60), left = mins % 60;
  return `${hours} hr${hours === 1 ? '' : 's'}${left ? ` ${left} min` : ''}`;
}
function formatTimer(ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
function dueText(value) {
  if (!value) return '';
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
  if (value === localDayKey(today)) return 'Due today';
  if (value === localDayKey(tomorrow)) return 'Due tomorrow';
  const text = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', ...(date.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) }).format(date);
  return date < today ? `Was due ${text}` : `Due ${text}`;
}
function plannedText(task) {
  if (!task?.plannedStart) return '';
  const date = new Date(task.plannedStart);
  return `Planned ${new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date)} for ${fmtDuration(task.plannedEnd - task.plannedStart)}`;
}
function metaText(task) { return [task.topic, dueText(task.dueDate), plannedText(task)].filter(Boolean).join(' · '); }
function titleSafe(task) { return escapeHtml(task?.title || 'Untitled task'); }
function toast(message, error = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('error', error);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 5000);
}
function applyResult(result, redraw = true) {
  state = result.state;
  meta = result.meta || meta;
  if (redraw) render();
}
async function command(cmd, message) {
  const result = await dispatch(cmd);
  applyResult(result);
  if (message) toast(message);
  return result;
}
function updateChrome() {
  document.title = `${{ today: 'Today', focus: 'Focus session', library: 'Library', insights: 'Check-ins', settings: 'Settings' }[route]} | BrowserBuddy`;
  for (const link of $$('[data-route]')) {
    if (link.dataset.route === route) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  $('#mode-label').textContent = inExtension ? 'Extension connected' : 'Dashboard preview';
  const banner = $('#mode-banner');
  banner.hidden = !bannerVisible;
  banner.innerHTML = inExtension
    ? `This dashboard uses the extension’s local data. Blocking applies only to sites you choose in this browser. <a href="#settings">Manage settings</a>`
    : `This standalone dashboard saves data in this browser only. It is <strong>not connected to the extension</strong>, and cannot block sites or collect activity. <a href="#settings">How to install the extension</a>`;
}

function checkInPanel() {
  const pending = pendingCheckIn(state);
  if (pending) return `<section class="panel checkin-panel" aria-labelledby="checkin-heading"><p class="eyebrow">A GENTLE CHECK-IN</p><h2 id="checkin-heading">A moment to reflect.</h2><p>Yesterday, about ${escapeHtml(fmtDuration(pending.duration))} on <strong>${escapeHtml(pending.host)}</strong> overlapped with your planned time for ${escapeHtml(pending.taskTitle)}. Was that how you intended to spend it?</p><button class="text-link" type="button" data-action="reflect">Reflect, if you like ${icon('arrow')}</button></section>`;
  const message = !inExtension
    ? 'Optional check-ins use real activity recorded by the extension. There is no activity data in this preview.'
    : state.settings.activityEnabled
      ? 'When approved activity overlaps a planned work window, you can reflect the next day. Nothing to review right now.'
      : 'Want a little perspective later? You can choose to record activity during planned work windows.';
  return `<section class="panel checkin-panel" aria-labelledby="checkin-heading"><p class="eyebrow">A GENTLE CHECK-IN</p><h2 id="checkin-heading">Notice, without judgment.</h2><p>${message}</p><a class="text-link" href="${state.settings.activityEnabled ? '#insights' : '#settings'}">${state.settings.activityEnabled ? 'See your check-ins' : 'Explore check-in settings'} ${icon('arrow')}</a></section>`;
}
function taskRow(task) {
  const selected = task.id === state.currentTaskId;
  const info = metaText(task) || 'No due date or work window added';
  return `<div class="task-row"><button class="task-toggle ${task.completed ? 'is-done' : ''}" type="button" data-action="toggle-task" data-id="${escapeHtml(task.id)}" aria-label="${task.completed ? 'Reopen' : 'Mark complete'}: ${titleSafe(task)}">${task.completed ? icon('check') : ''}</button><div><div class="task-title ${task.completed ? 'is-done' : ''}">${titleSafe(task)}</div><div class="task-meta">${escapeHtml(info)}</div></div><div class="task-actions">${!task.completed ? `<button type="button" class="text-link task-select" data-action="select-task" data-id="${escapeHtml(task.id)}">${state.session ? (selected ? 'Next session' : 'Choose next') : (selected ? 'Selected' : 'Use for focus')}</button>` : ''}<button class="icon-button" type="button" data-action="edit-task" data-id="${escapeHtml(task.id)}" aria-label="Edit ${titleSafe(task)}">${icon('edit')}</button></div></div>`;
}
function renderToday() {
  const task = currentTask();
  const taskPanel = task
    ? `<section class="panel intention-panel" aria-labelledby="intention-heading"><div class="panel-topline"><p class="eyebrow">YOUR NEXT STEP</p><span class="tiny-pill">${state.session ? (state.session.status === 'paused' ? 'PAUSED' : 'IN SESSION') : 'READY WHEN YOU ARE'}</span></div><h2 id="intention-heading">${titleSafe(task)}</h2><p class="meta-line">${escapeHtml(metaText(task) || 'One thing at a time.')}</p><a class="button button-primary" href="#focus">${state.session ? 'Go to your session' : 'Set up a focus session'} ${icon('arrow')}</a></section>`
    : `<section class="panel intention-panel" aria-labelledby="intention-heading"><div class="panel-topline"><p class="eyebrow">YOUR NEXT STEP</p><span class="tiny-pill">START HERE</span></div><h2 id="intention-heading">What are you working on?</h2><p class="panel-copy">Give it a name, add a work window if you like, and take the first small step.</p><button class="button button-primary empty-button" type="button" data-action="add-task">${icon('plus')} Add your first task</button></section>`;
  const tasks = state.tasks.length ? state.tasks.map(taskRow).join('') : '<div class="empty-list">Your tasks will appear here. Start with one that matters to you.</div>';
  return `<div class="page"><section class="hero"><div class="hero-copy"><p class="eyebrow">A LITTLE SPACE FOR WHAT MATTERS</p><h1>Come back to<br><em>your task.</em></h1><p>Pick one thing to work on. Buddy will help you keep it in sight.</p></div><img class="hero-art" src="assets/mascot.png" alt="Buddy sitting with a notebook"></section><div class="dashboard-grid">${taskPanel}${checkInPanel()}</div><section class="task-section" aria-labelledby="tasks-heading"><div class="section-heading"><div><p class="eyebrow">ONE THING AT A TIME</p><h2 id="tasks-heading">Your tasks</h2></div><button class="text-link" type="button" data-action="add-task">${icon('plus')} Add a task</button></div><div class="task-list">${tasks}</div></section>${!state.tasks.length ? `<section class="starter" aria-label="Getting started"><p class="eyebrow">GETTING STARTED</p><div class="starter-steps"><span><b>01</b> Add a task</span><span><b>02</b> Choose your site rules</span><span><b>03</b> Start a session</span></div></section>` : ''}</div>`;
}
function protectionCopy() {
  if (!inExtension) return 'Timer only in this preview. Install the extension to block sites.';
  if (!state.session?.strict) return 'Site blocking is off for this session.';
  if (!state.settings.blockedSites.length) return 'No sites selected to block yet.';
  if (state.session.status === 'paused') return 'Session paused. Your selected sites are available.';
  if (isOverridden(state)) return 'Selected sites are temporarily allowed. Your timer keeps running.';
  if (meta.missingSites?.length) return `Site access is missing for ${meta.missingSites.join(', ')}.`;
  return `${state.settings.blockedSites.length} selected ${state.settings.blockedSites.length === 1 ? 'site is' : 'sites are'} blocked during this session.`;
}
function taskPageButton(task, label = 'Open task page') {
  const href = safeLink(task?.url);
  return href ? `<a class="button button-secondary" href="${href}" target="_blank" rel="noopener noreferrer">${label} ${icon('external')}</a>` : '';
}
function renderFocus() {
  const task = currentTask();
  let main;
  if (!task) {
    main = `<div class="panel focus-main"><p class="eyebrow">START WITH AN INTENTION</p><h2>First, choose what you’re working on.</h2><p>A task gives your session somewhere to begin and somewhere to return.</p><button class="button button-primary" type="button" data-action="add-task">${icon('plus')} Add a task</button></div>`;
  } else if (!state.session) {
    main = `<div class="panel focus-main"><p class="eyebrow">YOUR CURRENT TASK</p><div class="current-task"><h2>${titleSafe(task)}</h2><p>${escapeHtml(metaText(task) || 'Ready when you are.')}</p></div><div class="focus-setup"><label for="session-minutes">How long would you like to focus?<select id="session-minutes"><option value="25" ${selectedMinutes === 25 ? 'selected' : ''}>25 minutes</option><option value="45" ${selectedMinutes === 45 ? 'selected' : ''}>45 minutes</option><option value="60" ${selectedMinutes === 60 ? 'selected' : ''}>1 hour</option><option value="90" ${selectedMinutes === 90 ? 'selected' : ''}>1 hour 30 minutes</option><option value="120" ${selectedMinutes === 120 ? 'selected' : ''}>2 hours</option><option value="180" ${selectedMinutes === 180 ? 'selected' : ''}>3 hours</option></select></label><div class="focus-setup-actions"><button class="button button-primary" type="button" data-action="start-session">Start focus session ${icon('arrow')}</button>${taskPageButton(task)}</div><p class="helper">${!inExtension ? 'The standalone dashboard is a timer only. It cannot block websites.' : state.settings.strict ? (state.settings.blockedSites.length ? 'Your selected sites will be blocked while the session is running. Chrome may ask for site access.' : 'Strict focus is on, but your block list is empty. Choose sites in Settings to block them.') : 'Site blocking is off in Settings. You can still use the timer.'}</p></div></div>`;
  } else {
    const s = state.session;
    const left = timeLeft(s);
    const percent = s.totalMs ? Math.max(0, Math.min(100, left / s.totalMs * 100)) : 0;
    const status = s.status === 'paused' ? 'PAUSED' : isOverridden(state) ? 'TEMPORARILY ALLOWED' : 'SESSION IN PROGRESS';
    main = `<div class="panel focus-main"><div class="panel-topline"><p class="eyebrow">YOUR FOCUS SESSION</p><span class="status-text"><span class="status-dot"></span>${status}</span></div><div class="timer-wrap"><div class="timer-visual"><svg viewBox="0 0 100 100" aria-hidden="true"><circle class="timer-track" cx="50" cy="50" r="44"></circle><circle class="timer-progress" cx="50" cy="50" r="44" pathLength="100" stroke-dasharray="${percent} 100"></circle></svg><div class="timer-center"><span class="timer-time" data-countdown>${formatTimer(left)}</span><span class="timer-caption">${s.status === 'paused' ? 'PAUSED' : 'REMAINING'}</span></div></div><div class="timer-details"><h3>${titleSafe(task)}</h3><p>${escapeHtml(metaText(task) || 'You’re making room for this.')}</p><p class="helper" data-protection-copy>${escapeHtml(protectionCopy())}</p></div></div><div class="timer-actions">${s.status === 'running' ? `<button class="button button-secondary" type="button" data-action="pause-session">Pause session</button>` : `<button class="button button-primary" type="button" data-action="resume-session">Resume session ${icon('arrow')}</button>`}${taskPageButton(task, 'Back to task')}<button class="button button-quiet" type="button" data-action="end-session">End session</button></div>${s.status === 'running' && s.strict && state.settings.blockedSites.length && inExtension ? `<div class="notice">${isOverridden(state) ? `<strong>Sites are available for now.</strong> Protection returns at ${escapeHtml(new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(s.overrideUntil)))} or when you choose. <button class="text-link" type="button" data-action="restore-blocking">Resume blocking</button>` : `<strong>Need a little room?</strong> You can temporarily allow your selected sites for 10 minutes. The timer continues. <button class="text-link" type="button" data-action="allow-temporary">Temporarily allow sites</button>`}</div>` : ''}</div>`;
  }
  const blockLabel = !inExtension ? 'Available in the extension' : !state.settings.strict ? 'Off for new sessions' : state.settings.blockedSites.length ? `${state.settings.blockedSites.length} ${state.settings.blockedSites.length === 1 ? 'site' : 'sites'} selected` : 'No sites selected';
  const side = `<div class="focus-side"><section class="panel side-panel"><p class="eyebrow">A LITTLE STRUCTURE</p><h2>Make some space.</h2><div class="fact-row"><div class="fact-icon">${icon('lock')}</div><div><strong>Site blocking</strong><span>${escapeHtml(blockLabel)}. Pausing or ending a session removes the rules.</span></div></div><div class="fact-row"><div class="fact-icon">${icon('focus')}</div><div><strong>It’s your session</strong><span>Pause, end, or temporarily allow sites whenever you need to.</span></div></div><a class="text-link" href="#settings">Adjust your settings ${icon('arrow')}</a></section>${task ? `<section class="panel side-panel"><p class="eyebrow">OPTIONAL TITLE CHECK</p><h2>Is this related?</h2><p>Compare a page title with your task’s keywords. This is not AI and cannot determine relevance.</p><form id="keyword-form" class="keyword-form"><label>Page or video title<input id="keyword-title" name="title" maxlength="500" required placeholder="Paste a title here"></label><div class="settings-actions"><button class="button button-secondary" type="submit">Check keywords</button></div><div id="keyword-result" class="keyword-result" role="status" hidden></div></form>${inExtension ? '<p class="helper">You can also right-click a page and choose “Check this page against my BrowserBuddy task.”</p>' : ''}</section>` : ''}</div>`;
  return `<div class="page"><div class="page-heading"><p class="eyebrow">A LITTLE FOCUS GOES A LONG WAY</p><h1>Make space for <em>one thing.</em></h1><p>Choose a task, set a timer, and take it one moment at a time.</p></div><div class="focus-layout">${main}${side}</div></div>`;
}
function resourceRow(resource) {
  const href = safeLink(resource.url);
  const thumb = /^data:image\/(?:png|jpeg|webp);base64,/i.test(resource.thumbnail || '') ? `<img src="${escapeHtml(resource.thumbnail)}" alt="">` : escapeHtml((resource.title || 'R').trim()[0]?.toUpperCase() || 'R');
  return `<article class="resource-row"><div class="resource-thumb" aria-hidden="true">${thumb}</div><div>${href ? `<a class="resource-title" href="${href}" target="_blank" rel="noopener noreferrer">${escapeHtml(resource.title)}</a>` : `<span class="resource-title">${escapeHtml(resource.title)}</span>`}<p class="resource-meta">${escapeHtml([resource.creator, resource.topic].filter(Boolean).join(' · ') || 'Saved by you')}</p>${resource.note ? `<p class="resource-note">${escapeHtml(resource.note)}</p>` : ''}</div><div class="resource-actions"><button class="icon-button" type="button" data-action="edit-resource" data-id="${escapeHtml(resource.id)}" aria-label="Edit ${escapeHtml(resource.title)}">${icon('edit')}</button><button class="icon-button" type="button" data-action="delete-resource" data-id="${escapeHtml(resource.id)}" aria-label="Delete ${escapeHtml(resource.title)}">${icon('close')}</button></div></article>`;
}
function filteredResources() {
  const query = libraryQuery.trim().toLocaleLowerCase();
  return state.resources.filter(item => !query || [item.title, item.creator, item.topic, item.note].some(value => String(value || '').toLocaleLowerCase().includes(query)));
}
function resourceResults() {
  const items = filteredResources();
  if (!state.resources.length) return `<div class="empty-library"><div><h2>A little library of your own.</h2><p>Save useful videos, articles, or other resources you’ve chosen, so they’re easier to find when it’s time to focus.</p><button class="button button-primary" type="button" data-action="add-resource">${icon('plus')} Save your first resource</button></div><img src="assets/mascot.png" alt=""></div>`;
  if (!items.length) return '<div class="empty-list">No saved resources match that search. Try a different word.</div>';
  return items.map(resourceRow).join('');
}
function renderLibrary() {
  return `<div class="page"><div class="page-heading row"><div><p class="eyebrow">YOUR PERSONAL LEARNING LIBRARY</p><h1>Keep the good stuff <em>close.</em></h1><p>A quiet place for links you’ve chosen to help with your work.</p></div><button class="button button-primary" type="button" data-action="add-resource">${icon('plus')} Save a resource</button></div><div class="library-top"><div class="search-wrap">${icon('search')}<label class="sr-only" for="library-search">Search saved resources</label><input id="library-search" type="search" placeholder="Search your saved resources" value="${escapeHtml(libraryQuery)}"></div><span class="library-count" id="library-count">${filteredResources().length} saved ${filteredResources().length === 1 ? 'resource' : 'resources'}</span></div><div class="resource-list" id="resource-results">${resourceResults()}</div><div class="info-line">${icon('info')}<span>This is a manual library. BrowserBuddy does not search, verify creators, or fetch view counts. Opening a link leaves BrowserBuddy; video sites may show ads or recommendations.</span></div></div>`;
}
function activityRows() {
  const groups = new Map();
  for (const item of state.intervals) groups.set(item.host, (groups.get(item.host) || 0) + item.end - item.start);
  return [...groups.entries()].sort((a, b) => b[1] - a[1]).map(([host, duration]) => `<li><strong>${escapeHtml(host)}</strong><span>about ${escapeHtml(fmtDuration(duration))}</span></li>`).join('');
}
function renderInsights() {
  const pending = pendingCheckIn(state);
  const checkin = pending ? `<section class="panel insight-block"><p class="eyebrow">READY WHEN YOU ARE</p><h2>A moment to reflect.</h2><p>Yesterday, about ${escapeHtml(fmtDuration(pending.duration))} on ${escapeHtml(pending.host)} overlapped with your planned time for ${escapeHtml(pending.taskTitle)}. Only you can decide what that means.</p><button class="button button-primary" type="button" data-action="reflect">Open check-in ${icon('arrow')}</button></section>` : `<section class="panel insight-block"><p class="eyebrow">YOUR NEXT CHECK-IN</p><h2>Nothing to review right now.</h2><p>${!inExtension ? 'Check-ins need the extension and your permission to record activity.' : state.settings.activityEnabled ? 'A next-day check-in appears when at least five recorded minutes overlap a planned work window. You can always skip it.' : 'Activity tracking is off. You can choose whether to turn it on in Settings.'}</p><a class="text-link" href="#settings">View activity settings ${icon('arrow')}</a></section>`;
  const activity = activityRows();
  const reflections = [...state.reflections].reverse().slice(0, 10).map(item => `<li><time>${escapeHtml(item.day)}</time><p>${escapeHtml(item.skipped ? 'Skipped' : item.answer || 'Saved without a note')}</p></li>`).join('');
  const sessions = state.sessions.slice(0, 8).map(item => `<li><strong>${escapeHtml(item.taskTitle)}</strong><span>${escapeHtml(fmtDuration(item.elapsedMs))} · ${item.completed ? 'finished' : 'ended early'}</span></li>`).join('');
  return `<div class="page"><div class="page-heading"><p class="eyebrow">A LITTLE PERSPECTIVE</p><h1>Notice, then <em>move on.</em></h1><p>A check-in is an invitation to reflect, not a judgment about how you spent your time.</p></div><div class="insights-layout"><div>${checkin}<section class="panel insight-block"><p class="eyebrow">RECORDED ACTIVITY</p><h2>During planned windows</h2><p>Only approved sites in a foreground tab are sampled. A visit here might have helped your task; we don’t decide that for you. Activity older than seven days is removed when BrowserBuddy next runs.</p>${activity ? `<ul class="data-list">${activity}</ul>` : `<div class="insight-empty">No recorded activity yet. ${inExtension ? 'Tracking is optional and starts only after you turn it on.' : 'This preview does not collect browsing activity.'}</div>`}</section><section class="panel insight-block"><p class="eyebrow">REFLECTIONS</p><h2>In your own words</h2>${reflections ? `<ul class="reflection-list">${reflections}</ul>` : '<div class="insight-empty">Any reflections you choose to save will appear here.</div>'}</section></div><aside class="panel side-panel"><p class="eyebrow">YOUR SESSIONS</p><h2>Time you made</h2><p>Time on the session timer, including any temporary site allowance.</p>${sessions ? `<ul class="data-list">${sessions}</ul>` : '<div class="insight-empty">Your finished or ended sessions will appear here.</div>'}</aside></div></div>`;
}
function renderSettings() {
  const settings = state.settings;
  return `<div class="page"><div class="page-heading"><p class="eyebrow">MAKE IT YOURS</p><h1>A little more <em>on your terms.</em></h1><p>You choose what to block and whether to record activity. BrowserBuddy does not send your tasks or activity to a server.</p></div><div class="settings-layout"><form class="panel settings-card" id="settings-form"><section class="settings-group"><h2>Focus protection</h2><p>Choose sites to block during a running strict session. Blocking covers the domain and its subdomains, in this browser only.</p><label class="switch-row"><input type="checkbox" name="strict" ${settings.strict ? 'checked' : ''}><span><strong>Use strict focus for new sessions</strong><small>You can pause, end, or temporarily allow sites during a session. Changing this switch affects the next session.</small></span></label><label>Sites to block<textarea name="blockedSites" rows="4" placeholder="youtube.com&#10;reddit.com">${escapeHtml(settings.blockedSites.join('\n'))}</textarea><small>One domain per line or separated by commas. ${inExtension ? `Chrome asks for access when a strict session starts${state.session?.strict ? ' or when you change this list during a session' : ''}. Its permission warning may say it can read and change data on those sites. BrowserBuddy uses access to redirect matching pages and find already-open tabs; it does not read page content.` : 'Site access is requested only in the extension. This preview cannot block websites.'}</small></label></section><section class="settings-group"><h2>Optional activity check-ins</h2><p>Record time on approved sites only while a non-incognito tab is in the foreground, the browser is active, and a task’s planned window is open. This records domains and times, not page titles or full URLs.</p><label class="switch-row"><input type="checkbox" name="activityEnabled" ${settings.activityEnabled ? 'checked' : ''} ${!inExtension ? 'disabled' : ''}><span><strong>Allow local activity recording</strong><small>${!inExtension ? 'Available in the extension, not this standalone preview.' : 'Chrome will ask for optional tabs and idle permissions. Its warning may say “Read your browsing history.” BrowserBuddy uses this access only as described here.'}</small></span></label><label>Sites approved for recording<textarea name="trackedSites" rows="3" placeholder="youtube.com&#10;reddit.com">${escapeHtml(settings.trackedSites.join('\n'))}</textarea><small>Only these domains and their subdomains are included. Leave empty if recording is off.</small></label><label>Next-day check-in time<input type="time" name="reminderTime" value="${escapeHtml(settings.reminderTime)}"><small>Check-ins appear in the dashboard after this time. No notification is sent.</small></label></section><div class="settings-actions"><button type="submit" class="button button-primary">Save settings</button><span class="form-error" role="alert" hidden></span></div></form><aside class="settings-sidebar"><section class="panel side-panel"><p class="eyebrow">PRIVATE BY DESIGN</p><h2>Your data is yours.</h2><p>Tasks, sessions, saved links, and any opted-in activity stay in this browser profile. There is no account, sync, cloud AI, or analytics in this version.</p><p>Activity older than 7 days and sessions or reflections older than 90 days are removed when BrowserBuddy next runs. Your tasks and saved resources stay until deleted.</p><a class="text-link" href="privacy.html">Read the privacy draft ${icon('arrow')}</a></section><section class="panel side-panel"><p class="eyebrow">YOUR LOCAL DATA</p><h2>Take care of your space.</h2><p>Downloads include all local data in this ${inExtension ? 'extension' : 'dashboard preview'}. Keep the file somewhere safe.</p><button class="button button-secondary" type="button" data-action="export-data">Download my data</button><button class="button button-secondary" type="button" data-action="clear-activity">Delete recorded activity</button><button class="button button-danger" type="button" data-action="reset-data">Delete all local data</button></section>${!inExtension ? `<section class="panel side-panel"><p class="eyebrow">COMPANION EXTENSION</p><h2>Use real site blocking.</h2><p>Download or clone the BrowserBuddy source. In Chrome or Edge, open the extensions page, turn on Developer mode, choose “Load unpacked,” and select the <strong>browserbuddy</strong> folder. Open BrowserBuddy using its toolbar icon.</p><p>Extension data is separate from this preview. Chromium-based desktop browsers only.</p></section>` : `<section class="panel side-panel"><p class="eyebrow">BROWSER PERMISSIONS</p><h2>You’re in control.</h2><p>Site permissions are requested as needed. You can also review or revoke extension access in your browser’s extension settings. Revoking required site access pauses an active strict session.</p></section>`}</aside></div></div>`;
}
function render() {
  settingsDirty = false;
  renderPending = false;
  route = location.hash.slice(1).split('?')[0] || 'today';
  if (!['today', 'focus', 'library', 'insights', 'settings'].includes(route)) route = 'today';
  updateChrome();
  $('#app').innerHTML = ({ today: renderToday, focus: renderFocus, library: renderLibrary, insights: renderInsights, settings: renderSettings })[route]();
  renderedCheckInDay = pendingCheckIn(state)?.day || '';
  updateTimer();
}
// Avoid losing an in-progress form to activity samples, but refresh changed
// session controls even when a button has keyboard focus.
function stateSignature(value) {
  if (!value) return '';
  switch (route) {
    case 'today': return JSON.stringify([value.tasks, value.currentTaskId, value.session, value.settings.activityEnabled, pendingCheckIn(value)]);
    case 'focus': return JSON.stringify([value.tasks, value.currentTaskId, value.session, value.settings.strict, value.settings.blockedSites]);
    case 'library': return JSON.stringify(value.resources);
    case 'insights': return JSON.stringify([value.intervals, value.sessions, value.reflections, value.settings.activityEnabled, value.settings.reminderTime]);
    case 'settings': return JSON.stringify([value.settings, value.session?.strict, value.session?.status]);
    default: return '';
  }
}
function renderPreservingFocus() {
  const active = document.activeElement;
  const hadMainFocus = Boolean(active && $('#main').contains(active));
  const action = active?.dataset?.action;
  const itemId = active?.dataset?.id;
  const elementId = active?.id;
  const textValue = active?.matches?.('input[type=text], input:not([type]), textarea') ? active.value : null;
  const selectionStart = textValue !== null ? active.selectionStart : null;
  const selectionEnd = textValue !== null ? active.selectionEnd : null;
  render();
  if (!hadMainFocus) return;
  const replacement = action
    ? $$('[data-action]', $('#main')).find(element => element.dataset.action === action && element.dataset.id === itemId)
    : elementId ? document.getElementById(elementId) : null;
  if (replacement && textValue !== null && replacement.matches('input, textarea')) {
    replacement.value = textValue;
    if (selectionStart !== null && selectionEnd !== null) replacement.setSelectionRange(selectionStart, selectionEnd);
  }
  (replacement && !replacement.disabled ? replacement : $('#main')).focus({ preventScroll: true });
}
function scheduleStateRender() {
  const active = document.activeElement;
  const editing = active?.matches?.('input, textarea, select, [contenteditable="true"]')
    && !(route === 'focus' && ['keyword-title', 'session-minutes'].includes(active.id));
  if ($('dialog[open]') || editing || (route === 'settings' && settingsDirty)) {
    renderPending = true;
    updateTimer();
    return;
  }
  renderPreservingFocus();
}
function receiveState(next) {
  const changed = stateSignature(state) !== stateSignature(next);
  state = next;
  if (changed) scheduleStateRender();
  else updateTimer();
}

function updateTimer() {
  if (!state.session) return;
  const left = timeLeft(state.session);
  const countdown = $('[data-countdown]');
  if (countdown) countdown.textContent = formatTimer(left);
  const ring = $('.timer-progress');
  if (ring) ring.setAttribute('stroke-dasharray', `${Math.max(0, Math.min(100, left / state.session.totalMs * 100))} 100`);
  if (state.session.status === 'running' && left <= 0 && !expirationPending) {
    expirationPending = true;
    dispatch({ type: 'TICK' }).then(result => { applyResult(result); toast('Session complete. Nice work making the time.'); }).catch(error => toast(error.message, true)).finally(() => { expirationPending = false; });
  } else if (state.session.overrideUntil && state.session.overrideUntil <= Date.now() && !expirationPending) {
    expirationPending = true;
    dispatch({ type: 'TICK' }).then(applyResult).catch(error => toast(error.message, true)).finally(() => { expirationPending = false; });
  }
}
function openDialog(dialog) {
  $('.form-error', dialog).hidden = true;
  if (!dialog.open) dialog.showModal();
  const first = $('input:not([type=hidden]), textarea', dialog);
  if (first) first.focus();
}
function localDateTime(ms) {
  if (!ms) return '';
  const date = new Date(ms);
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function showTaskDialog(task = null) {
  const dialog = $('#task-dialog'), form = $('#task-form');
  form.reset();
  form.elements.id.value = task?.id || '';
  form.elements.title.value = task?.title || '';
  form.elements.topic.value = task?.topic || '';
  form.elements.url.value = task?.url || '';
  form.elements.dueDate.value = task?.dueDate || '';
  form.elements.plannedStart.value = localDateTime(task?.plannedStart);
  if (task?.plannedStart && task?.plannedEnd) {
    const minutes = String(Math.round((task.plannedEnd - task.plannedStart) / 60_000));
    if ([...form.elements.windowMinutes.options].some(option => option.value === minutes)) form.elements.windowMinutes.value = minutes;
  }
  $('#task-dialog-title').textContent = task ? 'Edit your task' : 'Add a task';
  $('[data-action="delete-task"]', dialog).hidden = !task;
  openDialog(dialog);
}
function showResourceDialog(resource = null) {
  const dialog = $('#resource-dialog'), form = $('#resource-form');
  form.reset();
  for (const name of ['id', 'title', 'url', 'creator', 'topic', 'note']) form.elements[name].value = resource?.[name] || '';
  form.elements.existingThumbnail.value = resource?.thumbnail || '';
  $('#resource-dialog-title').textContent = resource ? 'Edit your resource' : 'Save a resource';
  openDialog(dialog);
}
function showReflection() {
  const pending = pendingCheckIn(state);
  if (!pending) { toast('There is no check-in to review right now.'); return; }
  const form = $('#reflection-form'); form.reset();
  form.elements.day.value = pending.day;
  $('#reflection-prompt').textContent = `Yesterday, about ${fmtDuration(pending.duration)} on ${pending.host} overlapped with your planned time for ${pending.taskTitle}. Only you know whether that was useful.`;
  openDialog($('#reflection-dialog'));
}
function formError(form, message) {
  const el = $('.form-error', form); el.textContent = message; el.hidden = false;
}
function requestSiteAccess(sites) {
  // Called directly in the originating click or submit handler to retain the user gesture.
  return inExtension && sites.length ? chrome.permissions.request({ origins: permissionOrigins(sites) }) : null;
}
async function grantResult(promise) {
  if (promise && !await promise) throw new Error('Permission was not granted. You can still use the timer without site blocking.');
}
async function compressThumbnail(file) {
  if (!file) return '';
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024) throw new Error('Choose a PNG, JPEG, or WebP under 10 MB.');
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 600 / bitmap.width, 400 / bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  let image = canvas.toDataURL('image/webp', .8);
  if (image.length > 350_000) image = canvas.toDataURL('image/webp', .55);
  if (image.length > 350_000) throw new Error('That thumbnail is too large after resizing. Try a smaller image.');
  return image;
}

window.addEventListener('hashchange', () => { libraryQuery = ''; render(); window.scrollTo({ top: 0 }); });
document.addEventListener('change', event => {
  if (event.target.closest('#settings-form')) settingsDirty = true;
  if (event.target.id === 'session-minutes') selectedMinutes = Number(event.target.value);
});
document.addEventListener('input', event => {
  if (event.target.closest('#settings-form')) settingsDirty = true;
  if (event.target.id === 'library-search') {
    libraryQuery = event.target.value;
    $('#resource-results').innerHTML = resourceResults();
    const count = filteredResources().length;
    $('#library-count').textContent = `${count} saved ${count === 1 ? 'resource' : 'resources'}`;
  }
});
document.addEventListener('click', async event => {
  if (event.target.closest('.skip-link')) {
    event.preventDefault(); $('#main').focus(); $('#main').scrollIntoView({ block: 'start' }); return;
  }
  const button = event.target.closest('[data-action]');
  if (!button || button.disabled) return;
  const action = button.dataset.action;
  // Request permissions before the first await, while Chrome still has a user gesture.
  let grant = null;
  try {
    if (action === 'start-session' && state.settings.strict) grant = requestSiteAccess(state.settings.blockedSites);
    if (action === 'resume-session' && state.session?.strict) grant = requestSiteAccess(state.settings.blockedSites);
    switch (action) {
      case 'mode-info': bannerVisible = !bannerVisible; updateChrome(); break;
      case 'close-dialog': button.closest('dialog')?.close(); break;
      case 'add-task': showTaskDialog(); break;
      case 'edit-task': showTaskDialog(state.tasks.find(task => task.id === button.dataset.id)); break;
      case 'select-task': await command({ type: 'SELECT_TASK', id: button.dataset.id }, 'Task selected for your next session.'); break;
      case 'toggle-task': await command({ type: 'TOGGLE_TASK', id: button.dataset.id }, 'Task updated.'); break;
      case 'delete-task': {
        const dialog = button.closest('dialog'); const taskId = $('#task-form').elements.id.value;
        if (confirm('Delete this task? Your past session and activity records will remain until their retention period ends.')) { await command({ type: 'DELETE_TASK', id: taskId }, 'Task deleted.'); dialog.close(); }
        break;
      }
      case 'start-session': await grantResult(grant); await command({ type: 'START_SESSION', taskId: currentTask()?.id, minutes: selectedMinutes }, 'Your session has started.'); break;
      case 'pause-session': await command({ type: 'PAUSE_SESSION' }, 'Session paused. Site blocks are off.'); break;
      case 'resume-session': await grantResult(grant); await command({ type: 'RESUME_SESSION' }, 'Session resumed.'); break;
      case 'end-session': if (confirm('End this focus session?')) await command({ type: 'END_SESSION' }, 'Session ended. Your selected sites are available.'); break;
      case 'allow-temporary': await command({ type: 'ALLOW_TEMPORARY' }, 'Selected sites are temporarily allowed. The timer continues.'); break;
      case 'restore-blocking': await command({ type: 'RESTORE_BLOCKING' }, 'Site blocking is back on.'); break;
      case 'add-resource': showResourceDialog(); break;
      case 'edit-resource': showResourceDialog(state.resources.find(item => item.id === button.dataset.id)); break;
      case 'delete-resource': if (confirm('Remove this saved resource from your library?')) await command({ type: 'DELETE_RESOURCE', id: button.dataset.id }, 'Resource removed.'); break;
      case 'reflect': showReflection(); break;
      case 'skip-reflection': {
        const day = $('#reflection-form').elements.day.value;
        await command({ type: 'SAVE_REFLECTION', day, skipped: true }, 'Check-in skipped.');
        $('#reflection-dialog').close(); $('#main').focus(); break;
      }
      case 'clear-activity': if (confirm('Delete recorded activity? If tracking remains enabled, new activity can still be recorded.')) await command({ type: 'CLEAR_ACTIVITY' }, 'Recorded activity deleted.'); break;
      case 'export-data': {
        const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), source: inExtension ? 'extension' : 'standalone-preview', data: state }, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `browserbuddy-${localDayKey(Date.now())}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); toast('Your local data was downloaded.'); break;
      }
      case 'reset-data': {
        if (!confirm('Delete all BrowserBuddy tasks, sessions, settings, activity, reflections, and saved resources on this device? This cannot be undone.')) break;
        applyResult(await reset());
        if (inExtension) {
          try {
            const all = await chrome.permissions.getAll();
            const optional = (all.permissions || []).filter(item => ['tabs', 'idle'].includes(item));
            if (optional.length || all.origins?.length) await chrome.permissions.remove({ permissions: optional, origins: all.origins || [] });
          } catch { toast('Data deleted. Review any remaining permissions in your browser settings.', true); break; }
        }
        toast('All local BrowserBuddy data was deleted.'); break;
      }
    }
  } catch (error) { toast(error.message || 'Something went wrong.', true); }
});

document.addEventListener('submit', async event => {
  const form = event.target;
  const formId = form.getAttribute('id');
  if (!['task-form', 'resource-form', 'reflection-form', 'settings-form', 'keyword-form'].includes(formId)) return;
  event.preventDefault();
  let grant = null;
  let settingsData = null;
  try {
    if (formId === 'settings-form') {
      const blockedSites = parseSites(form.elements.blockedSites.value);
      const trackedSites = parseSites(form.elements.trackedSites.value);
      settingsData = { strict: form.elements.strict.checked, blockedSites, trackedSites, activityEnabled: inExtension && form.elements.activityEnabled.checked, reminderTime: form.elements.reminderTime.value || '09:00' };
      if (settingsData.activityEnabled && !trackedSites.length) throw new Error('Choose at least one site before turning on activity tracking.');
      if (inExtension) {
        const permissions = settingsData.activityEnabled ? ['tabs', 'idle'] : [];
        const origins = state.session?.strict && state.session.status === 'running' ? permissionOrigins(blockedSites) : [];
        if (permissions.length || origins.length) grant = chrome.permissions.request({ permissions, origins });
      }
    }
    if (formId === 'task-form') {
      const plannedStart = form.elements.plannedStart.value ? new Date(form.elements.plannedStart.value).getTime() : null;
      if (plannedStart && !Number.isFinite(plannedStart)) throw new Error('Choose a valid planned start.');
      const data = { id: form.elements.id.value || undefined, title: form.elements.title.value, topic: form.elements.topic.value, url: form.elements.url.value, dueDate: form.elements.dueDate.value, plannedStart, plannedEnd: plannedStart ? plannedStart + Number(form.elements.windowMinutes.value) * 60_000 : null };
      await command({ type: 'UPSERT_TASK', data }, 'Task saved.');
      $('#task-dialog').close(); $('#main').focus();
    } else if (formId === 'resource-form') {
      const file = form.elements.thumbnail.files[0];
      const thumbnail = file ? await compressThumbnail(file) : form.elements.existingThumbnail.value;
      const data = { id: form.elements.id.value || undefined, title: form.elements.title.value, url: form.elements.url.value, creator: form.elements.creator.value, topic: form.elements.topic.value, note: form.elements.note.value, thumbnail };
      await command({ type: 'SAVE_RESOURCE', data }, 'Resource saved.');
      $('#resource-dialog').close(); $('#main').focus();
    } else if (formId === 'reflection-form') {
      await command({ type: 'SAVE_REFLECTION', day: form.elements.day.value, answer: form.elements.answer.value }, 'Reflection saved on this device.');
      $('#reflection-dialog').close(); $('#main').focus();
    } else if (formId === 'keyword-form') {
      const result = checkTitle(currentTask(), form.elements.title.value);
      const output = $('#keyword-result'); output.textContent = `${result.message} A title alone cannot tell you whether a page is useful.`; output.hidden = false;
    } else if (formId === 'settings-form') {
      await grantResult(grant);
      const old = state.settings;
      await command({ type: 'SAVE_SETTINGS', data: settingsData }, 'Settings saved.');
      if (inExtension) {
        const removed = old.blockedSites.filter(site => !settingsData.blockedSites.some(current => hostMatches(site, current) || hostMatches(current, site)));
        const permissions = old.activityEnabled && !settingsData.activityEnabled ? ['tabs', 'idle'] : [];
        const origins = permissionOrigins(removed);
        if (permissions.length || origins.length) {
          try { await chrome.permissions.remove({ permissions, origins }); } catch { toast('Settings saved. Review any remaining permissions in browser settings.', true); }
        }
      }
    }
  } catch (error) { formError(form, error.message || 'Something went wrong.'); }
});

if (inExtension) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[STORAGE_KEY]?.newValue) return;
    receiveState(changes[STORAGE_KEY].newValue);
  });
} else {
  window.addEventListener('storage', event => {
    if (event.key === STORAGE_KEY) getState().then(result => receiveState(result.state)).catch(error => toast(error.message, true));
  });
}
document.addEventListener('focusout', () => {
  if (renderPending) queueMicrotask(() => { if (renderPending) scheduleStateRender(); });
});
for (const dialog of $$('dialog')) dialog.addEventListener('close', () => { if (renderPending) scheduleStateRender(); });
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) getState().then(result => { meta = result.meta || meta; receiveState(result.state); }).catch(error => toast(error.message, true));
});
$('#top-date').textContent = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date());
getState().then(result => applyResult(result)).catch(error => { $('#app').innerHTML = `<div class="page"><div class="page-heading"><h1>Couldn’t open your space.</h1><p>${escapeHtml(error.message)}</p></div></div>`; });
setInterval(() => {
  updateTimer();
  if (['today', 'insights'].includes(route) && !renderPending && (pendingCheckIn(state)?.day || '') !== renderedCheckInDay) scheduleStateRender();
}, 1000);
