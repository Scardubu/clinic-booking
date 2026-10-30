import crypto from 'crypto';

export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const pairs = keys
    .filter((k) => record[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalize(record[k])}`);
  return `{${pairs.join(',')}}`;
}

export const canonicalJson = canonicalize;

export function hashPayload(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalize(value)).digest('hex');
}