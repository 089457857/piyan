// 牛牛線上牌桌 — 伺服器
// 籌碼為虛擬記分用，不可兌換任何財物。
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const ADMIN_USER = (process.env.ADMIN_USER || 'admin').trim();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const DATABASE_URL = process.env.DATABASE_URL || '';

// ---------------- 儲存：Postgres（Render）或本機 JSON 檔 ----------------
let S = { users: {}, sessions: {}, requests: {}, ledger: [], tables: {}, history: [], seq: 1 };
let pool = null;
const FILE = path.join(__dirname, 'data.json');

async function load() {
  if (DATABASE_URL) {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: /render\.com|sslmode=require/.test(DATABASE_URL) ? { rejectUnauthorized: false } : false,
    });
    // 兩個遊戲共用資料庫，同時啟動時可能一起建立資料表：撞到「已經存在」就當作成功
    try { await pool.query('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v JSONB NOT NULL)'); } catch (e) { if (!['23505', '42P07'].includes(e.code)) throw e; }
    const r = await pool.query("SELECT v FROM kv WHERE k='state'");
    if (r.rows[0]) S = Object.assign(S, r.rows[0].v);
    console.log('已連上 Postgres 資料庫');
  } else if (fs.existsSync(FILE)) {
    S = Object.assign(S, JSON.parse(fs.readFileSync(FILE, 'utf8')));
    console.log('使用本機 data.json（未設定 DATABASE_URL）');
  }
}
let saveTimer = null, saving = false, again = false;
function save() { clearTimeout(saveTimer); saveTimer = setTimeout(flush, 500); }
async function flush() {
  if (saving) { again = true; return; }
  saving = true;
  try {
    const data = JSON.stringify(S);
    if (pool) await pool.query("INSERT INTO kv (k, v) VALUES ('state', $1) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v", [data]);
    else fs.writeFileSync(FILE, data);
  } catch (e) { console.error('儲存失敗', e.message); }
  saving = false;
  if (again) { again = false; flush(); }
}
const newId = () => (S.seq++).toString(36) + crypto.randomBytes(3).toString('hex');

async function ensureAdmin() {
  let a = Object.values(S.users).find(u => u.name.toLowerCase() === ADMIN_USER.toLowerCase());
  if (!a) {
    if (!ADMIN_PASSWORD) { console.warn('⚠ 尚未設定 ADMIN_PASSWORD，管理員帳號不會建立'); return; }
    a = { id: newId(), name: ADMIN_USER, hash: await bcrypt.hash(ADMIN_PASSWORD, 10), admin: true, bal: 0, created: Date.now() };
    S.users[a.id] = a;
    console.log('已建立管理員帳號：' + ADMIN_USER);
  } else if (!a.admin) a.admin = true;
  if (!Object.keys(S.tables).length) {
    const t = { id: newId(), name: '一號桌', base: 10, game: 'niuniu' };
    S.tables[t.id] = t;
    const t2 = { id: newId(), name: '推筒子一號桌', base: 10, game: 'tuitong' };
    S.tables[t2.id] = t2;
  }
  save();
}

// ---------------- 牌型 ----------------
const CN = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
function evalHand(c) {
  const v = c.map(x => Math.min(x.r, 10)), sum = v.reduce((a, b) => a + b, 0);
  const top = Math.max(...c.map(x => x.r * 4 + x.s));
  if (c.every(x => x.r < 5) && sum <= 10) return { rank: 13, mult: 5, name: '五小牛', key: top, tri: null };
  const cnt = {}; c.forEach(x => cnt[x.r] = (cnt[x.r] || 0) + 1);
  const q = Object.keys(cnt).find(k => cnt[k] === 4);
  if (q) return { rank: 12, mult: 4, name: '炸彈', key: +q * 4 + 3, tri: null };
  if (c.every(x => x.r > 10)) return { rank: 11, mult: 4, name: '五花牛', key: top, tri: null };
  for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) for (let k = j + 1; k < 5; k++)
    if ((v[i] + v[j] + v[k]) % 10 === 0) {
      const n = (sum % 10) || 10;
      return { rank: n, mult: n === 10 ? 3 : n >= 7 ? 2 : 1, name: n === 10 ? '牛牛' : '牛' + CN[n], key: top, tri: [i, j, k] };
    }
  return { rank: 0, mult: 1, name: '沒牛', key: top, tri: null };
}
const cmp = (a, b) => a.rank - b.rank || a.key - b.key;
const rnd = n => crypto.randomInt(n);

// ---------------- HTTP ----------------
const app = express();
const json10 = express.json({ limit: '10kb' });
app.use((req, res, next) => req.path === '/api/restore' ? next() : json10(req, res, next));
// index.html 可放在 public/ 資料夾，也可以直接放在最外層
const PUB = path.join(__dirname, 'public');
const pageFile = () => fs.existsSync(path.join(PUB, 'index.html')) ? path.join(PUB, 'index.html') : path.join(__dirname, 'index.html');
app.get(['/', '/index.html'], (req, res) => res.sendFile(pageFile()));
const tries = {};
function limited(ip) { const now = Date.now(); const t = (tries[ip] || []).filter(x => now - x < 60000); t.push(now); tries[ip] = t; return t.length > 15; }

app.post('/api/register', async (req, res) => {
  if (limited(req.ip)) return res.status(429).json({ error: '嘗試太多次，請稍後再試' });
  const name = String(req.body.name || '').trim(), pass = String(req.body.pass || '');
  if (!/^[\p{L}\p{N}_\-]{2,16}$/u.test(name)) return res.status(400).json({ error: '暱稱需 2～16 個字，只能用文字、數字、底線或減號' });
  if (pass.length < 4 || pass.length > 64) return res.status(400).json({ error: '密碼需 4～64 個字元' });
  if (Object.values(S.users).some(u => u.name.toLowerCase() === name.toLowerCase())) return res.status(400).json({ error: '這個暱稱已經有人用了' });
  const u = { id: newId(), name, hash: await bcrypt.hash(pass, 10), admin: false, bal: 0, created: Date.now() };
  S.users[u.id] = u;
  const token = crypto.randomBytes(24).toString('hex'); S.sessions[token] = u.id; save();
  res.json({ token });
  pushAdmin();
});
app.post('/api/login', async (req, res) => {
  if (limited(req.ip)) return res.status(429).json({ error: '嘗試太多次，請稍後再試' });
  const name = String(req.body.name || '').trim(), pass = String(req.body.pass || '');
  const u = Object.values(S.users).find(x => x.name.toLowerCase() === name.toLowerCase());
  if (!u || !(await bcrypt.compare(pass, u.hash))) return res.status(400).json({ error: '暱稱或密碼錯誤' });
  const token = crypto.randomBytes(24).toString('hex'); S.sessions[token] = u.id; save();
  res.json({ token });
});
app.get('/healthz', (_, res) => res.send('ok'));

