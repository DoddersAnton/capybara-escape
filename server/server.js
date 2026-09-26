'use strict';
// Leaderboard server for Ezra's Capybara Escape Game.
//
// No packages to install: it only uses Node's built-in modules (works on Node 12 and newer).
//   * GET  /                serves the game (index.html)
//   * GET  /api/scores      the top scores, fastest first     (?limit=10, up to 50)
//   * POST /api/scores      submit a score  { name, time, lives }
//   * GET  /api/health      lets the game check the server is there
// Scores are kept in a JSON file (server/data/scores.json by default). Writes go through a queue and are saved
// to a temporary file first and then renamed into place, so two people finishing at once can't corrupt it.
//
// Settings (environment variables): PORT, SCORES_FILE, ALLOWED_ORIGIN, TRUST_PROXY, SUBMIT_GAP_MS.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';     // which websites may call the API from a browser
const TRUST_PROXY = process.env.TRUST_PROXY === '1';           // set when running behind a proxy that sets X-Forwarded-For
const DATA_FILE = process.env.SCORES_FILE || path.join(__dirname, 'data', 'scores.json');
const GAME_FILE = path.join(__dirname, '..', 'index.html');

const MAX_STORED = 200;                                        // keep the best 200
const MAX_NAME = 12;
const MIN_TIME = 15;                                           // a five-level run can't honestly be faster than this (seconds)
const MAX_TIME = 36000;
const MAX_LIVES = 3;
const MAX_BODY = 2048;
const SUBMIT_GAP_MS = process.env.SUBMIT_GAP_MS !== undefined ? parseInt(process.env.SUBMIT_GAP_MS, 10) : 10000;

let scores = [];
let lastDate = 0;

// Fastest time wins; ties go to whoever finished with more lives, then whoever got there first.
const byRank = (a, b) => a.time - b.time || b.lives - a.lives || a.date - b.date;

function isStoredScore(s) {
  return s && typeof s.name === 'string' && typeof s.time === 'number' && isFinite(s.time)
    && Number.isInteger(s.lives) && typeof s.date === 'number';
}

function loadFromDisk() {
  let raw;
  try { raw = fs.readFileSync(DATA_FILE, 'utf8'); }
  catch (e) {
    if (e.code !== 'ENOENT') console.error('Could not read the scores file:', e.message);
    return;
  }
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) throw new Error('not a list');
    scores = arr.filter(isStoredScore).sort(byRank);
    lastDate = scores.reduce((m, s) => Math.max(m, s.date), 0);
  } catch (e) {
    // Don't silently start over (and then overwrite the evidence): keep the unreadable file next to the new one.
    const backup = DATA_FILE + '.corrupt-' + Date.now();
    try { fs.renameSync(DATA_FILE, backup); } catch (err) { /* nothing more we can do */ }
    console.error('The scores file was unreadable (' + e.message + '); moved it to ' + backup + ' and starting empty.');
  }
}

let writing = Promise.resolve(true);
function persist() {
  const snapshot = JSON.stringify(scores.slice(0, MAX_STORED), null, 2);
  const tmp = DATA_FILE + '.tmp';
  writing = writing
    .then(() => fs.promises.mkdir(path.dirname(DATA_FILE), { recursive: true }))
    .then(() => fs.promises.writeFile(tmp, snapshot))
    .then(() => fs.promises.rename(tmp, DATA_FILE))
    .then(() => true)
    .catch(err => { console.error('Could not save the scores:', err.message); return false; });
  return writing;
}

function cleanName(raw) {
  const s = typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim() : '';
  return Array.from(s).slice(0, MAX_NAME).join('').trim() || 'Capybara';
}

function addScore(name, time, lives) {
  lastDate = Math.max(Date.now(), lastDate + 1);                // unique, always increasing
  const entry = { name, time: Math.round(time * 10) / 10, lives, date: lastDate };
  scores.push(entry);
  scores.sort(byRank);
  const rank = scores.indexOf(entry) + 1;
  if (scores.length > MAX_STORED) scores.length = MAX_STORED;
  return { entry, rank };
}

