// Snake SOL: server-authoritative 1v1 snake with SOL stakes (DEVNET prototype).
const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  LAMPORTS_PER_SOL, clusterApiUrl, sendAndConfirmTransaction,
} = require('@solana/web3.js');

const CLUSTER = process.env.CLUSTER || 'devnet';
if (CLUSTER !== 'devnet' && process.env.ALLOW_REAL_MONEY !== 'I_HAVE_A_LICENCE') {
  console.error('Refusing to run outside devnet. Real-money wagering needs a gambling licence and a security audit.');
  process.exit(1);
}
const RPC = process.env.RPC_URL || clusterApiUrl(CLUSTER);
const PORT = Number(process.env.PORT || 3000);
const RAKE_BPS = Number(process.env.RAKE_BPS || 500); // 500 = 5% of the pot
const STAKES = [0.01, 0.05, 0.1]; // SOL
const DEMO_STAKES = [0.1, 0.2, 0.5, 1]; // fake dollars, free play
const BOT_WAIT_MS = 5000; // how long a free-play player waits for a human before a practice bot joins
const GRID = 30, TICK_MS = 110, MAX_TICKS = 900, COUNTDOWN_MS = 3000;
const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

const KEYFILE = path.join(__dirname, 'escrow-keypair.json');
const LEDGER = process.env.LEDGER_PATH || path.join(__dirname, 'ledger.jsonl');
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || '').split(',').map((x) => x.trim()).filter(Boolean);
const conn = new Connection(RPC, 'confirmed');

let escrow;
if (process.env.ESCROW_SECRET_KEY) {
  // Hosted deployments: set this env var (JSON array of 64 numbers) because the disk is wiped on redeploy.
  escrow = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.ESCROW_SECRET_KEY)));
} else if (fs.existsSync(KEYFILE)) {
  escrow = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(KEYFILE, 'utf8'))));
} else {
  escrow = Keypair.generate();
  fs.writeFileSync(KEYFILE, JSON.stringify(Array.from(escrow.secretKey)), { mode: 0o600 });
}
const ESCROW = escrow.publicKey.toBase58();

// Ledger: append-only log. Also used to block deposit replays after restart.
const usedSigs = new Set();
const board = new Map(); // wallet -> { wins, won (lamports) }
let paidOut = 0;
function addWin(w, lamports) {
  const r = board.get(w) || { wins: 0, won: 0 };
  r.wins++; r.won += lamports; board.set(w, r); paidOut += lamports;
}
let feesEarned = 0, matchesPlayed = 0;
if (fs.existsSync(LEDGER)) {
  for (const line of fs.readFileSync(LEDGER, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if (e.type === 'deposit') usedSigs.add(e.sig);
      if (e.type === 'match') { feesEarned += e.fee; matchesPlayed++; addWin(e.winner, e.pot - e.fee); }
    } catch {}
  }
}
const log = (e) => fs.appendFileSync(LEDGER, JSON.stringify({ t: Date.now(), ...e }) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pay(to, lamports, reason) {
  for (let i = 0; i < 3; i++) {
    try {
      const tx = new Transaction().add(SystemProgram.transfer({
        fromPubkey: escrow.publicKey, toPubkey: new PublicKey(to), lamports,
      }));
      const sig = await sendAndConfirmTransaction(conn, tx, [escrow]);
      log({ type: reason, to, lamports, sig });
      return sig;
    } catch (e) {
      log({ type: 'pay_failed', to, lamports, reason, err: String(e.message || e) });
      await sleep(1500);
    }
  }
  throw new Error('payment failed, check ledger.jsonl');
}

// Check the player's deposit really landed on-chain: wallet -> escrow, exact stake.
async function verifyDeposit(sig, wallet, lamports) {
  if (usedSigs.has(sig)) return false;
  for (let i = 0; i < 6; i++) {
    const tx = await conn.getParsedTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }).catch(() => null);
    if (tx) {
      if (tx.meta && tx.meta.err) return false;
      return tx.transaction.message.instructions.some((ix) =>
        ix.program === 'system' && ix.parsed && ix.parsed.type === 'transfer' &&
        ix.parsed.info.source === wallet && ix.parsed.info.destination === ESCROW &&
        ix.parsed.info.lamports === lamports);
    }
    await sleep(1500);
  }
  return false;
}

