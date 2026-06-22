// Magic Reel — engine
// v0.3.0 — 🧵 Stitch: Mux clips, server -c copy join
//
// How the clean cut works now:
//   1. Each selected range becomes its OWN single-range Mux clip, cut straight from
//      the MASTER asset (frame-accurate, full quality). All trimming/decoding happens
//      on Mux — never on our server. Each clip also gets a downloadable "highest" MP4.
//   2. We pull those clip MP4s and join them with FFmpeg: video is STREAM-COPIED (the
//      expensive part never re-encodes), and audio is re-encoded into one continuous
//      track so there's no click at a seam (stream-copying independently-encoded AAC
//      leaves a ~18ms overlap at each join). Audio-only encode is cheap, so this stays
//      light on the basic tier — nothing like the libx264 path that timed out.
//   3. We delete the Mux clip assets the moment the stitch succeeds (the finished reel
//      lives locally by then), so Mux storage trends to ~0.
//
// Why this shape:
//   - Mux has no video-concatenation API (its multi-input inputs[] is for layering
//     audio/captions/overlays, not sequencing clips). So the join must happen here —
//     but only as a stream copy, which is light.
//   - Each clip MP4 is already muxed (audio + video in one file), so the "audio is a
//     separate HLS track" gotcha never arises.
//
// Each cut returns a RECEIPT (per-clip status, stitch state, requested vs actual
// duration) so we can verify the -c copy join against real footage. See /api/cuts/:jobId.

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const { Pool } = require('pg');
let ffmpegPath = null;
try { ffmpegPath = require('ffmpeg-static'); } catch (e) { /* installed in production via npm install */ }

const APP_VERSION = 'v0.10.4 — 🔤 Smarter titles: split run-together filenames into words';

const app = express();
const PORT = process.env.PORT || 3000;

// Neon Postgres — the SAME database Magic Story Maker uses, so Magic Reel
// can read your real cast & crew later. Neon requires SSL.
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

// --- Mux (REST API, HTTP Basic auth with the token id + secret) ---
const MUX_ID = process.env.MUX_TOKEN_ID;
const MUX_SECRET = process.env.MUX_TOKEN_SECRET;
function muxConfigured() { return !!(MUX_ID && MUX_SECRET); }
async function muxFetch(p, opts) {
  opts = opts || {};
  const res = await fetch('https://api.mux.com' + p, {
    method: opts.method || 'GET',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(MUX_ID + ':' + MUX_SECRET).toString('base64'),
      'Content-Type': 'application/json'
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  let json = {};
  try { const t = await res.text(); json = t ? JSON.parse(t) : {}; } catch (e) { /* non-JSON */ }
  if (!res.ok) {
    const m = (json.error && json.error.messages && json.error.messages.join('; ')) || ('Mux error ' + res.status);
    const err = new Error(m); err.status = res.status; throw err;
  }
  return json.data;
}

// --- Email (Resend REST API) — reuses MSM's env var names so the same values work.
//     Silently no-ops if not configured, exactly like MSM. ---
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const CALLSHEET_FROM = process.env.CALLSHEET_FROM || ''; // e.g. "Isaiah Smith <you@isaiahsmithfilms.com>"
// Public base URL (e.g. https://reels.isaiahsmithfilms.com) for links built in background jobs,
// where there's no request to read the host from. Only needed for the "expiring soon" email;
// if unset, that email stays dormant.
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/[/]+$/, '');
const DISPLAY_TZ = process.env.DISPLAY_TZ || 'America/Los_Angeles'; // Pacific — timezone for dates shown in recipient emails
function resendConfigured() { return !!(RESEND_API_KEY && CALLSHEET_FROM); }
function fmtClock(s) { s = Math.max(0, Math.round(Number(s) || 0)); const m = Math.floor(s / 60), ss = s % 60; return m + ':' + (ss < 10 ? '0' : '') + ss; }
function emailEsc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// The public origin to build recipient links from: prefer the request Origin header,
// fall back to the Host. Shared by the mint + resend/nudge endpoints so links are
// built one way everywhere.
function reqBase(req) {
  return (req.headers.origin && /^https?:\/\//.test(req.headers.origin)) ? req.headers.origin : ('https://' + (req.headers.host || ''));
}

// Strip a video file extension (.mov/.mp4/etc) from any user-facing film name.
function stripExt(s) {
  s = String(s == null ? '' : s).trim();
  return s.replace(/[.](mov|mp4|m4v|avi|mkv|webm|mpg|mpeg|wmv|flv|mts|m2ts|ts|prores|mxf|r3d|braw|3gp|ogv|vob|qt|dv)$/i, '');
}
function reelFirstName(name) {
  var n = String(name == null ? '' : name).trim();
  return n.split(' ')[0] || 'there';
}
// One elegant, minimal shell for every recipient email: greeting, one line, button, fine print.
function emailShell(firstEsc, bodyHtml, link, fileNote) {
  var foot = fileNote ? ('<p style="color:#c2c2c2;font-size:11px;margin:22px 0 0;">File: ' + fileNote + '</p>') : '';
  return '<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;color:#1a1a1c;line-height:1.65;max-width:460px;margin:0 auto;padding:12px 0;">' +
    '<p style="font-size:16px;font-weight:600;margin:0 0 16px;">Hi ' + firstEsc + ',</p>' +
    '<p style="font-size:15px;color:#3a3a3c;margin:0 0 26px;">' + bodyHtml + '</p>' +
    '<p style="margin:0 0 26px;"><a href="' + link + '" style="background:#7c4dff;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:14px 28px;border-radius:11px;display:inline-block;">Open your reel</a></p>' +
    '<p style="font-size:14px;color:#3a3a3c;margin:0 0 3px;">All the best,</p>' +
    '<p style="font-size:14px;color:#1a1a1c;font-weight:600;margin:0 0 22px;">Isaiah Jeremiah</p>' +
    '<p style="color:#a0a0a0;font-size:12.5px;margin:0;">Your private link — just for you.</p>' +
    foot +
    '</div>';
}

function reelReadyLine(phrase, cap) {
  var L = [
    'Your selects from ' + phrase + ' are ready \u2014 grab up to <strong>' + cap + '</strong>.',
    phrase + ' is cut and waiting \u2014 pick your favorite moments, up to <strong>' + cap + '</strong>.',
    'Fresh from the edit: ' + phrase + ' \u2014 choose your selects, up to <strong>' + cap + '</strong>.',
    'Time to pull your moments from ' + phrase + ' \u2014 you have up to <strong>' + cap + '</strong>.',
    phrase + ' is ready for your eyes \u2014 mark your selects, up to <strong>' + cap + '</strong>.',
    'Dive into ' + phrase + ' and pick your selects \u2014 up to <strong>' + cap + '</strong>.'
  ];
  return L[Math.floor(Math.random() * L.length)];
}
// Owner-editable email message (Studio -> Settings). Returns safe defaults if the
// table/row is missing or anything fails, so email sending never breaks on it.
async function getReelSettings() {
  if (!pool) return { customMessage: '', useCustom: false };
  try {
    const q = await pool.query('SELECT custom_message, use_custom FROM reel_settings WHERE id = 1');
    if (!q.rows.length) return { customMessage: '', useCustom: false };
    return { customMessage: q.rows[0].custom_message || '', useCustom: !!q.rows[0].use_custom };
  } catch (e) { return { customMessage: '', useCustom: false }; }
}
async function sendReelEmail(to, name, link, filmName, budgetSeconds, sourceFile) {
  if (!resendConfigured()) return { ok: false, reason: 'not-configured' };
  to = String(to || '').trim();
  if (!(to.indexOf('@') > 0 && to.lastIndexOf('.') > to.indexOf('@') + 1)) return { ok: false, reason: 'no-recipient' };
  var film = String(filmName || '').trim();
  var named = film && film !== 'Untitled';
  var phrase = named ? '\u201c' + emailEsc(film) + '\u201d' : 'your footage';
  var cap = fmtClock(budgetSeconds);
  var subject = 'Magic Reel | ' + (named ? film + ' | ' : '') + 'Choose Your Selects';
  var bodyHtml = reelReadyLine(phrase, cap);
  try {
    var st = await getReelSettings();
    if (st.useCustom && st.customMessage && st.customMessage.trim()) {
      // Escape literal text first, then expand the known tokens (plain text only).
      var titleTok = named ? film : 'your footage';
      bodyHtml = emailEsc(st.customMessage).split('{title}').join(emailEsc(titleTok)).split('{name}').join(emailEsc(reelFirstName(name))).split('{time}').join(cap);
    }
  } catch (e) {}
  var html = emailShell(emailEsc(reelFirstName(name)), bodyHtml, link, emailEsc(sourceFile || ''));
  try {
    var r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: CALLSHEET_FROM, to: [to], subject: subject, html })
    });
    if (!r.ok) { var d = await r.text().catch(function () { return ''; }); return { ok: false, reason: 'resend-' + r.status, detail: String(d).slice(0, 200) }; }
    return { ok: true };
  } catch (e) { return { ok: false, reason: 'exception', detail: e.message }; }
}

