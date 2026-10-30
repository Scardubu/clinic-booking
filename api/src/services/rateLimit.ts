import { Request, Response, NextFunction } from 'express';
import { config } from '../config.js';
import { ApiError } from '../validation.js';

interface SlidingBucket {
  timestamps: number[];
}

const memoryBuckets = new Map<string, SlidingBucket>();

export function evaluateSlidingWindow(
  bucketKey: string,
  windowMs = config.rateLimitWindowMs,
  maxRequests = config.rateLimitMaxRequests
): {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
  resetAtEpochSeconds: number;
} {
  const now = Date.now();
  const windowStart = now - windowMs;

  let bucket = memoryBuckets.get(bucketKey);
  if (!bucket) {
    bucket = { timestamps: [] };
    memoryBuckets.set(bucketKey, bucket);
  }

  bucket.timestamps = bucket.timestamps.filter((ts) => ts > windowStart);

  if (bucket.timestamps.length >= maxRequests) {
    const oldest = bucket.timestamps[0];
    const retryAfterMs = Math.max(1000, oldest + windowMs - now);
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
      resetAtEpochSeconds: Math.ceil((oldest + windowMs) / 1000),
    };
  }

  bucket.timestamps.push(now);
  return {
    allowed: true,
    remaining: Math.max(0, maxRequests - bucket.timestamps.length),
    retryAfterSeconds: 0,
    resetAtEpochSeconds: Math.ceil((now + windowMs) / 1000),
  };
}

export function resetRateLimiterMemory(): void {
  memoryBuckets.clear();
}

export function bookingRateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
  const forwarded = req.headers['x-forwarded-for'];
  const ip =
    (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : req.ip) || 'unknown-ip';

  const customActor =
    (req.headers['x-client-id'] as string) ||
    (req.headers['x-rate-limit-key'] as string) ||
    ip;

  const bucketKey = `booking:${customActor}`;
  const status = evaluateSlidingWindow(bucketKey);

  res.setHeader('X-RateLimit-Limit', String(config.rateLimitMaxRequests));
  res.setHeader('X-RateLimit-Remaining', String(status.remaining));
  res.setHeader('X-RateLimit-Reset', String(status.resetAtEpochSeconds));

  if (!status.allowed) {
    res.setHeader('Retry-After', String(status.retryAfterSeconds));
    return next(
      new ApiError(
        429,
        'RATE_LIMIT_EXCEEDED',
        `Rate limit exceeded. Try again in ${status.retryAfterSeconds} seconds.`
      )
    );
  }

  next();
}