// ---------- Game ----------
class Game {
  constructor(p0, p1) {
    this.p = [p0, p1]; this.tick = 0; this.over = false; this.timer = null;
    this.s = [
      { body: [[5, 15], [4, 15], [3, 15]], dir: [1, 0], next: [1, 0] },
      { body: [[24, 15], [25, 15], [26, 15]], dir: [-1, 0], next: [-1, 0] },
    ];
    this.food = [];
    while (this.food.length < 3) this.spawn();
  }
  spawn() {
    const occ = new Set([...this.s.flatMap((x) => x.body), ...this.food].map(String));
    for (;;) {
      const c = [Math.floor(Math.random() * GRID), Math.floor(Math.random() * GRID)];
      if (!occ.has(String(c))) { this.food.push(c); return; }
    }
  }
  // returns null while running, or { winner: 0 | 1 | -1 (draw) }
  step() {
    this.tick++;
    const nb = [];
    this.s.forEach((sn) => {
      if (sn.next[0] !== -sn.dir[0] || sn.next[1] !== -sn.dir[1]) sn.dir = sn.next;
      const h = [sn.body[0][0] + sn.dir[0], sn.body[0][1] + sn.dir[1]];
      const fi = this.food.findIndex((f) => f[0] === h[0] && f[1] === h[1]);
      const body = [h, ...sn.body];
      if (fi >= 0) this.food.splice(fi, 1); else body.pop();
      nb.push(body);
    });
    const dead = nb.map((body, i) => {
      const [x, y] = body[0];
      return x < 0 || y < 0 || x >= GRID || y >= GRID ||
        body.slice(1).some((c) => c[0] === x && c[1] === y) ||
        nb[1 - i].some((c) => c[0] === x && c[1] === y);
    });
    this.s.forEach((sn, i) => { sn.body = nb[i]; });
    while (this.food.length < 3) this.spawn();
    if (dead[0] && dead[1]) return { winner: -1 };
    if (dead[0]) return { winner: 1 };
    if (dead[1]) return { winner: 0 };
    if (this.tick >= MAX_TICKS) {
      const a = this.s[0].body.length, b = this.s[1].body.length;
      return { winner: a > b ? 0 : b > a ? 1 : -1 };
    }
    return null;
  }
}

const send = (ws, m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };
const snapshot = (g) => ({ type: 'state', s: g.s.map((x) => x.body), food: g.food, tick: g.tick, max: MAX_TICKS });

function startGame(a, b) {
  const g = new Game(a, b);
  [a, b].forEach((p, i) => { p.game = g; p.idx = i; p.state = 'playing'; clearTimeout(p.botTimer); send(p.ws, { type: 'start', you: i, grid: GRID, countdown: COUNTDOWN_MS, demo: !!p.demo, bot: !!(a.bot || b.bot) }); send(p.ws, snapshot(g)); });
  setTimeout(() => {
    if (g.over) return;
    g.timer = setInterval(() => {
      if (g.p[1].bot) botDir(g);
      const r = g.step();
      g.p.forEach((p) => send(p.ws, snapshot(g)));
      if (r) finish(g, r.winner, 'normal');
    }, TICK_MS);
  }, COUNTDOWN_MS);
}

