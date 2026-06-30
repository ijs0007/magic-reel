# Magic Reel — handoff notes

## Polish Round 2 + YouTube Reconnect (2026-06-30)

**Phase A — `uncaughtException` → exit-and-restart (APP_VERSION v0.19.1 → v0.19.2; footers fetch `/version`).**
After an uncaught exception the engine may be in an undefined state, so on Render the safe pattern is log →
alert → `process.exit(1)` and let the platform auto-restart clean. The `uncaughtException` handler now logs +
fires the rate-limited Resend alert (via `logError`, which now **returns** the alert promise — additive), then
exits, **racing the alert against `setTimeout(bail, 2500)`** (first to settle wins; `exited` flag → exactly one
exit). The timer is **not `unref`'d** so it deterministically forces exit(1). **`unhandledRejection` unchanged**
(log + alert, stays alive). Double-alert prevented by the existing 1-email-per-5-min rate-limiter. CommonJS
syntax (`var`/`function`). Verified: `node --check` ✓; isolated harness proves exit(1) on fast (~35ms) and hung
(~2.5s) paths; engine boots, `/health` + normal requests succeed, logs clean.

**Phase B — "How It Works" standardization (APP_VERSION v0.19.2 → v0.19.3).** Reel is multi-page, so the
canonical "How It Works" lives where the hamburger does — the **owner shell `studio.html`**. Added a
Credits-style dismissible card (`#reelHelp`, fixed/centered with a `✕` close button + bold "How It Works"
heading), a **first paragraph leading with "Magic Reel lets you share film footage…"**, a 4-step quick start,
and the **"Part of the Magic Suite"** block. Wired a new hamburger item **`#reelHelpMenuItem` "❓ How It Works"**
in `#fastMenu` (opens the panel + closes the menu; `✕` hides it).
- **Decision (noted):** `index.html` (the Send screen, iframed into the shell) and `reel.html` (the public
  recipient page) keep their own `?`-button *screen-specific* quick-help modals — those are page how-tos, not the
  app explainer — but I **renamed their headings + the `?` button title/aria-label "How this works" → "How It
  Works"** for consistency. The studio panel is the standardized app-level How It Works; the `?` modals are the
  per-screen guides. Cross-iframe triggering of the index modal from the shell hamburger would need fragile
  postMessage, so a self-contained shell panel is cleaner.
- App-title wordmark ("Magic Reel") untouched. Verified: `node --check` ✓; all four pages' inline scripts parse
  ✓; studio markup serves the heading, hamburger item, Magic-Reel-led paragraph, and Suite block; no leftover
  "How this works" anywhere.

## Suite Bulletproofing, Fixes & Improvements (2026-06-30) — APP_VERSION v0.18.0 → v0.19.0

**Repo hygiene first:** Reel had **no `.gitattributes`** while `core.autocrlf=true` — exactly the setup the
house rules warn against (line-ending normalization silently strips regex backslashes, e.g. `server.js`'s
`/^https?:\/\//`). Added the canonical `* -text` `.gitattributes` (own commit) so this commit — and all
future ones — keep code byte-for-byte. Verified the committed blobs still contain their backslashes.

**Phase 1 fix:** Title descender clip — added `padding-bottom:.16em; margin-bottom:-.16em` to `.brand .wm`
(and `.brand .bn` on the recipient page) across all four Reel pages. Zero layout shift.

**Phase 2 — Bulletproofing.** All additive; no behavior change on success.
- **Async route wrapper** installed right after `app = express()` (CommonJS variant): every handler's throw or
  rejected promise is forwarded to the error middleware. Arity preserved (3-arg vs 4-arg). Pattern validated
  in isolation.
- **Global error-handling middleware** (after all routes): logs + alerts, returns a calm HTML page / `{error}`
  JSON; defers to Express if headers already sent.
- **Process nets:** `uncaughtException` / `unhandledRejection` log + alert and keep the engine alive (it
  already had per-job `.catch()` on the retention sweeps — left intact).
- **Network resilience:** new `fetchWithTimeout()` wraps the **Mux API** (12s) and **all Resend sends** (8s).
  No retry on those (Mux mutations + email sends must not double-fire). The large **clip download**
  (`downloadToFile`) deliberately stays on plain `fetch` — a short timeout would break big transfers.
- **Error logging + email alerts:** `logError()` + `sendErrorAlert()` email Isaiah via the existing Resend
  setup (`FEEDBACK_TO`, else `CALLSHEET_FROM` address), **rate-limited to one per 5 min**. No-op if unset.
