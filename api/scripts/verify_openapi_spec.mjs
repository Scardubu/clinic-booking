import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

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

const BASE_URL = (process.env.API_BASE_URL || 'http://localhost:4000').replace(/\/$/, '');
const API_KEY = process.env.API_KEY || 'koya_live_9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c';

async function request(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.apiKey !== false ? { 'X-API-Key': options.apiKey ?? API_KEY } : {}),
    ...(options.headers || {}),
  };

  const res = await fetch(`${BASE_URL}${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const data = await res.json().catch(() => ({}));
  return { status: res.status, headers: res.headers, data };
}

async function runSpecVerification() {
  console.log('\n======================================================');
  console.log('--- STRICT OPENAPI SPECIFICATION VERIFICATION SUITE ---');
  console.log('Target:', BASE_URL);
  console.log('======================================================\n');

  // Step 1: POST /reset with exact spec payload
  console.log('1. Testing POST /reset with custom slots (including past slot)...');
  
  // Test reset with empty array leaves exactly 0 slots
  const emptyResetRes = await request('/reset', {
    method: 'POST',
    body: { slots: [] },
  });
  assert.equal(emptyResetRes.status, 200, 'POST /reset with empty slots must return 200');
  const emptySlotsRes = await request('/slots');
  assert.equal(emptySlotsRes.data.slots.length, 0, 'POST /reset with { slots: [] } must leave 0 slots');

  const customSlots = [
    {
      id: 's-past',
      provider: 'Dr Ade',
      start: '2020-01-01T09:00:00Z',
      end: '2020-01-01T09:30:00Z',
    },
    {
      id: 's-dr-ade-1',
      provider: 'Dr Ade',
      start: '2028-12-10T09:00:00Z',
      end: '2028-12-10T09:30:00Z',
    },
    {
      id: 's-dr-ade-2',
      provider: 'Dr Ade',
      start: '2028-12-10T10:00:00Z',
      end: '2028-12-10T10:30:00Z',
    },
    {
      id: 's-dr-chi-1',
      provider: 'Dr Chioma',
      start: '2028-12-10T11:00:00Z',
      end: '2028-12-10T11:30:00Z',
    },
  ];

  const resetRes = await request('/reset', {
    method: 'POST',
    body: { slots: customSlots },
  });
  assert.equal(resetRes.status, 200, 'POST /reset must return 200 Done');
  console.log('   [PASS] POST /reset successfully replaced all slots.');

  // Step 2: GET /slots format & provider filtering
  console.log('2. Testing GET /slots schema conformance & provider filtering...');
  const allSlotsRes = await request('/slots');
  assert.equal(allSlotsRes.status, 200);
  assert.ok(Array.isArray(allSlotsRes.data.slots));
  assert.equal(allSlotsRes.data.slots.length, 4);

  // Validate SlotWithAvailability schema on every slot
  for (const s of allSlotsRes.data.slots) {
    assert.equal(typeof s.id, 'string', 'Slot.id must be string');
    assert.equal(typeof s.provider, 'string', 'Slot.provider must be string');
    assert.equal(typeof s.start, 'string', 'Slot.start must be string');
    assert.equal(typeof s.end, 'string', 'Slot.end must be string');
    assert.equal(typeof s.available, 'boolean', 'Slot.available must be boolean');
    assert.ok(!Number.isNaN(Date.parse(s.start)), 'Slot.start must be valid date-time');
    assert.ok(!Number.isNaN(Date.parse(s.end)), 'Slot.end must be valid date-time');
  }

  // Earliest start first check
  const startTimes = allSlotsRes.data.slots.map((s) => new Date(s.start).getTime());
  for (let i = 1; i < startTimes.length; i++) {
    assert.ok(startTimes[i] >= startTimes[i - 1], 'Slots must be ordered earliest start first');
  }

  // Provider filtering
  const filterRes = await request('/slots?provider=Dr%20Chioma');
  assert.equal(filterRes.status, 200);
  assert.equal(filterRes.data.slots.length, 1);
  assert.equal(filterRes.data.slots[0].provider, 'Dr Chioma');
  console.log('   [PASS] GET /slots complies with SlotWithAvailability and provider filter.');

  // Step 3: Level 2 Validation rules
  console.log('3. Testing Level 2 input validation edge cases...');
  // Missing slot_id
  const noSlot = await request('/bookings', {
    method: 'POST',
    body: { name: 'Ada', email: 'ada@example.com' },
  });
  assert.equal(noSlot.status, 400);
  assert.equal(typeof noSlot.data.error, 'string', 'Error must be a string');

  // Missing name
  const noName = await request('/bookings', {
    method: 'POST',
    body: { slot_id: 's-dr-ade-1', email: 'ada@example.com' },
  });
  assert.equal(noName.status, 400);
  assert.equal(typeof noName.data.error, 'string');

  // Missing/invalid email
  const badEmail = await request('/bookings', {
    method: 'POST',
    body: { slot_id: 's-dr-ade-1', name: 'Ada', email: 'not-an-email' },
  });
  assert.equal(badEmail.status, 400);
  assert.equal(typeof badEmail.data.error, 'string');

  // Slot doesn't exist -> 404
  const noSlotFound = await request('/bookings', {
    method: 'POST',
    body: { slot_id: 'non-existent-slot-id', name: 'Ada', email: 'ada@example.com' },
  });
  assert.equal(noSlotFound.status, 404);
  assert.equal(typeof noSlotFound.data.error, 'string');

  // Slot has already started -> 400
  const pastSlot = await request('/bookings', {
    method: 'POST',
    body: { slot_id: 's-past', name: 'Ada', email: 'ada@example.com' },
  });
  assert.equal(pastSlot.status, 400);
  assert.equal(typeof pastSlot.data.error, 'string');
  console.log('   [PASS] Level 2 validation checks (400, 404, past slot) fully verified.');

  // Step 4: Level 1 & Level 2 Happy Path Booking
  console.log('4. Testing Level 1 booking creation and email lowercasing/trimming...');
  const createRes = await request('/bookings', {
    method: 'POST',
    body: {
      slot_id: 's-dr-ade-1',
      name: '  Ada Obi  ',
      email: '  Ada.Obi@EXAMPLE.com  ',
    },
  });
  assert.equal(createRes.status, 201);
  const booking = createRes.data;
  assert.equal(typeof booking.id, 'string', 'Booking.id must be a string');
  assert.equal(booking.slot_id, 's-dr-ade-1');
  assert.equal(booking.name, 'Ada Obi', 'Name must be trimmed');
  assert.equal(booking.email, 'ada.obi@example.com', 'Email must be trimmed and lowercased');
  assert.equal(booking.status, 'confirmed', 'Status must be confirmed (lowercase)');
  assert.ok(!Number.isNaN(Date.parse(booking.created_at)), 'created_at must be valid date-time');
  console.log('   [PASS] Level 1 booking creation verified. Booking ID:', booking.id);

  // Step 5: Level 1 Lookup Single Booking & 404
  console.log('5. Testing Level 1 GET /bookings/:id...');
  const lookupRes = await request(`/bookings/${booking.id}`);
  assert.equal(lookupRes.status, 200);
  assert.equal(lookupRes.data.id, booking.id);
  assert.equal(lookupRes.data.status, 'confirmed');

  const lookup404 = await request('/bookings/does-not-exist');
  assert.equal(lookup404.status, 404);
  assert.equal(typeof lookup404.data.error, 'string');
  console.log('   [PASS] GET /bookings/:id (200 & 404) verified.');

  // Step 6: Level 3 Conflict on booked slot & Cancellation
  console.log('6. Testing Level 3 double booking conflict (409) and cancellation...');
  const doubleBookRes = await request('/bookings', {
    method: 'POST',
    body: {
      slot_id: 's-dr-ade-1',
      name: 'Chidi Okonkwo',
      email: 'chidi@example.com',
    },
  });
  assert.equal(doubleBookRes.status, 409);
  assert.equal(typeof doubleBookRes.data.error, 'string');

  // Cancel booking
  const cancelRes = await request(`/bookings/${booking.id}`, { method: 'DELETE' });
  assert.equal(cancelRes.status, 200);
  assert.equal(cancelRes.data.status, 'cancelled');

  // Cancelling again must return 409
  const reCancelRes = await request(`/bookings/${booking.id}`, { method: 'DELETE' });
  assert.equal(reCancelRes.status, 409);
  assert.equal(typeof reCancelRes.data.error, 'string');

  // Slot s-dr-ade-1 is now free again
  const rebookRes = await request('/bookings', {
    method: 'POST',
    body: {
      slot_id: 's-dr-ade-1',
      name: 'Chidi Okonkwo',
      email: 'chidi@example.com',
    },
  });
  assert.equal(rebookRes.status, 201);
  console.log('   [PASS] Level 3 conflict, cancellation (409 & 200), and slot rebooking verified.');

  // Step 7: Level 4 Idempotency (201 replay, 422 on payload change) & Pagination
  console.log('7. Testing Level 4 Idempotency (replay, 422) and cursor pagination...');
  const idemKey = `idem-${crypto.randomUUID()}`;
  const idemAttempt1 = await request('/bookings', {
    method: 'POST',
    headers: { 'Idempotency-Key': idemKey },
    body: { slot_id: 's-dr-ade-2', name: 'Emeka', email: 'emeka@example.com' },
  });
  assert.equal(idemAttempt1.status, 201);

  // Exact same body and key replayed 6 times -> must return 201 each time without hitting rate limit
  for (let r = 2; r <= 7; r++) {
    const replayAttempt = await request('/bookings', {
      method: 'POST',
      headers: { 'Idempotency-Key': idemKey },
      body: { slot_id: 's-dr-ade-2', name: 'Emeka', email: 'emeka@example.com' },
    });
    assert.equal(replayAttempt.status, 201, `Replay #${r} must return 201 and not consume rate limit budget`);
    assert.equal(replayAttempt.data.id, idemAttempt1.data.id, `Replay #${r} must return identical booking ID`);
  }

  // Different body with same key -> must return 422
  const idemAttempt3 = await request('/bookings', {
    method: 'POST',
    headers: { 'Idempotency-Key': idemKey },
    body: { slot_id: 's-dr-chi-1', name: 'Mutated Emeka', email: 'emeka@example.com' },
  });
  assert.equal(idemAttempt3.status, 422, 'Idempotency-Key reused with different body must return 422');
  assert.equal(typeof idemAttempt3.data.error, 'string');

  // Create second booking for Emeka to test pagination
  const emekaBooking2 = await request('/bookings', {
    method: 'POST',
    body: { slot_id: 's-dr-chi-1', name: 'Emeka', email: 'emeka@example.com' },
  });
  assert.equal(emekaBooking2.status, 201);

  // Cursor Pagination: Oldest first
  const emekaPage1 = await request('/bookings?email=emeka@example.com&limit=1');
  assert.equal(emekaPage1.status, 200);
  assert.equal(emekaPage1.data.bookings.length, 1);
  assert.equal(emekaPage1.data.bookings[0].id, idemAttempt1.data.id, 'Oldest booking must be first');
  assert.ok(emekaPage1.data.next_cursor, 'Page 1 must include next_cursor');

  const emekaPage2 = await request(
    `/bookings?email=emeka@example.com&limit=1&cursor=${encodeURIComponent(emekaPage1.data.next_cursor)}`
  );
  assert.equal(emekaPage2.status, 200);
  assert.equal(emekaPage2.data.bookings.length, 1);
  assert.equal(emekaPage2.data.bookings[0].id, emekaBooking2.data.id);
  assert.equal(emekaPage2.data.next_cursor, null, 'Last page must have next_cursor: null');

  // Invalid limit tests (1 to 50 allowed)
  const badLimit0 = await request('/bookings?email=emeka@example.com&limit=0');
  assert.equal(badLimit0.status, 400);
  assert.equal(typeof badLimit0.data.error, 'string');

  const badLimit51 = await request('/bookings?email=emeka@example.com&limit=51');
  assert.equal(badLimit51.status, 400);

  const badLimitAlpha = await request('/bookings?email=emeka@example.com&limit=abc');
  assert.equal(badLimitAlpha.status, 400);
  console.log('   [PASS] Level 4 idempotency replay, 422, cursor pagination & limit validation verified.');

  // Step 8: Level 5 Rate Limiting (5 per minute per email, 6th 429)
  console.log('8. Testing Level 5 email rate limiting (5 attempts allowed, 6th returns 429 with Retry-After)...');
  const targetEmail = `rate.limit.${Date.now()}@example.com`;
  for (let i = 1; i <= 5; i++) {
    const attempt = await request('/bookings', {
      method: 'POST',
      body: { slot_id: 's-none', name: 'Spam User', email: targetEmail },
    });
    assert.notEqual(attempt.status, 429, `Attempt ${i} should be allowed (got ${attempt.status})`);
  }

  // 6th attempt must be 429
  const sixthAttempt = await request('/bookings', {
    method: 'POST',
    body: { slot_id: 's-none', name: 'Spam User', email: targetEmail },
  });
  assert.equal(sixthAttempt.status, 429, '6th attempt must return 429');
  assert.equal(typeof sixthAttempt.data.error, 'string');
  const retryAfter = sixthAttempt.headers.get('retry-after');
  assert.ok(retryAfter, '429 must include Retry-After header');
  assert.ok(/^\d+$/.test(retryAfter), 'Retry-After must be integer whole seconds');

  // Another email must be unaffected
  const unaffectedAttempt = await request('/bookings', {
    method: 'POST',
    body: { slot_id: 's-none', name: 'Unrelated User', email: `unrelated.${Date.now()}@example.com` },
  });
  assert.notEqual(unaffectedAttempt.status, 429, 'Unrelated email must not be rate limited');
  console.log('   [PASS] Level 5 email-isolated rate limiting and Retry-After header verified.');

  console.log('\n======================================================');
  console.log('--- ALL OPENAPI SPECIFICATION REQUIREMENTS PASSED! ---');
  console.log('======================================================\n');
}

runSpecVerification().catch((err) => {
  console.error('\n[OPENAPI SPEC VERIFICATION FAILURE]', err);
  process.exit(1);
});