// ---------------- 資料備份／還原（管理員） ----------------
// 牛牛和屁眼王國大冒險共用同一個資料庫，備份檔會把資料庫裡所有遊戲的資料一起存下來
const adminOf = req => { const uid = S.sessions[String(req.get('x-token') || '')]; return uid && S.users[uid]?.admin ? uid : null; };
app.get('/api/backup', async (req, res) => {
  if (!adminOf(req)) return res.status(403).json({ error: '只有管理員可以下載備份' });
  clearTimeout(saveTimer); await flush();
  const rows = {};
  if (pool) { const r = await pool.query('SELECT k, v FROM kv'); for (const x of r.rows) if (!x.k.endsWith(':reload')) rows[x.k] = x.v; }
  else rows.state = S;
  const stamp = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace(/[-:T]/g, '');
  res.set('Content-Disposition', `attachment; filename="game-backup-${stamp}.json"`);
  res.json({ type: 'naiyou-backup', version: 1, at: Date.now(), rows });
});
app.post('/api/restore', express.json({ limit: '50mb' }), async (req, res) => {
  const by = adminOf(req); if (!by) return res.status(403).json({ error: '只有管理員可以還原備份' });
  const b = req.body || {}, rows = b.rows;
  if (b.type !== 'naiyou-backup' || !rows || typeof rows !== 'object' || !rows.state || !rows.state.users) return res.status(400).json({ error: '這不是正確的備份檔' });
  try {
    clearTimeout(saveTimer);
    if (pool) {
      for (const [k, v] of Object.entries(rows)) await pool.query('INSERT INTO kv (k, v) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v', [k, JSON.stringify(v)]);
      for (const k of Object.keys(rows)) if (k !== 'state') await pool.query('INSERT INTO kv (k, v) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v', [k + ':reload', JSON.stringify({ at: Date.now() })]);
    }
    S = Object.assign({ users: {}, sessions: {}, requests: {}, ledger: [], tables: {}, history: [], seq: 1 }, rows.state);
    for (const k in G) delete G[k];
    if (S.hstk) { for (const [uid, x] of Object.entries(S.hstk)) { const u = S.users[uid]; if (u && x.amt > 0) u.bal += x.amt; } S.hstk = {}; }
    await ensureAdmin(); await flush();
    res.json({ ok: true, users: Object.keys(S.users).length, games: Object.keys(rows) });
    setTimeout(() => io.disconnectSockets(true), 300);
  } catch (e) { console.error('還原失敗', e); res.status(500).json({ error: '還原失敗：' + e.message }); }
});

const server = http.createServer(app);
const io = new Server(server);

// ---------------- 牌桌執行狀態（記憶體） ----------------
const G = {}; // tid -> runtime
function rt(tid) {
  if (!G[tid]) G[tid] = { phase: 'idle', seats: [], round: 0, banker: null, grabMult: 1, deadline: null, results: null, hands: {} };
  return G[tid];
}
const online = uid => (io.sockets.adapter.rooms.get('u:' + uid)?.size || 0) > 0;
const ownerOf = g => (g.seats.find(s => online(s.uid)) || g.seats[0] || {}).uid || null;
// 遊戲種類：niuniu 牛牛 / tuitong 推筒子
const gameOf = tid => { const g = S.tables[tid]?.game; return g === 'tuitong' || g === 'holdem' ? g : 'niuniu'; };
const SERIES_OPTS = { niuniu: [3, 5, 10], tuitong: [4, 8], holdem: [1] }; // 房主可選的每輪局數
const seriesOptsOf = tid => SERIES_OPTS[gameOf(tid)];
const seriesOf = tid => { const o = seriesOptsOf(tid), v = Number(S.tables[tid]?.series); return o.includes(v) ? v : (gameOf(tid) === 'tuitong' ? 4 : 5); };
const maxSeatsOf = tid => gameOf(tid) === 'tuitong' ? 4 : 6; // 德州撲克也是 6 人桌
const maxXOf = () => 10; // 推筒子下注範圍：底注 ～ 底注 × 10（例：底注 10 → 10～100）
const isPlaying = g => ['grab', 'bet', 'tbet', 'peek', 'hplay'].includes(g.phase);
const PEEK_MS = 10000, DEAL_MS = 2600; // 推筒子：發牌動畫時間 + 掀牌時間
const grabSecOf = tid => { const v = Number(S.tables[tid]?.grabSec); return v >= 5 && v <= 10 ? v : 8; };
function pubTable(tid) {
  const t = S.tables[tid], g = rt(tid);
  return {
    id: tid, name: t.name, base: t.base, phase: g.phase, round: g.round, banker: g.banker, grabMult: g.grabMult,
    game: gameOf(tid), maxSeats: maxSeatsOf(tid), seriesOpts: seriesOptsOf(tid), maxX: maxXOf(tid), maxBet: t.base * maxXOf(tid),
    wall: g.wall ? g.wall.length : null, shoeHand: g.shoeHand || 0, dice: g.dice || null, startUid: g.startUid || null,
    deadline: g.deadline, now: Date.now(), results: g.results, owner: ownerOf(g), seriesNo: g.seriesNo || 0, seriesTotal: g.seriesNo ? (g.seriesLen || seriesOf(tid)) : seriesOf(tid), grabSec: grabSecOf(tid),
    seats: g.seats.map(s => ({ uid: s.uid, name: S.users[s.uid]?.name || '玩家', bal: S.users[s.uid]?.bal || 0, grab: s.grab, bet: s.bet, ready: !!s.ready, leave: !!s.leave, open: !!s.open, online: online(s.uid), stack: s.stack || 0 })),
    ...(gameOf(tid) === 'holdem' ? hePub(tid, g) : {}),
  };
}
const pushTable = tid => S.tables[tid] && io.to('t:' + tid).emit('table', pubTable(tid));
function lobby() {
  return Object.values(S.tables).map(t => ({ id: t.id, name: t.name, base: t.base, game: gameOf(t.id), maxSeats: maxSeatsOf(t.id), players: rt(t.id).seats.length, phase: rt(t.id).phase }));
}
const pushLobby = () => io.emit('lobby', lobby());
function meInfo(uid) {
  const u = S.users[uid]; if (!u) return null;
  const reqs = Object.values(S.requests).filter(r => r.uid === uid).sort((a, b) => b.at - a.at).slice(0, 10);
  const hist = S.history.filter(h => h.res.some(x => x.uid === uid)).slice(0, 20).map(h => ({ round: h.round, table: h.table, at: h.at, banker: h.bankerName, ...h.res.find(x => x.uid === uid) }));
  return { id: u.id, name: u.name, admin: u.admin, bal: u.bal, requests: reqs, history: hist };
}
const pushMe = uid => io.to('u:' + uid).emit('me', meInfo(uid));
function adminInfo() {
  return {
    requests: Object.values(S.requests).filter(r => r.status === 'pending').sort((a, b) => a.at - b.at).map(r => ({ ...r, name: S.users[r.uid]?.name || '?' })),
    users: Object.values(S.users).sort((a, b) => a.name.localeCompare(b.name)).map(u => ({ id: u.id, name: u.name, bal: u.bal, admin: u.admin, online: online(u.id) })),
    ledger: S.ledger.slice(0, 80).map(l => ({ ...l, name: S.users[l.uid]?.name || '?', byName: S.users[l.by]?.name || '' })),
  };
}
const pushAdmin = () => io.to('admins').emit('admin', adminInfo());

