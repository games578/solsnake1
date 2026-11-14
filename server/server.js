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
let feesEarned = 0, matchesPlayed = 0;
if (fs.existsSync(LEDGER)) {
  for (const line of fs.readFileSync(LEDGER, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if (e.type === 'deposit') usedSigs.add(e.sig);
      if (e.type === 'match') { feesEarned += e.fee; matchesPlayed++; }
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

const send = (ws, m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
const snapshot = (g) => ({ type: 'state', s: g.s.map((x) => x.body), food: g.food, tick: g.tick, max: MAX_TICKS });

function startGame(a, b) {
  const g = new Game(a, b);
  [a, b].forEach((p, i) => { p.game = g; p.idx = i; p.state = 'playing'; send(p.ws, { type: 'start', you: i, grid: GRID, countdown: COUNTDOWN_MS }); send(p.ws, snapshot(g)); });
  setTimeout(() => {
    if (g.over) return;
    g.timer = setInterval(() => {
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
  const pot = a.lamports * 2, fee = Math.floor((pot * RAKE_BPS) / 10000);
  try {
    if (winner < 0) {
      await Promise.all([pay(a.wallet, a.lamports, 'refund_draw'), pay(b.wallet, b.lamports, 'refund_draw')]);
      [a, b].forEach((p) => send(p.ws, { type: 'end', result: 'draw', payout: p.lamports / LAMPORTS_PER_SOL, why }));
    } else {
      const w = g.p[winner], l = g.p[1 - winner];
      const sig = await pay(w.wallet, pot - fee, 'payout');
      feesEarned += fee; matchesPlayed++;
      log({ type: 'match', winner: w.wallet, loser: l.wallet, pot, fee, why, sig });
      send(w.ws, { type: 'end', result: 'win', payout: (pot - fee) / LAMPORTS_PER_SOL, sig, why });
      send(l.ws, { type: 'end', result: 'lose', payout: 0, why });
    }
  } catch (e) {
    [a, b].forEach((p) => send(p.ws, { type: 'error', msg: 'Payout failed. Your stake is safe in escrow; contact the operator.' }));
  }
  [a, b].forEach((p) => { p.game = null; p.state = 'idle'; });
}

// ---------- Matchmaking ----------
const queues = new Map(); // lamports -> waiting players
function enqueue(p) {
  const q = queues.get(p.lamports) || [];
  queues.set(p.lamports, q);
  const i = q.findIndex((o) => o.wallet !== p.wallet && o.ws.readyState === 1);
  if (i >= 0) { const [o] = q.splice(i, 1); startGame(o, p); }
  else { q.push(p); p.state = 'queued'; send(p.ws, { type: 'queued' }); }
}
function dequeue(p) {
  const q = queues.get(p.lamports) || [];
  const i = q.indexOf(p);
  if (i >= 0) q.splice(i, 1);
}
const refund = (p) => pay(p.wallet, p.lamports, 'refund_leave').catch(() => {});

// ---------- Server ----------
const app = express();
app.use(express.static(path.join(__dirname, '..'))); // local dev only; in production the root folder is served as a static site
app.get('/api/stats', (req, res) => res.json({ cluster: CLUSTER, escrow: ESCROW, rakePercent: RAKE_BPS / 100, matchesPlayed, feesEarnedSol: feesEarned / LAMPORTS_PER_SOL }));
const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  verifyClient: (info) => !ALLOWED_ORIGINS.length || ALLOWED_ORIGINS.includes(info.origin),
});

wss.on('connection', (ws) => {
  const me = { ws, wallet: null, lamports: 0, state: 'idle', game: null, idx: -1 };
  send(ws, { type: 'config', escrow: ESCROW, cluster: CLUSTER, rpc: RPC, rakeBps: RAKE_BPS, stakes: STAKES });

  ws.on('message', async (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'join' && me.state === 'idle') {
      me.state = 'verifying';
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
    } else if (m.type === 'leave' && me.state === 'queued') {
      dequeue(me); me.state = 'idle'; await refund(me); send(ws, { type: 'left' });
    } else if (m.type === 'dir' && me.game && !me.game.over && DIRS[m.dir]) {
      me.game.s[me.idx].next = DIRS[m.dir];
    }
  });

  ws.on('close', () => {
    if (me.state === 'queued') { dequeue(me); refund(me); }
    else if (me.game && !me.game.over) finish(me.game, 1 - me.idx, 'forfeit');
  });
});

server.listen(PORT, () => {
  console.log(`Snake SOL on http://localhost:${PORT}  (${CLUSTER}, rake ${RAKE_BPS / 100}%)`);
  console.log(`Escrow address: ${ESCROW}`);
  if (CLUSTER === 'devnet') console.log('Fund it with devnet SOL at https://faucet.solana.com');
});
