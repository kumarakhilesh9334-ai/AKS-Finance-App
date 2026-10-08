// ─────────────────────────────────────────────────────────────────────────────
// AKS Finance — snapshot Worker (Cloudflare, free tier)
//
// WHAT IT DOES
//   GET  /snapshot.json   serves the pre-built snapshot, but ONLY to a valid
//                          signed token. No token, bad signature, expired, or
//                          revoked  ->  401 with an empty body.
//   POST /                accepts a push from the Apps Script (pushSnapshot()).
//                          The body is either plain JSON or a ZIP containing it;
//                          the Worker always stores the plain JSON in KV.
//
// SETUP (about 5 minutes, no card, no billing)
//   1. https://dash.cloudflare.com  ->  Workers & Pages  ->  Create  ->  Worker
//      Give it a name, e.g. `aks-finance`. Paste this whole file over the
//      sample code and Deploy.
//   2. Settings  ->  Bindings  ->  Add  ->  KV namespace
//      Binding name: AKS_SNAPSHOT     (create the namespace if asked)
//   3. Settings  ->  Variables and Secrets  ->  Add
//      Secret name:  AKS_SECRET       (type: Secret)
//      Value:        the `secret` printed by configureSnapshot(url) in Apps Script
//   4. Copy the Worker URL, e.g.  https://aks-finance.<account>.workers.dev
//      In the Apps Script editor run:  configureSnapshot('https://...')
//      That prints the same secret and installs the 5-minute trigger.
//
// SECURITY MODEL
//   The URL is not a secret (it is visible in view-source), so nothing is
//   protected by obscurity. A read requires a token of the form
//       <userId>.<expiresAt>.<epoch>.<hmac-sha256>
//   signed with AKS_SECRET, which never leaves Apps Script / this Worker.
//   The `epoch` is bumped by Apps Script whenever the Users sheet changes, so
//   editing a PIN or deleting a user directly in the sheet kills every
//   outstanding token within 5 minutes.
// ─────────────────────────────────────────────────────────────────────────────

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  // Browsers cache the preflight for a day, so the extra round-trip costs
  // roughly one per day rather than one per read.
  'Access-Control-Max-Age': '86400',
  Vary: 'Origin',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = extra => Object.assign({}, CORS, extra || {});

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors() });
    }
    if (request.method === 'POST') {
      return handlePush(request, env, cors);
    }
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/snapshot.json')) {
      return handleRead(request, env, cors);
    }
    return new Response('Not found', { status: 404, headers: cors() });
  },
};

async function handleRead(request, env, cors) {
  if (!env.AKS_SNAPSHOT) {
    return new Response('KV binding AKS_SNAPSHOT missing', { status: 500, headers: cors() });
  }
  if (!env.AKS_SECRET) {
    return new Response('Secret AKS_SECRET missing', { status: 500, headers: cors() });
  }

  const token = bearer(request);
  if (!token) return unauthorized(cors);

  const parsed = parseToken(token);
  if (!parsed) return unauthorized(cors);

  // Signature first — never trust anything before it verifies.
  const expected = await hmacHex(env.AKS_SECRET, parsed.body);
  if (!ctEqual(expected, parsed.sig)) return unauthorized(cors);

  if (!(parsed.expiresAt > Math.floor(Date.now() / 1000))) return unauthorized(cors);

  const liveEpoch = await env.AKS_SNAPSHOT.get('epoch');
  if (liveEpoch === null || liveEpoch !== parsed.epoch) return unauthorized(cors);

  const snapshot = await env.AKS_SNAPSHOT.get('snapshot', 'text');
  if (!snapshot) return new Response('', { status: 404, headers: cors() });

  return new Response(snapshot, {
    status: 200,
    headers: cors({
      'Content-Type': 'application/json; charset=utf-8',
      // Never let a browser hold a snapshot after we replaced it.
      'Cache-Control': 'no-store',
    }),
  });
}

