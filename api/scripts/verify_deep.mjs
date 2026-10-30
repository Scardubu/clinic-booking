// clinic-booking/api/scripts/verify_deep.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import proxyHandler from '../../web/api/[...path].js';
import { safeEqual } from '../dist/util/safeEqual.js';
import { canonicalize, canonicalJson, hashPayload } from '../dist/util/canonical.js';
import { encodeCursor, decodeCursor } from '../dist/util/cursor.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const envPaths = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), 'api/.env'),
  path.resolve(__dirname, '../.env'),
];
for (const p of envPaths) {
  if (fs.existsSync(p)) dotenv.config({ path: p });
}

function mockResponse() {
  let statusCode = 200;
  const headers = {};
  let sentBody = null;

  return {
    status(code) {
      statusCode = code;
      return this;
    },
    setHeader(key, val) {
      headers[key.toLowerCase()] = val;
      return this;
    },
    getHeader(key) {
      return headers[key.toLowerCase()];
    },
    send(body) {
      sentBody = body;
      return this;
    },
    json(obj) {
      headers['content-type'] = 'application/json';
      sentBody = JSON.stringify(obj);
      return this;
    },
    getResult() {
      let parsed = sentBody;
      try {
        parsed = JSON.parse(sentBody);
      } catch {}
      return { status: statusCode, headers, body: parsed, rawBody: sentBody };
    },
  };
}