function grant(uid, delta, reason, by) {
  const u = S.users[uid]; if (!u) return;
  const before = u.bal; u.bal = Math.max(0, Math.round(u.bal + delta));
  S.ledger.unshift({ id: newId(), uid, delta: u.bal - before, reason, by, at: Date.now() });
  S.ledger = S.ledger.slice(0, 500);
  save(); pushMe(uid); pushAdmin(); refreshSeated(uid);
}
function refreshSeated(uid) { for (const tid in G) if (G[tid].seats.some(s => s.uid === uid)) pushTable(tid); }

// ---------------- 中途離座罰金 ----------------
const PENALTY_X = 5; // 罰金 = 底注 × 5，付給其他每位玩家
const seriesActive = (tid, g) => g.seriesNo > 0 && !(g.phase === 'done' && g.seriesNo >= (g.seriesLen || seriesOf(tid)));
function penalize(tid, uid, why) {
  const t = S.tables[tid], g = rt(tid), u = S.users[uid]; if (!t || !u) return;
  const others = g.seats.filter(s => s.uid !== uid && !s.leave && S.users[s.uid]);
  if (!others.length) return;
  let each = t.base * PENALTY_X;
  if (u.bal < each * others.length) each = Math.floor(u.bal / others.length);
  if (each <= 0) return;
  const now = Date.now();
  u.bal -= each * others.length;
  S.ledger.unshift({ id: newId(), uid, delta: -each * others.length, reason: why, by: uid, at: now });
  for (const s of others) {
    S.users[s.uid].bal += each;
    S.ledger.unshift({ id: newId(), uid: s.uid, delta: each, reason: '收到 ' + u.name + ' 的離座罰金', by: uid, at: now });
    pushMe(s.uid);
  }
  S.ledger = S.ledger.slice(0, 500); save(); pushMe(uid); pushAdmin();
  io.to('t:' + tid).emit('toast', `${u.name} ${why.includes('斷線') ? '中途斷線' : '中途離座'}，付給每位玩家 ${each.toLocaleString()} 籌碼罰金`);
}

// ---------------- 遊戲流程 ----------------
function endSeries(tid) {
  const g = rt(tid);
  g.seats.forEach(s => { s.ready = false; }); g.seriesNo = 0;
  g.phase = 'idle'; g.deadline = null; g.results = null; g.banker = null; g.dice = null;
  pushTable(tid); pushLobby();
}
function startRound(tid) {
  const t = S.tables[tid], g = rt(tid);
  g.seats = g.seats.filter(s => !s.leave && online(s.uid) && (S.users[s.uid]?.bal || 0) >= t.base);
  if (g.seats.length < 2) return endSeries(tid);
  if (gameOf(tid) === 'tuitong') return ttStart(tid);
  const deck = []; for (let r = 1; r <= 13; r++) for (let s = 0; s < 4; s++) deck.push({ r, s });
  for (let i = deck.length - 1; i > 0; i--) { const j = rnd(i + 1); [deck[i], deck[j]] = [deck[j], deck[i]]; }
  g.round++; g.hands = {}; g.results = null; g.banker = null; g.grabMult = 1;
  g.seats.forEach(s => { g.hands[s.uid] = deck.splice(0, 5); s.grab = null; s.bet = null; });
  g.phase = 'grab'; g.deadline = Date.now() + grabSecOf(tid) * 1000;
  for (const s of g.seats) io.to('u:' + s.uid).emit('hand', { tid, round: g.round, cards: g.hands[s.uid].slice(0, 4) });
  pushTable(tid); pushLobby();
}
function resolveBanker(tid) {
  const g = rt(tid);
  g.seats.forEach(s => { if (s.grab == null) s.grab = 0; });
  const mx = Math.max(...g.seats.map(s => s.grab)), c = g.seats.filter(s => s.grab === mx);
  g.banker = c[rnd(c.length)].uid; g.grabMult = Math.max(1, mx);
  g.phase = 'bet'; g.deadline = Date.now() + 10000; pushTable(tid);
}
function showdown(tid) {
  const t = S.tables[tid], g = rt(tid), B = g.banker;
  g.seats.forEach(s => { if (s.uid !== B && s.bet == null) s.bet = 1; });
  const ev = {}; g.seats.forEach(s => ev[s.uid] = evalHand(g.hands[s.uid]));
  const bal = uid => S.users[uid]?.bal || 0, delta = {}, owed = []; let inB = 0;
  for (const s of g.seats) {
    if (s.uid === B) continue;
    const win = cmp(ev[s.uid], ev[B]) > 0, amt = t.base * g.grabMult * s.bet * (win ? ev[s.uid].mult : ev[B].mult);
    if (win) owed.push([s.uid, amt]); else { const l = Math.min(amt, bal(s.uid)); delta[s.uid] = -l; inB += l; }
  }
  const tot = owed.reduce((a, x) => a + x[1], 0), avail = bal(B) + inB, f = tot > avail ? avail / tot : 1; let outB = 0;
  owed.forEach(([u, a]) => { const p = Math.floor(a * f); delta[u] = p; outB += p; });
  delta[B] = inB - outB;
  for (const s of g.seats) if (S.users[s.uid]) S.users[s.uid].bal = Math.max(0, bal(s.uid) + (delta[s.uid] || 0));
  g.results = g.seats.map(s => ({ uid: s.uid, name: S.users[s.uid]?.name || '玩家', cards: g.hands[s.uid], tri: ev[s.uid].tri, hand: ev[s.uid].name, mult: ev[s.uid].mult, delta: delta[s.uid] || 0, bet: s.bet }));
  S.history.unshift({ round: g.round, table: t.name, at: Date.now(), bankerName: S.users[B]?.name || '', res: g.results.map(r => ({ uid: r.uid, hand: r.hand, delta: r.delta })) });
  S.history = S.history.slice(0, 300);
  g.phase = 'done'; g.deadline = Date.now() + 9000;
  save(); pushTable(tid); for (const s of g.seats) pushMe(s.uid); pushAdmin();
}
// ---------------- 推筒子 ----------------
// 牌：0 = 白板，1～9 = 一～九筒，各 4 張共 40 張；每 4 把重新洗牌（避免算牌）
const CNN = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
const TT_SHOE = 4;
function ttEval(tiles) {
  const [a, b] = tiles, half = v => v === 0 ? 1 : v * 2;
  if (a === b) return { pair: true, rank: 100 + (a === 0 ? 10 : a), mult: a === 0 ? 3 : 2, name: a === 0 ? '白板對' : CNN[a] + '筒對', key: 0, bie: false };
  const pts = (half(a) + half(b)) % 20, key = Math.max(half(a), half(b));
  const name = pts === 0 ? '鱉十' : (pts % 2 ? (pts === 1 ? '半點' : CNN[(pts - 1) / 2] + '點半') : CNN[pts / 2] + '點');
  return { pair: false, rank: pts, mult: 1, name, key, bie: pts === 0 };
}
const ttCmp = (a, b) => a.rank - b.rank; // 平點（含同樣對子）一律莊家贏
function ttStart(tid) {
  const g = rt(tid), n = g.seats.length;
  g.round++; g.results = null; g.dice = null; g.startUid = null; g.hands = {};
  let idx;
  if (!g.lastBanker) idx = Math.max(0, g.seats.findIndex(s => s.uid === ownerOf(g)));
  else { const li = g.seats.findIndex(s => s.uid === g.lastBanker); idx = li >= 0 ? (li + 1) % n : (g.lastBankerIdx || 0) % n; }
  g.banker = g.seats[idx].uid; g.lastBanker = g.banker; g.lastBankerIdx = idx;
  g.seats.forEach(s => { s.bet = null; s.grab = null; });
  if (!g.wall || (g.shoeHand || 0) >= TT_SHOE || g.wall.length < n * 2) {
    const w = []; for (let v = 0; v <= 9; v++) for (let k = 0; k < 4; k++) w.push(v);
    for (let i = w.length - 1; i > 0; i--) { const j = rnd(i + 1); [w[i], w[j]] = [w[j], w[i]]; }
    g.wall = w; g.shoeHand = 0;
  }
  g.shoeHand++;
  g.phase = 'tbet'; g.deadline = Date.now() + grabSecOf(tid) * 1000;
  pushTable(tid); pushLobby();
}
function ttDeal(tid) {
  const t = S.tables[tid], g = rt(tid), B = g.banker, n = g.seats.length;
  const bal = uid => S.users[uid]?.bal || 0;
  g.seats.forEach(s => { if (s.uid !== B && s.bet == null) s.bet = Math.min(t.base, bal(s.uid)); s.open = false; });
  // 擲骰決定從哪一家開始發牌（從莊家起算）
  const d1 = rnd(6) + 1, d2 = rnd(6) + 1; g.dice = [d1, d2];
  const bi = g.seats.findIndex(s => s.uid === B), start = (bi + (d1 + d2 - 1)) % n;
  g.startUid = g.seats[start].uid;
  for (let k = 0; k < n; k++) { const s = g.seats[(start + k) % n]; g.hands[s.uid] = [g.wall.shift(), g.wall.shift()]; }
  // 看牌階段：每人只收到自己的牌，掀完或時間到才一起亮牌
  g.phase = 'peek'; g.deadline = Date.now() + DEAL_MS + PEEK_MS;
  for (const s of g.seats) io.to('u:' + s.uid).emit('thand', { tid, round: g.round, tiles: g.hands[s.uid] });
  pushTable(tid);
}
function ttSettle(tid) {
  const t = S.tables[tid], g = rt(tid), B = g.banker;
  const bal = uid => S.users[uid]?.bal || 0;
  const ev = {}; g.seats.forEach(s => ev[s.uid] = ttEval(g.hands[s.uid]));
  const delta = {}, owed = []; let inB = 0;
  for (const s of g.seats) {
    if (s.uid === B) continue;
    const win = ev[B].bie ? true : ttCmp(ev[s.uid], ev[B]) > 0; // 莊家鱉十通賠；平點莊家贏
    const amt = s.bet * (win ? ev[s.uid].mult : ev[B].mult);
    if (win) owed.push([s.uid, amt]); else { const l = Math.min(amt, bal(s.uid)); delta[s.uid] = -l; inB += l; }
  }
  const tot = owed.reduce((a, x) => a + x[1], 0), avail = bal(B) + inB, f = tot > avail ? avail / tot : 1; let outB = 0;
  owed.forEach(([u, a]) => { const p = Math.floor(a * f); delta[u] = p; outB += p; });
  delta[B] = inB - outB;
  for (const s of g.seats) if (S.users[s.uid]) S.users[s.uid].bal = Math.max(0, bal(s.uid) + (delta[s.uid] || 0));
  g.results = g.seats.map(s => ({ uid: s.uid, name: S.users[s.uid]?.name || '玩家', tiles: g.hands[s.uid], hand: ev[s.uid].name, mult: ev[s.uid].mult, pair: ev[s.uid].pair, bie: ev[s.uid].bie, delta: delta[s.uid] || 0, bet: s.bet }));
  S.history.unshift({ round: g.round, table: t.name, at: Date.now(), bankerName: S.users[B]?.name || '', res: g.results.map(r => ({ uid: r.uid, hand: r.hand, delta: r.delta })) });
  S.history = S.history.slice(0, 300);
  g.phase = 'done'; g.deadline = Date.now() + 9000;
  save(); pushTable(tid); for (const s of g.seats) pushMe(s.uid); pushAdmin();
}