async function handlePush(request, env, cors) {
  if (!env.AKS_SECRET) {
    return new Response('Secret AKS_SECRET missing', { status: 500, headers: cors() });
  }
  if (bearer(request) !== env.AKS_SECRET) {
    return new Response('', { status: 403, headers: cors() });
  }
  if (!env.AKS_SNAPSHOT) {
    return new Response('KV binding AKS_SNAPSHOT missing', { status: 500, headers: cors() });
  }

  // The push arrives either as plain JSON or as a ZIP-wrapped deflate of that
  // same JSON (Apps Script zips to cut a ~4.6 MB upload down to ~0.5 MB). The
  // ZIP magic bytes decide, not a header, so either version of either side can
  // talk to the other. KV always stores the inflated JSON, so the read path
  // below and every client stay byte-for-byte identical.
  const buf = await request.arrayBuffer();
  const head = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
  let text;
  if (head.length === 4 && head[0] === 0x50 && head[1] === 0x4B &&
      head[2] === 0x03 && head[3] === 0x04) {
    try {
      text = await unzipFirstEntry(buf);
    } catch (e) {
      return new Response('invalid zip: ' + e.message, { status: 400, headers: cors() });
    }
  } else {
    text = new TextDecoder().decode(buf);
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch (e) {
    return new Response('invalid JSON', { status: 400, headers: cors() });
  }
  if (!body || !body.data || typeof body.data !== 'object') {
    return new Response('missing data', { status: 400, headers: cors() });
  }
  if (typeof body.epoch !== 'number' || typeof body.generatedAt !== 'number') {
    return new Response('missing epoch/generatedAt', { status: 400, headers: cors() });
  }

  await env.AKS_SNAPSHOT.put('snapshot', text);

  // Only write the epoch when it actually moved. KV free tier allows 1,000
  // writes/day; at one push per 5 minutes an unconditional second write would
  // still fit, but this keeps us well clear of the ceiling.
  const liveEpoch = await env.AKS_SNAPSHOT.get('epoch');
  if (liveEpoch !== String(body.epoch)) {
    await env.AKS_SNAPSHOT.put('epoch', String(body.epoch));
  }

  return new Response(JSON.stringify({ ok: true, bytes: text.length }), {
    status: 200,
    headers: cors({ 'Content-Type': 'application/json' }),
  });
}

// Inflates the first entry of a ZIP archive. Only used on the push path, and
// supports exactly what Utilities.zip() emits: one entry, method 8 (deflate) or
// 0 (stored). Sizes come from the central directory, which stays authoritative
// even when the local header carries a data descriptor (bit 3).
async function unzipFirstEntry(buf) {
  const dv = new DataView(buf);
  const dec = new TextDecoder();

  // Walk back to the End Of Central Directory record (0x06054b50). Its comment
  // is at most 65535 bytes, so a bounded scan is enough.
  let eocd = -1;
  const floor = Math.max(0, buf.byteLength - 22 - 65535);
  for (let i = buf.byteLength - 22; i >= floor; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('no end-of-central-directory');

  const total = dv.getUint16(eocd + 10, true);
  const cdOff = dv.getUint32(eocd + 16, true);
  if (total < 1) throw new Error('archive is empty');
  if (dv.getUint32(cdOff, true) !== 0x02014b50) throw new Error('bad central directory');

  const method   = dv.getUint16(cdOff + 10, true);
  const compSize = dv.getUint32(cdOff + 20, true);
  const locOff   = dv.getUint32(cdOff + 42, true);
  if (dv.getUint32(locOff, true) !== 0x04034b50) throw new Error('bad local header');

  const start = locOff + 30 + dv.getUint16(locOff + 26, true) + dv.getUint16(locOff + 28, true);
  const end = start + compSize;
  if (end > buf.byteLength) throw new Error('entry runs past the end of the archive');
  const raw = buf.slice(start, end);

  if (method === 0) return dec.decode(raw);
  if (method !== 8) throw new Error('unsupported compression method ' + method);

  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return await new Response(stream).text();
}

function bearer(request) {
  const h = request.headers.get('Authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

// <userId>.<expiresAt>.<epoch>.<hmac>  — parsed from the right so a userId
// containing dots cannot shift the fields.
function parseToken(token) {
  const parts = token.split('.');
  if (parts.length < 4) return null;
  const sig = parts[parts.length - 1];
  const epoch = parts[parts.length - 2];
  const expiresAt = Number(parts[parts.length - 3]);
  const userId = parts.slice(0, parts.length - 3).join('.');
  if (!/^[0-9a-f]{64}$/.test(sig)) return null;
  if (!/^\d+$/.test(epoch) || !Number.isFinite(expiresAt) || !userId) return null;
  return { userId, expiresAt, epoch, sig, body: parts.slice(0, parts.length - 1).join('.') };
}

async function hmacHex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Compare without returning early, so a wrong guess cannot be timed bit by bit.
function ctEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function unauthorized(cors) {
  // Empty body on purpose: an invalid token must learn nothing at all.
  return new Response('', { status: 401, headers: cors() });
}
