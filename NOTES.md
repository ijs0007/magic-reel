# Magic Reel — handoff notes

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