// ---------------- 德州撲克（隨時入座、隨時離開） ----------------
// 入座時從餘額買入桌上籌碼（20～200 個大盲），離座時退回；盲注 = 底注的一半／底注
const HE_MAX = 6, HE_ACT_MS = 20000, HE_OFF_MS = 5000, HE_NEXT_MS = 3000, HE_SHOW_MS = 7000, HE_FOLD_MS = 3500, HE_OFFLINE_KICK = 60000;
const heBlinds = tid => { const b = S.tables[tid].base; return [Math.max(1, Math.floor(b / 2)), b]; };
const heBuy = tid => { const bb = S.tables[tid].base; return [bb * 20, bb * 200]; };
const HN = ['高牌', '一對', '兩對', '三條', '順子', '同花', '葫蘆', '四條', '同花順', '皇家同花順'];
function heEval5(cs) {
  const v = cs.map(c => c.r === 1 ? 14 : c.r).sort((a, b) => b - a), fl = cs.every(c => c.s === cs[0].s);
  const u = [...new Set(v)]; let st = 0;
  if (u.length === 5) { if (u[0] - u[4] === 4) st = u[0]; else if (u[0] === 14 && u[1] === 5) st = 5; }
  const cnt = {}; v.forEach(x => cnt[x] = (cnt[x] || 0) + 1);
  const gr = Object.entries(cnt).map(([k, n]) => [n, +k]).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  if (st && fl) return { cat: st === 14 ? 9 : 8, key: [st] };
  if (gr[0][0] === 4) return { cat: 7, key: [gr[0][1], gr[1][1]] };
  if (gr[0][0] === 3 && gr[1][0] === 2) return { cat: 6, key: [gr[0][1], gr[1][1]] };
  if (fl) return { cat: 5, key: v };
  if (st) return { cat: 4, key: [st] };
  if (gr[0][0] === 3) return { cat: 3, key: gr.map(g => g[1]) };
  if (gr[0][0] === 2 && gr[1][0] === 2) return { cat: 2, key: gr.map(g => g[1]) };
  if (gr[0][0] === 2) return { cat: 1, key: gr.map(g => g[1]) };
  return { cat: 0, key: v };
}
function heCmp(a, b) { if (a.cat !== b.cat) return a.cat - b.cat; for (let i = 0; i < Math.max(a.key.length, b.key.length); i++) { const d = (a.key[i] || 0) - (b.key[i] || 0); if (d) return d; } return 0; }
function heBest(cs) {
  let best = null;
  for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) {
    const five = cs.filter((_, k) => k !== i && k !== j); if (five.length !== 5) continue;
    const e = heEval5(five); if (!best || heCmp(e, best) > 0) { best = e; best.cards = five; }
  }
  if (cs.length === 5) { best = heEval5(cs); best.cards = cs; }
  best.name = HN[best.cat]; return best;
}
// 桌上籌碼備份：伺服器重啟時退回餘額（手牌進行到一半就當作沒發生）
function heBackup(tid) { if (!S.hstk) S.hstk = {}; for (const s of rt(tid).seats) S.hstk[s.uid] = { tid, amt: s.stack }; save(); }
function heRefund(tid, s, why) {
  const u = S.users[s.uid]; if (S.hstk) delete S.hstk[s.uid];
  if (u && s.stack > 0) { u.bal += s.stack; S.ledger.unshift({ id: newId(), uid: s.uid, delta: s.stack, reason: why || '德州撲克離座，桌上籌碼退回', by: s.uid, at: Date.now() }); S.ledger = S.ledger.slice(0, 500); }
  s.stack = 0; save(); pushMe(s.uid); pushAdmin();
}
function heStand(tid, uid, why) {
  const g = rt(tid), s = g.seats.find(x => x.uid === uid); if (!s) return;
  const hd = g.hd, p = hd && g.phase === 'hplay' ? hd.ps[uid] : null;
  if (p && !p.fold) { s.leave = true; if (hd.cur === uid) heAct(tid, uid, 'fold'); else { p.fold = true; heAfter(tid, uid, true); } return; }
  if (p) { s.leave = true; return; } // 已棄牌，這手結束後再退籌碼
  heRefund(tid, s, why); g.seats = g.seats.filter(x => x.uid !== uid); pushTable(tid); pushLobby();
}
function heStart(tid) {
  const t = S.tables[tid], g = rt(tid), [SB, BB] = heBlinds(tid);
  for (const s of g.seats.filter(x => x.leave)) heRefund(tid, s);
  g.seats = g.seats.filter(x => !x.leave);
  const el = g.seats.filter(s => s.stack > 0 && online(s.uid));
  if (el.length < 2) { g.phase = 'idle'; g.hd = null; g.deadline = null; pushTable(tid); pushLobby(); return; }
  // 莊家按鈕：上一手按鈕之後的下一位
  const seatIdx = uid => g.seats.findIndex(s => s.uid === uid);
  let bi = g.btn ? seatIdx(g.btn) : -1, btn = null;
  for (let k = 1; k <= g.seats.length; k++) { const s = g.seats[(bi + k + g.seats.length) % g.seats.length]; if (el.includes(s)) { btn = s.uid; break; } }
  g.btn = btn;
  const bpos = el.findIndex(s => s.uid === btn), ord = [...el.slice(bpos + 1), ...el.slice(0, bpos + 1)].map(s => s.uid); // 按鈕最後
  const deck = []; for (let r = 1; r <= 13; r++) for (let s = 0; s < 4; s++) deck.push({ r, s });
  for (let i = deck.length - 1; i > 0; i--) { const j = rnd(i + 1); [deck[i], deck[j]] = [deck[j], deck[i]]; }
  const ps = {}; for (const uid of ord) ps[uid] = { hole: [deck.pop(), deck.pop()], bet: 0, tot: 0, fold: false, allin: false, acted: false };
  const hd = { deck, board: [], ps, ord, street: 0, curBet: 0, minRaise: BB, cur: null, btn };
  const sbU = ord.length === 2 ? btn : ord[0], bbU = ord.length === 2 ? ord[0] : ord[1];
  hd.sb = sbU; hd.bb = bbU; g.hd = hd; g.round++; g.results = null; g.phase = 'hplay';
  heBackup(tid);
  const post = (uid, amt) => { const s = g.seats.find(x => x.uid === uid), p = ps[uid], a = Math.min(amt, s.stack); s.stack -= a; p.bet += a; p.tot += a; if (!s.stack) p.allin = true; };
  post(sbU, SB); post(bbU, BB); hd.curBet = BB;
  for (const uid of ord) io.to('u:' + uid).emit('hhole', { tid, round: g.round, cards: ps[uid].hole });
  // 翻牌前：大盲之後的人先說話（兩人時由按鈕／小盲先說話）
  hd.cur = heNext(g, bbU); if (!hd.cur || heLive(g).filter(u => !ps[u].allin).length < 2 && ps[hd.cur]?.bet >= hd.curBet) return heStreetEnd(tid);
  heDeadline(tid); pushTable(tid); pushLobby();
}
const heLive = g => g.hd.ord.filter(u => !g.hd.ps[u].fold);
function heNext(g, from) { const o = g.hd.ord, i = o.indexOf(from); for (let k = 1; k <= o.length; k++) { const u = o[(i + k) % o.length], p = g.hd.ps[u]; if (!p.fold && !p.allin) return u; } return null; }
function heDeadline(tid) { const g = rt(tid); g.deadline = Date.now() + (online(g.hd.cur) ? HE_ACT_MS : HE_OFF_MS); }
function heAct(tid, uid, type, to) {
  const g = rt(tid), hd = g.hd; if (!hd || g.phase !== 'hplay' || hd.cur !== uid) return '還沒輪到你';
  const s = g.seats.find(x => x.uid === uid), p = hd.ps[uid], need = hd.curBet - p.bet;
  const put = a => { a = Math.min(a, s.stack); s.stack -= a; p.bet += a; p.tot += a; if (!s.stack) p.allin = true; };
  if (type === 'fold') p.fold = true;
  else if (type === 'check') { if (need > 0) return '現在不能過牌'; }
  else if (type === 'call') { if (need <= 0) return '現在不用跟注'; put(need); }
  else if (type === 'raise' || type === 'allin') {
    to = type === 'allin' ? p.bet + s.stack : Math.round(Number(to));
    if (!(to > hd.curBet)) return type === 'allin' ? heAct(tid, uid, need > 0 ? 'call' : 'check') : '加注金額要大於目前的注額';
    if (to - p.bet > s.stack) return '桌上籌碼不夠';
    const inc = to - hd.curBet, isAll = to - p.bet === s.stack;
    if (inc < hd.minRaise && !isAll) return `最少要加到 ${hd.curBet + hd.minRaise}`;
    put(to - p.bet);
    if (inc >= hd.minRaise) { hd.minRaise = inc; for (const u of hd.ord) if (u !== uid && !hd.ps[u].fold && !hd.ps[u].allin) hd.ps[u].acted = false; }
    hd.curBet = Math.max(hd.curBet, p.bet);
  } else return '無效的動作';
  p.acted = true; p.last = type === 'allin' || p.allin ? 'allin' : type;
  heAfter(tid, uid, false); return null;
}
function heAfter(tid, uid, outOfTurn) {
  const g = rt(tid), hd = g.hd;
  if (heLive(g).length === 1) return heSettle(tid);
  const wait = hd.ord.filter(u => { const p = hd.ps[u]; return !p.fold && !p.allin && (!p.acted || p.bet < hd.curBet); });
  if (!wait.length) return heStreetEnd(tid);
  if (!outOfTurn || hd.cur === uid || !wait.includes(hd.cur)) { const o = hd.ord, i = o.indexOf(hd.cur === uid || !outOfTurn ? uid : hd.cur); hd.cur = null; for (let k = 1; k <= o.length; k++) { const c = o[(i + k) % o.length]; if (wait.includes(c)) { hd.cur = c; break; } } }
  heDeadline(tid); pushTable(tid);
}
function heStreetEnd(tid) {
  const g = rt(tid), hd = g.hd;
  for (const u of hd.ord) { const p = hd.ps[u]; p.bet = 0; p.acted = false; p.last = p.fold ? 'fold' : p.allin ? 'allin' : null; }
  hd.curBet = 0; hd.minRaise = heBlinds(tid)[1];
  if (hd.street >= 3) return heSettle(tid);
  hd.street++; if (hd.street === 1) hd.board.push(hd.deck.pop(), hd.deck.pop(), hd.deck.pop()); else hd.board.push(hd.deck.pop());
  const able = heLive(g).filter(u => !hd.ps[u].allin);
  if (able.length < 2) { hd.cur = null; g.deadline = Date.now() + 1400; hd.runout = true; pushTable(tid); return; } // 全下後自動發完公牌
  hd.cur = heNext(g, hd.btn); heDeadline(tid); pushTable(tid);
}
function heSettle(tid) {
  const t = S.tables[tid], g = rt(tid), hd = g.hd, live = heLive(g), show = live.length > 1;
  while (show && hd.board.length < 5) hd.board.push(hd.deck.pop());
  const ev = {}; if (show) for (const u of live) ev[u] = heBest([...hd.ps[u].hole, ...hd.board]);
  const won = {}; hd.ord.forEach(u => won[u] = 0);
  const levels = [...new Set(hd.ord.map(u => hd.ps[u].tot).filter(x => x > 0))].sort((a, b) => a - b); let prev = 0; const pots = [];
  for (const L of levels) {
    const amt = hd.ord.reduce((a, u) => a + Math.max(0, Math.min(hd.ps[u].tot, L) - prev), 0);
    let el = live.filter(u => hd.ps[u].tot >= L); if (!el.length) el = live;
    let w = el; if (show) { let best = null; for (const u of el) { const c = best ? heCmp(ev[u], ev[best[0]]) : 1; if (c > 0) best = [u]; else if (c === 0) best.push(u); } w = best; }
    const each = Math.floor(amt / w.length); let rem = amt - each * w.length;
    for (const u of hd.ord) if (w.includes(u)) { won[u] += each + (rem > 0 ? 1 : 0); if (rem > 0) rem--; }
    pots.push({ amt, win: w }); prev = L;
  }
  for (const u of hd.ord) { const s = g.seats.find(x => x.uid === u); if (s) s.stack += won[u]; }
  g.results = hd.ord.map(u => { const p = hd.ps[u], e = ev[u]; return { uid: u, name: S.users[u]?.name || '玩家', fold: p.fold, cards: show && !p.fold ? p.hole : null, hand: e ? e.name : (p.fold ? '棄牌' : ''), cat: e ? e.cat : -1, best: e ? e.cards : null, won: won[u], delta: won[u] - p.tot }; });
  g.pots = pots.filter(p => p.amt > 0).map(p => ({ amt: p.amt, win: p.win }));
  S.history.unshift({ round: g.round, table: t.name, at: Date.now(), bankerName: '德州撲克', res: g.results.map(r => ({ uid: r.uid, hand: r.hand || '—', delta: r.delta })) });
  S.history = S.history.slice(0, 300);
  hd.cur = null; g.phase = 'hdone'; g.deadline = Date.now() + (show ? HE_SHOW_MS : HE_FOLD_MS);
  heBackup(tid); pushTable(tid); for (const u of hd.ord) pushMe(u); pushAdmin();
}
function heTick(tid, now) {
  const g = rt(tid);
  if (g.phase === 'hplay' && g.hd) {
    if (g.hd.runout) { if (now > g.deadline) { g.hd.runout = false; heStreetEnd(tid); } return; }
    if (g.hd.cur && now > g.deadline) { const p = g.hd.ps[g.hd.cur]; heAct(tid, g.hd.cur, p.bet >= g.hd.curBet ? 'check' : 'fold'); }
    else if (g.hd.cur && !online(g.hd.cur) && g.deadline - now > HE_OFF_MS) { g.deadline = now + HE_OFF_MS; pushTable(tid); }
    return;
  }
  // 等待中／一手結束：離線超過 60 秒自動離座
  let changed = false;
  for (const s of [...g.seats]) { if (online(s.uid)) { if (s.offSince) { delete s.offSince; changed = true; } } else if (!s.offSince) { s.offSince = now; changed = true; } else if (now - s.offSince > HE_OFFLINE_KICK) { heStand(tid, s.uid, '德州撲克離線自動離座，桌上籌碼退回'); changed = true; } }
  if (g.phase === 'hdone' && now > g.deadline) return heStart(tid);
  if (g.phase === 'idle' && g.seats.filter(s => s.stack > 0 && online(s.uid)).length >= 2) { if (!g.wait) g.wait = now + HE_NEXT_MS; else if (now > g.wait) { g.wait = 0; return heStart(tid); } }
  else if (g.phase === 'idle') g.wait = 0;
  if (changed) pushTable(tid);
}
function hePub(tid, g) {
  const hd = g.hd, [SB, BB] = heBlinds(tid), [mn, mx] = heBuy(tid);
  return { blinds: [SB, BB], buyMin: mn, buyMax: mx, board: hd ? hd.board : [], pot: hd ? hd.ord.reduce((a, u) => a + hd.ps[u].tot, 0) : 0, curBet: hd ? hd.curBet : 0, minRaise: hd ? hd.minRaise : BB,
    cur: hd ? hd.cur : null, btn: hd ? hd.btn : g.btn || null, sb: hd ? hd.sb : null, bb: hd ? hd.bb : null, street: hd ? hd.street : 0, pots: g.phase === 'hdone' ? g.pots : null,
    hs: hd ? Object.fromEntries(hd.ord.map(u => { const p = hd.ps[u]; return [u, { bet: p.bet, tot: p.tot, fold: p.fold, allin: p.allin, last: p.last || null }]; })) : {} };
}