- **Client-side net:** early inline script on **all four pages** (incl. the public `reel.html` recipient page)
  catches `window.onerror` + `unhandledrejection`, never blanks the page, best-effort reports to
  **`POST /api/client-error`** (added to the gate's public allowlist so recipient pages can report too).

**Validation:** `node --check server.js` ✅; all four pages' inline scripts parse + tags balanced ✅; server
boots and `/health`,`/version`,`/`,`/api/client-error`(public, logged),`/api/dashboard`(503 w/o DB) all
behave correctly. ⚠️ No live browser / no Mux+DB creds this session — spot-check a real send + recipient cut.

## Phase 1 (2026-06-26) — switcher + accent. Mechanical pass. Review & push when ready.

### 1A · Two-way switcher
- Added **Credits** as a destination in the app switcher (`public/studio.html`, the only page with the switcher nav). Inserted a `&middot;` dot + `<a href="https://credits.isaiahsmithfilms.com" data-app="credits">Credits</a>` after Marquee, matching the existing entry shape exactly.
- No JS change needed: the existing hostname-aware lighting snippet only marks the *current* app active, and Reel is never served on the credits host, so Credits renders as a normal link — same as the other non-active entries.

### 1B · Accent reassigned: purple → **orange `#f45911`**
Reel had no accent picker — purple was its hardcoded suite identity. Changed every identity instance to orange; left non-identity color data alone.

Changed:
- `public/dashboard.html`, `index.html`, `reel.html`, `studio.html` — each `:root` light + `body.dark` `--accent` (purple → `#f45911`), and the wordmark title gradient `--t1/--t2/--t3` (`#9a78ff/#7c4dff/#c77dff` → `#ff8a3d/#f45911/#ffb74d`).
- `public/reel.html` — `.greet .ava` default avatar background (was the brand purple) → orange, to stay on-brand.
- `server.js` — recipient-page `:root --accent` and the "Open your reel" email button background → orange.
- `server.js` `APP_VERSION` bumped `v0.10.8` → `v0.11.0`.

Also swept the old-purple leftover:
- The `AVA=[...]` avatar palette in `dashboard.html` and `index.html` had `#7c4dff` as its first slot → changed to `#f45911` so it leads with the new brand orange. (The other 7 wheel colors are unrelated and untouched.)

✅ CLAUDE.md accent table updated across all four repos to the new mapping.

### Orange gradient choice
For the wordmark gradient I derived `#ff8a3d / #f45911 / #ffb74d` (light → base → light) since there was no existing orange gradient at `#f45911`. Easy to tweak if you want a different feel.

### Validation
- `node --check server.js` ✅
- Switcher: 1 Credits entry, nav tags balanced ✅
- No deploy — yours to push.

---

## Phase 2 (2026-06-26) — header → fast menu (Reel). Review/test/push before I do Marquee.

**Goal:** top-right shows only the **app switcher + a hamburger (☰)**; everything else lives in the ☰ menu. Version `v0.11.0` → **`v0.12.0`** (`server.js` `APP_VERSION` + studio.html footer fallback).

### Scope — `public/studio.html` only
The suite header (brand + switcher) only exists in the **studio shell** (`studio.html`); the Send/Dashboard pages render inside it as iframes, and the public recipient page (`/r/<token>`) has no suite chrome. So Phase 2 touches **studio.html** only. *(If you ever want the same treatment on the standalone Send page, flag it — out of scope for this pass.)*

### What was up top, and where it went
Reel's studio top-right had just **two** things: the **app switcher** and a **dark/light toggle** (`#themeBtn`). Reel had **no** existing menu, so I built one (its own, themed with Reel's vars — orange accent):
- **Built a hamburger (☰) + dropdown** (`.fast-menu`), pinned far-right next to the switcher.
- **Moved the dark/light toggle into the menu.** I literally moved the same `#themeBtn` element inside the dropdown and relabelled it to text ("☀️ Light mode" / "🌙 Dark mode") — so the existing click handler + theme-broadcast-to-iframes logic is **unchanged and still works**; only its location and label changed. Clicking it flips the theme in place and keeps the menu open so you see it change.
- **Added a grayed-out, disabled "↩ Log out" placeholder** — not wired to anything (Reel is a satellite; real sign-out is Suite Pass / MSM's job). It's `disabled` + dimmed.

### Result
Top-right now = **switcher + ☰** only. On phones (≤560px) the switcher + ☰ wrap to their own row under the brand (Credits-style), so nothing's cramped.

### Validation
- Extracted the inline `<script>` and `node --check`'d it ✅; `node --check server.js` ✅
- Tag-balance (a/span/nav/div/button/header/footer) all balanced ✅
- ⚠️ Couldn't run a live browser this session (Chrome extension not connected). **Please device-test:** open ☰ on desktop + iPhone Safari portrait, confirm dark/light still toggles (and re-themes the embedded Send/Preview/Dashboard frames), the switcher still hops to all four apps, and the top-right shows only switcher + ☰. Log out should appear grayed/un-clickable.
- No deploy — yours to push.

---

## Unified header + logo badge task (2026-06-27) — Reel. v0.12.0 → v0.13.0.

Applied the **same canonical header** as MSM (`public/studio.html`; the studio shell is the only
page with the suite header):
- **Part 1:** two-row header — Row 1 badge + `Magic Reel` wordmark (orange gradient kept, unified
  to 27px); Row 2 the switcher; full-width divider underneath. Flattened the old `.hdr-actions`
  wrapper into `<header>` (column layout). Hamburger pinned top-right (absolute).
- **Part 2:** boxed logo badge — `.brand-badge` (30×30, 1.5px orange border, dark fill) with an
  inline-SVG **clapperboard** in the accent color. Replaces the old `✦`.
- **Part 3:** mobile (≤560px) centers brand + switcher; hamburger stays top-right.
- **Part 5:** the ☰ Dark/Light toggle already flipped in place and kept the menu open (the toggle
  lives inside the menu) — unchanged, already matches the target behavior.
- Part 4 N/A (Reel is orange, already correct).
- Version: `server.js` `APP_VERSION` + studio footer → `v0.13.0`.

**Validation:** inline `<script>` + `server.js` `node --check`'d ✅; tags balanced (a/span/nav/div/
button/header) ✅; no `.hdr-actions`/`.star` leftovers. ⚠️ Couldn't run a live browser — please
device-test the header on desktop + iPhone Safari portrait (badge renders, two-row + divider,
mobile centered, ☰ theme toggle keeps menu open, switcher hops all four apps).

