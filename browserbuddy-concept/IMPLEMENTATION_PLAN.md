# BrowserBuddy: concept and implementation plan

**Status:** Design and planning only. The mockups show imagined screens and sample data. BrowserBuddy does not yet track browsing, block sites, analyze pages, or search or play videos.

## 1. Product in one sentence

BrowserBuddy is a browser companion that helps people decide what they want to do online, notice when browsing pulls them away from that intention, and reflect on what happened later.

### Decisions already made

- **Audience:** Anyone who procrastinates, whether they are studying, working, or doing something personal.
- **Surfaces:** A browser extension for in-browser context and a companion web dashboard.
- **Focus mode:** Strict by default during a session, with a clear user-controlled override.
- **Privacy:** Local-first where practical. Any cloud AI must be separately and explicitly opted into.
- **Business constraint:** Free to users, with no subscriptions or ads from BrowserBuddy. See the YouTube trade-off below before promising that every video will be ad-free.
- **Tone:** A supportive learning coach, not a parent, surveillance tool, or source of guilt.

## 2. The experience, scene by scene

### Scene A: Set an intention and begin

A person enters a concrete task, such as “Finish my gas stoichiometry assignment,” optionally adds the specific topic, due date, and the page they want to return to, and chooses a session length. They can also plan a focus window in advance. The dashboard shows the active intention and a clear start action.

**Acceptance criteria**

1. An intention requires a short task description and may include a topic, due date, task URL, and planned time window.
2. A user can start, pause, resume, and end a session. Strict mode is selected initially but is active only while a session is running.
3. The user can review and edit the sites they wish to block or allow. A break or override is always accessible; the app never locks the user out of the browser.
4. Ending or expiring a session removes its blocking rules. The interface explains when protection is active and what permissions were granted.

### Scene B: Notice a detour in context

Suppose the intention is gas stoichiometry and the user opens a documentary about Teflon. It is chemistry, but it may not help with the specific assignment. BrowserBuddy presents a short explanation and offers **Back to my task** or **Continue anyway**. If no task page was saved, the return action opens the focus dashboard instead.

**Acceptance criteria**

1. Compare the user's specific goal and topic with minimal page context on sites the user has permitted. A broad subject match alone must not automatically mean “on task.”
2. Treat relevance as uncertain. When confidence is low, ask rather than assert; do not silently block an ambiguous page. A user can correct a decision, change the intention, or continue.
3. Explicit user-selected blocklists can be enforced during the session. Provide an override, for example a 10-minute exception or ending the session, and label it clearly.
4. Never inspect passwords, form fields, private messages, or page contents by default. Do not monitor private browsing by default.
5. Do not promise a before-load AI decision: Chrome's declarative network rules can act on URL patterns, whereas title/content analysis generally happens after the page is available. [1](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest)
6. The YouTube-specific version of this flow requires a policy review before implementation. Do not interfere with an embedded YouTube player's playback, controls, ads, or related-video links. [1](https://developers.google.com/youtube/terms/developer-policies-guide)

### Scene C: Reflect the next morning

On Wednesday morning, a check-in can say: “Yesterday at 4:00 PM you spent 34 minutes on YouTube while your assignment was planned. Was that how you intended to spend your time?” The user can answer yes, not really, or unsure, and optionally describe what happened and what might help next time.

**Acceptance criteria**

1. Offer at most one concise check-in for a meaningful overlap between a user-planned work window and observed browsing. If there is no suitable data, show an empty state rather than inventing a story.
2. Phrase the prompt as a question, not a judgment or a claim to know the user's intent. Allow skip, edit, and delete.
3. Use the user's local date and time. If the browser is closed at the chosen reminder time, show the check-in on the next launch; do not claim it was delivered on time.
4. Save responses locally by default. Never send reflection text to a cloud model without a separate, informed opt-in.

### Scene D: Find a useful video without browsing a full feed

A focus library could search or list learning resources for the exact task and show the title, thumbnail, channel, duration, and view count where the source provides them. A maintained, transparent list of suggested educators can help discovery. Being popular or “verified” does not prove teaching quality.

**Acceptance criteria**

