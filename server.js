// Magic Reel — engine (skeleton)
// A small standalone service: serves the app pages and proves the
// pipeline (subdomain + Render + shared Neon database). Video upload,
// preview, the metered budget, and the clean cut arrive in later milestones.

const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// Neon Postgres — the SAME database Magic Story Maker uses, so Magic Reel
// can read your real cast & crew later. Neon requires SSL.
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

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

app.listen(PORT, () => console.log('Magic Reel engine listening on ' + PORT));
