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
    await pool.query('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v JSONB NOT NULL)');
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
app.use(express.json({ limit: '10kb' }));
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
const gameOf = tid => S.tables[tid]?.game === 'tuitong' ? 'tuitong' : 'niuniu';
const SERIES_OPTS = { niuniu: [3, 5, 10], tuitong: [4, 8] }; // 房主可選的每輪局數
const seriesOptsOf = tid => SERIES_OPTS[gameOf(tid)];
const seriesOf = tid => { const o = seriesOptsOf(tid), v = Number(S.tables[tid]?.series); return o.includes(v) ? v : (gameOf(tid) === 'tuitong' ? 4 : 5); };
const maxSeatsOf = tid => gameOf(tid) === 'tuitong' ? 4 : 6;
const maxXOf = () => 10; // 推筒子下注範圍：底注 ～ 底注 × 10（例：底注 10 → 10～100）
const isPlaying = g => ['grab', 'bet', 'tbet', 'peek'].includes(g.phase);
const PEEK_MS = 10000, DEAL_MS = 2600; // 推筒子：發牌動畫時間 + 掀牌時間
const grabSecOf = tid => { const v = Number(S.tables[tid]?.grabSec); return v >= 5 && v <= 10 ? v : 8; };
function pubTable(tid) {
  const t = S.tables[tid], g = rt(tid);
  return {
    id: tid, name: t.name, base: t.base, phase: g.phase, round: g.round, banker: g.banker, grabMult: g.grabMult,
    game: gameOf(tid), maxSeats: maxSeatsOf(tid), seriesOpts: seriesOptsOf(tid), maxX: maxXOf(tid), maxBet: t.base * maxXOf(tid),
    wall: g.wall ? g.wall.length : null, shoeHand: g.shoeHand || 0, dice: g.dice || null, startUid: g.startUid || null,
    deadline: g.deadline, now: Date.now(), results: g.results, owner: ownerOf(g), seriesNo: g.seriesNo || 0, seriesTotal: g.seriesNo ? (g.seriesLen || seriesOf(tid)) : seriesOf(tid), grabSec: grabSecOf(tid),
    seats: g.seats.map(s => ({ uid: s.uid, name: S.users[s.uid]?.name || '玩家', bal: S.users[s.uid]?.bal || 0, grab: s.grab, bet: s.bet, ready: !!s.ready, leave: !!s.leave, open: !!s.open, online: online(s.uid) })),
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

setInterval(() => {
  const now = Date.now();
  for (const tid in G) {
    const g = G[tid]; if (!S.tables[tid]) { delete G[tid]; continue; }
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
    pushTable(tid);
  });
  socket.on('exit', () => { if (cur) { socket.leave('t:' + cur); cur = null; } });
  socket.on('sit', () => {
    if (!cur) return; const g = rt(cur), t = S.tables[cur];
    if (g.seats.some(s => s.uid === uid)) return;
    for (const tid in G) if (G[tid].seats.some(s => s.uid === uid)) return toast('你已經坐在其他牌桌');
    if (g.phase !== 'idle') return toast('這一輪牌局進行中，結束後再入座');
    if (g.seats.length >= maxSeatsOf(cur)) return toast('這桌已經坐滿了');
    if (u().bal < t.base) return toast('籌碼不足，請先申請籌碼');
    g.seats.push({ uid, grab: null, bet: null, ready: false }); pushTable(cur); pushLobby();
  });
  socket.on('stand', () => {
    if (!cur) return; const g = rt(cur), s = g.seats.find(x => x.uid === uid); if (!s || s.leave) return;
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
    game = game === 'tuitong' ? 'tuitong' : 'niuniu';
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
  server.listen(PORT, () => console.log('哪有小孩天天輸 伺服器啟動於 port ' + PORT));
}).catch(e => { console.error('啟動失敗', e); process.exit(1); });
process.on('SIGTERM', async () => { clearTimeout(saveTimer); await flush(); process.exit(0); });