1. Show clear source attribution and the original metadata. State when view counts are unavailable or stale; do not invent them.
2. Start with a small, manually reviewed list and let people add or remove sources. Define who reviews entries and how corrections work; do not present an editorial label as YouTube verification.
3. If using YouTube, use its official Data API and standard player. Check embedding availability and handle deleted, private, age-restricted, or region-restricted videos gracefully. A user must be able to play without a separate gate. [1](https://developers.google.com/youtube/terms/developer-policies)
4. Keep YouTube player controls, ads, attribution, and related-video features intact. A cleaner page around the player is feasible, but a guaranteed ad-free or recommendation-free YouTube player is not. [1](https://developers.google.com/youtube/terms/developer-policies-guide) [1](https://developers.google.com/youtube/player_parameters)
5. Check YouTube's rules and obtain an appropriate compliance review before ranking, classifying, caching, or using API data to drive restrictions. The policies limit derived metrics and storage. [1](https://developers.google.com/youtube/terms/developer-policies)

### Scene E: Understand browsing patterns

Show an optional, private view of foreground browser activity against planned work windows. Useful examples include “You often browse selected entertainment sites between 4 and 6 PM” and “You had planned an assignment during part of that time.” A pattern is a starting point for a question, not a diagnosis.

**Acceptance criteria**

1. Only collect activity after clear, separate permission. Count the visible active browser tab while the browser is in use; exclude idle time, background tabs, and unapproved private browsing.
2. Do not call this total device screen time. An extension cannot measure all native apps, other browsers, or other devices.
3. Avoid double-counting tab switches and handle sleep, browser restarts, time zones, and daylight-saving changes. Show the observed date range and known gaps.
4. Allow a user to pause collection, inspect what is stored, export their own data, and delete it. Suggest short retention defaults, such as seven days of detailed events and 30 days of aggregates, subject to user choice and legal review.

## 3. Technical approach

### Recommended first release

- **Extension:** Chromium Manifest V3. The extension owns local activity and session state, manages a user-approved list of site rules with `declarativeNetRequest`, and opens an extension-owned intervention page where appropriate. Redirect rules require the relevant host access. [2](https://developer.chrome.com/docs/extensions/develop/migrate/blocking-web-requests)
- **Dashboard:** A small static web app for intentions, session controls, local insights, and reflections. It cannot read browser tabs on its own. Communicate with the extension through a narrowly scoped, origin-allowlisted message interface, or host sensitive views inside the extension if that is simpler and safer.
- **Storage:** Extension-local storage or IndexedDB, with explicit retention, export, and deletion controls. Do not assume extension storage is encrypted just because it is local.
- **Reliability:** Persist session deadlines and rule state; reconcile them when the extension service worker starts, the browser restarts, or the device wakes. Use alarms rather than assuming a service worker stays alive. [2](https://developer.chrome.com/docs/extensions/reference/api/alarms)
- **Permissions:** Request permissions progressively and explain them. `activeTab` is temporary and cannot support continuous monitoring by itself; ongoing tab context needs appropriate permissions and consent. [1](https://developer.chrome.com/docs/extensions/reference/api/tabs)
- **No required backend for the basic experience:** A static dashboard and extension can cover the first local-only version. A separately hosted dashboard still needs hosting and a secure connection to the extension.

### Context and AI

1. Begin with explicit user rules, task details, and conservative keyword matching. This is cheaper and easier to explain, but it will not reliably understand subtle topic drift.
2. Prototype a small local semantic model as an experiment. Test the gas-stoichiometry/Teflon distinction and measure false positives, latency, memory use, and performance on ordinary devices.
3. Add optional cloud AI only after a separate consent screen explains the provider, exactly what text is sent, retention, and potential costs. Disable it by default and keep basic focus controls usable without it.
4. Do not claim an AI model is accurate, private, or free without testing and verifying the actual provider terms. Do not use YouTube API data for semantic classification until the intended use has been reviewed for policy compliance.

### Suggested local records

- **Intention:** title, specific topic, optional task URL, due date, planned window.
- **Session:** intention ID, start/end timestamps, state, selected rules, user overrides.
- **Activity interval:** approved site or domain, start/end, optional minimized context, collection source. Avoid saving full URLs or titles unless necessary and consented to.
- **Reflection:** referenced interval, answer, optional notes and next-step plan.
- **Preferences:** permissions, blocklist, retention, reminder time, and cloud-AI consent.

The exact schema and retention periods should be tested with real users before launch.

## 4. Free and ad-free: the important trade-off

BrowserBuddy can avoid charging users and can avoid placing ads in its own interface. However:

- The official YouTube player may show ads and related videos, and its policies do not allow an API client to remove them. An in-house wrapper or another link service does not change that obligation. [1](https://developers.google.com/youtube/terms/developer-policies-guide)
- If **no ads anywhere** is a hard requirement, do not depend on YouTube playback. Use properly licensed ad-free video sources or creator-provided material instead, accepting that coverage, metadata, and view counts may be limited and hosting still costs money.
- YouTube Data API access is quota-limited. As documented in October 2026, the default allocation includes 100 `search.list` calls per day in a separate search bucket and 10,000 daily units for most other endpoints. Quotas can change and extra capacity is not guaranteed. [3](https://developers.google.com/youtube/v3/determine_quota_cost?hl=en)
- Local software can be free to users, but development, distribution, hosting, optional cloud AI, bandwidth, and maintenance can still cost the operator money. A free tier is not a guarantee of unlimited capacity.
- The VideoLink developer guide currently returned a 404 when checked. Do not plan around an unverified price, API availability, or promise of ad removal.

## 5. Delivery sequence

**Phase 0: Validate the concept**

- Review the static mockups and resolve the open decisions below.
- Test the coaching questions and interruption language with a small number of people who choose to participate.
- Confirm privacy, accessibility, and video-platform policy requirements before writing production integrations.

**Phase 1: Local focus MVP**

- Create intentions, schedules, and a timer; implement user-selected website blocking, override, and return-to-task in the extension.
- Add the dashboard and clear permission controls. Verify rule cleanup and browser restart behavior.

**Phase 2: Reflection and patterns**

- Add optional foreground activity collection, planned-versus-actual comparisons, next-day check-ins, export, and deletion.
- Validate that timestamps, idle detection, and gaps are understandable.

**Phase 3: Research context and resources**

- Evaluate local context matching and its error rates; trial optional cloud AI only with informed consent.
- Test an official, policy-compliant video integration or an alternative ad-free source, depending on the decision below.

## 6. Decisions still needed

1. Does “no ads” mean **no ads anywhere**, including inside third-party videos, or only no ads placed by BrowserBuddy? The first choice rules out a guaranteed YouTube-based experience.
2. Which browser should the first extension support: Chrome, Edge, Firefox, or another browser? Manifest V3 behavior and permissions vary.
3. What should a strict-mode override look like: a simple button, a short delay, a reason prompt, or a timed exception? An emergency exit should remain available.
4. Should the first release offer reflection only during manually scheduled focus windows, or also during broader opt-in browsing? The second requires more sensitive permissions.
5. Who curates trusted video channels, and what process lets users challenge or update that list?

## 7. Design direction

The mockups use a warm neutral canvas, dark readable type, a single restrained green accent, generous spacing, and the original Buddy mascot. They show examples rather than real analytics. The companion should feel encouraging and deliberate, with the task and the next action more prominent than decorative UI.
