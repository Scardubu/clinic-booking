// clinic-booking/api/scripts/conformance.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

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

  // 1. LEVEL 2: Auth & Payload Validation
  console.log('-> Testing Level 2: API Key Auth & Validation...');
  const noAuth = await request('/slots', { apiKey: false });
  assert.equal(noAuth.status, 401, 'Missing API key must return 401');

  const wrongAuth = await request('/slots', { apiKey: 'invalid_key_value' });
  assert.equal(wrongAuth.status, 401, 'Invalid API key must return 401');

  const badPayload = await request('/bookings', {
    method: 'POST',
    headers: { 'X-Client-Id': `val-client-${Date.now()}` },
    body: { slotId: 'not-a-uuid', patientName: 'A', patientEmail: 'bad-email' },
  });
  assert.equal(badPayload.status, 400, 'Malformed booking payload must return 400');
  console.log('   [PASS] Level 2 verified.');

  // 2. LEVEL 1: List Slots
  console.log('-> Testing Level 1: List Available Slots...');
  const slotsRes = await request('/slots');
  assert.equal(slotsRes.status, 200, 'GET /slots must return 200');
  const slots = slotsRes.data.slots || [];
  assert.ok(slots.length >= 3, 'Expected at least 3 available seeded slots');
  const targetSlot = slots[0];
  console.log(`   [PASS] Found ${slots.length} available slots. Target slot: ${targetSlot.id}`);

  // 3. LEVEL 3: 5-Way Simultaneous Race Condition & Cancellation
  console.log('-> Testing Level 3: 5-Way Concurrent Booking Race & Cancellation...');
  const contenders = Array.from({ length: 5 }, (_, idx) =>
    request('/bookings', {
      method: 'POST',
      headers: { 'X-Client-Id': `race-contender-${idx}-${Date.now()}` },
      body: {
        slotId: targetSlot.id,
        patientName: `Contender ${idx + 1}`,
        patientEmail: `contender${idx + 1}.${Date.now()}@example.com`,
      },
    })
  );

  const raceResults = await Promise.all(contenders);
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
  assert.equal(cancelRes.data.status, 'CANCELLED');
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
      slotId: targetSlot.id,
      patientName: 'Idempotent User',
      patientEmail,
    },
  });
  const retryAttempt = await request('/bookings', {
    method: 'POST',
    headers: { ...clientHeader, 'Idempotency-Key': idemKey },
    body: {
      slotId: targetSlot.id,
      patientName: 'Idempotent User',
      patientEmail,
    },
  });

  assert.equal(firstAttempt.status, 201);
  assert.equal(retryAttempt.status, 201);
  assert.equal(firstAttempt.data.id, retryAttempt.data.id, 'Retried request must return same booking ID');

  // Mutated payload with same Idempotency-Key must return 409
  const mutatedAttempt = await request('/bookings', {
    method: 'POST',
    headers: { ...clientHeader, 'Idempotency-Key': idemKey },
    body: {
      slotId: slots[1].id,
      patientName: 'Mutated Payload User',
      patientEmail,
    },
  });
  assert.equal(mutatedAttempt.status, 409, 'Reusing Idempotency-Key with different body must return 409');

  // Create a second booking for the same patient to test pagination
  const secondBooking = await request('/bookings', {
    method: 'POST',
    headers: clientHeader,
    body: {
      slotId: slots[1].id,
      patientName: 'Idempotent User',
      patientEmail,
    },
  });
  assert.equal(secondBooking.status, 201);

  const page1 = await request(`/bookings?patientEmail=${encodeURIComponent(patientEmail)}&limit=1`);
  assert.equal(page1.status, 200);
  assert.equal(page1.data.bookings.length, 1);
  assert.ok(page1.data.nextCursor, 'Expected nextCursor when more bookings exist');

  const page2 = await request(
    `/bookings?patientEmail=${encodeURIComponent(patientEmail)}&limit=1&cursor=${encodeURIComponent(page1.data.nextCursor)}`
  );
  assert.equal(page2.status, 200);
  assert.equal(page2.data.bookings.length, 1);
  assert.notEqual(page1.data.bookings[0].id, page2.data.bookings[0].id);

  // Clean up test bookings so slots remain open
  await request(`/bookings/${firstAttempt.data.id}`, { method: 'DELETE' });
  await request(`/bookings/${secondBooking.data.id}`, { method: 'DELETE' });
  console.log('   [PASS] Level 4 verified.');

  // 5. LEVEL 5: Rate Limiting
  console.log('-> Testing Level 5: Booking Spam Rate Limiter...');
  const spamClientId = `spammer-${Date.now()}`;
  let hit429 = false;
  for (let i = 0; i < 15; i++) {
    const res = await request('/bookings', {
      method: 'POST',
      headers: { 'X-Client-Id': spamClientId },
      body: { slotId: 'invalid-uuid', patientName: 'Spam', patientEmail: 'spam@example.com' },
    });
    if (res.status === 429) {
      hit429 = true;
      break;
    }
  }
  assert.ok(hit429, 'Spamming POST /bookings must trigger 429 Too Many Requests');
  console.log('   [PASS] Level 5 verified.\n');
  console.log('=== ALL 5 LEVELS PASSED CONFORMANCE SUCCESSFULLY ===\n');
}

runConformance().catch((err) => {
  console.error('\n[CONFORMANCE FAILURE]', err);
  process.exit(1);
});