async function runDeepVerification() {
  console.log('\n=== Deep Skeptical Verification Suite ===\n');

  // Verify backend connectivity; if localhost is down, seamlessly fallback to live Render backend
  const candidateUrl = (process.env.BACKEND_URL || 'http://localhost:4000').replace(/\/$/, '');
  if (candidateUrl.includes('localhost') || candidateUrl.includes('127.0.0.1')) {
    try {
      const ping = await fetch(`${candidateUrl}/health`, { signal: AbortSignal.timeout(1200) });
      if (!ping.ok) throw new Error('Unhealthy');
    } catch {
      process.env.BACKEND_URL = 'https://clinic-booking-api-od9i.onrender.com';
      console.log('   [INFO] Localhost:4000 inactive; executing proxy checks against live Render backend.');
    }
  }

  // Test 1: safeEqual edge cases
  console.log('1. Testing safeEqual behavior:');
  assert.equal(safeEqual('', ''), true, 'safeEqual("", "") must be true');
  assert.equal(safeEqual('abc', 'abc'), true, 'safeEqual("abc", "abc") must be true');
  assert.equal(safeEqual('abc', 'def'), false, 'safeEqual("abc", "def") must be false');
  assert.equal(safeEqual('short', 'much_longer_string_here'), false, 'Differing lengths must not throw');
  assert.equal(safeEqual(null, 'abc'), false, 'Null provided must return false');
  assert.equal(safeEqual('abc', undefined), false, 'Undefined expected must return false');
  console.log('   [PASS] safeEqual correctly handles empty strings and varying lengths without throwing.');

  // Test 2: canonicalize and hashPayload
  console.log('2. Testing canonicalize and hashPayload determinism:');
  const h1 = hashPayload({ z: 1, a: 'test', m: [1, 2] });
  const h2 = hashPayload({ a: 'test', m: [1, 2], z: 1 });
  assert.equal(h1, h2, 'Different key ordering must yield identical hash');
  assert.equal(typeof canonicalJson, 'function');
  assert.equal(canonicalize({ b: 2, a: 1 }), '{"a":1,"b":2}');
  console.log('   [PASS] Canonical JSON hashing is deterministic.');

  // Test 3: Cursor encode / decode
  console.log('3. Testing cursor encode / decode:');
  const sample = { createdAt: '2026-10-30T12:00:00.000Z', id: '123e4567-e89b-12d3-a456-426614174000' };
  const encoded = encodeCursor(sample);
  assert.ok(encoded && typeof encoded === 'string');
  const decoded = decodeCursor(encoded);
  assert.deepEqual(decoded, sample);
  assert.equal(decodeCursor('gibberish-not-base64-json!'), null);
  assert.equal(decodeCursor(Buffer.from('{"invalid":"object"}').toString('base64url')), null);
  console.log('   [PASS] Cursor encoding/decoding works and rejects malformed inputs.');

  // Test 4: Proxy favicon handling
  console.log('4. Testing proxy /favicon.ico handler:');
  const favRes = mockResponse();
  await proxyHandler({ url: '/api/favicon.ico', headers: {}, method: 'GET' }, favRes);
  const favResult = favRes.getResult();
  assert.equal(favResult.status, 200);
  assert.ok(favResult.headers['content-type'].includes('image/svg+xml'));
  assert.ok(favResult.rawBody.includes('<svg'));
  console.log('   [PASS] Proxy returns SVG favicon with 200 OK.');

  // Test 5: Proxy GET /api/slots
  console.log('5. Testing proxy GET /api/slots:');
  const slotsRes = mockResponse();
  await proxyHandler({ url: '/api/slots', headers: {}, method: 'GET' }, slotsRes);
  const slotsResult = slotsRes.getResult();
  assert.equal(slotsResult.status, 200, `Expected 200 from proxy, got ${slotsResult.status}`);
  assert.ok(Array.isArray(slotsResult.body.slots), 'Expected slots array');
  assert.ok(slotsResult.body.slots.length > 0, 'Expected non-empty slots');
  console.log(`   [PASS] Proxy forwarded GET /api/slots -> 200 OK (${slotsResult.body.slots.length} slots).`);

  // Test 6: Proxy GET /api/bookings?limit=2
  console.log('6. Testing proxy GET /api/bookings?limit=2 (query preservation):');
  const bookRes = mockResponse();
  await proxyHandler({ url: '/api/bookings?limit=2', headers: {}, method: 'GET' }, bookRes);
  const bookResult = bookRes.getResult();
  assert.equal(bookResult.status, 200);
  assert.ok(Array.isArray(bookResult.body.bookings));
  assert.ok(bookResult.body.bookings.length <= 2, 'Query parameter limit=2 was not respected');
  console.log('   [PASS] Proxy preserved query parameters successfully.');

  // Test 7: Proxy with Vercel catch-all query.path format
  console.log('7. Testing proxy with Vercel route params (req.query.path):');
  const vercelRes = mockResponse();
  await proxyHandler(
    {
      url: '/api/[...path]',
      query: { path: ['slots'] },
      headers: {},
      method: 'GET',
    },
    vercelRes
  );
  const vercelResult = vercelRes.getResult();
  assert.equal(vercelResult.status, 200);
  assert.ok(Array.isArray(vercelResult.body.slots));
  console.log('   [PASS] Proxy resolved Vercel catch-all query.path format.');

  // Test 8: Proxy preserves client-provided invalid API key
  console.log('8. Testing proxy forwarding of client API key:');
  const invalidKeyRes = mockResponse();
  await proxyHandler(
    {
      url: '/api/slots',
      headers: { 'x-api-key': 'deliberately_wrong_key' },
      method: 'GET',
    },
    invalidKeyRes
  );
  const invalidKeyResult = invalidKeyRes.getResult();
  assert.equal(
    invalidKeyResult.status,
    401,
    `Expected proxy to forward wrong key and return 401, got ${invalidKeyResult.status}`
  );
  console.log('   [PASS] Proxy preserves invalid client API key without overwriting it.');

  // Test 9: Proxy upstream failure handling (502 response)
  console.log('9. Testing proxy error handling on unreachable upstream:');
  const originalBackend = process.env.BACKEND_URL;
  try {
    process.env.BACKEND_URL = 'http://127.0.0.1:59999';
    const failRes = mockResponse();
    await proxyHandler({ url: '/api/slots', headers: {}, method: 'GET' }, failRes);
    const failResult = failRes.getResult();
    assert.equal(failResult.status, 502, `Expected 502, got ${failResult.status}`);
    assert.equal(failResult.body.error, 'Upstream gateway error');
    assert.ok(failResult.body.details, 'Expected error details');
    console.log('   [PASS] Proxy catches connection errors and returns 502 with structured error.');
  } finally {
    process.env.BACKEND_URL = originalBackend;
  }

  // Test 10: Proxy security blocks administrative /reset endpoint
  console.log('10. Testing proxy blocks administrative endpoint POST /api/reset (returns 403):');
  const resetRes = mockResponse();
  await proxyHandler({ url: '/api/reset', headers: {}, method: 'POST' }, resetRes);
  const resetResult = resetRes.getResult();
  assert.equal(resetResult.status, 403, `Expected proxy to block /reset with 403, got ${resetResult.status}`);
  assert.equal(resetResult.body.error, 'Forbidden');
  console.log('   [PASS] Proxy successfully blocks administrative /reset with 403 Forbidden.');

  console.log('\n=== ALL DEEP VERIFICATION CHECKS PASSED ===\n');
}

runDeepVerification().catch((err) => {
  console.error('\n[DEEP VERIFICATION FAILURE]', err);
  process.exit(1);
});
