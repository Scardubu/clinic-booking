// clinic-booking/web/api/[...path].js

export const config = {
  maxDuration: 60,
};

function sendResponse(res, statusCode, body, contentType) {
  if (typeof res.status === 'function') {
    res.status(statusCode);
  } else {
    res.statusCode = statusCode;
  }

  if (contentType && typeof res.setHeader === 'function') {
    res.setHeader('Content-Type', contentType);
  }

  if (body !== undefined && body !== null) {
    if (typeof body === 'object' && !Buffer.isBuffer(body)) {
      const jsonStr = JSON.stringify(body);
      if (typeof res.json === 'function') {
        return res.json(body);
      }
      if (typeof res.send === 'function') {
        return res.send(jsonStr);
      }
      return res.end(jsonStr);
    }

    if (typeof res.send === 'function') {
      return res.send(body);
    }
    return res.end(body);
  }

  return res.end();
}

export default async function handler(req, res) {
  try {
    // Handle favicon to avoid 404/500 proxy errors
    if (req.url && req.url.includes('favicon.ico')) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🏥</text></svg>`;
      if (typeof res.setHeader === 'function') {
        res.setHeader('Cache-Control', 'public, max-age=86400');
      }
      return sendResponse(res, 200, svg, 'image/svg+xml');
    }

    // Resolve backend target URL: default to live Render production backend if unset
    let backendBase = (
      process.env.BACKEND_URL ||
      process.env.API_BASE_URL ||
      'https://clinic-booking-api-od9i.onrender.com'
    ).trim().replace(/\/$/, '');

    if (!/^https?:\/\//i.test(backendBase)) {
      backendBase = `https://${backendBase}`;
    }

    // Preserve client-provided API key; fallback to production key if client omitted it
    const incomingApiKey = req.headers ? (req.headers['x-api-key'] || req.headers['api-key']) : undefined;
    const apiKey = incomingApiKey !== undefined
      ? (Array.isArray(incomingApiKey) ? incomingApiKey[0] : String(incomingApiKey))
      : (process.env.API_KEY || 'koya_live_9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c');

    // Robustly extract path and preserve query parameters
    const parsedUrl = new URL(req.url || '/', 'http://localhost');
    let pathname = parsedUrl.pathname.replace(/^\/api\/?/, '/');

    if (pathname.includes('[...path]') || !pathname || pathname === '/') {
      if (req.query && req.query.path) {
        const routePath = Array.isArray(req.query.path)
          ? req.query.path.join('/')
          : String(req.query.path);
        pathname = `/${routePath.replace(/^\/+/, '')}`;
      } else if (req.headers && req.headers['x-matched-path']) {
        pathname = req.headers['x-matched-path'].replace(/^\/api\/?/, '/');
      }
    }

    if (!pathname.startsWith('/')) {
      pathname = `/${pathname}`;
    }

    // Security Guardrail: Block administrative endpoints from being invoked via public edge proxy
    const cleanPath = pathname.replace(/\/+$/, '').toLowerCase();
    if (cleanPath === '/reset' || cleanPath.endsWith('/reset')) {
      return sendResponse(
        res,
        403,
        {
          error: 'Forbidden',
          message: 'Administrative endpoints cannot be accessed via the public edge proxy.',
        },
        'application/json'
      );
    }

    const searchParams = new URLSearchParams(parsedUrl.search);
    searchParams.delete('path'); // Remove Vercel catch-all parameter if injected

    if (req.query) {
      for (const [key, val] of Object.entries(req.query)) {
        if (key !== 'path' && !searchParams.has(key)) {
          if (Array.isArray(val)) {
            for (const v of val) searchParams.append(key, String(v));
          } else if (val !== undefined && val !== null) {
            searchParams.set(key, String(val));
          }
        }
      }
    }

    const qs = searchParams.toString();
    const targetUrl = `${backendBase}${pathname}${qs ? `?${qs}` : ''}`;

    // Forward HTTP headers safely without duplicate case-variant collision
    const forwardHeaders = {};
    const managedHeaders = new Set([
      'host',
      'connection',
      'content-length',
      'x-api-key',
      'api-key',
      'idempotency-key',
      'x-idempotency-key',
      'authorization',
      'content-type',
    ]);

    for (const [key, val] of Object.entries(req.headers || {})) {
      const lowerKey = key.toLowerCase();
      if (val !== undefined && !managedHeaders.has(lowerKey)) {
        forwardHeaders[lowerKey] = Array.isArray(val) ? val.join(', ') : String(val);
      }
    }

    if (apiKey) {
      forwardHeaders['X-API-Key'] = apiKey;
    }
    const idemKey = req.headers ? (req.headers['idempotency-key'] || req.headers['x-idempotency-key']) : undefined;
    if (idemKey) {
      forwardHeaders['Idempotency-Key'] = Array.isArray(idemKey) ? idemKey[0] : String(idemKey);
    }
    const authHeader = req.headers ? req.headers['authorization'] : undefined;
    if (authHeader) {
      forwardHeaders['Authorization'] = Array.isArray(authHeader) ? authHeader[0] : String(authHeader);
    }
    const contentType = (req.headers && req.headers['content-type']) || 'application/json';
    if (contentType) {
      forwardHeaders['Content-Type'] = Array.isArray(contentType) ? contentType[0] : String(contentType);
    }

    let body;
    if (!['GET', 'HEAD'].includes(req.method)) {
      if (Buffer.isBuffer(req.body)) {
        body = req.body;
      } else if (typeof req.body === 'string') {
        body = req.body;
      } else if (req.body && typeof req.body === 'object') {
        body = JSON.stringify(req.body);
      } else if (req.body !== undefined && req.body !== null) {
        body = String(req.body);
      } else if (typeof req.on === 'function') {
        body = await new Promise((resolve, reject) => {
          const chunks = [];
          req.on('data', chunk => chunks.push(chunk));
          req.on('end', () => resolve(Buffer.concat(chunks)));
          req.on('error', reject);
        });
      }
    }

    // Set 55s timeout controller to preempt Vercel serverless freeze on long cold starts
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 55000);

    let upstream;
    try {
      upstream = await fetch(targetUrl, {
        method: req.method,
        headers: forwardHeaders,
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    const bodyText = await upstream.text();

    // Forward rate limit and caching headers
    if (typeof res.setHeader === 'function') {
      const retryAfter = upstream.headers.get('retry-after');
      if (retryAfter) res.setHeader('Retry-After', retryAfter);

      const rateLimitLimit = upstream.headers.get('x-ratelimit-limit');
      if (rateLimitLimit) res.setHeader('X-RateLimit-Limit', rateLimitLimit);

      const rateLimitRemaining = upstream.headers.get('x-ratelimit-remaining');
      if (rateLimitRemaining) res.setHeader('X-RateLimit-Remaining', rateLimitRemaining);

      const rateLimitReset = upstream.headers.get('x-ratelimit-reset');
      if (rateLimitReset) res.setHeader('X-RateLimit-Reset', rateLimitReset);

      const idempotentReplayed = upstream.headers.get('idempotent-replayed');
      if (idempotentReplayed) res.setHeader('Idempotent-Replayed', idempotentReplayed);
    }

    const upstreamContentType = upstream.headers.get('content-type') || 'application/json';
    return sendResponse(res, upstream.status, bodyText, upstreamContentType);
  } catch (err) {
    const isTimeout = err?.name === 'AbortError' || err?.message?.includes('timeout') || err?.message?.includes('aborted');
    const statusCode = isTimeout ? 504 : 502;
    return sendResponse(
      res,
      statusCode,
      {
        error: isTimeout ? 'Gateway Timeout' : 'Upstream gateway error',
        message: isTimeout
          ? 'The clinic booking server timed out while waking up. Please retry in a few moments.'
          : (err?.message || 'Unable to communicate with upstream booking API.'),
        details: err?.message,
      },
      'application/json'
    );
  }
}