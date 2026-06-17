// Magic Reel — engine
// v0.2.0 — ✂️ Mux Cut: clip + concat on Mux, server just relays
//
// The clean cut no longer encodes on our server. We ask Mux to cut the chosen
// ranges straight from the MASTER asset (full quality) and concatenate them into
// one new asset, and to produce a downloadable MP4 in the same call. Our server
// then does ZERO video processing — it just streams that finished MP4 through to
// the recipient (keeping the Mux URL private and setting a clean filename), and
// deletes the clip asset afterward so storage stays at ~0.
//
// Why this shape:
//  - No libx264 / FFmpeg on the box  -> fast, and free of CPU timeouts on the basic tier.
//  - Static MP4 = audio + video in ONE file -> the "audio is a separate HLS track"
//    gotcha disappears structurally (we never touch HLS renditions anymore).
//  - "highest" static rendition on the basic tier is free to encode (storage + delivery only).
//
// Each cut returns a RECEIPT (requested vs actual duration, concat check, MP4 status)
// so we can verify Mux's multi-range concatenation against real footage instead of
// trusting docs. See /api/cuts/:jobId.

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { Pool } = require('pg');

const APP_VERSION = 'v0.2.0 — ✂️ Mux Cut';

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
  const base = { ok: true, version: APP_VERSION, mux: muxConfigured() };
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

// --- The clean cut (Mux): cut the chosen ranges from the master, concatenate on
//     Mux, get one downloadable MP4 back, relay it. No encoding on this server. ---
const cuts = new Map(); // jobId -> { status, phase, error, filmName, createdAt, clipAssetId, clipPlaybackId, mp4Name, ... }
const MAX_CUT_SECONDS = 600;
const MIN_CLIP_SECONDS = 0.5;   // Mux requires clips of at least 500 ms
const POLL_MS = 2500;
const CUT_TIMEOUT_MS = 6 * 60 * 1000;

function round2(n) { return Math.round(n * 100) / 100; }

// Validate + clean the requested ranges. Returns an array of [start,end] (ms-rounded
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

// Sum of selected seconds.
function sumSeconds(clips) {
  return clips.reduce(function (a, c) { return a + (c[1] - c[0]); }, 0);
}

// Build the Mux create-asset `inputs` array: one clip per range, all from the same
// master asset. Mux concatenates them in order into a single new asset.
function buildClipInputs(masterAssetId, clips) {
  return clips.map(function (c) {
    return { url: 'mux://assets/' + masterAssetId, start_time: c[0], end_time: c[1] };
  });
}

// From an asset's static_renditions object, return the first ready downloadable MP4
// (video). Ignores audio-only .m4a. Returns the file object or null.
function pickReadyMp4(sr) {
  if (!sr || !Array.isArray(sr.files)) return null;
  return sr.files.find(function (f) {
    return f && f.status === 'ready' && typeof f.name === 'string' && /\.mp4$/i.test(f.name);
  }) || null;
}

// A small summary of static-rendition progress for the receipt while it's still cooking.
function summarizeSR(sr) {
  if (!sr) return null;
  const f = Array.isArray(sr.files)
    ? sr.files.find(function (x) { return x && typeof x.name === 'string' && /\.mp4$/i.test(x.name); })
    : null;
  return f ? { name: f.name, status: f.status } : { status: sr.status || 'preparing' };
}

// Sanity check: does the concatenated asset's duration match the sum of the ranges
// we asked for? (Allow a little slack for frame-boundary rounding across N cuts.)
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

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// Best-effort: delete the Mux clip asset so we don't accrue storage.
function deleteClipAsset(job) {
  if (!job || !job.clipAssetId) return;
  const id = job.clipAssetId;
  job.clipAssetId = null;
  muxFetch('/video/v1/assets/' + id, { method: 'DELETE' }).catch(function () { /* best effort */ });
}

