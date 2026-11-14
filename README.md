# Snake SOL (devnet prototype)

1v1 snake where both players stake SOL and the winner takes the pot minus a house fee.

```
index.html, config.js, vercel.json   static frontend (GitHub Pages or Vercel)
server/                              game server, WebSockets + escrow (Render/Railway/Fly, NOT Vercel)
```

## Run locally
```
cd server && npm install && node server.js
```
Open http://localhost:3000. The server prints the escrow address; fund it with devnet SOL at https://faucet.solana.com.
In Phantom: Settings > Developer Settings > Testnet Mode > Solana Devnet. Use two browsers with two wallets.

## Deploy
Vercel can't run the game server (serverless functions don't keep WebSocket connections or a game loop alive), so it's two deploys:

1. **Server** (Render, Railway or Fly.io): root directory `server`, build `npm install`, start `npm start`. Set env vars:
   - `ESCROW_SECRET_KEY`: contents of your `escrow-keypair.json` (the JSON array). Needed because hosted disks reset on redeploy.
   - `ALLOWED_ORIGIN`: your Vercel URL, e.g. `https://snake-sol.vercel.app`
   - `RAKE_BPS`: house fee, default 500 (5%)
   - `LEDGER_PATH`: path on a persistent disk/volume, so deposit history survives restarts
2. **Frontend** (Vercel or GitHub Pages): import the repo, leave Root Directory as the repo root, framework preset Other. Then edit `config.js` and set `window.SERVER_URL = 'wss://your-server-host'`, commit and push.

## Earnings
`RAKE_BPS` (default 5% of the pot) is kept on every decided match. Draws are refunded in full. Fees pile up in the escrow wallet. `GET /api/stats` on the server shows totals, and the ledger logs every deposit, payout and refund.

## Security
- Never commit `escrow-keypair.json` or put the key in the repo. `.gitignore` covers it; use host env vars instead.
- Server is authoritative: clients only send direction inputs. Deposits are verified on-chain and each signature works once.
- Custodial escrow, in-memory matches, no anti-bot or collusion checks yet.
- Refuses to run outside devnet unless `ALLOW_REAL_MONEY=I_HAVE_A_LICENCE`. Real-money play needs a gambling licence, legal advice and a security audit.
