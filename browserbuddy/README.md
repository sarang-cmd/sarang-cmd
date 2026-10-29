# BrowserBuddy

A local-first, ad-free focus companion. This folder contains a real Chromium Manifest V3 extension and the same dashboard as an independent static web preview. No build step, account, API key, or paid service is required.

## Try the dashboard

From this directory, run:

```sh
npm start
# or: python3 -m http.server 4173 --bind 0.0.0.0
```

Open the server URL in a browser. The standalone dashboard stores its own data in that browser's `localStorage`. **It is not connected to the extension:** its timer works, but it cannot block websites or record activity. The extension's data is separate. A web host will receive ordinary HTTP access information and should document its own logs and retention.

## Install the extension locally

1. Use desktop Chrome, Edge, or another compatible Chromium browser, version 120 or newer.
2. Open the browser's extensions page, such as `chrome://extensions` or `edge://extensions`.
3. Turn on **Developer mode**, choose **Load unpacked**, and select this `browserbuddy` folder, which contains `manifest.json`.
4. Pin and click the BrowserBuddy toolbar icon to open the extension dashboard. If you change the source, reload the extension from the extensions page.
5. Add a task, choose your blocked domains in **Settings**, and start a strict session. Chrome asks for access only to the domains you choose. If you decline, the strict session does not start. Pause or end the session, or use the clearly labeled ten-minute allowance, to restore access.

No extension store package or hosted production site is included yet. Browser profiles and the standalone dashboard do not share data. Uninstalling the extension generally deletes its local extension data; use **Download my data** first if you need a backup.

## What works

- Create, edit, select, complete, and delete tasks with an optional topic, due date, task URL, and planned work window.
- Run a local timer; pause, resume, end early, and temporarily allow blocked sites for up to ten minutes. Session history is based on timer time, including any temporary allowance.
- The extension creates declarative, session-scoped redirect rules for user-selected domains and subdomains. It also attempts to redirect already-open matching tabs. Alarms and startup reconciliation restore or remove rules after sleep/restart. A task URL on the blocked list is rejected so that the return-to-task link remains usable. Revoking a needed domain permission pauses an active strict session.
- Separately opt in to approximate activity recording. The optional `tabs` and `idle` permissions are requested only when enabled. Chrome may label `tabs` as “Read your browsing history”; the app samples only approved domains in the active, focused, non-incognito tab while the browser is active and a planned window is open. It stores the domain, times, and associated task, not the page title or full URL. During a session it uses only that session’s task when its planned window is open. Otherwise it uses the selected task if eligible or the sole planned window; ambiguous overlaps are skipped. Background tabs and idle/locked periods are excluded. Sampling and browser sleep may cause gaps.
- A dashboard check-in appears the next day after the chosen time if at least five recorded minutes on a single domain overlap the same planned task. It can be skipped. There are no desktop notifications.
- Save, edit, search, and remove your own resource links, notes, and optional uploaded thumbnails. The library does not search the web or assert verification, view counts, or relevance.
- Compare a pasted title with the task's keywords, or right-click a page and choose the extension's title check. This is a transparent, imperfect keyword comparison, **not semantic AI**. It does not automatically monitor titles or make a claim that a page is distracting. The selected title is held only in browser session memory for a page-menu check.
- Export local data and delete activity or all data. Activity older than seven days and sessions/reflections older than 90 days are removed when BrowserBuddy next runs. Tasks and library entries remain until deleted.

## Important limitations

- Blocking applies to top-level HTTP(S) requests reaching Chromium's network stack, not other browsers or devices. Browser-restricted pages, other extensions, cached responses supplied by a website service worker, browser shutdown/sleep, or disabling the extension can bypass or delay rules. Existing pages are redirected on best effort. This is not a security or parental-control guarantee. The extension is not enabled in incognito by default; opted-in activity recording always excludes incognito tabs.
- The standalone web preview has no extension bridge, tracking, or blocking, even if the extension is installed. Open the extension dashboard via its toolbar icon for those functions.
- There is no automatic semantic relevance, cloud AI, video search, official YouTube integration, embed, or ad removal. External video sites can show ads and recommendations. YouTube API and player policy, quota, and licensed ad-free sources require separate research before those features ship.
- Privacy and Terms pages are **drafts** describing this prototype. The operator/contact, hosting practices, legal basis, jurisdiction, and consumer terms must be reviewed and supplied before a public launch.

## Tests

```sh
npm test
```

The pure domain tests cover URL/domain validation, session lifecycle, overrides, activity sampling boundaries and retention, check-in eligibility, and keyword-check uncertainty. Browser and extension behavior should also be tested manually in the browsers intended for release, including optional permission grants and revocation.

The original Buddy artwork is in `assets/mascot-original.png`; the UI uses a transparent derivative. DM Sans is locally bundled with its license in `assets/fonts/`.

To run the optional browser and extension end-to-end suite, install the development dependencies and point it at a full Chromium or Chrome for Testing binary (the headless-shell build does not support extensions):

```sh
npm install
CHROMIUM_PATH=/path/to/chromium npm run test:browser
```

The suite uses a disposable browser profile, tests MV3 redirects, restart, permission revocation, foreground activity, and reflection UI, and runs axe accessibility checks on the dashboard. It pre-grants only a local test domain and the optional tracking APIs in that disposable profile; it does **not** automate Chrome's native permission prompt. Verify the consent prompts manually in supported browsers before distribution.
