// netlify/functions/anchor.mjs
//
// Writes a draw's fingerprint onto Kaspa so the commitment is provably earlier
// than the moment that decides the draw. The organiser needs no wallet: this
// pays, at roughly 0.002 KAS a write.
//
// SECURITY NOTE
// This endpoint spends money and has no login, because requiring one would
// defeat the point of the tool. So it is defended by limits rather than by
// secrecy:
//
//   * the wallet holds a small float and refuses to go below a floor
//   * requests are throttled per caller and in total
//   * only the configured site may call it from a browser
//
// Publishing this file is safe. The private key is never in it — it comes from
// an environment variable, and must never be committed anywhere.

import { createRequire } from 'node:module';

const PAYLOAD_PREFIX = 'fairdraw:1:';
const require = createRequire(import.meta.url);

const PRIVATE_KEY = process.env.KASPA_ANCHOR_KEY;
const NETWORK = process.env.KASPA_NETWORK || 'mainnet';
const NODE_URL = process.env.KASPA_NODE_URL || undefined;

// Below this the wallet stops anchoring, so abuse can never empty it entirely
// and there is always enough left that you notice before it matters.
const FLOOR_KAS = Number(process.env.ANCHOR_FLOOR_KAS || 2);

// Per warm instance. Not airtight — instances come and go — but it blunts the
// obvious case of someone hammering the endpoint in a loop.
const MIN_GAP_MS = 4000;
const MAX_PER_INSTANCE_PER_HOUR = 200;

const seen = new Map();
let hourStarted = Date.now();
let countThisHour = 0;

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

const json = (status, body) => ({
  statusCode: status,
  headers: {
    'content-type': 'application/json',
    'access-control-allow-origin': ALLOWED_ORIGIN,
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'POST, OPTIONS',
    'cache-control': 'no-store',
  },
  body: JSON.stringify(body),
});

// Netlify flattens the function to /var/task/anchor.mjs but keeps included
// files at their path relative to the repo root, so the SDK does not end up
// beside the function. Try every location it could plausibly be, and say which
// were tried if none work.
const SDK_PATHS = [
  './kaspa/kaspa.js',
  './netlify/functions/kaspa/kaspa.js',
  '/var/task/netlify/functions/kaspa/kaspa.js',
  '/var/task/kaspa/kaspa.js',
];

let sdkCache = null;
function loadSdk() {
  if (sdkCache) return sdkCache;
  const tried = [];
  for (const rel of SDK_PATHS) {
    try { return (sdkCache = require(rel)); }
    catch (e) {
      tried.push(`${rel} (${e.code || e.message})`);
      if (e.code !== 'MODULE_NOT_FOUND') throw e;
    }
  }
  throw new Error(`Kaspa SDK not found. Tried: ${tried.join(' | ')}`);
}

function withTimeout(promise, ms, what) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out`)), ms)),
  ]);
}

// Reused across warm invocations: finding a node is most of the latency.
let shared = null;
async function connection(sdk) {
  try { if (shared?.isConnected) return shared; } catch { /* rebuild below */ }
  shared = null;

  const candidates = [NODE_URL, null, 'ws://seeder2.kaspad.net:17110'].filter((x) => x !== undefined);
  const failures = [];
  for (const url of candidates) {
    const rpc = url
      ? new sdk.RpcClient({ url, encoding: sdk.Encoding.Borsh, networkId: NETWORK })
      : new sdk.RpcClient({ resolver: new sdk.Resolver(), networkId: NETWORK });
    try {
      await withTimeout(rpc.connect(), 12000, 'connecting');
      const info = await withTimeout(rpc.getServerInfo(), 8000, 'checking the node');
      if (!info.isSynced) throw new Error('node still catching up');
      shared = rpc;
      return rpc;
    } catch (e) {
      failures.push(`${url ?? 'directory'}: ${e.message}`);
      rpc.disconnect?.().catch(() => {});
    }
  }
  throw new Error(`no node available (${failures.join('; ')})`);
}

async function currentBlueScore() {
  const res = await fetch('https://api.kaspa.org/info/virtual-chain-blue-score');
  if (!res.ok) throw new Error(`blue score lookup returned ${res.status}`);
  const n = Number((await res.json())?.blueScore);
  if (!Number.isFinite(n)) throw new Error('no blue score returned');
  return n;
}

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
  if (!PRIVATE_KEY) return json(500, { error: 'anchor wallet is not configured' });

  // --- throttling -----------------------------------------------------------
  const now = Date.now();
  if (now - hourStarted > 3_600_000) { hourStarted = now; countThisHour = 0; }
  if (countThisHour >= MAX_PER_INSTANCE_PER_HOUR)
    return json(429, { error: 'this service is busy — try again shortly' });

  const caller = event.headers?.['x-nf-client-connection-ip']
    || event.headers?.['client-ip'] || 'unknown';
  if (now - (seen.get(caller) ?? 0) < MIN_GAP_MS)
    return json(429, { error: 'too quick — wait a few seconds and try again' });
  seen.set(caller, now);
  if (seen.size > 5000) seen.clear();

  // --- input ----------------------------------------------------------------
  if ((event.body?.length ?? 0) > 4096) return json(413, { error: 'body too large' });

  let fingerprint;
  try { fingerprint = String(JSON.parse(event.body || '{}').fingerprint || '').toLowerCase(); }
  catch { return json(400, { error: 'body must be JSON' }); }
  if (!/^[0-9a-f]{64}$/.test(fingerprint))
    return json(400, { error: 'fingerprint must be 64 hex characters' });

  // --- anchor ---------------------------------------------------------------
  let sdk;
  try { sdk = loadSdk(); }
  catch (e) { return json(500, { error: e.message }); }

  const privateKey = new sdk.PrivateKey(PRIVATE_KEY);
  const address = privateKey.toKeypair().toAddress(NETWORK).toString();

  try {
    const rpc = await connection(sdk);
    const { entries } = await withTimeout(
      rpc.getUtxosByAddresses({ addresses: [address] }), 12000, 'reading the wallet');

    const balance = entries.reduce((a, e) => a + BigInt(e.amount ?? e.utxoEntry?.amount ?? 0), 0n);
    if (balance === 0n) return json(503, { error: 'the anchor wallet is empty' });
    if (Number(balance) / 1e8 < FLOOR_KAS)
      return json(503, { error: 'this service has run low and is paused — please report it' });

    const blueScore = await withTimeout(currentBlueScore(), 12000, 'reading the blue score');

    const generator = new sdk.Generator({
      entries,
      outputs: [{ address, amount: sdk.kaspaToSompi('0.2') }],
      changeAddress: address,
      priorityFee: 0n,
      payload: new TextEncoder().encode(PAYLOAD_PREFIX + fingerprint),
      networkId: NETWORK,
    });

    let txid, tx;
    while ((tx = await generator.next())) {
      await tx.sign([privateKey]);
      txid = await withTimeout(tx.submit(rpc), 20000, 'submitting');
    }

    countThisHour++;
    return json(200, { txid, anchoredAtBlueScore: blueScore, network: NETWORK });
  } catch (e) {
    shared = null;                       // force a fresh connection next time
    return json(502, { error: `could not record the commitment: ${e.message}` });
  }
}