setInterval(() => {
  const now = Date.now();
  for (const tid in G) {
    const g = G[tid]; if (!S.tables[tid]) { delete G[tid]; continue; }
    if (gameOf(tid) === 'holdem') { heTick(tid, now); continue; }
    if (g.phase === 'grab' && (g.seats.every(s => s.grab != null) || now > g.deadline)) resolveBanker(tid);
    else if (g.phase === 'bet' && (g.seats.every(s => s.uid === g.banker || s.bet != null) || now > g.deadline)) showdown(tid);
    else if (g.phase === 'tbet' && (g.seats.every(s => s.uid === g.banker || s.bet != null) || now > g.deadline)) ttDeal(tid);
    else if (g.phase === 'peek' && (g.seats.every(s => s.open) || now > g.deadline)) ttSettle(tid);
    else if (g.phase === 'done' && now > g.deadline) {
      if ((g.seriesNo || 0) < (g.seriesLen || seriesOf(tid))) {
        const gone = g.seats.filter(s => !s.leave && !online(s.uid));
        gone.forEach(s => { s.leave = true; });
        gone.forEach(s => penalize(tid, s.uid, '中途斷線罰金'));
      }
      g.seats = g.seats.filter(s => !s.leave && online(s.uid));
      if ((g.seriesNo || 0) < (g.seriesLen || seriesOf(tid)) && g.seats.length >= 2) { g.seriesNo++; startRound(tid); }
      else endSeries(tid);
    } else if (g.phase === 'idle') {
      // 斷線超過 15 秒的玩家離座，房主自動由下一位遞補
      let changed = false;
      for (const s of g.seats) { if (online(s.uid)) { if (s.offSince) { delete s.offSince; changed = true; } } else if (!s.offSince) { s.offSince = now; changed = true; } }
      const before = g.seats.length;
      g.seats = g.seats.filter(s => !s.offSince || now - s.offSince < 15000);
      if (changed || g.seats.length !== before) { pushTable(tid); if (g.seats.length !== before) pushLobby(); }
    }
  }
}, 400);

