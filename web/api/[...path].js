// Vercel serverless proxy: browser -> /api/* -> Render API.
//
// Why a proxy instead of calling the API from the browser:
//   1. The API key stays in a server-side env var. A key baked into client JS is public.
//   2. No CORS surface to configure or get wrong.
//   3. It lets us expose ONLY what the page needs. /reset (wipes the database) and the
//      list-bookings-by-email endpoint (a PII lookup) are deliberately NOT reachable
//      from the public page. A booking is retrievable only by its unguessable UUID.
//
// CommonJS on purpose: works on Vercel with no package.json "type" configuration.

const BOOKING_ID = '[A-Za-z0-9-]{1,64}';
const ALLOWED = [
  { method: 'GET', re: /^\/slots$/ },
  { method: 'POST', re: /^\/bookings$/ },
  { method: 'GET', re: new RegExp(`^/bookings/${BOOKING_ID}$`) },
  { method: 'DELETE', re: new RegExp(`^/bookings/${BOOKING_ID}$`) },
];

module.exports = async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');

  const base = (process.env.API_BASE_URL || '').replace(/\/+$/, '');
  const key = process.env.API_KEY;
  if (!base || !key) return res.status(500).json({ error: 'proxy is not configured' });

  const url = new URL(req.url, 'http://local');
  const path = url.pathname.replace(/^\/api/, '').replace(/\/+$/, '') || '/';
  if (!ALLOWED.some((r) => r.method === req.method && r.re.test(path))) {
    return res.status(404).json({ error: 'not found' });
  }

  const headers = { 'x-api-key': key, accept: 'application/json' };
  let body;
  if (req.method === 'POST') {
    headers['content-type'] = 'application/json';
    const idem = req.headers['idempotency-key'];
    if (typeof idem === 'string' && idem) headers['idempotency-key'] = idem;
    try {
      body = JSON.stringify(req.body ?? {});
    } catch {
      return res.status(400).json({ error: 'request body is not valid JSON' });
    }
  }
  const search = path === '/slots' ? url.search : ''; // only /slots takes a query (provider)

  try {
    const upstream = await fetch(base + path + search, {
      method: req.method,
      headers,
      body,
      redirect: 'manual',
      // The free API host cold-starts in up to ~a minute; don't give up before it wakes.
      signal: AbortSignal.timeout(55_000),
    });
    for (const h of ['retry-after', 'idempotent-replayed']) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    res.setHeader('content-type', 'application/json; charset=utf-8');
    return res.status(upstream.status).send(await upstream.text());
  } catch {
    return res.status(504).json({ error: 'the booking service did not respond in time' });
  }
};
