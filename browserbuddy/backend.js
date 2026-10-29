import { STORAGE_KEY, applyCommand, initialState, normalizeState } from './core.js';

export const inExtension = location.protocol === 'chrome-extension:' && Boolean(globalThis.chrome?.runtime?.id);

function localRead() {
  try { return normalizeState(JSON.parse(localStorage.getItem(STORAGE_KEY))); }
  catch { return initialState(); }
}
function localSave(state) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  catch { throw new Error('This browser could not save your data. Check your storage settings or free up space.'); }
  return { state, meta: { mode: 'web', missingSites: [], activityPermission: false } };
}
async function send(message) {
  let response;
  try { response = await chrome.runtime.sendMessage(message); }
  catch { throw new Error('The extension is unavailable. Try reopening BrowserBuddy from its toolbar icon.'); }
  if (!response?.ok) throw new Error(response?.error || 'The extension could not complete that action.');
  return response;
}
export async function getState() {
  if (inExtension) return send({ type: 'GET_STATE' });
  return localSave(applyCommand(localRead(), { type: 'TICK' }));
}
export async function dispatch(command) {
  if (inExtension) return send({ type: 'COMMAND', command });
  return localSave(applyCommand(localRead(), command, Date.now(), { blockingAvailable: false }));
}
export async function reset() {
  if (inExtension) return send({ type: 'RESET' });
  localStorage.removeItem(STORAGE_KEY);
  return { state: initialState(), meta: { mode: 'web', missingSites: [], activityPermission: false } };
}
