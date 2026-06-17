// Magic Reel — engine (skeleton)
// A small standalone service: serves the app pages and proves the
// pipeline (subdomain + Render + shared Neon database). Video upload,
// preview, the metered budget, and the clean cut arrive in later milestones.

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
  if (!pool) return res.json({ ok: true, db: 'not configured' });
  try {
    const r = await pool.query('SELECT now() AS now');
    res.json({ ok: true, db: 'connected', now: r.rows[0].now });
  } catch (e) {
    res.status(500).json({ ok: false, db: 'error', error: e.message });
  }
});

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

// --- The clean cut (FFmpeg): turn the chosen ranges into one clean, watermark-free MP4 ---
const cuts = new Map(); // jobId -> { status, phase, file, error, filmName, createdAt }
const MAX_CUT_SECONDS = 600;

function sanitizeClips(arr, duration) {
  if (!Array.isArray(arr) || !arr.length) return null;
  const out = [];
  for (const c of arr) {
    if (!Array.isArray(c) || c.length < 2) return null;
    let a = Number(c[0]), b = Number(c[1]);
    if (!isFinite(a) || !isFinite(b)) return null;
    a = Math.max(0, a);
    if (duration) b = Math.min(b, duration);
    if (b - a < 0.1) return null;
    out.push([Math.round(a * 1000) / 1000, Math.round(b * 1000) / 1000]);
  }
  return out;
}

// Trim each range and concatenate them into one clean MP4 (validated against ffmpeg 6.x).
function buildCutArgs(input, clips, output) {
  const parts = []; let cat = '';
  clips.forEach(function (c, i) {
    parts.push('[0:v]trim=start=' + c[0] + ':end=' + c[1] + ',setpts=PTS-STARTPTS[v' + i + ']');
    parts.push('[0:a]atrim=start=' + c[0] + ':end=' + c[1] + ',asetpts=PTS-STARTPTS[a' + i + ']');
    cat += '[v' + i + '][a' + i + ']';
  });
  const filter = parts.join(';') + ';' + cat + 'concat=n=' + clips.length + ':v=1:a=1[outv][outa]';
  return ['-y', '-i', input, '-filter_complex', filter, '-map', '[outv]', '-map', '[outa]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', output];
}

function runFfmpeg(args) {
  return new Promise(function (resolve, reject) {
    const proc = spawn(ffmpegPath, args);
    let err = '';
    proc.stderr.on('data', function (d) { err += d.toString(); if (err.length > 4000) err = err.slice(-4000); });
    proc.on('error', reject);
    proc.on('close', function (code) { code === 0 ? resolve() : reject(new Error('FFmpeg failed: ' + err.slice(-400))); });
  });
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function processCut(jobId, assetId, clips) {
  const job = cuts.get(jobId); if (!job) return;
  const masterFile = path.join(os.tmpdir(), 'mr-master-' + jobId + '.mp4');
  const outFile = path.join(os.tmpdir(), 'mr-reel-' + jobId + '.mp4');
  try {
    job.status = 'processing'; job.phase = 'preparing';
    // 1) enable temporary access to the master (highest-quality, clean) file
    await muxFetch('/video/v1/assets/' + assetId + '/master-access', { method: 'PUT', body: { master_access: 'temporary' } });
    // 2) poll until the master URL is ready
    let url = null;
    for (let i = 0; i < 60; i++) {
      const a = await muxFetch('/video/v1/assets/' + assetId);
      if (a.master && a.master.status === 'ready' && a.master.url) { url = a.master.url; break; }
      if (a.master && a.master.status === 'errored') throw new Error('Master preparation failed');
      await sleep(3000);
    }
    if (!url) throw new Error('Timed out preparing the master file');
    // 3) stream the master to a temp file (handles large originals without buffering in memory)
    job.phase = 'downloading';
    const r = await fetch(url);
    if (!r.ok || !r.body) throw new Error('Could not download master (' + r.status + ')');
    await new Promise(function (resolve, reject) {
      const ws = fs.createWriteStream(masterFile);
      Readable.fromWeb(r.body).pipe(ws);
      ws.on('finish', resolve); ws.on('error', reject);
    });
    // 4) cut + concatenate into one clean MP4
    job.phase = 'rendering';
    if (!ffmpegPath) throw new Error('FFmpeg is not available on the server');
    await runFfmpeg(buildCutArgs(masterFile, clips, outFile));
    job.file = outFile; job.status = 'ready'; job.phase = 'ready';
  } catch (e) {
    job.status = 'error'; job.phase = 'error'; job.error = e.message;
  } finally {
    try { if (fs.existsSync(masterFile)) fs.unlinkSync(masterFile); } catch (e) {}
  }
}

// Start a cut job for the chosen ranges.
app.post('/api/sends/:id/cut', async (req, res) => {
  if (!muxConfigured()) return res.status(503).json({ error: 'Mux is not configured yet.' });
  if (!pool) return res.status(503).json({ error: 'Database is not configured yet.' });
  try {
    const q = await pool.query('SELECT * FROM reel_sends WHERE id = $1', [req.params.id]);
    if (!q.rows.length) return res.status(404).json({ error: 'Not found' });
    const row = q.rows[0];
    if (!row.asset_id || row.status !== 'ready') return res.status(409).json({ error: 'This film isn\u2019t ready yet.' });
    const clips = sanitizeClips(req.body && req.body.clips, row.duration);
    if (!clips) return res.status(400).json({ error: 'No valid clips were provided.' });
    const total = clips.reduce(function (a, c) { return a + (c[1] - c[0]); }, 0);
    if (total > MAX_CUT_SECONDS) return res.status(400).json({ error: 'That selection is too long.' });
    const jobId = crypto.randomUUID();
    cuts.set(jobId, { status: 'queued', phase: 'queued', filmName: row.film_name, createdAt: Date.now() });
    res.json({ jobId: jobId });
    processCut(jobId, row.asset_id, clips); // run in the background
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Poll a cut job's progress.
app.get('/api/cuts/:jobId', (req, res) => {
  const job = cuts.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Not found' });
  res.json({ status: job.status, phase: job.phase, error: job.error || null });
});

// Download the finished reel (single-use; the temp file is cleaned up after sending).
app.get('/api/cuts/:jobId/download', (req, res) => {
  const job = cuts.get(req.params.jobId);
  if (!job || job.status !== 'ready' || !job.file || !fs.existsSync(job.file)) return res.status(404).json({ error: 'Not ready' });
  const safe = (job.filmName || 'reel').replace(/[^a-z0-9 _-]/gi, '').trim().slice(0, 60) || 'reel';
  res.download(job.file, safe + ' - reel.mp4', function () {
    try { if (fs.existsSync(job.file)) fs.unlinkSync(job.file); } catch (e) {}
    cuts.delete(req.params.jobId);
  });
});

if (pool) ensureSchema().then(() => console.log('reel_sends table ready')).catch(e => console.error('schema error:', e.message));

app.listen(PORT, () => console.log('Magic Reel engine listening on ' + PORT));
