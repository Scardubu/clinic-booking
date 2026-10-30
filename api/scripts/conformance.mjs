// clinic-booking/api/scripts/conformance.mjs
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
  if (fs.existsSync(p)) {
    dotenv.config({ path: p });
  }
}

const BASE_URL = (process.env.API_BASE_URL || 'http://localhost:4000').replace(/\/$/, '');
const API_KEY = process.env.API_KEY || 'dev-clinic-api-key-2026';

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

async function runConformance() {
  console.log(`\n=== Running Clinic Booking API Conformance Suite (Levels 1–5) ===`);
  console.log(`Target: ${BASE_URL}\n`);

  // 0. RESET: Initialize clean state
  console.log('-> Testing Level 1: Reset Database State...');
  const resetRes = await request('/reset', { method: 'POST' });
  assert.equal(resetRes.status, 200, 'POST /reset must return 200');
  console.log('   [PASS] POST /reset completed.');

  // 1. LEVEL 2: Auth & Payload Validation
  console.log('-> Testing Level 2: API Key Auth & Validation...');
  const noAuth = await request('/slots', { apiKey: false });
  assert.equal(noAuth.status, 401, 'Missing API key must return 401');

  const wrongAuth = await request('/slots', { apiKey: 'invalid_key_value' });
  assert.equal(wrongAuth.status, 401, 'Invalid API key must return 401');

  const badPayload = await request('/bookings', {
    method: 'POST',
    body: { slot_id: '', name: 'A', email: 'bad-email' },
  });
  assert.equal(badPayload.status, 400, 'Malformed booking payload must return 400');
  console.log('   [PASS] Level 2 verified.');

  // 2. LEVEL 1: List Slots
  console.log('-> Testing Level 1: List Available Slots...');
  const slotsRes = await request('/slots');
  assert.equal(slotsRes.status, 200, 'GET /slots must return 200');
  const slots = slotsRes.data.slots || [];
  const availableSlots = slots.filter(
    (s) =>
      s.available !== false &&
      s.is_available !== false &&
      new Date(s.start || s.startTime || s.start_time).getTime() > Date.now()
  );
  assert.ok(availableSlots.length >= 2, 'Expected at least 2 available seeded slots');
  const targetSlot = availableSlots[0];
  const secondSlot = availableSlots[1];
  console.log(`   [PASS] Found ${availableSlots.length} available future slots. Target slot: ${targetSlot.id}`);

  // 3. LEVEL 3: 5-Way Simultaneous Race Condition & Cancellation
  console.log('-> Testing Level 3: 5-Way Concurrent Booking Race & Cancellation...');
  const contenders = Array.from({ length: 5 }, (_, idx) =>
    request('/bookings', {
      method: 'POST',
      headers: { 'X-Client-Id': `race-contender-${idx}-${Date.now()}` },
      body: {
        slot_id: targetSlot.id,
        name: `Contender ${idx + 1}`,
        email: `contender${idx + 1}.${Date.now()}@example.com`,
      },
    })
  );

  const raceResults = await Promise.all(contenders);
  console.log('   Race results statuses:', raceResults.map(r => ({ status: r.status, error: r.data.error, msg: r.data.message })));
  const createdCount = raceResults.filter((r) => r.status === 201).length;
  const conflictCount = raceResults.filter((r) => r.status === 409).length;

  assert.equal(createdCount, 1, 'Exactly 1 concurrent request must succeed with 201');
  assert.equal(conflictCount, 4, 'All other 4 concurrent requests must fail with 409 Conflict');

  const winningBooking = raceResults.find((r) => r.status === 201).data;
  const bookingId = winningBooking.id || winningBooking.booking?.id;

  // Level 1: Lookup booking by ID
  const lookupRes = await request(`/bookings/${bookingId}`);
  assert.equal(lookupRes.status, 200, 'GET /bookings/:id must return 200');
  assert.equal(lookupRes.data.id, bookingId);

  // Level 3: Cancel booking and verify slot is freed
  const cancelRes = await request(`/bookings/${bookingId}`, { method: 'DELETE' });
  assert.equal(cancelRes.status, 200, 'DELETE /bookings/:id must return 200');
  assert.equal(cancelRes.data.status?.toLowerCase(), 'cancelled');
  console.log('   [PASS] Level 1 & Level 3 verified.');

  // 4. LEVEL 4: Idempotency & Cursor Pagination
  console.log('-> Testing Level 4: Idempotency-Key Replay, Conflict & Cursor Pagination...');
  const idemKey = `idem-${crypto.randomUUID()}`;
  const patientEmail = `patient.${Date.now()}@example.com`;
  const clientHeader = { 'X-Client-Id': `idem-client-${Date.now()}` };

  const firstAttempt = await request('/bookings', {
    method: 'POST',
    headers: { ...clientHeader, 'Idempotency-Key': idemKey },
    body: {
      slot_id: targetSlot.id,
      name: 'Idempotent User',
      email: patientEmail,
    },
  });
  const retryAttempt = await request('/bookings', {
    method: 'POST',
    headers: { ...clientHeader, 'Idempotency-Key': idemKey },
    body: {
      slot_id: targetSlot.id,
      name: 'Idempotent User',
      email: patientEmail,
    },
  });

  assert.equal(firstAttempt.status, 201);
  assert.equal(retryAttempt.status, 201);
  assert.equal(firstAttempt.data.id, retryAttempt.data.id, 'Retried request must return same booking ID');

  // Mutated payload with same Idempotency-Key must return 422
  const mutatedAttempt = await request('/bookings', {
    method: 'POST',
    headers: { ...clientHeader, 'Idempotency-Key': idemKey },
    body: {
      slot_id: secondSlot.id,
      name: 'Mutated Payload User',
      email: patientEmail,
    },
  });
  assert.equal(mutatedAttempt.status, 422, 'Reusing Idempotency-Key with different body must return 422');

  // Create a second booking for the same patient to test pagination
  const secondBooking = await request('/bookings', {
    method: 'POST',
    headers: clientHeader,
    body: {
      slot_id: secondSlot.id,
      name: 'Idempotent User',
      email: patientEmail,
    },
  });
  assert.equal(secondBooking.status, 201);

  const page1 = await request(`/bookings?email=${encodeURIComponent(patientEmail)}&limit=1`);
  assert.equal(page1.status, 200);
  assert.equal(page1.data.bookings.length, 1);
  assert.ok(page1.data.next_cursor || page1.data.nextCursor, 'Expected next_cursor when more bookings exist');
  const nextCursor = page1.data.next_cursor || page1.data.nextCursor;

  const page2 = await request(
    `/bookings?email=${encodeURIComponent(patientEmail)}&limit=1&cursor=${encodeURIComponent(nextCursor)}`
  );
  assert.equal(page2.status, 200);
  assert.equal(page2.data.bookings.length, 1);
  assert.notEqual(page1.data.bookings[0].id, page2.data.bookings[0].id);

  // Clean up test bookings so slots remain open
  await request(`/bookings/${firstAttempt.data.id}`, { method: 'DELETE' });
  await request(`/bookings/${secondBooking.data.id}`, { method: 'DELETE' });
  console.log('   [PASS] Level 4 verified.');

  // 5. LEVEL 5: Rate Limiting
  console.log('-> Testing Level 5: Booking Spam Rate Limiter (5 attempts per email per minute)...');
  const spamEmail = `spammer.${Date.now()}@example.com`;
  let hit429 = false;
  let retryAfterHeader = null;
  for (let i = 0; i < 7; i++) {
    const res = await request('/bookings', {
      method: 'POST',
      body: { slot_id: 'non-existent', name: 'Spam User', email: spamEmail },
    });
    if (res.status === 429) {
      hit429 = true;
      retryAfterHeader = res.headers.get('retry-after');
      break;
    }
  }
  assert.ok(hit429, 'Spamming POST /bookings for an email must trigger 429 Too Many Requests on 6th attempt');
  assert.ok(retryAfterHeader, '429 response must include Retry-After header in whole seconds');

  const otherRes = await request('/bookings', {
    method: 'POST',
    body: { slot_id: 'non-existent', name: 'Other User', email: `other.${Date.now()}@example.com` },
  });
  assert.notEqual(otherRes.status, 429, 'Other emails must not be affected by rate limiting');
  console.log('   [PASS] Level 5 verified.\n');
  console.log('=== ALL 5 LEVELS PASSED CONFORMANCE SUCCESSFULLY ===\n');
}

runConformance().catch((err) => {
  console.error('\n[CONFORMANCE FAILURE]', err);
  process.exit(1);
});