// ---------------- Socket ----------------
io.use((socket, next) => {
  const uid = S.sessions[socket.handshake.auth?.token];
  if (!uid || !S.users[uid]) return next(new Error('auth'));
  socket.data.uid = uid; next();
});
io.on('connection', socket => {
  const uid = socket.data.uid, u = () => S.users[uid];
  socket.join('u:' + uid);
  if (u().admin) { socket.join('admins'); socket.emit('admin', adminInfo()); }
  socket.emit('me', meInfo(uid)); socket.emit('lobby', lobby());
  let cur = null; const toast = m => socket.emit('toast', m);
  const isAdmin = () => !!u()?.admin;

  socket.on('join', ({ tid } = {}) => {
    if (!S.tables[tid]) return;
    if (cur) socket.leave('t:' + cur);
    cur = tid; socket.join('t:' + tid); socket.emit('table', pubTable(tid));
    const g = rt(tid);
    if ((g.phase === 'grab' || g.phase === 'bet') && g.hands[uid]) socket.emit('hand', { tid, round: g.round, cards: g.hands[uid].slice(0, 4) });
    if (g.phase === 'peek' && g.hands[uid]) socket.emit('thand', { tid, round: g.round, tiles: g.hands[uid] });
    if (g.hd && g.hd.ps[uid] && (g.phase === 'hplay' || g.phase === 'hdone')) socket.emit('hhole', { tid, round: g.round, cards: g.hd.ps[uid].hole });
    pushTable(tid);
  });
  socket.on('exit', () => { if (cur) { socket.leave('t:' + cur); cur = null; } });
  socket.on('sit', ({ v } = {}) => {
    if (!cur) return; const g = rt(cur), t = S.tables[cur];
    if (g.seats.some(s => s.uid === uid)) return;
    for (const tid in G) if (G[tid].seats.some(s => s.uid === uid)) return toast('你已經坐在其他牌桌');
    if (gameOf(cur) === 'holdem') {
      const [mn, mx] = heBuy(cur); v = Math.round(Number(v)) || mn * 5;
      if (g.seats.length >= HE_MAX) return toast('這桌已經坐滿了');
      if (u().bal < mn) return toast(`至少要有 ${mn.toLocaleString()} 籌碼才能入座（20 個大盲）`);
      v = Math.max(mn, Math.min(v, mx, u().bal));
      u().bal -= v; S.ledger.unshift({ id: newId(), uid, delta: -v, reason: `德州撲克買入（${t.name}）`, by: uid, at: Date.now() }); S.ledger = S.ledger.slice(0, 500);
      g.seats.push({ uid, stack: v }); heBackup(cur); pushMe(uid); pushAdmin(); pushTable(cur); pushLobby(); return;
    }
    if (g.phase !== 'idle') return toast('這一輪牌局進行中，結束後再入座');
    if (g.seats.length >= maxSeatsOf(cur)) return toast('這桌已經坐滿了');
    if (u().bal < t.base) return toast('籌碼不足，請先申請籌碼');
    g.seats.push({ uid, grab: null, bet: null, ready: false }); pushTable(cur); pushLobby();
  });
  socket.on('stand', () => {
    if (!cur) return; const g = rt(cur), s = g.seats.find(x => x.uid === uid); if (!s || s.leave) return;
    if (gameOf(cur) === 'holdem') { heStand(cur, uid); pushTable(cur); pushLobby(); return; }
    if (seriesActive(cur, g)) { s.leave = true; penalize(cur, uid, '中途離座罰金'); }
    if (g.phase === 'idle' || g.phase === 'done') g.seats = g.seats.filter(x => x.uid !== uid); else s.leave = true;
    pushTable(cur); pushLobby();
  });
  socket.on('ready', () => {
    if (!cur) return; const g = rt(cur), s = g.seats.find(x => x.uid === uid);
    if (!s || g.phase !== 'idle' || ownerOf(g) === uid) return;
    s.ready = !s.ready; pushTable(cur);
  });
  socket.on('start', () => {
    if (!cur) return; const g = rt(cur);
    if (g.phase !== 'idle') return;
    if (ownerOf(g) !== uid) return toast('只有房主可以開始遊戲');
    if (g.seats.length < 2) return toast('至少需要 2 位玩家入座');
    const notReady = g.seats.filter(s => s.uid !== uid && !s.ready);
    if (notReady.length) return toast('還有 ' + notReady.length + ' 位玩家尚未準備');
    g.seriesNo = 1; g.seriesLen = seriesOf(cur); g.lastBanker = null; g.lastBankerIdx = null; g.wall = null; startRound(cur);
  });
  socket.on('setGrab', ({ sec } = {}) => {
    if (!cur) return; const g = rt(cur); sec = Math.round(Number(sec));
    if (ownerOf(g) !== uid) return toast('只有房主可以調整設定');
    if (!(sec >= 5 && sec <= 10)) return;
    if (isPlaying(g)) return toast('牌局進行中，結束後再調整');
    S.tables[cur].grabSec = sec; save(); pushTable(cur); toast((gameOf(cur) === 'tuitong' ? '下注' : '搶莊') + '時間已改為 ' + sec + ' 秒');
  });
  socket.on('setSeries', ({ n } = {}) => {
    if (!cur) return; const g = rt(cur); n = Math.round(Number(n));
    if (ownerOf(g) !== uid) return toast('只有房主可以調整設定');
    if (!seriesOptsOf(cur).includes(n)) return;
    if (g.seriesNo) return toast('這一輪進行中，打完再調整');
    S.tables[cur].series = n; save(); pushTable(cur); toast('每輪局數已改為 ' + n + (gameOf(cur) === 'tuitong' ? ' 把' : ' 局'));
  });
  socket.on('hact', ({ a, v } = {}) => {
    if (!cur || gameOf(cur) !== 'holdem') return;
    const err = heAct(cur, uid, String(a), v); if (err) toast(err);
  });
  socket.on('hbuy', ({ v } = {}) => {
    if (!cur || gameOf(cur) !== 'holdem') return; const g = rt(cur), s = g.seats.find(x => x.uid === uid); if (!s) return;
    if (g.phase === 'hplay' && g.hd && g.hd.ps[uid] && !g.hd.ps[uid].fold) return toast('這一手打完再補充籌碼');
    const [, mx] = heBuy(cur); v = Math.round(Number(v)); const room = mx - s.stack;
    if (!(v > 0)) return; v = Math.min(v, room, u().bal); if (v <= 0) return toast(room <= 0 ? `桌上籌碼最多 ${mx.toLocaleString()}` : '餘額不足');
    u().bal -= v; s.stack += v; S.ledger.unshift({ id: newId(), uid, delta: -v, reason: `德州撲克補充籌碼（${S.tables[cur].name}）`, by: uid, at: Date.now() }); S.ledger = S.ledger.slice(0, 500);
    heBackup(cur); pushMe(uid); pushAdmin(); pushTable(cur); toast(`補充了 ${v.toLocaleString()} 籌碼`);
  });
  socket.on('open', () => {
    if (!cur) return; const g = rt(cur), s = g.seats.find(x => x.uid === uid);
    if (g.phase !== 'peek' || !s || s.open) return;
    s.open = true; pushTable(cur);
  });
  socket.on('tbet', ({ v } = {}) => {
    if (!cur) return; const g = rt(cur), t = S.tables[cur], s = g.seats.find(x => x.uid === uid);
    if (g.phase !== 'tbet' || !s || uid === g.banker || s.bet != null) return;
    v = Math.round(Number(v)); const hi = Math.min(t.base * maxXOf(cur), u().bal), lo = Math.min(t.base, u().bal);
    if (!(v >= lo && v <= hi)) return toast(`下注金額需在 ${lo.toLocaleString()} 到 ${hi.toLocaleString()} 之間`);
    s.bet = v; pushTable(cur);
  });
  socket.on('grab', ({ v } = {}) => {
    if (!cur) return; const g = rt(cur), s = g.seats.find(x => x.uid === uid); v = Number(v);
    if (g.phase !== 'grab' || !s || s.grab != null || ![0, 1, 2, 3, 4].includes(v)) return;
    s.grab = v; pushTable(cur);
  });
  socket.on('bet', ({ v } = {}) => {
    if (!cur) return; const g = rt(cur), s = g.seats.find(x => x.uid === uid); v = Number(v);
    if (g.phase !== 'bet' || !s || uid === g.banker || s.bet != null || ![1, 2, 3, 5].includes(v)) return;
    s.bet = v; pushTable(cur);
  });
  socket.on('request', ({ amount, note } = {}) => {
    amount = Math.round(Number(amount));
    if (!(amount >= 10 && amount <= 100000)) return toast('請輸入 10 到 100,000 之間的數量');
    if (Object.values(S.requests).some(r => r.uid === uid && r.status === 'pending')) return toast('你已經有一筆申請在審核中');
    const id = newId(); S.requests[id] = { id, uid, amount, note: String(note || '').slice(0, 80), status: 'pending', at: Date.now() };
    save(); pushMe(uid); pushAdmin(); toast('已送出，等待管理員審核');
  });
  // ---- 管理員 ----
  socket.on('approve', ({ rid } = {}) => {
    if (!isAdmin()) return; const r = S.requests[rid]; if (!r || r.status !== 'pending') return;
    r.status = 'approved'; r.handledAt = Date.now(); grant(r.uid, r.amount, '申請核准', uid); toast('已核准');
  });
  socket.on('reject', ({ rid } = {}) => {
    if (!isAdmin()) return; const r = S.requests[rid]; if (!r || r.status !== 'pending') return;
    r.status = 'rejected'; r.handledAt = Date.now(); save(); pushMe(r.uid); pushAdmin(); toast('已拒絕');
  });
  socket.on('adjust', ({ target, delta } = {}) => {
    if (!isAdmin()) return; delta = Math.round(Number(delta)); if (!delta || !S.users[target] || Math.abs(delta) > 10000000) return;
    grant(target, delta, delta > 0 ? '管理員加發' : '管理員扣回', uid); toast('已調整');
  });
  socket.on('setAdmin', ({ target, on } = {}) => {
    if (!isAdmin() || !S.users[target] || target === uid) return;
    S.users[target].admin = !!on; save(); pushMe(target); pushAdmin();
    for (const [, s] of io.of('/').sockets) if (s.data.uid === target) { if (on) { s.join('admins'); s.emit('admin', adminInfo()); } else s.leave('admins'); }
  });
  socket.on('resetPass', async ({ target, pass } = {}) => {
    if (!isAdmin() || !S.users[target]) return; pass = String(pass || '');
    if (pass.length < 4) return toast('新密碼至少 4 個字元');
    S.users[target].hash = await bcrypt.hash(pass, 10);
    for (const k in S.sessions) if (S.sessions[k] === target) delete S.sessions[k];
    save(); toast('已重設密碼');
  });
  socket.on('createTable', ({ name, base, game } = {}) => {
    if (!isAdmin()) return; name = String(name || '').trim().slice(0, 16) || '新牌桌'; base = Math.round(Number(base));
    if (![10, 50, 100, 500, 1000].includes(base)) base = 10;
    game = game === 'tuitong' || game === 'holdem' ? game : 'niuniu';
    const id = newId(); S.tables[id] = { id, name, base, game }; save(); pushLobby(); toast('已建立牌桌');
  });
  socket.on('editTable', ({ tid, base } = {}) => {
    if (!isAdmin() || !S.tables[tid]) return; const g = rt(tid);
    if (isPlaying(g)) return toast('牌局進行中，結束後再改');
    base = Math.round(Number(base)); if (![10, 50, 100, 500, 1000].includes(base)) return;
    S.tables[tid].base = base; save(); pushTable(tid); pushLobby();
  });
  socket.on('deleteTable', ({ tid } = {}) => {
    if (!isAdmin() || !S.tables[tid]) return; const g = rt(tid);
    if (isPlaying(g)) return toast('牌局進行中，結束後再刪');
    delete S.tables[tid]; delete G[tid]; io.to('t:' + tid).emit('kicked'); save(); pushLobby(); toast('已刪除牌桌');
  });
  socket.on('logout', () => {
    const tok = socket.handshake.auth?.token; delete S.sessions[tok]; save(); socket.disconnect(true);
  });
  socket.on('disconnect', () => { setTimeout(() => { if (cur) pushTable(cur); pushAdmin(); }, 200); });
});

