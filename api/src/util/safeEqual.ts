import crypto from 'crypto';

export function safeEqual(provided: string, expected: string): boolean {
  if (typeof provided !== 'string' || typeof expected !== 'string') {
    return false;
  }
  const digestA = crypto.createHash('sha256').update(provided, 'utf8').digest();
  const digestB = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(digestA, digestB);
}