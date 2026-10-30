// clinic-booking/web/api/[...path].js
export default async function handler(req, res) {
  const apiBase = (process.env.API_BASE_URL || '').replace(/\/$/, '');
  const apiKey = process.env.API_KEY || req.headers['x-api-key'] || '';

  if (!apiBase) {
    return res.status(500).json({
      error: {
        code: 'MISSING_API_BASE_URL',
        message: 'Set API_BASE_URL and API_KEY in your Vercel Project Environment Variables.',
      },
    });
  }

  const subPath = req.url.replace(/^\/api/, '') || '/';
  const targetUrl = `${apiBase}${subPath}`;

  const headers = {
    'Content-Type': 'application/json',
    'X-API-Key': apiKey,
  };

  if (req.headers['idempotency-key']) {
    headers['Idempotency-Key'] = req.headers['idempotency-key'];
  }
  if (req.headers['x-forwarded-for']) {
    headers['X-Forwarded-For'] = req.headers['x-forwarded-for'];
  }

  try {
    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body || {}),
    });

    const bodyText = await upstream.text();
    const retryAfter = upstream.headers.get('retry-after');
    if (retryAfter) res.setHeader('Retry-After', retryAfter);

    res.status(upstream.status);
    try {
      res.json(JSON.parse(bodyText));
    } catch {
      res.send(bodyText);
    }
  } catch (err) {
    res.status(502).json({
      error: {
        code: 'UPSTREAM_UNREACHABLE',
        message: 'Could not reach the backend API server.',
      },
    });
  }
}