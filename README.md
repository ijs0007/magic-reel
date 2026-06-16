# Magic Reel

A standalone service where a filmmaker shares a film and cast & crew open a
private link to pull their own reel — a watermarked preview, mark in/out
points up to a per-person budget, and download a clean cut.

Sibling app to Magic Story Maker; shares the same Neon database.

## Run locally
    npm install
    npm start
Then open http://localhost:3000

## Environment variables
    DATABASE_URL   Neon Postgres connection string (same one Magic Story Maker uses)
    # MUX_TOKEN_ID / MUX_TOKEN_SECRET  — added in the next milestone

## Deploy
Push to GitHub → Render auto-deploys this repo as a Web Service.
Build command: npm install   ·   Start command: npm start
Set DATABASE_URL in the Render service's Environment.
