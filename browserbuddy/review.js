import { checkTitle } from './core.js';
const $ = selector => document.querySelector(selector);
const id = new URL(location.href).searchParams.get('id');
async function send(type, extra = {}) {
  const response = await chrome.runtime.sendMessage({ type, id, ...extra });
  if (!response?.ok) throw new Error(response?.error || 'This check is no longer available.');
  return response;
}
if (location.protocol !== 'chrome-extension:' || !id) {
  $('#review-result').textContent = 'Use the installed extension’s page menu to check a title.';
  $('#review-continue').hidden = true;
} else {
  send('GET_REVIEW').then(({ review }) => {
    if (!review) throw new Error('This check is no longer available.');
    $('#review-task').textContent = review.task?.title || 'No task selected';
    $('#review-title').textContent = review.title ? `Page title: ${review.title}` : 'The browser did not share a title for this page.';
    $('#review-result').textContent = review.task && review.title ? checkTitle(review.task, review.title).message : 'Choose a task and try the page menu again.';
    if (review.task?.url) {
      try { const url = new URL(review.task.url); if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) $('#review-work').href = url.href; } catch { /* Keep dashboard link. */ }
    }
  }).catch(error => { $('#review-result').textContent = error.message; });
  $('#review-continue').addEventListener('click', () => send('DISMISS_REVIEW', { back: true }).catch(() => window.close()));
}