---

## Suite consistency pass (2026-06-27) — Reel. v0.14.0 → v0.15.0.

Aligning Reel to MSM as the gold reference (suite-wide pass; full audit in the repo-root
`MSM-Studio-Suite/NOTES.md`). Header was already unified in v0.13/v0.14 — untouched here.

**Scrollbar (was entirely absent):** added MSM's custom thin/translucent scrollbar block to all
four HTML files (`studio.html`, `index.html`, `dashboard.html`, `reel.html`):
`scrollbar-width:thin; scrollbar-color:rgba(150,150,160,.32) transparent` + the `::-webkit-scrollbar*`
thumb (rgba(150,150,160,.30), radius 999px, 2px transparent border, padding-box). This is MSM's
actual scrollbar — used over the task's `#3a3a3d` baseline because MSM already had one (it wins).

**Over-wide top buttons (studio Send/Preview/Dashboard/Settings):** root cause was `.tab{flex:1}`
inside the uncapped full-height shell — each tab stretched to a full quarter of the window and grew
without bound on wide desktops. Now `flex:0 0 auto` + `padding:9px 18px`, and `nav.tabs` is
`justify-content:center` → compact, content-sized, centered, stops growing. Mobile (≤600px) restores
`flex:1 1 auto` (padding 9px 6px) so the four tabs fill the narrow width without overflow.

**Button/card drift:** studio `.btn-primary` radius 11→10 and hover `filter:brightness(1.06)`→
`opacity:.9` (now matches `.send/.dl/.modalbtn` + MSM). `.preview-card` radius 13→12.

**Width:** `index/dashboard/reel.html` `.wrap` max-width 760→860 (MSM column).

**Misc:** `index.html` `cardflash` keyframe stale MSM-purple `rgba(124,77,255)`→Reel orange
`rgba(244,89,17)`; the two custom `<select>` chevrons hardcoded the light text-soft `#6b6a64`→
theme-neutral `#8a8a8a` (visible in dark too).

**Footer:** all four pages now read "Isaiah Smith Films · Magic Reel v…" (added the brand prefix);
CSS font-size 11–12→12.5px, dropped `opacity:.7`, added `letter-spacing:.02em`. The runtime
`/version` fetch was updated to emit the brand prefix too, so the live footer stays consistent.
`server.js APP_VERSION` → `v0.15.0 — 🎛️ Suite consistency pass: scrollbar, tab sizing, button states`.

**Deliberately left alone:** the standalone `index/dashboard/reel.html` `.star ✦` brand header — the
public recipient page has no suite chrome by design and the other two render embedded in the studio
iframe (header hidden). Converting those to the full-width suite band is structural scope, not a
consistency tweak; their tokens/scrollbar/footer/width were aligned instead.

**Validation:** `node --check server.js` ✅; all inline `<script>` blocks parse ✅; tag-balance
(div/button/nav/header/footer/select) balanced across all four files ✅. ⚠️ No live browser this
session — please device-test desktop + iPhone Safari portrait (tab row sizing across widths,
scrollbars in the Settings panel + dashboard list, footer text). No deploy — yours to push.
