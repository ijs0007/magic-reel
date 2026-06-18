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

const APP_VERSION = 'v0.4.0 — 🔑 Recipients: tokens + budget guard';

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
    ' created_at TIMESTAMPTZ NOT NULL DEFAULT now()' +
    ')'
  );
  await pool.query(
    'CREATE TABLE IF NOT EXISTS reel_recipients (' +
    ' token TEXT PRIMARY KEY,' +
    ' send_id TEXT NOT NULL,' +
    ' name TEXT,' +
    ' budget_seconds INTEGER NOT NULL DEFAULT 120,' +
    ' created_at TIMESTAMPTZ NOT NULL DEFAULT now()' +
    ')'
  );
}
function publicSend(r) {
  return { sendId: r.id, filmName: r.film_name, status: r.status, playbackId: r.playback_id, duration: r.duration };
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- pages ---
//  /            -> filmmaker send screen      (public/index.html, served by static)
//  /dashboard   -> the activity dashboard
//  /r/:token    -> a recipient's private preview link (token wiring comes later)
app.get('/dashboard', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));

app.get('/r/:token?', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'reel.html')));

// --- health check: confirms the service is up and the database is reachable ---
app.get('/health', async (req, res) => {
  const base = { ok: true, version: APP_VERSION, mux: muxConfigured(), ffmpeg: !!ffmpegPath };
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

// --- Milestone 2: real video via Mux ---

// Create a Mux direct-upload URL and a matching send record.
app.post('/api/uploads', async (req, res) => {
  if (!muxConfigured()) return res.status(503).json({ error: 'Mux is not configured yet (set MUX_TOKEN_ID and MUX_TOKEN_SECRET).' });
  if (!pool) return res.status(503).json({ error: 'Database is not configured yet (set DATABASE_URL).' });
  try {
    const filmName = (req.body && req.body.filmName) || 'Untitled';
    const upload = await muxFetch('/video/v1/uploads', {
      method: 'POST',
      body: {
        cors_origin: req.headers.origin || '*',
        new_asset_settings: { playback_policies: ['public'], video_quality: 'basic' }
      }
    });
    const id = crypto.randomUUID();
    await pool.query(
      'INSERT INTO reel_sends (id, film_name, upload_id, status) VALUES ($1, $2, $3, $4)',
      [id, filmName, upload.id, 'uploading']
    );
    res.json({ sendId: id, uploadUrl: upload.url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
    // Step 2: we have an asset -> read its status / playback id / duration.
    if (row.asset_id) {
      try {
        const a = await muxFetch('/video/v1/assets/' + row.asset_id);
        const pid = a.playback_ids && a.playback_ids[0] && a.playback_ids[0].id;
        row.playback_id = pid || row.playback_id;
        row.duration = a.duration || row.duration;
        row.status = a.status === 'ready' ? 'ready' : (a.status === 'errored' ? 'error' : 'processing');
        await pool.query('UPDATE reel_sends SET playback_id = $1, duration = $2, status = $3 WHERE id = $4',
          [row.playback_id || null, row.duration || null, row.status, row.id]);
      } catch (e) { /* transient */ }
    }
    res.json(publicSend(row));
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
    cuts.set(jobId, { status: 'queued', phase: 'queued', filmName: row.film_name, createdAt: Date.now() });
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

// Start a cut job from a ready send row. Shared by the recipient cut endpoint.
function startCutJob(send, clips) {
  const jobId = crypto.randomUUID();
  cuts.set(jobId, { status: 'queued', phase: 'queued', filmName: send.film_name, createdAt: Date.now() });
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
    let budget = parseInt(b.budgetSeconds, 10);
    if (!isFinite(budget) || budget <= 0) budget = 120;
    budget = Math.min(budget, MAX_CUT_SECONDS);
    const s = await pool.query('SELECT id FROM reel_sends WHERE id = $1', [b.sendId]);
    if (!s.rows.length) return res.status(404).json({ error: 'No such send.' });
    const token = genToken();
    await pool.query('INSERT INTO reel_recipients (token, send_id, name, budget_seconds) VALUES ($1, $2, $3, $4)',
      [token, b.sendId, name, budget]);
    res.json({ token: token, link: '/r/' + token, name: name, budgetSeconds: budget });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// What the recipient page loads: the film + their personal budget + identity.
app.get('/api/r/:token', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database is not configured yet.' });
  try {
    const r = await pool.query(
      'SELECT rec.name, rec.budget_seconds, s.film_name, s.playback_id, s.duration, s.status' +
      ' FROM reel_recipients rec JOIN reel_sends s ON s.id = rec.send_id WHERE rec.token = $1',
      [req.params.token]);
    if (!r.rows.length) return res.status(404).json({ error: 'This link is not valid.' });
    const row = r.rows[0];
    res.json({
      name: row.name, filmName: row.film_name, playbackId: row.playback_id,
      duration: row.duration, budgetSeconds: row.budget_seconds, status: row.status
    });
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
      'SELECT rec.budget_seconds, s.* FROM reel_recipients rec JOIN reel_sends s ON s.id = rec.send_id WHERE rec.token = $1',
      [req.params.token]);
    if (!r.rows.length) return res.status(404).json({ error: 'This link is not valid.' });
    const row = r.rows[0];
    if (row.status !== 'ready') return res.status(409).json({ error: 'This film isn\u2019t ready yet.' });
    if (!row.asset_id) return res.status(409).json({ error: 'This film has no master asset to cut from yet.' });
    const clips = sanitizeClips(req.body && req.body.clips, row.duration);
    if (!clips) return res.status(400).json({ error: 'No valid selections — each must be at least 0.5 seconds.' });
    if (clips.length > MAX_RANGES) return res.status(400).json({ error: 'Too many separate selections (max ' + MAX_RANGES + ').' });
    const total = sumSeconds(clips);
    if (!withinBudget(clips, row.budget_seconds)) {
      return res.status(403).json({ error: 'Over your reel budget — that\u2019s ' + Math.round(total) + 's of a ' + row.budget_seconds + 's limit.' });
    }
    if (total > MAX_CUT_SECONDS) return res.status(400).json({ error: 'That selection is too long.' });
    res.json({ jobId: startCutJob(row, clips) });
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
  genToken, withinBudget,
  safeFilename, muxDownloadUrl, concatListText, parseFfmpegDuration, round2,
  MIN_CLIP_SECONDS, MAX_CUT_SECONDS, MAX_RANGES, APP_VERSION
};

if (require.main === module) {
  if (pool) ensureSchema().then(() => console.log('reel_ tables ready')).catch(e => console.error('schema error:', e.message));
  setInterval(sweepStaleCuts, 10 * 60 * 1000).unref();
  app.listen(PORT, () => console.log('Magic Reel engine ' + APP_VERSION + ' listening on ' + PORT));
}
