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
    const t = { id: newId(), name: '一號桌', base: 10 };
    S.tables[t.id] = t;
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
const grabSecOf = tid => { const v = Number(S.tables[tid]?.grabSec); return v >= 5 && v <= 10 ? v : 8; };
function pubTable(tid) {
  const t = S.tables[tid], g = rt(tid);
  return {
    id: tid, name: t.name, base: t.base, phase: g.phase, round: g.round, banker: g.banker, grabMult: g.grabMult,
    deadline: g.deadline, now: Date.now(), results: g.results, owner: ownerOf(g), grabSec: grabSecOf(tid),
    seats: g.seats.map(s => ({ uid: s.uid, name: S.users[s.uid]?.name || '玩家', bal: S.users[s.uid]?.bal || 0, grab: s.grab, bet: s.bet, ready: !!s.ready, leave: !!s.leave, online: online(s.uid) })),
  };
}
const pushTable = tid => S.tables[tid] && io.to('t:' + tid).emit('table', pubTable(tid));
function lobby() {
  return Object.values(S.tables).map(t => ({ id: t.id, name: t.name, base: t.base, players: rt(t.id).seats.length, phase: rt(t.id).phase }));
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

// ---------------- 遊戲流程 ----------------
function startRound(tid) {
  const t = S.tables[tid], g = rt(tid);
  g.seats = g.seats.filter(s => !s.leave && online(s.uid) && (S.users[s.uid]?.bal || 0) >= t.base);
  if (g.seats.length < 2) { g.phase = 'idle'; g.deadline = null; pushTable(tid); pushLobby(); return; }
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
setInterval(() => {
  const now = Date.now();
  for (const tid in G) {
    const g = G[tid]; if (!S.tables[tid]) { delete G[tid]; continue; }
    if (g.phase === 'grab' && (g.seats.every(s => s.grab != null) || now > g.deadline)) resolveBanker(tid);
    else if (g.phase === 'bet' && (g.seats.every(s => s.uid === g.banker || s.bet != null) || now > g.deadline)) showdown(tid);
    else if (g.phase === 'done' && now > g.deadline) {
      g.seats = g.seats.filter(s => !s.leave && online(s.uid)); g.seats.forEach(s => { s.ready = false; });
      g.phase = 'idle'; g.deadline = null; g.results = null; g.banker = null;
      pushTable(tid); pushLobby();
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
    pushTable(tid);
  });
  socket.on('exit', () => { if (cur) { socket.leave('t:' + cur); cur = null; } });
  socket.on('sit', () => {
    if (!cur) return; const g = rt(cur), t = S.tables[cur];
    if (g.seats.some(s => s.uid === uid)) return;
    for (const tid in G) if (G[tid].seats.some(s => s.uid === uid)) return toast('你已經坐在其他牌桌');
    if (g.phase !== 'idle' && g.phase !== 'done') return toast('本局進行中，下一局再入座');
    if (g.seats.length >= 6) return toast('這桌已經坐滿了');
    if (u().bal < t.base) return toast('籌碼不足，請先申請籌碼');
    g.seats.push({ uid, grab: null, bet: null, ready: false }); pushTable(cur); pushLobby();
  });
  socket.on('stand', () => {
    if (!cur) return; const g = rt(cur), s = g.seats.find(x => x.uid === uid); if (!s) return;
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
    startRound(cur);
  });
  socket.on('setGrab', ({ sec } = {}) => {
    if (!cur) return; const g = rt(cur); sec = Math.round(Number(sec));
    if (ownerOf(g) !== uid) return toast('只有房主可以調整設定');
    if (!(sec >= 5 && sec <= 10)) return;
    if (g.phase === 'grab' || g.phase === 'bet') return toast('牌局進行中，結束後再調整');
    S.tables[cur].grabSec = sec; save(); pushTable(cur); toast('搶莊時間已改為 ' + sec + ' 秒');
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
  socket.on('createTable', ({ name, base } = {}) => {
    if (!isAdmin()) return; name = String(name || '').trim().slice(0, 16) || '新牌桌'; base = Math.round(Number(base));
    if (![10, 50, 100, 500, 1000].includes(base)) base = 10;
    const id = newId(); S.tables[id] = { id, name, base }; save(); pushLobby(); toast('已建立牌桌');
  });
  socket.on('editTable', ({ tid, base } = {}) => {
    if (!isAdmin() || !S.tables[tid]) return; const g = rt(tid);
    if (g.phase === 'grab' || g.phase === 'bet') return toast('牌局進行中，結束後再改');
    base = Math.round(Number(base)); if (![10, 50, 100, 500, 1000].includes(base)) return;
    S.tables[tid].base = base; save(); pushTable(tid); pushLobby();
  });
  socket.on('deleteTable', ({ tid } = {}) => {
    if (!isAdmin() || !S.tables[tid]) return; const g = rt(tid);
    if (g.phase === 'grab' || g.phase === 'bet') return toast('牌局進行中，結束後再刪');
    delete S.tables[tid]; delete G[tid]; io.to('t:' + tid).emit('kicked'); save(); pushLobby(); toast('已刪除牌桌');
  });
  socket.on('logout', () => {
    const tok = socket.handshake.auth?.token; delete S.sessions[tok]; save(); socket.disconnect(true);
  });
  socket.on('disconnect', () => { setTimeout(() => { if (cur) pushTable(cur); pushAdmin(); }, 200); });
});

load().then(ensureAdmin).then(() => {
  server.listen(PORT, () => console.log('牛牛伺服器啟動於 port ' + PORT));
}).catch(e => { console.error('啟動失敗', e); process.exit(1); });
process.on('SIGTERM', async () => { clearTimeout(saveTimer); await flush(); process.exit(0); });
