// Magic Reel — engine (skeleton)
// A small standalone service: serves the app pages and proves the
// pipeline (subdomain + Render + shared Neon database). Video upload,
// preview, the metered budget, and the clean cut arrive in later milestones.

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

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

if (pool) ensureSchema().then(() => console.log('reel_sends table ready')).catch(e => console.error('schema error:', e.message));

app.listen(PORT, () => console.log('Magic Reel engine listening on ' + PORT));