async function sendReelNudgeEmail(to, name, link, filmName, budgetSeconds) {
  if (!resendConfigured()) return { ok: false, reason: 'not-configured' };
  to = String(to || '').trim();
  if (!(to.indexOf('@') > 0 && to.lastIndexOf('.') > to.indexOf('@') + 1)) return { ok: false, reason: 'no-recipient' };
  var film = String(filmName || '').trim();
  var named = film && film !== 'Untitled';
  var phrase = named ? '\u201c' + emailEsc(film) + '\u201d' : 'your footage';
  var cap = fmtClock(budgetSeconds);
  var html = emailShell(emailEsc(reelFirstName(name)), 'Still waiting on your selects from ' + phrase + ' — up to <strong>' + cap + '</strong>, whenever you’re ready.', link);
  try {
    var r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: CALLSHEET_FROM, to: [to], subject: 'Reminder: your reel selects' + (named ? ' \u2014 ' + film : ''), html })
    });
    if (!r.ok) { var d = await r.text().catch(function () { return ''; }); return { ok: false, reason: 'resend-' + r.status, detail: String(d).slice(0, 200) }; }
    return { ok: true };
  } catch (e) { return { ok: false, reason: 'exception', detail: e.message }; }
}

async function sendReelExpiringEmail(to, name, link, filmName, budgetSeconds, expiresAt) {
  if (!resendConfigured()) return { ok: false, reason: 'not-configured' };
  to = String(to || '').trim();
  if (!(to.indexOf('@') > 0 && to.lastIndexOf('.') > to.indexOf('@') + 1)) return { ok: false, reason: 'no-recipient' };
  var film = String(filmName || '').trim();
  var named = film && film !== 'Untitled';
  var phrase = named ? '\u201c' + emailEsc(film) + '\u201d' : 'your footage';
  var cap = fmtClock(budgetSeconds);
  var when = '';
  try { var d0 = new Date(expiresAt); if (!isNaN(d0.getTime())) when = d0.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: DISPLAY_TZ }); } catch (e) {}
  var expiry = when ? ('on ' + when) : 'soon';
  var html = emailShell(emailEsc(reelFirstName(name)), 'Your link for ' + phrase + ' expires <strong>' + expiry + '</strong> — grab your cut (up to <strong>' + cap + '</strong>) before then.', link);
  try {
    var r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: CALLSHEET_FROM, to: [to], subject: 'Your reel link is expiring' + (named ? ' \u2014 ' + film : ''), html })
    });
    if (!r.ok) { var d = await r.text().catch(function () { return ''; }); return { ok: false, reason: 'resend-' + r.status, detail: String(d).slice(0, 200) }; }
    return { ok: true };
  } catch (e) { return { ok: false, reason: 'exception', detail: e.message }; }
}

// --- Mux signed playback (opt-in: dormant unless a signing key is set) ---
// Makes the master private so the ONLY way to get video is the metered cut endpoint.
const MUX_SIGNING_KEY_ID = process.env.MUX_SIGNING_KEY_ID || '';
const MUX_SIGNING_KEY_PRIVATE = process.env.MUX_SIGNING_KEY_PRIVATE || '';
const PLAYBACK_TTL = 6 * 3600; // signed tokens live 6h; a fresh one is minted on every page load
function signingConfigured() { return !!(MUX_SIGNING_KEY_ID && MUX_SIGNING_KEY_PRIVATE); }
function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function signingKeyPem() { const k = MUX_SIGNING_KEY_PRIVATE; return /BEGIN/.test(k) ? k : Buffer.from(k, 'base64').toString('utf8'); }
function signMuxToken(playbackId, aud, ttlSeconds) {
  if (!signingConfigured() || !playbackId) return null;
  const header = { alg: 'RS256', typ: 'JWT', kid: MUX_SIGNING_KEY_ID };
  const payload = { sub: playbackId, aud: aud, exp: Math.floor(Date.now() / 1000) + (ttlSeconds || PLAYBACK_TTL) };
  const signingInput = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(payload));
  const sig = crypto.sign('RSA-SHA256', Buffer.from(signingInput), signingKeyPem());
  return signingInput + '.' + b64url(sig);
}
// aud: 'v' video, 't' thumbnail, 's' storyboard. mux-video only needs the video token;
// the others let a full mux-player show its poster + scrubbing previews.
function playbackTokens(playbackId, isSigned) {
  if (!playbackId || !isSigned || !signingConfigured()) return {};
  return {
    playbackToken: signMuxToken(playbackId, 'v', PLAYBACK_TTL),
    thumbnailToken: signMuxToken(playbackId, 't', PLAYBACK_TTL),
    storyboardToken: signMuxToken(playbackId, 's', PLAYBACK_TTL)
  };
}

// --- Whole-app owner gate (opt-in: open until DASHBOARD_PASSWORD is set).
//     One password-only login page guards the entire owner surface (send screen,
//     dashboard, all owner APIs). The recipient flow (/r/:token + its APIs) is NEVER
//     gated — a recipient's token IS their key. Set DASHBOARD_PASSWORD to your MSM
//     password for a unified feel. True shared login arrives when Magic Reel merges
//     into MSM. Auth is a stateless signed cookie (HMAC of the password), no DB needed. ---
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const AUTH_COOKIE = 'mr_auth';
function authToken() { return crypto.createHmac('sha256', DASHBOARD_PASSWORD || 'unset').update('mr-auth-v1').digest('hex'); }
function parseCookies(req) {
  const out = {}; (req.headers.cookie || '').split(';').forEach(function (p) {
    const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  });
  return out;
}
function isAuthed(req) { return !DASHBOARD_PASSWORD || parseCookies(req)[AUTH_COOKIE] === authToken(); }

// Gate runs before static + routes. Owner surface needs the cookie; everything a
// recipient or the login page touches passes through untouched.
function gate(req, res, next) {
  if (!DASHBOARD_PASSWORD) return next();
  const p = req.path;
  if (p === '/login' || p === '/api/login' || p === '/logout' || p === '/health' || p === '/version') return next();
  if (p.indexOf('/r/') === 0 || p.indexOf('/api/r/') === 0 || p.indexOf('/api/cuts/') === 0) return next();
  if (/\.(css|js|mjs|png|jpe?g|webp|gif|svg|ico|woff2?|ttf|otf|map)$/i.test(p)) return next();
  if (isAuthed(req)) return next();
  if (p.indexOf('/api/') === 0) return res.status(401).json({ error: 'Not authenticated.' });
  return res.redirect('/login');
}

const LOGIN_HTML = '<!doctype html><html lang="en"><head>' +
'<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#faf9f5">' +
'<title>Magic Reel</title>' +
'<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
'<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@600;700&display=swap" rel="stylesheet">' +
'<style>' +
':root{--bg:#faf9f5;--surface:#fff;--text:#1a1a18;--text-soft:#6b6b66;--border:#e7e5df;--accent:#7c4dff;--accent-text:#fff;--bad:#c2410c}' +
'*{box-sizing:border-box}' +
'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;padding:24px}' +
'.card{width:100%;max-width:360px;background:var(--surface);border:1px solid var(--border);border-radius:18px;padding:34px 28px;box-shadow:0 12px 40px rgba(0,0,0,.06)}' +
'.brand{font-family:"Poppins",sans-serif;font-weight:700;font-size:22px;text-align:center;margin:0 0 4px}' +
'.brand .dot{color:var(--accent)}' +
'.sub{text-align:center;color:var(--text-soft);font-size:13.5px;margin:0 0 22px}' +
'label{display:block;font-size:12.5px;color:var(--text-soft);margin:0 0 6px}' +
'input{width:100%;font-family:inherit;font-size:15px;padding:12px 13px;border:1px solid var(--border);border-radius:10px;background:#fbfbf9;color:var(--text);outline:none}' +
'input:focus{border-color:var(--accent)}input.bad{border-color:var(--bad)}' +
'button{width:100%;margin-top:16px;font-family:inherit;font-size:15px;font-weight:600;padding:12px;border:none;border-radius:10px;background:var(--accent);color:var(--accent-text);cursor:pointer}' +
'button:disabled{opacity:.6;cursor:default}' +
'.err{color:var(--bad);font-size:13px;margin-top:12px;text-align:center;min-height:16px}' +
'</style></head><body>' +
'<div class="card">' +
'<div class="brand">Magic Reel<span class="dot">.</span></div>' +
'<p class="sub">Enter your password to continue.</p>' +
'<label for="pw">Password</label>' +
'<input id="pw" type="password" autocomplete="current-password" autofocus>' +
'<button id="go">Sign in</button>' +
'<div class="err" id="err"></div>' +
'</div>' +
'<script>' +
'var pw=document.getElementById("pw"),go=document.getElementById("go"),err=document.getElementById("err");' +
'function submit(){var v=pw.value;if(!v){pw.classList.add("bad");return;}go.disabled=true;err.textContent="";pw.classList.remove("bad");' +
'fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:v})})' +
'.then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});})' +
'.then(function(o){if(o.ok){location.href="/";}else{go.disabled=false;err.textContent=(o.j&&o.j.error)||"Incorrect password.";pw.classList.add("bad");pw.focus();pw.select();}})' +
'.catch(function(){go.disabled=false;err.textContent="Something went wrong. Try again.";});}' +
'go.addEventListener("click",submit);' +
'pw.addEventListener("keydown",function(e){if(e.key==="Enter")submit();});' +
'pw.addEventListener("input",function(){pw.classList.remove("bad");err.textContent="";});' +
'</scr' + 'ipt></body></html>';

