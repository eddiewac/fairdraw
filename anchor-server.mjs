#!/usr/bin/env node
// anchor-server.mjs — the anchoring service, runnable on your own machine.
//
// Same job as the Netlify function: take a draw's fingerprint, write it onto
// Kaspa, hand back the transaction id. Run this while testing so you can watch
// the whole flow work before deploying anything.
//
//   setx KASPA_ANCHOR_KEY "your-hex-key"      (then open a new terminal)
//   node anchor-server.mjs
//
// Listens on http://127.0.0.1:8787

import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const PORT = Number(process.env.ANCHOR_PORT || 8787);
const NETWORK = process.env.KASPA_NETWORK || 'mainnet';
const PRIVATE_KEY = process.env.KASPA_ANCHOR_KEY;
const PAYLOAD_PREFIX = 'fairdraw:1:';

const require = createRequire(import.meta.url);

const SDK_PATHS = ['./kaspa/kaspa.js', './kaspa-wasm32-sdk/nodejs/kaspa/kaspa.js', './nodejs/kaspa/kaspa.js'];
let sdk = null;
for (const p of SDK_PATHS) {
  try { sdk = require(p); break; } catch (e) { if (!/Cannot find module/.test(e.message)) throw e; }
}
if (!sdk) {
  console.error('\nKaspa SDK not found. Copy kaspa-wasm32-sdk/nodejs/kaspa next to this file.\n');
  process.exit(1);
}
if (!PRIVATE_KEY) {
  console.error('\nKASPA_ANCHOR_KEY is not set.\n');
  process.exit(1);
}

const privateKey = new sdk.PrivateKey(PRIVATE_KEY);
const address = privateKey.toKeypair().toAddress(NETWORK).toString();

// Crude but effective: one anchor per caller every few seconds. Without some
// limit anyone who finds the URL can empty the float a fraction of a cent at
// a time.
const lastSeen = new Map();
const MIN_GAP_MS = 5000;

function send(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'POST, OPTIONS',
  });
  res.end(JSON.stringify(body));
}


// The page commits against the blue score from the public API. Read the same
// counter from the same place — virtualDaaScore is a DIFFERENT and much larger
// number, and mixing them makes the margin check nonsense.
async function currentBlueScore() {
  const res = await fetch('https://api.kaspa.org/info/virtual-chain-blue-score');
  if (!res.ok) throw new Error(`blue score lookup returned ${res.status}`);
  const n = Number((await res.json())?.blueScore);
  if (!Number.isFinite(n)) throw new Error('no blue score returned');
  return n;
}

