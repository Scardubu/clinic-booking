/**
 * Deterministic JSON: object keys sorted recursively. Two request bodies that
 * differ only in key order or whitespace hash identically, so an Idempotency-Key
 * retry from a client that re-serialises its payload is not mistaken for a
 * different request.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const parts = Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