/* ---------- HTTP ---------- */

function corsHeaders() {
  return { 'Access-Control-Allow-Origin': ALLOWED_ORIGIN, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
           'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' };
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, corsHeaders()));
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, tooBig = false;
    req.on('data', chunk => { size += chunk.length; if (size > limit) tooBig = true; else chunks.push(chunk); });
    req.on('end', () => tooBig ? reject(Object.assign(new Error('body too large'), { status: 413 })) : resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function clientIp(req) {
  const fwd = TRUST_PROXY && req.headers['x-forwarded-for'];
  return fwd ? String(fwd).split(',')[0].trim() : req.socket.remoteAddress;
}

const lastSubmit = new Map();                                   // address -> when they last submitted
setInterval(() => {
  const cutoff = Date.now() - 60000;
  lastSubmit.forEach((t, ip) => { if (t < cutoff) lastSubmit.delete(ip); });
}, 60000).unref();

function listScores(url, res) {
  let limit = parseInt(url.searchParams.get('limit'), 10);
  if (!(limit >= 1)) limit = 10;
  sendJson(res, 200, { scores: scores.slice(0, Math.min(limit, 50)) });
}

async function postScore(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req, MAX_BODY)); }
  catch (e) { return sendJson(res, e.status || 400, { error: e.status === 413 ? 'body too large' : 'invalid JSON' }); }
  if (!body || typeof body !== 'object') return sendJson(res, 400, { error: 'expected an object' });

  const time = body.time, lives = body.lives;
  if (typeof time !== 'number' || !isFinite(time) || time < MIN_TIME || time > MAX_TIME) return sendJson(res, 400, { error: 'time out of range' });
  if (!Number.isInteger(lives) || lives < 1 || lives > MAX_LIVES) return sendJson(res, 400, { error: 'lives out of range' });

  const ip = clientIp(req), now = Date.now();
  if (now - (lastSubmit.get(ip) || 0) < SUBMIT_GAP_MS) return sendJson(res, 429, { error: 'too many submissions, try again in a few seconds' });
  lastSubmit.set(ip, now);

  const { entry, rank } = addScore(cleanName(body.name), time, lives);
  const persisted = await persist();
  sendJson(res, 201, { entry, rank, persisted, scores: scores.slice(0, 10) });
}

function serveGame(res) {
  fs.readFile(GAME_FILE, (err, data) => {
    if (err) { res.writeHead(500, { 'Content-Type': 'text/plain' }); return res.end('Could not read index.html'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });   // always fetch the newest game
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  if (p === '/api/scores') {
    if (req.method === 'OPTIONS') { res.writeHead(204, corsHeaders()); return res.end(); }
    if (req.method === 'GET') return listScores(url, res);
    if (req.method === 'POST') return postScore(req, res).catch(err => { console.error(err); sendJson(res, 500, { error: 'server error' }); });
    return sendJson(res, 405, { error: 'method not allowed' });
  }
  if (p === '/api/health') return sendJson(res, 200, { ok: true, scores: scores.length });
  // Only the game itself is served, never other files (so the scores file and the repo can't be downloaded).
  if ((p === '/' || p === '/index.html') && req.method === 'GET') return serveGame(res);
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') console.error('Port ' + PORT + ' is already in use. Is the leaderboard server already running? To use another port: PORT=3001 npm start');
  else console.error('Server error:', err.message);
  process.exit(1);
});

loadFromDisk();
server.listen(PORT, () => {
  console.log('Capybara Escape is running at http://localhost:' + PORT);
  console.log('Leaderboard: ' + scores.length + ' score(s) loaded from ' + DATA_FILE);
});

function shutdown() {
  console.log('Shutting down…');
  server.close();
  writing.then(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