// Magic Reel's own table — prefixed reel_ so it can never collide with Magic Story Maker's tables.
async function ensureSchema() {
  if (!pool) return;
  await pool.query(
    'CREATE TABLE IF NOT EXISTS reel_sends (' +
    ' id TEXT PRIMARY KEY,' +
    ' film_name TEXT,' +
    ' upload_id TEXT,' +
    ' asset_id TEXT,' +
    ' playback_id TEXT,' +
    " status TEXT NOT NULL DEFAULT 'created'," +
    ' duration DOUBLE PRECISION,' +
    ' playback_signed BOOLEAN NOT NULL DEFAULT false,' +
    ' expires_at TIMESTAMPTZ,' +
    ' asset_deleted_at TIMESTAMPTZ,' +
    ' created_at TIMESTAMPTZ NOT NULL DEFAULT now()' +
    ')'
  );
  await pool.query('ALTER TABLE reel_sends ADD COLUMN IF NOT EXISTS playback_signed BOOLEAN NOT NULL DEFAULT false');
  await pool.query('ALTER TABLE reel_sends ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ');
  await pool.query('ALTER TABLE reel_sends ADD COLUMN IF NOT EXISTS asset_deleted_at TIMESTAMPTZ');
  await pool.query('ALTER TABLE reel_sends ADD COLUMN IF NOT EXISTS fps DOUBLE PRECISION');
  await pool.query('ALTER TABLE reel_sends ADD COLUMN IF NOT EXISTS source_file TEXT');
  // Backfill expiry for rows that predate the column (LINK_TTL_DAYS is an in-code integer, no injection).
  await pool.query("UPDATE reel_sends SET expires_at = created_at + interval '" + LINK_TTL_DAYS + " days' WHERE expires_at IS NULL");
  await pool.query(
    'CREATE TABLE IF NOT EXISTS reel_recipients (' +
    ' token TEXT PRIMARY KEY,' +
    ' send_id TEXT NOT NULL,' +
    ' name TEXT,' +
    ' email TEXT,' +
    ' budget_seconds INTEGER NOT NULL DEFAULT 120,' +
    ' used_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,' +
    ' created_at TIMESTAMPTZ NOT NULL DEFAULT now()' +
    ')'
  );
  // migrate older reel_recipients tables that predate these columns
  await pool.query('ALTER TABLE reel_recipients ADD COLUMN IF NOT EXISTS email TEXT');
  await pool.query('ALTER TABLE reel_recipients ADD COLUMN IF NOT EXISTS used_seconds DOUBLE PRECISION NOT NULL DEFAULT 0');
  await pool.query('ALTER TABLE reel_recipients ADD COLUMN IF NOT EXISTS opened_at TIMESTAMPTZ');
  await pool.query('ALTER TABLE reel_recipients ADD COLUMN IF NOT EXISTS last_cut_at TIMESTAMPTZ');
  await pool.query('ALTER TABLE reel_recipients ADD COLUMN IF NOT EXISTS expiring_notified_at TIMESTAMPTZ');
  // Studio: a dedicated, flagged "Preview" recipient backs the Preview tab so the
  // owner can scrub/mark without polluting any real recipient's usage.
  await pool.query('ALTER TABLE reel_recipients ADD COLUMN IF NOT EXISTS is_preview BOOLEAN DEFAULT false');
  // Studio: owner-editable email message (single owner row, id = 1).
  await pool.query(
    'CREATE TABLE IF NOT EXISTS reel_settings (' +
    ' id INTEGER PRIMARY KEY DEFAULT 1,' +
    ' custom_message TEXT,' +
    ' use_custom BOOLEAN NOT NULL DEFAULT false,' +
    ' updated_at TIMESTAMPTZ NOT NULL DEFAULT now()' +
    ')'
  );
}
function publicSend(r) {
  return Object.assign(
    { sendId: r.id, filmName: r.film_name, status: r.status, playbackId: r.playback_id, duration: r.duration, fps: r.fps },
    playbackTokens(r.playback_id, r.playback_signed)
  );
}

app.use(express.json());
app.use(gate);
app.use(express.static(path.join(__dirname, 'public'), { setHeaders: function(res, fp){ if(String(fp).toLowerCase().endsWith('.html')) res.set('Cache-Control','no-store, max-age=0'); } }));

// --- auth (exempt from the gate) ---
app.get('/login', (req, res) => {
  if (!DASHBOARD_PASSWORD || isAuthed(req)) return res.redirect('/');
  res.type('html').send(LOGIN_HTML);
});
app.post('/api/login', (req, res) => {
  if (!DASHBOARD_PASSWORD) return res.json({ ok: true });
  const pw = (req.body && req.body.password) || '';
  if (pw !== DASHBOARD_PASSWORD) return res.status(401).json({ error: 'Incorrect password.' });
  const secure = (req.headers['x-forwarded-proto'] === 'https' || req.secure) ? '; Secure' : '';
  res.setHeader('Set-Cookie', AUTH_COOKIE + '=' + authToken() + '; HttpOnly; Path=/; Max-Age=' + (60 * 60 * 24 * 30) + '; SameSite=Lax' + secure);
  res.json({ ok: true });
});
app.get('/logout', (req, res) => {
  res.setHeader('Set-Cookie', AUTH_COOKIE + '=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
  res.redirect('/login');
});

// --- pages ---
//  /            -> filmmaker send screen      (public/index.html, served by static)
//  /dashboard   -> the activity dashboard
//  /r/:token    -> a recipient's private preview link
app.get('/dashboard', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'), { headers: { 'Cache-Control': 'no-store, max-age=0' } }));

app.get('/r/:token?', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'reel.html'), { headers: { 'Cache-Control': 'no-store, max-age=0' } }));

// Studio shell: one tabbed space wrapping Send / Preview / Dashboard / Settings.
// Gated like the rest of the owner surface (not in the gate's exempt list).
app.get('/studio', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'studio.html'), { headers: { 'Cache-Control': 'no-store, max-age=0' } }));

// --- health check: confirms the service is up and the database is reachable ---
app.get('/health', async (req, res) => {
  const base = { ok: true, version: APP_VERSION, mux: muxConfigured(), ffmpeg: !!ffmpegPath, resend: resendConfigured(), signing: signingConfigured(), dashboardAuth: !!DASHBOARD_PASSWORD };
  if (!pool) return res.json(Object.assign(base, { db: 'not configured' }));
  try {
    const r = await pool.query('SELECT now() AS now');
    res.json(Object.assign(base, { db: 'connected', now: r.rows[0].now }));
  } catch (e) {
    res.status(500).json({ ok: false, version: APP_VERSION, db: 'error', error: e.message });
  }
});

// Quick read-only version check.
app.get('/version', (req, res) => res.json({ version: APP_VERSION }));

