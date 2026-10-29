import { hostMatches, isBlocking } from './core.js';
import { dispatch, getState, inExtension } from './backend.js';

const $ = selector => document.querySelector(selector);
function originalUrl(state) {
  try {
    const url = new URL(location.hash.slice(1));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    if (!state.settings.blockedSites.some(site => hostMatches(url.hostname.toLowerCase(), site))) return '';
    return url.href;
  } catch { return ''; }
}
function showError(error) { $('#blocked-error').textContent = error.message || 'Something went wrong.'; $('#blocked-error').hidden = false; }
if (window.top !== window.self) {
  document.body.textContent = 'Open BrowserBuddy in its own tab.';
} else if (!inExtension) {
  $('#blocked-task').textContent = 'Open this page through the installed extension.';
  $('#blocked-helper').textContent = 'The standalone dashboard does not block websites.';
} else {
  let url = '';
  function render(state) {
    // Keep an initially validated URL even if the user removes that domain later.
    if (!url) url = originalUrl(state);
    const active = isBlocking(state);
    const task = state.tasks.find(item => item.id === state.session?.taskId);
    $('#blocked-task').textContent = task?.title || 'Your focus session';
    $('#blocked-detail').textContent = task?.topic || (state.session ? 'One thing at a time.' : 'This session is no longer active.');
    $('#return-task').href = 'index.html#focus';
    if (task?.url) {
      try {
        const taskUrl = new URL(task.url);
        if (['http:', 'https:'].includes(taskUrl.protocol) && !taskUrl.username && !taskUrl.password) $('#return-task').href = taskUrl.href;
      } catch { /* Keep the dashboard link. */ }
    }
    $('#allow-site').hidden = !active || !url;
    $('#end-session').hidden = !active || !url;
    $('#continue-site').hidden = active || !url;
    if (active && url) {
      $('#blocked-heading').innerHTML = 'Let’s come back<br>to your task.';
      $('#blocked-description').textContent = 'You chose to make some room for your work during this session.';
      $('#blocked-helper').textContent = 'The timer keeps running if you temporarily allow all selected sites. You can always pause or end the session.';
    } else if (url) {
      $('#blocked-heading').textContent = 'Your site is available now.';
      $('#blocked-description').textContent = 'Your session has ended, paused, or site blocking is temporarily off.';
      $('#continue-site').href = url;
      $('#blocked-helper').textContent = 'You can return to your task whenever you are ready.';
    } else {
      $('#blocked-heading').textContent = 'Let’s come back to your task.';
      $('#blocked-description').textContent = 'The original site is no longer on your selected block list.';
      $('#blocked-helper').textContent = 'Open your dashboard to review your session or site settings.';
    }
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes['browserbuddy.local.v1']?.newValue) render(changes['browserbuddy.local.v1'].newValue);
  });
  $('#allow-site').addEventListener('click', async () => {
    try {
      if (!url) return;
      await dispatch({ type: 'ALLOW_TEMPORARY' });
      location.replace(url);
    } catch (error) { showError(error); }
  });
  $('#end-session').addEventListener('click', async () => {
    try {
      if (!url) return;
      await dispatch({ type: 'END_SESSION' });
      location.replace(url);
    } catch (error) { showError(error); }
  });
  getState().then(result => render(result.state)).catch(showError);
}
