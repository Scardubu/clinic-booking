import crypto from 'crypto';

export function safeEqual(provided: string, expected: string): boolean {
  if (typeof provided !== 'string' || typeof expected !== 'string') {
    return false;
  }
  const a = Buffer.from(provided.trim(), 'utf8');
  const b = Buffer.from(expected.trim(), 'utf8');
  if (a.length === 0 || b.length === 0) {
    return false;
  }
  if (a.length !== b.length) {
    const digestA = crypto.createHash('sha256').update(a).digest();
    const digestB = crypto.createHash('sha256').update(b).digest();
    crypto.timingSafeEqual(digestA, digestB);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}