async function finish(g, winner, why) {
  if (g.over) return;
  g.over = true; clearInterval(g.timer);
  const [a, b] = g.p;
  if (a.demo || b.demo) { // free play: fake dollars, nothing on-chain, not on the leaderboard
    const win = Math.round(a.lamports * 2 * (1 - RAKE_BPS / 10000) * 100) / 100;
    g.p.forEach((p, i) => send(p.ws, { type: 'end', demo: true, why, result: winner < 0 ? 'draw' : winner === i ? 'win' : 'lose', payout: winner < 0 ? p.lamports : winner === i ? win : 0 }));
    g.p.forEach((p) => { p.game = null; p.state = 'idle'; });
    return;
  }
  const pot = a.lamports * 2, fee = Math.floor((pot * RAKE_BPS) / 10000);
  try {
    if (winner < 0) {
      await Promise.all([pay(a.wallet, a.lamports, 'refund_draw'), pay(b.wallet, b.lamports, 'refund_draw')]);
      [a, b].forEach((p) => send(p.ws, { type: 'end', result: 'draw', payout: p.lamports / LAMPORTS_PER_SOL, why }));
    } else {
      const w = g.p[winner], l = g.p[1 - winner];
      const sig = await pay(w.wallet, pot - fee, 'payout');
      feesEarned += fee; matchesPlayed++; addWin(w.wallet, pot - fee);
      log({ type: 'match', winner: w.wallet, loser: l.wallet, pot, fee, why, sig });
      send(w.ws, { type: 'end', result: 'win', payout: (pot - fee) / LAMPORTS_PER_SOL, sig, why });
      send(l.ws, { type: 'end', result: 'lose', payout: 0, why });
    }
  } catch (e) {
    [a, b].forEach((p) => send(p.ws, { type: 'error', msg: 'Payout failed. Your stake is safe in escrow; contact the operator.' }));
  }
  [a, b].forEach((p) => { p.game = null; p.state = 'idle'; });
}

// ---------- Practice bot (free play) ----------
const makeBot = (p) => ({ ws: null, bot: true, demo: true, wallet: 'bot', lamports: p.lamports, state: 'idle', game: null });
function botDir(g) {
  const me = g.s[1], head = me.body[0];
  const occ = new Set([...g.s[0].body, ...me.body.slice(0, -1)].map(String));
  const opts = Object.values(DIRS).filter((d) => !(d[0] === -me.dir[0] && d[1] === -me.dir[1]));
  const safe = opts.filter((d) => {
    const x = head[0] + d[0], y = head[1] + d[1];
    return x >= 0 && y >= 0 && x < GRID && y < GRID && !occ.has(x + ',' + y);
  });
  const pool = safe.length ? safe : opts;
  if (Math.random() < 0.12) { me.next = pool[Math.floor(Math.random() * pool.length)]; return; }
  const dist = (c) => Math.abs(c[0] - head[0]) + Math.abs(c[1] - head[1]);
  const food = [...g.food].sort((x, y) => dist(x) - dist(y))[0] || [15, 15];
  pool.sort((d1, d2) => (Math.abs(food[0] - (head[0] + d1[0])) + Math.abs(food[1] - (head[1] + d1[1]))) - (Math.abs(food[0] - (head[0] + d2[0])) + Math.abs(food[1] - (head[1] + d2[1]))));
  me.next = pool[0];
}

// ---------- Matchmaking ----------
const qkey = (p) => (p.demo ? 'demo:' + p.lamports : p.lamports);
const queues = new Map(); // lamports -> waiting players
function enqueue(p) {
  const q = queues.get(qkey(p)) || [];
  queues.set(qkey(p), q);
  const i = q.findIndex((o) => o.wallet !== p.wallet && o.ws.readyState === 1);
  if (i >= 0) { const [o] = q.splice(i, 1); startGame(o, p); }
  else {
    q.push(p); p.state = 'queued';
    if (p.demo) p.botTimer = setTimeout(() => { if (p.state === 'queued') { dequeue(p); startGame(p, makeBot(p)); } }, BOT_WAIT_MS);
    send(p.ws, { type: 'queued' });
  }
}
function dequeue(p) {
  const q = queues.get(qkey(p)) || [];
  const i = q.indexOf(p);
  if (i >= 0) q.splice(i, 1);
}
const refund = (p) => pay(p.wallet, p.lamports, 'refund_leave').catch(() => {});