// Every step here can stall — the resolver hunting for a public node, a slow
// peer, a node mid-sync. Without a deadline the page just spins.
function withTimeout(promise, ms, what) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms / 1000}s`)), ms)),
  ]);
}

// The resolver is convenient when it works and useless when it does not, so
// try it first and then fall back to nodes we know the addresses of. Your own
// node, if you run one, beats both — set KASPA_NODE_URL.
const NODE_CANDIDATES = [
  process.env.KASPA_NODE_URL,
  null,                                   // null means "use the resolver"
  'ws://seeder2.kaspad.net:17110',
  'ws://seeder1.kaspad.net:17110',
].filter((x) => x !== undefined);

async function connectSomewhere() {
  const failures = [];
  for (const url of NODE_CANDIDATES) {
    const label = url ?? 'public node directory';
    const rpc = url
      ? new sdk.RpcClient({ url, encoding: sdk.Encoding.Borsh, networkId: NETWORK })
      : new sdk.RpcClient({ resolver: new sdk.Resolver(), networkId: NETWORK });
    try {
      process.stdout.write(`  trying ${label}… `);
      await withTimeout(rpc.connect(), 12000, 'connecting');
      const info = await withTimeout(rpc.getServerInfo(), 10000, 'checking the node');
      if (!info.isSynced) throw new Error('node is still catching up');
      console.log('connected');
      return rpc;
    } catch (e) {
      console.log(`no (${e.message})`);
      failures.push(`${label}: ${e.message}`);
      try { await rpc.disconnect(); } catch { /* never opened */ }
    }
  }
  throw new Error(`no node would accept a connection. ${failures.join(' | ')}`);
}

// Finding a node and connecting is most of the wait, so do it once and keep it.
// The connection is rebuilt only if it has actually dropped.
let shared = null;

async function getConnection() {
  try {
    if (shared?.isConnected) return shared;
  } catch { /* client is in a bad state; fall through and rebuild */ }
  if (shared) { try { shared.disconnect().catch(() => {}); } catch {} shared = null; }
  shared = await connectSomewhere();
  return shared;
}

// Connect at startup so the first draw is as quick as the rest.
async function warmUp() {
  try {
    await getConnection();
    console.log('  ready — connection held open\n');
  } catch (e) {
    console.log(`  could not connect yet (${e.message}); will retry on first use\n`);
  }
}

async function anchor(fingerprint, listHash) {
  const rpc = await getConnection();
  try {
    process.stdout.write('  checking the wallet… ');
    const { entries } = await withTimeout(
      rpc.getUtxosByAddresses({ addresses: [address] }), 15000, 'reading the wallet');
    console.log(`${entries.length} output(s)`);
    if (entries.length === 0) throw new Error('the anchor wallet is empty');

    const blueScore = await withTimeout(currentBlueScore(), 15000, 'reading the blue score');
    const generator = new sdk.Generator({
      entries,
      outputs: [{ address, amount: sdk.kaspaToSompi('0.2') }],
      changeAddress: address,
      priorityFee: 0n,
      payload: new TextEncoder().encode(PAYLOAD_PREFIX + fingerprint + (listHash ? ':' + listHash : '')),
      networkId: NETWORK,
    });

    process.stdout.write('  submitting… ');
    let txid, tx;
    while ((tx = await generator.next())) {
      await tx.sign([privateKey]);
      txid = await withTimeout(tx.submit(rpc), 20000, 'submitting the transaction');
    }
    console.log('done');
    return { txid, anchoredAtBlueScore: blueScore, network: NETWORK };
  } catch (e) {
    // A failure may mean the connection went bad; drop it so the next request
    // builds a fresh one rather than retrying down a dead socket.
    shared = null;
    rpc.disconnect().catch(() => {});
    throw e;
  }
}

createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });

  const who = req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  if (now - (lastSeen.get(who) ?? 0) < MIN_GAP_MS)
    return send(res, 429, { error: 'too quick — wait a few seconds' });
  lastSeen.set(who, now);

  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 4096) return send(res, 413, { error: 'body too large' });
  }

  let fingerprint, listHash;
  try {
    const body = JSON.parse(raw);
    fingerprint = String(body.fingerprint || '').toLowerCase();
    listHash = String(body.listHash || '').toLowerCase();
  } catch { return send(res, 400, { error: 'body must be JSON' }); }

  if (!/^[0-9a-f]{64}$/.test(fingerprint))
    return send(res, 400, { error: 'fingerprint must be 64 hex characters' });
  if (listHash && !/^[0-9a-f]{64}$/.test(listHash))
    return send(res, 400, { error: 'listHash must be 64 hex characters' });

  const startedAt = Date.now();
  try {
    const result = await anchor(fingerprint, listHash);
    send(res, 200, result);
    console.log(`  anchored ${fingerprint.slice(0, 12)}…  tx ${result.txid}`);
    console.log(`  replied in ${((Date.now() - startedAt) / 1000).toFixed(1)}s\n`);
  } catch (e) {
    console.error(`  failed: ${e.message}`);
    send(res, 502, { error: `could not anchor: ${e.message}` });
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log(`  anchor service   http://127.0.0.1:${PORT}`);
  console.log(`  network          ${NETWORK}`);
  console.log(`  paying from      ${address}`);
  console.log('');
  console.log('  Leave this running while you use the draw page.');
  console.log('');
  warmUp();
});
