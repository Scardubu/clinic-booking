#!/usr/bin/env node
// Black-box conformance suite for the Koya "Clinic booking API" contract.
//
//   BASE_URL=https://your-api.onrender.com API_KEY=... node scripts/conformance.mjs
//   add --slow to also verify the limiter window really slides open again (~60s)
//
// WARNING: calls POST /reset, which DELETES ALL BOOKINGS AND SLOTS. Run it before you
// submit, never after the graders have started using your deployment.

const BASE = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const KEY = process.env.API_KEY ?? '';
const SLOW = process.argv.includes('--slow');

let passed = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `  (${detail})` : ''}`);
  }
}
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

/** Always sends Content-Type: application/json, even with no body (like many HTTP clients do). */
async function call(method, path, { body, headers = {}, key = KEY, rawBody } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(key ? { 'x-api-key': key } : {}), ...headers },
    body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* leave null */
  }
  return { status: res.status, headers: res.headers, json, text };
}

const isErr = (r) => r.json && typeof r.json.error === 'string' && r.json.error.length > 0;
const FUTURE = (n) => `2099-01-${String(n).padStart(2, '0')}T09:00:00Z`;
const slot = (id, provider, start, end) => ({ id, provider, start, end: end ?? start.replace('09:00', '09:30') });
const book = (slot_id, email, name = 'Ada Obi', headers) =>
  call('POST', '/bookings', { body: { slot_id, name, email }, headers });
const uniq = () => Math.random().toString(36).slice(2, 10);

async function resetWith(slots) {
  const r = await call('POST', '/reset', { body: { slots } });
  if (r.status !== 200) throw new Error(`reset failed: ${r.status} ${r.text}`);
}

async function main() {
  console.log(`Target: ${BASE}`);

  // ───────────────────────────────────────────── Level 2: auth
  section('Level 2 · API key');
  {
    const none = await call('GET', '/slots', { key: '' });
    check('missing key → 401 {error}', none.status === 401 && isErr(none), `got ${none.status}`);
    const wrong = await call('GET', '/slots', { key: 'definitely-wrong' });
    check('wrong key → 401', wrong.status === 401 && isErr(wrong));
    const reset = await call('POST', '/reset', { key: '', body: { slots: [] } });
    check('POST /reset without key → 401', reset.status === 401);
    const del = await call('DELETE', '/bookings/x', { key: '' });
    check('DELETE without key → 401 (auth precedes 404)', del.status === 401);
    const unknown = await call('GET', '/nope');
    check('unknown route with key → 404 {error}', unknown.status === 404 && isErr(unknown));
  }

  // ───────────────────────────────────────────── Level 1
  section('Level 1 · slots, book, look up');
  const SLOTS = [
    slot('s3', 'Dr Bello', FUTURE(12)),
    slot('s1', 'Dr Ade', FUTURE(10)),
    slot('s2', 'Dr Ade', FUTURE(11)),
    slot('past', 'Dr Ade', '2020-01-01T09:00:00Z', '2020-01-01T09:30:00Z'),
    ...Array.from({ length: 12 }, (_, i) => slot(`x${i + 1}`, 'Dr Bulk', `2099-02-${String(i + 1).padStart(2, '0')}T09:00:00Z`)),
  ];
  await resetWith(SLOTS);
  {
    const list = await call('GET', '/slots');
    check('GET /slots → 200 {slots:[...]}', list.status === 200 && Array.isArray(list.json?.slots));
    const ids = (list.json?.slots ?? []).map((s) => s.id);
    check('ordered by start ascending', ids[0] === 'past' && ids.slice(1, 4).join() === 's1,s2,s3', ids.join());
    const s1 = list.json.slots.find((s) => s.id === 's1');
    check('slot has id/provider/start/end/available', s1 && s1.provider === 'Dr Ade' && s1.available === true);
    check('start/end echoed exactly as sent', s1?.start === FUTURE(10) && s1?.end === '2099-01-10T09:30:00Z', `${s1?.start}`);
    const ade = await call('GET', '/slots?provider=Dr%20Ade');
    check('provider filter (exact)', ade.json?.slots.length === 3 && ade.json.slots.every((s) => s.provider === 'Dr Ade'));
    const none = await call('GET', '/slots?provider=Dr');
    check('provider filter is exact, not prefix', none.json?.slots.length === 0);
  }
  let first;
  {
    first = await book('s1', '  Ada@Example.COM ', '  Ada Obi  ');
    const b = first.json;
    check('POST /bookings → 201', first.status === 201, `got ${first.status} ${first.text}`);
    check('booking shape + status confirmed', b && typeof b.id === 'string' && b.slot_id === 's1' && b.status === 'confirmed');
    check('name trimmed, email trimmed + lower-cased', b?.name === 'Ada Obi' && b?.email === 'ada@example.com', `${b?.name}|${b?.email}`);
    check('created_at is an ISO date-time', !Number.isNaN(Date.parse(b?.created_at)) && /T.*Z$/.test(b?.created_at));
    const got = await call('GET', `/bookings/${b.id}`);
    check('GET /bookings/:id → 200 same booking', got.status === 200 && got.json?.id === b.id && got.json?.email === 'ada@example.com');
    const missing = await call('GET', '/bookings/does-not-exist');
    check('unknown booking → 404 {error}', missing.status === 404 && isErr(missing));
    const s = (await call('GET', '/slots')).json.slots.find((x) => x.id === 's1');
    check('booked slot shows available:false', s.available === false);
  }

  // ───────────────────────────────────────────── Level 2: validation
  section('Level 2 · validation');
  {
    // Each case gets its OWN email: the limiter counts failed attempts, so reusing one
    // address across >5 invalid requests would (correctly) start returning 429.
    const E = '@b.co';
    const cases = [
      ['missing slot_id', (e) => ({ name: 'A', email: e })],
      ['empty slot_id', (e) => ({ slot_id: '', name: 'A', email: e })],
      ['missing name', (e) => ({ slot_id: 's2', email: e })],
      ['empty name', (e) => ({ slot_id: 's2', name: '', email: e })],
      ['whitespace-only name', (e) => ({ slot_id: 's2', name: '   ', email: e })],
      ['missing email', () => ({ slot_id: 's2', name: 'A' })],
      ['empty email', () => ({ slot_id: 's2', name: 'A', email: '' })],
      ['email without @', () => ({ slot_id: 's2', name: 'A', email: `nope${uniq()}` })],
      ['email without domain dot', () => ({ slot_id: 's2', name: 'A', email: `a${uniq()}@b` })],
      ['email with spaces inside', () => ({ slot_id: 's2', name: 'A', email: `a ${uniq()}@c.co` })],
      ['non-string name', (e) => ({ slot_id: 's2', name: 42, email: e })],
      ['non-string slot_id', (e) => ({ slot_id: 2, name: 'A', email: e })],
    ];
    for (const [label, make] of cases) {
      const r = await call('POST', '/bookings', { body: make(`v${uniq()}${E}`) });
      check(`400: ${label}`, r.status === 400 && isErr(r), `got ${r.status} ${r.text}`);
    }
    const arr = await call('POST', '/bookings', { body: [1, 2] });
    check('400: JSON array body', arr.status === 400 && isErr(arr));
    const bad = await call('POST', '/bookings', { rawBody: '{not json' });
    check('400: malformed JSON → {error}', bad.status === 400 && isErr(bad), `got ${bad.status} ${bad.text}`);
    const empty = await call('POST', '/bookings');
    check('400: empty body', empty.status === 400 && isErr(empty), `got ${empty.status}`);
    const unk = await book('no-such-slot', `v${uniq()}@x.co`);
    check('404: unknown slot', unk.status === 404 && isErr(unk));
    const past = await book('past', `v${uniq()}@x.co`);
    check('400: slot already started', past.status === 400 && isErr(past), `got ${past.status}`);
    const stillFree = (await call('GET', '/slots')).json.slots.find((x) => x.id === 's2');
    check('failed attempts did not book anything', stillFree.available === true);
  }

  // ───────────────────────────────────────────── Level 3
  section('Level 3 · conflicts, concurrency, cancellation');
  {
    const dup = await book('s1', `other-${uniq()}@example.com`);
    check('slot already booked → 409 {error}', dup.status === 409 && isErr(dup), `got ${dup.status}`);

    const N = 40;
    const results = await Promise.all(Array.from({ length: N }, (_, i) => book('s2', `racer${i}-${uniq()}@x.co`)));
    const codes = results.map((r) => r.status);
    check(`${N} simultaneous requests, one slot → exactly one 201`, codes.filter((c) => c === 201).length === 1, JSON.stringify(codes.filter((c) => c !== 409)));
    check(`…and ${N - 1} × 409, nothing else`, codes.filter((c) => c === 409).length === N - 1);

    const winner = results.find((r) => r.status === 201).json;
    const c1 = await call('DELETE', `/bookings/${winner.id}`);
    check('DELETE → 200 cancelled booking', c1.status === 200 && c1.json?.status === 'cancelled' && c1.json?.id === winner.id, `got ${c1.status} ${c1.text}`);
    const afterCancel = (await call('GET', '/slots')).json.slots.find((x) => x.id === 's2');
    check('cancel frees the slot', afterCancel.available === true);
    check('GET shows status cancelled', (await call('GET', `/bookings/${winner.id}`)).json?.status === 'cancelled');
    const again = await call('DELETE', `/bookings/${winner.id}`);
    check('cancel twice → 409 {error}', again.status === 409 && isErr(again));
    const nf = await call('DELETE', '/bookings/nope');
    check('cancel unknown → 404 {error}', nf.status === 404 && isErr(nf));
    const rebook = await book('s2', `second-${uniq()}@example.com`);
    check('slot can be booked again after cancel', rebook.status === 201 && rebook.json.id !== winner.id);

    const race = await Promise.all(Array.from({ length: 12 }, () => call('DELETE', `/bookings/${rebook.json.id}`)));
    const rc = race.map((r) => r.status);
    check('12 concurrent cancels → one 200, eleven 409', rc.filter((c) => c === 200).length === 1 && rc.filter((c) => c === 409).length === 11, rc.join());
  }

  // ───────────────────────────────────────────── Level 4: idempotency
  section('Level 4 · Idempotency-Key');
  {
    const key = `idem-${uniq()}`;
    const email = `idem-${uniq()}@x.co`;
    const a = await book('s3', email, 'Ida', { 'idempotency-key': key });
    const b = await book('s3', email, 'Ida', { 'idempotency-key': key });
    check('first call → 201', a.status === 201);
    check('retry → same status and same booking id', b.status === 201 && b.json?.id === a.json?.id, `${b.status} ${b.json?.id}`);
    const reordered = await call('POST', '/bookings', {
      headers: { 'idempotency-key': key },
      rawBody: JSON.stringify({ email, name: 'Ida', slot_id: 's3' }),
    });
    check('same body with different key order still replays', reordered.status === 201 && reordered.json?.id === a.json?.id);
    const diff = await book('s3', email, 'Someone Else', { 'idempotency-key': key });
    check('same key, different body → 422 {error}', diff.status === 422 && isErr(diff), `got ${diff.status}`);
    const mine = await call('GET', `/bookings?email=${encodeURIComponent(email)}`);
    check('exactly one booking was created', mine.json?.bookings.length === 1);

    const failKey = `idem-${uniq()}`;
    const f1 = await book('s3', `other-${uniq()}@x.co`, 'Z', { 'idempotency-key': failKey });
    const f2 = await book('s3', `changed-${uniq()}@x.co`, 'Z', { 'idempotency-key': failKey });
    check('a 409 outcome is itself a stable response for its key (422 for changed body)', f1.status === 409 && f2.status === 422, `${f1.status}/${f2.status}`);
    const sameEmail = `same-${uniq()}@x.co`;
    const f3a = await book('s3', sameEmail, 'Z', { 'idempotency-key': 'fixed-' + failKey });
    const f3b = await book('s3', sameEmail, 'Z', { 'idempotency-key': 'fixed-' + failKey });
    check('replayed 409 returns 409 again', f3a.status === 409 && f3b.status === 409);

    // Retry storm: 25 identical requests at once.
    const stormKey = `storm-${uniq()}`;
    const stormEmail = `storm-${uniq()}@x.co`;
    const storm = await Promise.all(Array.from({ length: 25 }, () => book('x1', stormEmail, 'Storm', { 'idempotency-key': stormKey })));
    const ids = new Set(storm.map((r) => r.json?.id));
    check('25 concurrent identical retries → all 201, ONE booking id', storm.every((r) => r.status === 201) && ids.size === 1, `${[...new Set(storm.map((r) => r.status))]} ids=${ids.size}`);
    const stormList = await call('GET', `/bookings?email=${encodeURIComponent(stormEmail)}`);
    check('…and exactly one row exists', stormList.json?.bookings.length === 1);

    const k1 = await book('x2', `nokey-${uniq()}@x.co`);
    const k2 = await book('x2', `nokey2-${uniq()}@x.co`);
    check('without a key, a repeat is a normal 409', k1.status === 201 && k2.status === 409);
  }

  // ───────────────────────────────────────────── Level 4: pagination
  section('Level 4 · cursor pagination');
  {
    const email = `Pager-${uniq()}@Example.com`;
    const made = [];
    for (let i = 1; i <= 5; i++) {
      const r = await book(`x${i + 2}`, i % 2 ? email : email.toUpperCase(), `P${i}`);
      made.push(r.json?.id);
    }
    await call('DELETE', `/bookings/${made[1]}`); // a cancelled booking must still be listed
    const q = encodeURIComponent(email.toLowerCase());

    const p1 = await call('GET', `/bookings?email=${q}&limit=2`);
    check('page 1 → 2 bookings + next_cursor', p1.status === 200 && p1.json?.bookings.length === 2 && typeof p1.json?.next_cursor === 'string', p1.text);
    const p2 = await call('GET', `/bookings?email=${q}&limit=2&cursor=${encodeURIComponent(p1.json.next_cursor)}`);
    const p3 = await call('GET', `/bookings?email=${q}&limit=2&cursor=${encodeURIComponent(p2.json.next_cursor)}`);
    check('page 2 → 2 bookings, page 3 → 1', p2.json?.bookings.length === 2 && p3.json?.bookings.length === 1);
    check('last page has next_cursor: null', p3.json?.next_cursor === null);
    const all = [...p1.json.bookings, ...p2.json.bookings, ...p3.json.bookings].map((b) => b.id);
    check('oldest first, no gaps, no duplicates', all.join() === made.join(), `${all.length} vs ${made.length}`);
    check('includes cancelled bookings', [...p1.json.bookings, ...p2.json.bookings].some((b) => b.status === 'cancelled'));
    const exact = await call('GET', `/bookings?email=${q}&limit=5`);
    check('page exactly `limit` long, nothing after → next_cursor: null (no phantom page)', exact.json?.bookings.length === 5 && exact.json?.next_cursor === null);
    const def = await call('GET', `/bookings?email=${q}`);
    check('default limit works', def.status === 200 && def.json?.bookings.length === 5);
    const upper = await call('GET', `/bookings?email=${encodeURIComponent(email.toUpperCase())}`);
    check('email match ignores case', upper.json?.bookings.length === 5);
    const nobody = await call('GET', '/bookings?email=nobody@nowhere.co');
    check('unknown email → empty page, null cursor', nobody.status === 200 && nobody.json?.bookings.length === 0 && nobody.json?.next_cursor === null);

    for (const bad of ['0', '51', '-1', 'abc', '1.5', '', '1e1', '999999999999']) {
      const r = await call('GET', `/bookings?email=${q}&limit=${bad}`);
      check(`limit=${JSON.stringify(bad)} → 400`, r.status === 400 && isErr(r), `got ${r.status}`);
    }
    check('limit=1 and limit=50 are accepted', (await call('GET', `/bookings?email=${q}&limit=1`)).status === 200 && (await call('GET', `/bookings?email=${q}&limit=50`)).status === 200);
    const noEmail = await call('GET', '/bookings');
    check('missing email → 400', noEmail.status === 400 && isErr(noEmail));
    const badCursor = await call('GET', `/bookings?email=${q}&cursor=not-a-real-cursor!!`);
    check('garbage cursor → 400', badCursor.status === 400 && isErr(badCursor), `got ${badCursor.status}`);
  }

  // ───────────────────────────────────────────── Level 5
  section('Level 5 · rate limit (5 attempts / email / minute)');
  {
    const email = `spam-${uniq()}@x.co`;
    const seen = [];
    seen.push((await book('no-such-slot', email)).status); // 404  — failed attempts count
    seen.push((await call('POST', '/bookings', { body: { slot_id: 'x9', email } })).status); // 400 missing name
    seen.push((await book('x9', email)).status); // 201
    seen.push((await book('x9', email)).status); // 409
    seen.push((await book('x9', email)).status); // 409
    check('attempts 1-5 are processed (404, 400, 201, 409, 409)', seen.join() === '404,400,201,409,409', seen.join());
    const sixth = await book('x9', email);
    check('6th attempt → 429 {error}', sixth.status === 429 && isErr(sixth), `got ${sixth.status}`);
    const ra = sixth.headers.get('retry-after');
    check('Retry-After is whole seconds in 1..60', /^\d+$/.test(ra ?? '') && Number(ra) >= 1 && Number(ra) <= 60, `${ra}`);
    const variant = await book('x9', `  ${email.toUpperCase()}  `);
    check('same email differing in case/whitespace shares the bucket', variant.status === 429);
    const other = await book('x10', `fresh-${uniq()}@x.co`);
    check('other emails are unaffected', other.status === 201);
    const getsFree = await call('GET', '/slots');
    check('reads are not rate limited', getsFree.status === 200);

    const burstEmail = `burst-${uniq()}@x.co`;
    const burst = await Promise.all(Array.from({ length: 15 }, () => book('no-such-slot', burstEmail)));
    const bc = burst.map((r) => r.status);
    check('15 simultaneous attempts → exactly 5 processed, 10 × 429', bc.filter((c) => c === 404).length === 5 && bc.filter((c) => c === 429).length === 10, bc.join());

    const rKey = `rl-${uniq()}`;
    const rEmail = `replay-${uniq()}@x.co`;
    const rFirst = await book('x11', rEmail, 'R', { 'idempotency-key': rKey });
    const replays = await Promise.all(Array.from({ length: 8 }, () => book('x11', rEmail, 'R', { 'idempotency-key': rKey })));
    check('idempotent replays are not new attempts (8 retries, none 429)', rFirst.status === 201 && replays.every((r) => r.status === 201 && r.json.id === rFirst.json.id), replays.map((r) => r.status).join());

    if (SLOW) {
      const wait = Number(ra) + 1;
      console.log(`  … waiting ${wait}s for the window to slide`);
      await new Promise((r) => setTimeout(r, wait * 1000));
      const reopened = await book('x9', email);
      check('after Retry-After elapses the email can attempt again (409, not 429)', reopened.status === 409, `got ${reopened.status}`);
    } else {
      console.log('  (skipped: window-slide check, run with --slow)');
    }

    await resetWith([slot('s1', 'Dr Ade', FUTURE(10))]);
    const afterReset = await book('s1', email);
    check('/reset clears limiter history and old bookings', afterReset.status === 201);
    const gone = await call('GET', `/bookings?email=${encodeURIComponent(email)}`);
    check('/reset wiped earlier bookings', gone.json?.bookings.length === 1);
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\nSuite crashed:', err);
  process.exit(2);
});