// ---------- Server ----------
const app = express();
app.use(express.static(path.join(__dirname, '..'))); // local dev only; in production the root folder is served as a static site
app.use('/api', (req, res, next) => { res.set('Access-Control-Allow-Origin', ALLOWED_ORIGINS[0] || '*'); next(); });
app.get('/api/leaderboard', (req, res) => {
  const top = [...board.entries()].sort((a, b) => b[1].won - a[1].won).slice(0, 8)
    .map(([wallet, r]) => ({ wallet, wins: r.wins, wonSol: r.won / LAMPORTS_PER_SOL }));
  res.json({ top, totalPaidSol: paidOut / LAMPORTS_PER_SOL, matches: matchesPlayed });
});
app.get('/api/stats', (req, res) => res.json({ cluster: CLUSTER, escrow: ESCROW, rakePercent: RAKE_BPS / 100, matchesPlayed, feesEarnedSol: feesEarned / LAMPORTS_PER_SOL }));
const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  verifyClient: (info) => !ALLOWED_ORIGINS.length || ALLOWED_ORIGINS.includes(info.origin),
});

const broadcastOnline = () => wss.clients.forEach((c) => send(c, { type: 'online', n: wss.clients.size }));

wss.on('connection', (ws) => {
  const me = { ws, wallet: null, lamports: 0, state: 'idle', game: null, idx: -1 };
  send(ws, { type: 'config', escrow: ESCROW, cluster: CLUSTER, rpc: RPC, rakeBps: RAKE_BPS, stakes: STAKES, demoStakes: DEMO_STAKES });
  broadcastOnline();

  ws.on('message', async (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'join' && me.state === 'idle') {
      me.state = 'verifying'; me.demo = false;
      try {
        const stake = Number(m.stake);
        if (!STAKES.includes(stake) || typeof m.sig !== 'string') throw new Error('Invalid stake.');
        new PublicKey(m.wallet);
        const lamports = Math.round(stake * LAMPORTS_PER_SOL);
        if (!(await verifyDeposit(m.sig, m.wallet, lamports))) throw new Error('Could not verify your deposit.');
        usedSigs.add(m.sig);
        log({ type: 'deposit', wallet: m.wallet, lamports, sig: m.sig });
        Object.assign(me, { wallet: m.wallet, lamports });
        if (ws.readyState !== 1) { await refund(me); return; }
        enqueue(me);
      } catch (e) { me.state = 'idle'; send(ws, { type: 'error', msg: e.message }); }
    } else if (m.type === 'join_demo' && me.state === 'idle') {
      const stake = Number(m.stake);
      if (!DEMO_STAKES.includes(stake)) return send(ws, { type: 'error', msg: 'Invalid free play stake.' });
      Object.assign(me, { demo: true, wallet: 'demo-' + Math.random().toString(36).slice(2), lamports: stake });
      enqueue(me);
    } else if (m.type === 'leave' && me.state === 'queued') {
      dequeue(me); clearTimeout(me.botTimer); me.state = 'idle'; if (!me.demo) await refund(me); send(ws, { type: 'left' });
    } else if (m.type === 'dir' && me.game && !me.game.over && DIRS[m.dir]) {
      me.game.s[me.idx].next = DIRS[m.dir];
    }
  });

  ws.on('close', () => {
    broadcastOnline();
    if (me.state === 'queued') { dequeue(me); clearTimeout(me.botTimer); if (!me.demo) refund(me); }
    else if (me.game && !me.game.over) finish(me.game, 1 - me.idx, 'forfeit');
  });
});

server.listen(PORT, () => {
  console.log(`Snake SOL on http://localhost:${PORT}  (${CLUSTER}, rake ${RAKE_BPS / 100}%)`);
  console.log(`Escrow address: ${ESCROW}`);
  if (CLUSTER === 'devnet') console.log('Fund it with devnet SOL at https://faucet.solana.com');
});