// The work: create the clip+concat asset on Mux, then poll until both the asset and
// its downloadable MP4 are ready. All heavy lifting is on Mux's side.
async function processCutViaMux(jobId, masterAssetId, clips, filmName) {
  const job = cuts.get(jobId); if (!job) return;
  job.inputsSent = clips.length;
  job.requestedSeconds = round2(sumSeconds(clips));
  try {
    job.status = 'processing'; job.phase = 'creating';
    const clip = await muxFetch('/video/v1/assets', {
      method: 'POST',
      body: {
        inputs: buildClipInputs(masterAssetId, clips),
        playback_policies: ['public'],
        video_quality: 'basic',
        static_renditions: [{ resolution: 'highest' }]
      }
    });
    job.clipAssetId = clip.id;
    job.clipPlaybackId = (clip.playback_ids && clip.playback_ids[0] && clip.playback_ids[0].id) || null;
    job.assetStatus = clip.status || 'preparing';
    job.phase = 'transcoding';

    const deadline = Date.now() + CUT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(POLL_MS);
      let a;
      try { a = await muxFetch('/video/v1/assets/' + clip.id); }
      catch (e) { continue; /* transient read error — keep polling */ }
      job.assetStatus = a.status;
      if (typeof a.duration === 'number') job.actualSeconds = round2(a.duration);

      const mp4 = pickReadyMp4(a.static_renditions);
      job.mp4 = mp4 ? { name: mp4.name, status: mp4.status } : summarizeSR(a.static_renditions);

      if (a.status === 'errored') throw new Error('Mux could not build the cut (asset errored).');
      if (a.status === 'ready' && mp4) {
        job.mp4Name = mp4.name;
        job.phase = 'ready'; job.status = 'ready';
        return;
      }
    }
    throw new Error('Timed out waiting for Mux to finish the cut.');
  } catch (e) {
    job.status = 'error'; job.phase = 'error'; job.error = e.message;
    deleteClipAsset(job); // clean up any partial asset
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
    if (row.status !== 'ready') return res.status(409).json({ error: 'This film isn\u2019t ready yet.' });
    if (!row.asset_id) return res.status(409).json({ error: 'This film has no master asset to cut from yet.' });
    const clips = sanitizeClips(req.body && req.body.clips, row.duration);
    if (!clips) return res.status(400).json({ error: 'No valid selections — each must be at least 0.5 seconds.' });
    const total = sumSeconds(clips);
    if (total > MAX_CUT_SECONDS) return res.status(400).json({ error: 'That selection is too long.' });
    const jobId = crypto.randomUUID();
    cuts.set(jobId, { status: 'queued', phase: 'queued', filmName: row.film_name, createdAt: Date.now() });
    res.json({ jobId: jobId });
    processCutViaMux(jobId, row.asset_id, clips, row.film_name); // run in the background
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Poll a cut job's progress — includes a verification RECEIPT so we can confirm
// Mux really concatenated the ranges (requested vs actual duration) and that the
// downloadable MP4 was produced.
app.get('/api/cuts/:jobId', (req, res) => {
  const job = cuts.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Not found' });
  res.json({
    status: job.status,
    phase: job.phase,
    error: job.error || null,
    receipt: {
      inputsSent: job.inputsSent != null ? job.inputsSent : null,
      requestedSeconds: job.requestedSeconds != null ? job.requestedSeconds : null,
      actualSeconds: typeof job.actualSeconds === 'number' ? job.actualSeconds : null,
      concatLooksCorrect: concatLooksCorrect(job.requestedSeconds, job.actualSeconds, job.inputsSent),
      assetStatus: job.assetStatus || null,
      clipAssetId: job.clipAssetId || null,
      clipPlaybackId: job.clipPlaybackId || null,
      mp4: job.mp4 || null,
      downloadReady: job.status === 'ready'
    }
  });
});

// Download the finished reel. We stream Mux's MP4 straight through (no buffering,
// no processing), set a clean filename, keep the Mux URL private, and delete the
// clip asset once the download completes.
app.get('/api/cuts/:jobId/download', async (req, res) => {
  const job = cuts.get(req.params.jobId);
  if (!job || job.status !== 'ready' || !job.clipPlaybackId || !job.mp4Name) {
    return res.status(404).json({ error: 'Not ready' });
  }
  try {
    const r = await fetch(muxDownloadUrl(job.clipPlaybackId, job.mp4Name));
    if (!r.ok || !r.body) {
      return res.status(502).json({ error: 'Could not fetch the finished cut from Mux (' + r.status + ').' });
    }
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'attachment; filename="' + safeFilename(job.filmName) + ' - reel.mp4"');
    const len = r.headers.get('content-length'); if (len) res.setHeader('Content-Length', len);

    const stream = Readable.fromWeb(r.body);
    stream.on('error', function () { try { res.destroy(); } catch (e) {} });
    // 'finish' = the response was fully sent -> safe to delete the asset + job.
    res.on('finish', function () { deleteClipAsset(job); cuts.delete(req.params.jobId); });
    stream.pipe(res);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Sweep abandoned cut jobs (never downloaded) so their Mux assets don't linger.
function sweepStaleCuts() {
  const now = Date.now();
  for (const [id, job] of cuts) {
    if (now - (job.createdAt || now) > 60 * 60 * 1000) {
      deleteClipAsset(job);
      cuts.delete(id);
    }
  }
}

// Exposed for logic tests (see test_helpers.js).
module.exports = {
  sanitizeClips, sumSeconds, buildClipInputs, pickReadyMp4, summarizeSR,
  concatLooksCorrect, safeFilename, muxDownloadUrl, round2,
  MIN_CLIP_SECONDS, MAX_CUT_SECONDS, APP_VERSION
};

if (require.main === module) {
  if (pool) ensureSchema().then(() => console.log('reel_sends table ready')).catch(e => console.error('schema error:', e.message));
  setInterval(sweepStaleCuts, 10 * 60 * 1000).unref();
  app.listen(PORT, () => console.log('Magic Reel engine ' + APP_VERSION + ' listening on ' + PORT));
}