// Owner dashboard data: every send you've made, with each recipient's usage + status.
app.get('/api/dashboard', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database is not configured yet.' });
  try {
    const sends = await pool.query('SELECT id, film_name, status, duration, created_at FROM reel_sends ORDER BY created_at DESC');
    const recips = await pool.query('SELECT token, send_id, name, email, budget_seconds, used_seconds, created_at, opened_at, last_cut_at FROM reel_recipients WHERE is_preview IS NOT TRUE ORDER BY created_at ASC');
    const bySend = {};
    recips.rows.forEach(function (r) {
      (bySend[r.send_id] = bySend[r.send_id] || []).push({
        token: r.token, name: r.name, email: r.email,
        cap: r.budget_seconds, used: Number(r.used_seconds) || 0,
        createdAt: r.created_at, openedAt: r.opened_at, lastCutAt: r.last_cut_at
      });
    });
    res.json({
      sends: sends.rows
        .filter(function (s) { return bySend[s.id]; }) // only sends actually delivered to someone
        .map(function (s) {
          return { id: s.id, title: s.film_name || 'Untitled', dur: s.duration, status: s.status, createdAt: s.created_at, recipients: bySend[s.id] };
        })
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Milestone 2: real video via Mux ---

// Create a Mux direct-upload URL and a matching send record.
// Your cast/crew + projects, read live from Magic Story Maker's shared database.
// MSM stores them as JSON rows in the kv table: the owner's people under key "people",
// scripts/projects under "library" (each project's castings link people to roles).
// Read-only — Magic Reel only ever writes its own reel_ tables.
function kvVal(rows, fb) {
  if (!rows.length) return fb;
  const v = rows[0].value;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch (e) { return fb; } }
  return v == null ? fb : v;
}
app.get('/api/roster', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database is not configured yet.' });
  try {
    const pe = await pool.query("SELECT value FROM kv WHERE key = 'people'");
    const li = await pool.query("SELECT value FROM kv WHERE key = 'library'");
    const peopleRaw = kvVal(pe.rows, []);
    const libraryRaw = kvVal(li.rows, []);
    const people = (Array.isArray(peopleRaw) ? peopleRaw : []).map(function (p) {
      return {
        id: p.id, name: p.name || '', kind: p.kind === 'crew' ? 'crew' : 'cast',
        email: (p.contact && p.contact.email) || '',
        phone: (p.contact && p.contact.phone) || ''
      };
    }).filter(function (p) { return p.id && p.name; });
    const byId = {}; people.forEach(function (p) { byId[p.id] = p; });
    const projects = (Array.isArray(libraryRaw) ? libraryRaw : [])
      .filter(function (it) { return it && it.id && !it.archived; })
      .map(function (it) {
        const members = (Array.isArray(it.castings) ? it.castings : [])
          .map(function (c) {
            const p = byId[c.personId];
            return p ? { id: p.id, name: p.name, email: p.email, phone: p.phone, kind: p.kind, role: c.roleKey || '' } : null;
          })
          .filter(Boolean);
        return { id: it.id, title: it.title || 'Untitled', members: members };
      })
      .filter(function (pr) { return pr.members.length; });
    res.json({ people: people, projects: projects });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/uploads', async (req, res) => {
  if (!muxConfigured()) return res.status(503).json({ error: 'Mux is not configured yet (set MUX_TOKEN_ID and MUX_TOKEN_SECRET).' });
  if (!pool) return res.status(503).json({ error: 'Database is not configured yet (set DATABASE_URL).' });
  try {
    // Make room before adding another asset: free anything expired, then enforce the floor.
    await cleanupExpiredSends().catch(function () {});
    await enforceAssetFloor().catch(function () {});
    const filmName = (String((req.body && req.body.filmName) || '').trim()) || 'Untitled';
    const sourceFile = String((req.body && req.body.sourceFile) || '').trim();
    const signed = signingConfigured();
    const upload = await muxFetch('/video/v1/uploads', {
      method: 'POST',
      body: {
        cors_origin: req.headers.origin || '*',
        timeout: 86400,
        new_asset_settings: { playback_policies: [signed ? 'signed' : 'public'], video_quality: 'basic' }
      }
    });
    const id = crypto.randomUUID();
    await pool.query(
      'INSERT INTO reel_sends (id, film_name, source_file, upload_id, status, playback_signed, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [id, filmName, sourceFile, upload.id, 'uploading', signed, expiryFromNow()]
    );
    res.json({ sendId: id, uploadUrl: upload.url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update a send's title + link expiry just before links go out (lets the sender
// correct the auto-extracted title during the upload/transcode window).
app.patch('/api/sends/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database is not configured yet.' });
  try {
    const id = String(req.params.id || '');
    const b = req.body || {};
    const sets = []; const vals = []; let n = 1;
    if (typeof b.title === 'string' && b.title.trim()) { sets.push('film_name = $' + (n++)); vals.push(b.title.trim().slice(0, 200)); }
    let days = parseInt(b.expiryDays, 10);
    if (isFinite(days)) { days = Math.max(1, Math.min(90, days)); sets.push('expires_at = $' + (n++)); vals.push(new Date(Date.now() + days * 86400000)); }
    if (!sets.length) return res.json({ ok: true, updated: 0 });
    vals.push(id);
    await pool.query('UPDATE reel_sends SET ' + sets.join(', ') + ' WHERE id = $' + n, vals);
    res.json({ ok: true, updated: sets.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Most recent upload (used by the recipient page for testing in this milestone).
app.get('/api/sends/latest', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database is not configured yet.' });
  try {
    const q = await pool.query('SELECT * FROM reel_sends ORDER BY created_at DESC LIMIT 1');
    if (!q.rows.length) return res.json({ none: true });
    res.json(publicSend(q.rows[0]));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Studio Preview tab: a recipient link for the most recent send, via a dedicated
// flagged "Preview" recipient (created once per send, on demand) so scrubbing/marking
// in Preview never touches a real recipient's used_seconds. Gated (owner-only); the
// returned token loads /r/<token>?embed=1, which is itself ungated like any reel link.
app.get('/api/latest-preview', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database is not configured yet.' });
  try {
    const s = await pool.query('SELECT id, film_name FROM reel_sends ORDER BY created_at DESC LIMIT 1');
    if (!s.rows.length) return res.json({ none: true });
    const sendId = s.rows[0].id;
    const filmName = s.rows[0].film_name || 'Untitled';
    // Mirror a real recipient so Preview shows exactly what went out — their name (drives the
    // greeting + the "for <name>" watermark) and their time budget. For a multi-recipient send,
    // take the most generous budget and the most recent recipient at that budget (which person
    // doesn't matter — it's only a preview of what was sent).
    const rep = await pool.query(
      'SELECT name, budget_seconds FROM reel_recipients WHERE send_id = $1 AND is_preview IS NOT TRUE' +
      ' ORDER BY budget_seconds DESC, created_at DESC LIMIT 1',
      [sendId]);
    const targetName = rep.rows.length ? (rep.rows[0].name || 'Preview') : 'Preview';
    const targetBudget = rep.rows.length ? Number(rep.rows[0].budget_seconds) : MAX_CUT_SECONDS;
    const ex = await pool.query('SELECT token, name, budget_seconds FROM reel_recipients WHERE send_id = $1 AND is_preview IS TRUE ORDER BY created_at ASC LIMIT 1', [sendId]);
    let token;
    if (ex.rows.length) {
      token = ex.rows[0].token;
      const budgetChanged = Number(ex.rows[0].budget_seconds) !== targetBudget;
      const nameChanged = (ex.rows[0].name || '') !== targetName;
      if (budgetChanged) {
        // Reset usage only when the budget changes, so a faithful re-check starts from a clean
        // slate; a name-only change leaves any in/out marks intact.
        await pool.query('UPDATE reel_recipients SET name = $1, budget_seconds = $2, used_seconds = 0 WHERE token = $3', [targetName, targetBudget, token]);
      } else if (nameChanged) {
        await pool.query('UPDATE reel_recipients SET name = $1 WHERE token = $2', [targetName, token]);
      }
    } else {
      token = genToken();
      await pool.query(
        'INSERT INTO reel_recipients (token, send_id, name, email, budget_seconds, is_preview) VALUES ($1, $2, $3, $4, $5, true)',
        [token, sendId, targetName, null, targetBudget]);
    }
    res.json({ token: token, filmName: filmName, sendId: sendId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Studio Settings tab: owner-editable email message. Both endpoints are owner-only
// (whole-app gate). Blank/!useCustom => the default rotating lines are used.
app.get('/api/settings', async (req, res) => {
  const st = await getReelSettings();
  res.json({ customMessage: st.customMessage, useCustom: st.useCustom });
});
app.post('/api/settings', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database is not configured yet.' });
  try {
    const b = req.body || {};
    const msg = String(b.customMessage == null ? '' : b.customMessage).slice(0, 2000);
    const use = b.useCustom === true;
    await pool.query(
      'INSERT INTO reel_settings (id, custom_message, use_custom, updated_at) VALUES (1, $1, $2, now())' +
      ' ON CONFLICT (id) DO UPDATE SET custom_message = EXCLUDED.custom_message, use_custom = EXCLUDED.use_custom, updated_at = now()',
      [msg, use]);
    res.json({ ok: true, customMessage: msg, useCustom: use });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Poll an upload's progress through Mux: upload -> asset created -> asset ready.
app.get('/api/sends/:id/status', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database is not configured yet.' });
  try {
    const q = await pool.query('SELECT * FROM reel_sends WHERE id = $1', [req.params.id]);
    if (!q.rows.length) return res.status(404).json({ error: 'Not found' });
    const row = q.rows[0];

    if (row.status === 'ready' || row.status === 'error' || !muxConfigured()) {
      return res.json(publicSend(row));
    }
    // Step 1: no asset yet -> ask the upload whether Mux has created one.
    if (!row.asset_id && row.upload_id) {
      try {
        const up = await muxFetch('/video/v1/uploads/' + row.upload_id);
        if (up && up.asset_id) {
          row.asset_id = up.asset_id; row.status = 'processing';
          await pool.query('UPDATE reel_sends SET asset_id = $1, status = $2 WHERE id = $3', [row.asset_id, row.status, row.id]);
        } else if (up && (up.status === 'errored' || up.status === 'cancelled' || up.status === 'timed_out')) {
          row.status = 'error';
          await pool.query('UPDATE reel_sends SET status = $1 WHERE id = $2', [row.status, row.id]);
        }
      } catch (e) { /* transient — report what we have so far */ }
    }
    // Step 2: we have an asset -> read its status / playback id / duration / transcode progress.
    let liveProgress = null, liveState = null;
    if (row.asset_id) {
      try {
        const a = await muxFetch('/video/v1/assets/' + row.asset_id);
        const pid = a.playback_ids && a.playback_ids[0] && a.playback_ids[0].id;
        row.playback_id = pid || row.playback_id;
        row.duration = a.duration || row.duration;
        // Real source fps so the recipient's frame-step is accurate. Mux returns -1 when it
        // can't determine it; in that case leave fps null and the client falls back to 24.
        let rawFps = a.max_stored_frame_rate;
        if (!(rawFps > 0)) { const vt = a.tracks && a.tracks.filter(t => t.type === 'video')[0]; rawFps = vt && vt.max_frame_rate; }
        if (rawFps > 0) row.fps = rawFps;
        // Mux reports a real transcode progress while the asset is preparing (especially for
        // non-standard input like high-bitrate files). Forward it so the sender sees a true %.
        if (a.progress) { liveProgress = a.progress.progress; liveState = a.progress.state; }
        row.status = a.status === 'ready' ? 'ready' : (a.status === 'errored' ? 'error' : 'processing');
        await pool.query('UPDATE reel_sends SET playback_id = $1, duration = $2, fps = $3, status = $4 WHERE id = $5',
          [row.playback_id || null, row.duration || null, row.fps || null, row.status, row.id]);
      } catch (e) { /* transient */ }
    }
    const out = publicSend(row);
    if (typeof liveProgress === 'number') out.progress = liveProgress;
    if (liveState) out.progressState = liveState;
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// A send's public details (used by the recipient page in the next milestone).
app.get('/api/sends/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database is not configured yet.' });
  try {
    const q = await pool.query('SELECT * FROM reel_sends WHERE id = $1', [req.params.id]);
    if (!q.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(publicSend(q.rows[0]));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- The clean cut: N single-range Mux clips (cut from the master) + a server-side
//     -c copy stitch into one clean MP4. Mux does the cutting; we only stream-copy. ---
const cuts = new Map(); // jobId -> { status, phase, error, filmName, createdAt, clips[], clipAssetIds[], tmpDir, file, ... }
const MAX_CUT_SECONDS = 600;
const MAX_RANGES = 25;          // a reel shouldn't need more cuts than this
const MIN_CLIP_SECONDS = 0.5;   // Mux requires clips of at least 500 ms
const MAX_ASSETS = 8;           // hard floor: never hold more than this many live master assets (Mux free tier caps at 10; leaves headroom for transient clip-assets)
const LINK_TTL_DAYS = 3;       // a recipient link (and its master asset) lives this long, then is cleaned up
const FULLY_DOWNLOADED_GRACE_HOURS = 24; // once EVERY recipient has pulled a cut, shorten the link's life to this so footage doesn't linger the full TTL
const EXPIRING_SOON_HOURS = 48;          // one-time heads-up email to recipients who haven't used their full budget when their link is within this window of expiry
const POLL_MS = 2500;
const CLIP_TIMEOUT_MS = 6 * 60 * 1000;
const STITCH_TIMEOUT_MS = 3 * 60 * 1000;

function round2(n) { return Math.round(n * 100) / 100; }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// Validate + clean the requested ranges. Returns [[start,end], ...] (ms-rounded
// seconds) or null if nothing usable. Each range must be at least MIN_CLIP_SECONDS.
function sanitizeClips(arr, duration) {
  if (!Array.isArray(arr) || !arr.length) return null;
  const out = [];
  for (const c of arr) {
    if (!Array.isArray(c) || c.length < 2) return null;
    let a = Number(c[0]), b = Number(c[1]);
    if (!isFinite(a) || !isFinite(b)) return null;
    a = Math.max(0, a);
    if (duration) b = Math.min(b, duration);
    if (b - a < MIN_CLIP_SECONDS) return null;
    out.push([Math.round(a * 1000) / 1000, Math.round(b * 1000) / 1000]);
  }
  return out;
}

function sumSeconds(clips) {
  return clips.reduce(function (a, c) { return a + (c[1] - c[0]); }, 0);
}

// The POST body to create ONE single-range clip from the master, with a downloadable MP4.
function clipCreateBody(masterAssetId, range) {
  return {
    inputs: [{ url: 'mux://assets/' + masterAssetId, start_time: range[0], end_time: range[1] }],
    playback_policies: ['public'],
    video_quality: 'basic',
    static_renditions: [{ resolution: 'highest' }]
  };
}

// From an asset's static_renditions object, return the first ready downloadable MP4.
function pickReadyMp4(sr) {
  if (!sr || !Array.isArray(sr.files)) return null;
  return sr.files.find(function (f) {
    return f && f.status === 'ready' && typeof f.name === 'string' && /\.mp4$/i.test(f.name);
  }) || null;
}

function concatLooksCorrect(requested, actual, n) {
  if (typeof actual !== 'number' || typeof requested !== 'number') return null;
  const tol = Math.max(0.75, 0.3 * (n || 1));
  return Math.abs(actual - requested) <= tol;
}

function safeFilename(name) {
  return (name || 'reel').replace(/[^a-z0-9 _-]/gi, '').trim().slice(0, 60) || 'reel';
}

function muxDownloadUrl(playbackId, name) {
  return 'https://stream.mux.com/' + playbackId + '/' + name;
}

// Text for FFmpeg's concat demuxer list file (one quoted path per line).
function concatListText(paths) {
  return paths.map(function (p) { return "file '" + String(p).replace(/'/g, "'\\''") + "'"; }).join('\n') + '\n';
}

// Parse a "Duration: HH:MM:SS.ss" line out of FFmpeg's stderr -> seconds, or null.
function parseFfmpegDuration(stderr) {
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr || '');
  if (!m) return null;
  return (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
}

function runFfmpeg(args, timeoutMs) {
  return new Promise(function (resolve, reject) {
    if (!ffmpegPath) return reject(new Error('FFmpeg is not available on the server'));
    const proc = spawn(ffmpegPath, args);
    let err = '';
    const killer = setTimeout(function () { try { proc.kill('SIGKILL'); } catch (e) {} reject(new Error('FFmpeg timed out')); }, timeoutMs || STITCH_TIMEOUT_MS);
    proc.stderr.on('data', function (d) { err += d.toString(); if (err.length > 8000) err = err.slice(-8000); });
    proc.on('error', function (e) { clearTimeout(killer); reject(e); });
    proc.on('close', function (code) { clearTimeout(killer); code === 0 ? resolve(err) : reject(new Error('FFmpeg failed: ' + err.slice(-400))); });
  });
}

// Read a file's duration by letting FFmpeg probe it (no separate ffprobe binary needed).
function ffmpegDuration(file) {
  return new Promise(function (resolve) {
    if (!ffmpegPath) return resolve(null);
    const proc = spawn(ffmpegPath, ['-hide_banner', '-i', file]);
    let err = '';
    proc.stderr.on('data', function (d) { err += d.toString(); if (err.length > 20000) err = err.slice(-20000); });
    proc.on('error', function () { resolve(null); });
    proc.on('close', function () { resolve(parseFfmpegDuration(err)); });
  });
}

async function downloadToFile(url, dest) {
  const r = await fetch(url);
  if (!r.ok || !r.body) throw new Error('Could not download a clip from Mux (' + r.status + ')');
  await fs.promises.writeFile(dest, Readable.fromWeb(r.body));
}

// Join the clips into one MP4. Video is STREAM-COPIED (pristine, fast — the expensive
// part never re-encodes). Audio is re-encoded into one continuous AAC track, which
// removes the ~18ms timestamp overlap you get when stream-copying independently-encoded
// AAC at a seam (the source of any faint click at a join). Audio-only encode is cheap,
// so this stays light on the basic tier.
async function stitchClips(localPaths, tmpDir, outPath) {
  const listPath = path.join(tmpDir, 'list.txt');
  await fs.promises.writeFile(listPath, concatListText(localPaths));
  await runFfmpeg(['-hide_banner', '-y', '-f', 'concat', '-safe', '0', '-i', listPath,
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', outPath]);
}

// Best-effort: delete every Mux clip asset for this job so we don't accrue storage.
function deleteClipAssets(job) {
  if (!job || !Array.isArray(job.clipAssetIds)) return;
  const ids = job.clipAssetIds; job.clipAssetIds = [];
  ids.forEach(function (id) { if (id) muxFetch('/video/v1/assets/' + id, { method: 'DELETE' }).catch(function () {}); });
}

function cleanupTmp(job) {
  if (job && job.tmpDir) {
    const d = job.tmpDir; job.tmpDir = null;
    fs.promises.rm(d, { recursive: true, force: true }).catch(function () {});
  }
}

// The work: make N clips on Mux, wait for each (asset + MP4) to be ready, pull the
// MP4s, and stream-copy-join them into one reel. All heavy lifting is on Mux.
async function processReelViaMux(jobId, masterAssetId, clips, filmName) {
  const job = cuts.get(jobId); if (!job) return;
  job.inputsSent = clips.length;
  job.requestedSeconds = round2(sumSeconds(clips));
  job.clips = clips.map(function (r) {
    return { range: r, assetId: null, playbackId: null, status: null, mp4Status: null, mp4Name: null, durationSeconds: null };
  });
  job.clipsReady = 0;
  try {
    // 1) Create all the clips in parallel.
    job.status = 'processing'; job.phase = 'clipping';
    const created = await Promise.all(clips.map(function (r) {
      return muxFetch('/video/v1/assets', { method: 'POST', body: clipCreateBody(masterAssetId, r) });
    }));
    job.clipAssetIds = created.map(function (c) { return c.id; });
    created.forEach(function (c, i) {
      job.clips[i].assetId = c.id;
      job.clips[i].playbackId = (c.playback_ids && c.playback_ids[0] && c.playback_ids[0].id) || null;
      job.clips[i].status = c.status || 'preparing';
    });

    // 2) Poll until every clip's asset AND its MP4 are ready.
    job.phase = 'transcoding';
    const deadline = Date.now() + CLIP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(POLL_MS);
      for (const ci of job.clips) {
        if (ci.mp4Name) continue; // already done
        let a;
        try { a = await muxFetch('/video/v1/assets/' + ci.assetId); }
        catch (e) { continue; /* transient — retry next tick */ }
        ci.status = a.status;
        if (typeof a.duration === 'number') ci.durationSeconds = round2(a.duration);
        if (a.status === 'errored') throw new Error('A clip failed on Mux (asset errored).');
        const mp4 = pickReadyMp4(a.static_renditions);
        if (mp4) { ci.mp4Name = mp4.name; ci.mp4Status = 'ready'; }
        else { ci.mp4Status = (a.static_renditions && a.static_renditions.status) || 'preparing'; }
      }
      job.clipsReady = job.clips.filter(function (c) { return !!c.mp4Name; }).length;
      if (job.clips.every(function (c) { return !!c.mp4Name; })) break;
    }
    if (!job.clips.every(function (c) { return !!c.mp4Name; })) throw new Error('Timed out waiting for Mux clips to finish.');

    // 3) Download the clip MP4s.
    job.phase = 'downloading';
    job.tmpDir = path.join(os.tmpdir(), 'mr-' + jobId);
    await fs.promises.mkdir(job.tmpDir, { recursive: true });
    const localPaths = [];
    for (let i = 0; i < job.clips.length; i++) {
      const dest = path.join(job.tmpDir, 'clip' + i + '.mp4');
      await downloadToFile(muxDownloadUrl(job.clips[i].playbackId, job.clips[i].mp4Name), dest);
      localPaths.push(dest);
    }

    // 4) Join into one MP4: video stream-copied, audio re-encoded for clean seams.
    job.phase = 'stitching';
    const outPath = path.join(job.tmpDir, 'reel.mp4');
    await stitchClips(localPaths, job.tmpDir, outPath);

    // 5) We have the finished reel locally -> free the Mux clip assets immediately.
    deleteClipAssets(job);
    job.actualSeconds = await ffmpegDuration(outPath);
    job.file = outPath;
    job.phase = 'ready'; job.status = 'ready';
  } catch (e) {
    job.status = 'error'; job.phase = 'error'; job.error = e.message;
    // refund the reserved allowance — a failed cut shouldn't cost the recipient
    if (job.meter && pool) pool.query('UPDATE reel_recipients SET used_seconds = GREATEST(0, used_seconds - $1) WHERE token = $2', [job.meter.charged, job.meter.token]).catch(function () {});
    deleteClipAssets(job);
    cleanupTmp(job);
  }
}

// Start a cut job for the chosen ranges.
app.post('/api/sends/:id/cut', async (req, res) => {
  if (!muxConfigured()) return res.status(503).json({ error: 'Mux is not configured yet.' });
  if (!pool) return res.status(503).json({ error: 'Database is not configured yet.' });
  if (!ffmpegPath) return res.status(503).json({ error: 'FFmpeg is not available on the server.' });
  try {
    const q = await pool.query('SELECT * FROM reel_sends WHERE id = $1', [req.params.id]);
    if (!q.rows.length) return res.status(404).json({ error: 'Not found' });
    const row = q.rows[0];
    if (row.status !== 'ready') return res.status(409).json({ error: 'This film isn\u2019t ready yet.' });
    if (!row.asset_id) return res.status(409).json({ error: 'This film has no master asset to cut from yet.' });
    const clips = sanitizeClips(req.body && req.body.clips, row.duration);
    if (!clips) return res.status(400).json({ error: 'No valid selections — each must be at least 0.5 seconds.' });
    if (clips.length > MAX_RANGES) return res.status(400).json({ error: 'Too many separate selections (max ' + MAX_RANGES + ').' });
    const total = sumSeconds(clips);
    if (total > MAX_CUT_SECONDS) return res.status(400).json({ error: 'That selection is too long.' });
    const jobId = crypto.randomUUID();
    cuts.set(jobId, { status: 'queued', phase: 'queued', filmName: row.film_name, assetId: row.asset_id, createdAt: Date.now() });
    res.json({ jobId: jobId });
    processReelViaMux(jobId, row.asset_id, clips, row.film_name); // run in the background
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- M3: per-recipient tokens + server-side budget enforcement ---
// A recipient is a unique token tied to one send (film) with its own time budget.
// The page loads via /r/:token; every budget check happens HERE on the server — the
// client cap is only UX, this is the real chokepoint. (Signed playback + per-person
// watermark are separate later pieces; this layer is tokens + budget only.)

function genToken() { return crypto.randomBytes(18).toString('base64url'); } // 24 url-safe chars
function withinBudget(clips, budgetSeconds) {
  return sumSeconds(clips) <= budgetSeconds + 0.05; // small epsilon for float rounding
}
// Metered allowance: a cut is allowed only if it fits what's LEFT (budget minus already used).
function meterCheck(totalSeconds, budgetSeconds, usedSeconds) {
  const remaining = budgetSeconds - (Number(usedSeconds) || 0);
  return { ok: totalSeconds <= remaining + 0.05, remaining: Math.max(0, remaining) };
}

// Start a cut job from a ready send row. Shared by the recipient cut endpoint.
function startCutJob(send, clips, meter) {
  const jobId = crypto.randomUUID();
  cuts.set(jobId, { status: 'queued', phase: 'queued', filmName: send.film_name, assetId: send.asset_id, createdAt: Date.now(), meter: meter || null });
  processReelViaMux(jobId, send.asset_id, clips, send.film_name);
  return jobId;
}

// Mint a recipient token for a send. DEV/ADMIN for now (no auth) — in M4 this moves
// into the authenticated send screen. Do not expose this publicly long-term.
app.post('/api/recipients', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database is not configured yet.' });
  try {
    const b = req.body || {};
    if (!b.sendId) return res.status(400).json({ error: 'sendId is required.' });
    const name = (typeof b.name === 'string' && b.name.trim()) ? b.name.trim().slice(0, 80) : 'Guest';
    const email = (typeof b.email === 'string' && b.email.trim()) ? b.email.trim().slice(0, 200) : null;
    let budget = parseInt(b.budgetSeconds, 10);
    if (!isFinite(budget) || budget <= 0) budget = 120;
    budget = Math.min(budget, MAX_CUT_SECONDS);
    const s = await pool.query('SELECT id, film_name, source_file FROM reel_sends WHERE id = $1', [b.sendId]);
    if (!s.rows.length) return res.status(404).json({ error: 'No such send.' });
    const token = genToken();
    await pool.query('INSERT INTO reel_recipients (token, send_id, name, email, budget_seconds) VALUES ($1, $2, $3, $4, $5)',
      [token, b.sendId, name, email, budget]);
    // Email the link only on an explicit notify (so test mints never fire mail).
    let emailed = false;
    if (b.notify === true && email && resendConfigured()) {
      const base = reqBase(req);
      const out = await sendReelEmail(email, name, base + '/r/' + token, s.rows[0].film_name, budget, s.rows[0].source_file);
      emailed = !!(out && out.ok);
      if (!emailed) console.warn('[reel-email] not sent to', email, '-', out && out.reason, out && out.detail ? ('(' + out.detail + ')') : '');
    }
    res.json({ token: token, link: '/r/' + token, name: name, email: email, budgetSeconds: budget, emailed: emailed });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Dashboard actions on an existing recipient (owner-gated by the app gate).
//     Keyed by the recipient's token (the reel_recipients primary key). ---

// Shared lookup: a recipient joined to their send (name, email, budget, film).
async function loadRecipient(token) {
  const q = await pool.query(
    'SELECT rec.token, rec.name, rec.email, rec.budget_seconds, rec.used_seconds, s.film_name, s.source_file' +
    ' FROM reel_recipients rec JOIN reel_sends s ON s.id = rec.send_id WHERE rec.token = $1',
    [token]);
  return q.rows.length ? q.rows[0] : null;
}

// Resend a recipient their original private-link email.
app.post('/api/recipients/:token/resend', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database is not configured yet.' });
  try {
    const r = await loadRecipient(req.params.token);
    if (!r) return res.status(404).json({ error: 'No such recipient.' });
    if (!r.email) return res.status(400).json({ error: 'No email on file for this recipient.' });
    if (!resendConfigured()) return res.json({ ok: false, emailed: false, reason: 'not-configured' });
    const out = await sendReelEmail(r.email, r.name, reqBase(req) + '/r/' + r.token, r.film_name, r.budget_seconds, r.source_file);
    if (!out.ok) console.warn('[reel-resend] not sent to', r.email, '-', out.reason, out.detail ? ('(' + out.detail + ')') : '');
    res.json({ ok: !!out.ok, emailed: !!out.ok, reason: out.reason || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Nudge a recipient: a gentler reminder email.
app.post('/api/recipients/:token/nudge', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database is not configured yet.' });
  try {
    const r = await loadRecipient(req.params.token);
    if (!r) return res.status(404).json({ error: 'No such recipient.' });
    if (!r.email) return res.status(400).json({ error: 'No email on file for this recipient.' });
    if (!resendConfigured()) return res.json({ ok: false, emailed: false, reason: 'not-configured' });
    const out = await sendReelNudgeEmail(r.email, r.name, reqBase(req) + '/r/' + r.token, r.film_name, r.budget_seconds);
    if (!out.ok) console.warn('[reel-nudge] not sent to', r.email, '-', out.reason, out.detail ? ('(' + out.detail + ')') : '');
    res.json({ ok: !!out.ok, emailed: !!out.ok, reason: out.reason || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Edit / bump a recipient's download budget. Clamped to the same 0:01–10:00 ceiling
// as the send screen. Lowering below what's already used simply caps further pulls
// (the meter clamps remaining to 0) — a legitimate "stop them here" action.
app.post('/api/recipients/:token/budget', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database is not configured yet.' });
  try {
    let budget = parseInt(req.body && req.body.budgetSeconds, 10);
    if (!isFinite(budget) || budget <= 0) return res.status(400).json({ error: 'Enter a length of at least 1 second.' });
    budget = Math.min(budget, MAX_CUT_SECONDS);
    const upd = await pool.query('UPDATE reel_recipients SET budget_seconds = $1 WHERE token = $2 RETURNING token', [budget, req.params.token]);
    if (!upd.rows.length) return res.status(404).json({ error: 'No such recipient.' });
    res.json({ ok: true, budgetSeconds: budget });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// What the recipient page loads: the film + their personal budget + identity.
app.get('/api/r/:token', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database is not configured yet.' });
  try {
    const r = await pool.query(
      'SELECT rec.name, rec.budget_seconds, rec.used_seconds, s.film_name, s.playback_id, s.playback_signed, s.duration, s.fps, s.status, s.expires_at, s.asset_deleted_at' +
      ' FROM reel_recipients rec JOIN reel_sends s ON s.id = rec.send_id WHERE rec.token = $1',
      [req.params.token]);
    if (!r.rows.length) return res.status(404).json({ error: 'This link is not valid.' });
    const row = r.rows[0];
    // Expired or cleaned-up: hand the page a clean signal so it shows a graceful message, never a broken player.
    if (isExpired(row)) {
      return res.json({ expired: true, filmName: row.film_name, name: row.name, expiresAt: row.expires_at });
    }
    pool.query('UPDATE reel_recipients SET opened_at = COALESCE(opened_at, now()) WHERE token = $1', [req.params.token]).catch(function () {});
    res.json(Object.assign({
      name: row.name, filmName: row.film_name, playbackId: row.playback_id,
      duration: row.duration, fps: row.fps, budgetSeconds: row.budget_seconds,
      usedSeconds: Number(row.used_seconds) || 0, status: row.status,
      expiresAt: row.expires_at
    }, playbackTokens(row.playback_id, row.playback_signed)));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// The recipient's cut — budget enforced HERE (the real chokepoint), not trusted from the client.
app.post('/api/r/:token/cut', async (req, res) => {
  if (!muxConfigured()) return res.status(503).json({ error: 'Mux is not configured yet.' });
  if (!pool) return res.status(503).json({ error: 'Database is not configured yet.' });
  if (!ffmpegPath) return res.status(503).json({ error: 'FFmpeg is not available on the server.' });
  try {
    const r = await pool.query(
      'SELECT rec.budget_seconds, rec.used_seconds, s.* FROM reel_recipients rec JOIN reel_sends s ON s.id = rec.send_id WHERE rec.token = $1',
      [req.params.token]);
    if (!r.rows.length) return res.status(404).json({ error: 'This link is not valid.' });
    const row = r.rows[0];
    if (isExpired(row)) return res.status(410).json({ error: 'This link has expired \u2014 ask for a fresh one.', expired: true });
    if (row.status !== 'ready') return res.status(409).json({ error: 'This film isn\u2019t ready yet.' });
    if (!row.asset_id) return res.status(409).json({ error: 'This film has no master asset to cut from yet.' });
    const clips = sanitizeClips(req.body && req.body.clips, row.duration);
    if (!clips) return res.status(400).json({ error: 'No valid selections — each must be at least 0.5 seconds.' });
    if (clips.length > MAX_RANGES) return res.status(400).json({ error: 'Too many separate selections (max ' + MAX_RANGES + ').' });
    const total = sumSeconds(clips);
    const gate = meterCheck(total, row.budget_seconds, row.used_seconds);
    if (!gate.ok) {
      return res.status(403).json({
        error: gate.remaining <= 0.05
          ? 'This link has used its full ' + row.budget_seconds + 's allowance.'
          : 'That selection is ' + Math.round(total) + 's, but only ' + Math.round(gate.remaining) + 's are left on this link.',
        remainingSeconds: gate.remaining
      });
    }
    if (total > MAX_CUT_SECONDS) return res.status(400).json({ error: 'That selection is too long.' });
    // Reserve the seconds now (refunded automatically if the cut fails on Mux).
    await pool.query('UPDATE reel_recipients SET used_seconds = used_seconds + $1, last_cut_at = now() WHERE token = $2', [total, req.params.token]);
    res.json({ jobId: startCutJob(row, clips, { token: req.params.token, charged: total }), remainingSeconds: Math.max(0, gate.remaining - total) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Poll a cut job's progress — includes a verification RECEIPT showing each clip's
// state, the stitch phase, and requested vs actual duration of the joined reel.
app.get('/api/cuts/:jobId', (req, res) => {
  const job = cuts.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Not found' });
  res.json({
    status: job.status,
    phase: job.phase,
    error: job.error || null,
    receipt: {
      inputsSent: job.inputsSent != null ? job.inputsSent : null,
      clipsReady: job.clipsReady != null ? job.clipsReady : null,
      requestedSeconds: job.requestedSeconds != null ? job.requestedSeconds : null,
      actualSeconds: typeof job.actualSeconds === 'number' ? job.actualSeconds : null,
      concatLooksCorrect: concatLooksCorrect(job.requestedSeconds, job.actualSeconds, job.inputsSent),
      clips: Array.isArray(job.clips) ? job.clips.map(function (c) {
        return { status: c.status, mp4Status: c.mp4Status, durationSeconds: c.durationSeconds };
      }) : null,
      downloadReady: job.status === 'ready'
    }
  });
});

// Download the finished reel (the locally joined MP4). Single-use: temp files are
// cleaned up after sending.
app.get('/api/cuts/:jobId/download', (req, res) => {
  const job = cuts.get(req.params.jobId);
  if (!job || job.status !== 'ready' || !job.file || !fs.existsSync(job.file)) {
    return res.status(404).json({ error: 'Not ready' });
  }
  res.download(job.file, safeFilename(job.filmName) + ' - reel.mp4', function () {
    cleanupTmp(job);
    cuts.delete(req.params.jobId);
  });
});

// --- Retention: link expiry + a hard asset floor so we never hit Mux's 10-asset cap.
//     Expiry is the primary, recipient-visible trigger; the floor is a deterministic
//     safety net. Both delete the master Mux asset and mark the send so its link shows
//     a graceful "expired" page instead of a broken player. ---

function expiryFromNow() { return new Date(Date.now() + LINK_TTL_DAYS * 86400000); }

// A send is expired (for the recipient) if its master was cleaned up, or its time is up.
function isExpired(row) {
  if (!row) return false;
  if (row.asset_deleted_at) return true;
  return !!(row.expires_at && new Date(row.expires_at).getTime() < Date.now());
}

// Master assets currently referenced by an in-flight cut — never evict these.
function activeCutAssetIds() {
  const ids = new Set();
  for (const job of cuts.values()) {
    if (job && job.assetId && job.status !== 'ready' && job.status !== 'error') ids.add(job.assetId);
  }
  return ids;
}

// Delete one send's master Mux asset (best-effort) and mark it deleted in the DB.
// A 404 from Mux means it's already gone — still mark it. Transient errors are left
// for the next sweep to retry.
async function deleteSendAsset(send) {
  if (!pool || !send || !send.asset_id || send.asset_deleted_at) return false;
  try {
    await muxFetch('/video/v1/assets/' + send.asset_id, { method: 'DELETE' });
  } catch (e) {
    if (e.status !== 404) { console.warn('[reel-retention] could not delete asset', send.asset_id, '-', e.message); return false; }
  }
  await pool.query('UPDATE reel_sends SET asset_deleted_at = now() WHERE id = $1', [send.id]);
  return true;
}

// Primary cleaner: free the master of every send whose link has passed its expiry.
async function cleanupExpiredSends() {
  if (!pool || !muxConfigured()) return;
  const q = await pool.query(
    'SELECT id, asset_id FROM reel_sends' +
    ' WHERE asset_id IS NOT NULL AND asset_deleted_at IS NULL AND expires_at IS NOT NULL AND expires_at < now()');
  for (const row of q.rows) {
    await deleteSendAsset({ id: row.id, asset_id: row.asset_id, asset_deleted_at: null });
  }
}

// Safety net: while we hold >= MAX_ASSETS live masters, evict the best candidate —
// expired first, then sends everyone has already downloaded, then the oldest. Never an
// asset an in-flight cut depends on; if every live master is busy, we bail rather than
// break a cut.
async function enforceAssetFloor() {
  if (!pool || !muxConfigured()) return;
  const q = await pool.query(
    'SELECT s.id, s.asset_id, s.created_at, s.expires_at,' +
    ' COUNT(rec.token) AS recips,' +
    ' COUNT(rec.token) FILTER (WHERE rec.used_seconds > 0.05) AS downloaded' +
    ' FROM reel_sends s LEFT JOIN reel_recipients rec ON rec.send_id = s.id' +
    ' WHERE s.asset_id IS NOT NULL AND s.asset_deleted_at IS NULL' +
    ' GROUP BY s.id ORDER BY s.created_at ASC');
  let rows = q.rows;
  if (rows.length < MAX_ASSETS) return;
  const now = Date.now();
  const busy = activeCutAssetIds();
  function rank(r) {
    const expired = r.expires_at && new Date(r.expires_at).getTime() < now;
    const recips = Number(r.recips) || 0, dl = Number(r.downloaded) || 0;
    const allDown = recips > 0 && dl >= recips;
    return expired ? 0 : (allDown ? 1 : 2); // lower = evict sooner
  }
  while (rows.length >= MAX_ASSETS) {
    const cands = rows
      .filter(function (r) { return r.asset_id && !busy.has(r.asset_id); })
      .sort(function (a, b) { return rank(a) - rank(b); }); // rows already oldest-first, so ties keep age order
    if (!cands.length) break; // every live master is mid-cut — don't break one to make room
    const victim = cands[0];
    await deleteSendAsset({ id: victim.id, asset_id: victim.asset_id, asset_deleted_at: null });
    rows = rows.filter(function (r) { return r.id !== victim.id; });
  }
}

// Sweep abandoned cut jobs (never downloaded) so their Mux assets + temp files don't linger.
function sweepStaleCuts() {
  const now = Date.now();
  for (const [id, job] of cuts) {
    if (now - (job.createdAt || now) > 60 * 60 * 1000) {
      deleteClipAssets(job);
      cleanupTmp(job);
      cuts.delete(id);
    }
  }
}

// Exposed for logic tests (see test_helpers.js).
module.exports = {
  sanitizeClips, sumSeconds, clipCreateBody, pickReadyMp4, concatLooksCorrect,
  genToken, withinBudget, meterCheck, fmtClock, emailEsc, signMuxToken, b64url,
  safeFilename, muxDownloadUrl, concatListText, parseFfmpegDuration, round2,
  isExpired, expiryFromNow, activeCutAssetIds,
  MIN_CLIP_SECONDS, MAX_CUT_SECONDS, MAX_RANGES, MAX_ASSETS, LINK_TTL_DAYS, APP_VERSION
};

// Footage that's served its purpose: once EVERY recipient on a send has pulled a cut,
// shorten the link's life to FULLY_DOWNLOADED_GRACE_HOURS so the master is cleaned up soon
// instead of lingering the full TTL. Hard guards: needs >=1 recipient AND every one of them
// downloaded (used_seconds > 0.05, the same "downloaded" signal the asset floor uses); only
// ever shortens (never extends), and is idempotent once a send is already inside the window.
async function accelerateFullyDownloaded() {
  if (!pool || !muxConfigured()) return;
  await pool.query(
    "UPDATE reel_sends s SET expires_at = now() + interval '" + FULLY_DOWNLOADED_GRACE_HOURS + " hours'" +
    " WHERE s.asset_id IS NOT NULL AND s.asset_deleted_at IS NULL" +
    " AND (s.expires_at IS NULL OR s.expires_at > now() + interval '" + FULLY_DOWNLOADED_GRACE_HOURS + " hours')" +
    " AND EXISTS (SELECT 1 FROM reel_recipients r WHERE r.send_id = s.id AND r.is_preview IS NOT TRUE)" +
    " AND NOT EXISTS (SELECT 1 FROM reel_recipients r WHERE r.send_id = s.id AND r.is_preview IS NOT TRUE AND r.used_seconds <= 0.05)");
}

// One-time "your link expires soon" email to recipients who still haven't grabbed anything.
// Guards: send must be live; recipient must have an email, NOT have downloaded (used_seconds
// <= 0.05), the link must be inside the warning window but not already expired, and they must
// not have been emailed before. Only marks notified on a successful send (so failures retry).
// Dormant unless both Resend and PUBLIC_BASE_URL are configured.
async function notifyExpiringSoon() {
  if (!pool || !resendConfigured() || !PUBLIC_BASE_URL) return;
  const q = await pool.query(
    "SELECT rec.token, rec.name, rec.email, rec.budget_seconds, s.film_name, s.expires_at" +
    " FROM reel_recipients rec JOIN reel_sends s ON s.id = rec.send_id" +
    " WHERE s.asset_id IS NOT NULL AND s.asset_deleted_at IS NULL" +
    " AND s.expires_at IS NOT NULL AND s.expires_at > now() AND s.expires_at < now() + interval '" + EXPIRING_SOON_HOURS + " hours'" +
    " AND rec.email IS NOT NULL AND rec.email <> ''" +
    " AND rec.used_seconds < rec.budget_seconds - 0.5" +
    " AND rec.is_preview IS NOT TRUE" +
    " AND rec.expiring_notified_at IS NULL");
  for (const r of q.rows) {
    const out = await sendReelExpiringEmail(r.email, r.name, PUBLIC_BASE_URL + '/r/' + r.token, r.film_name, r.budget_seconds, r.expires_at);
    if (out && out.ok) {
      await pool.query('UPDATE reel_recipients SET expiring_notified_at = now() WHERE token = $1', [r.token]).catch(function () {});
    }
  }
}

function runRetention() {
  accelerateFullyDownloaded().catch(function (e) { console.warn('[reel-retention] accelerate:', e.message); });
  cleanupExpiredSends().catch(function (e) { console.warn('[reel-retention] cleanup:', e.message); });
  enforceAssetFloor().catch(function (e) { console.warn('[reel-retention] floor:', e.message); });
  notifyExpiringSoon().catch(function (e) { console.warn('[reel-retention] expiring:', e.message); });
}

if (require.main === module) {
  if (pool) ensureSchema()
    .then(() => { console.log('reel_ tables ready'); runRetention(); })
    .catch(e => console.error('schema error:', e.message));
  setInterval(sweepStaleCuts, 10 * 60 * 1000).unref();
  setInterval(runRetention, 30 * 60 * 1000).unref();
  app.listen(PORT, () => console.log('Magic Reel engine ' + APP_VERSION + ' listening on ' + PORT));
}