load().then(ensureAdmin).then(() => {
  // 舊資料只有牛牛桌時，自動補一張推筒子桌
  if (!Object.values(S.tables).some(t => t.game === 'tuitong')) { const t = { id: newId(), name: '推筒子一號桌', base: 10, game: 'tuitong' }; S.tables[t.id] = t; save(); }
  if (!Object.values(S.tables).some(t => t.game === 'holdem')) { const t = { id: newId(), name: '德州撲克一號桌', base: 10, game: 'holdem' }; S.tables[t.id] = t; save(); }
  // 德州撲克：伺服器重啟前還在桌上的籌碼，全部退回餘額
  if (S.hstk) { for (const [uid, x] of Object.entries(S.hstk)) { const u = S.users[uid]; if (u && x.amt > 0) { u.bal += x.amt; S.ledger.unshift({ id: newId(), uid, delta: x.amt, reason: '德州撲克桌上籌碼退回（伺服器重新啟動）', by: uid, at: Date.now() }); } } S.hstk = {}; save(); }
  server.listen(PORT, () => console.log('哪有小孩天天輸 伺服器啟動於 port ' + PORT));
}).catch(e => { console.error('啟動失敗', e); process.exit(1); });
process.on('SIGTERM', async () => { clearTimeout(saveTimer); await flush(); process.exit(0); });
