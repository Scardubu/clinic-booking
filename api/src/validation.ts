// Pragmatic email check: one @, no whitespace, a dot in the domain. Deliverability
// is not something regexes can prove; this rejects the junk the spec cares about.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_NAME = 200;
const MAX_EMAIL = 254;
const MAX_SLOT_ID = 200;

export const normalizeEmail = (raw: string): string => raw.trim().toLowerCase();

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export interface NewBooking {
  slotId: string;
  name: string;
  email: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Level 2 field validation. Returns the FIRST problem so the client gets one
 * clear message. Name and email are trimmed; email is lower-cased.
 */
export function parseNewBooking(body: unknown): Result<NewBooking> {
  if (!isRecord(body)) return { ok: false, error: 'request body must be a JSON object' };

  const { slot_id, name, email } = body;

  if (typeof slot_id !== 'string' || slot_id.trim() === '') {
    return { ok: false, error: 'slot_id is required' };
  }
  if (slot_id.length > MAX_SLOT_ID) return { ok: false, error: 'slot_id is too long' };

  if (typeof name !== 'string' || name.trim() === '') {
    return { ok: false, error: 'name is required' };
  }
  const cleanName = name.trim();
  if (cleanName.length > MAX_NAME) return { ok: false, error: `name must be at most ${MAX_NAME} characters` };

  if (typeof email !== 'string' || email.trim() === '') {
    return { ok: false, error: 'email is required' };
  }
  const cleanEmail = normalizeEmail(email);
  if (cleanEmail.length > MAX_EMAIL || !EMAIL_RE.test(cleanEmail)) {
    return { ok: false, error: 'email is not valid' };
  }

  return { ok: true, value: { slotId: slot_id, name: cleanName, email: cleanEmail } };
}

/**
 * Level 5 limiter key. Derived from the RAW body *before* validation so that
 * failed attempts (bad payloads, unknown slots, conflicts) are counted too.
 * No usable email string => no key => nothing to attribute the attempt to.
 */
export function rateLimitKey(body: unknown): string | null {
  if (!isRecord(body) || typeof body.email !== 'string') return null;
  const key = normalizeEmail(body.email);
  return key === '' ? null : key;
}

export interface NewSlot {
  id: string;
  provider: string;
  startAt: string; // normalised ISO, for the timestamptz column
  endAt: string;
  startRaw: string; // as sent, echoed back verbatim
  endRaw: string;
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/i;

function parseInstant(v: unknown): { raw: string; iso: string } | null {
  if (typeof v !== 'string' || !ISO_RE.test(v)) return null;
  // No offset => treat as UTC rather than server-local time.
  const hasOffset = /(Z|[+-]\d{2}:\d{2})$/i.test(v);
  const ms = Date.parse(hasOffset ? v : `${v}Z`);
  return Number.isNaN(ms) ? null : { raw: v, iso: new Date(ms).toISOString() };
}

/** POST /reset body. */
export function parseSlots(body: unknown): Result<NewSlot[]> {
  if (!isRecord(body) || !Array.isArray(body.slots)) {
    return { ok: false, error: 'body must be {"slots": [...]}' };
  }
  const seen = new Set<string>();
  const out: NewSlot[] = [];
  for (const [i, s] of body.slots.entries()) {
    if (!isRecord(s)) return { ok: false, error: `slots[${i}] must be an object` };
    if (typeof s.id !== 'string' || s.id === '') return { ok: false, error: `slots[${i}].id is required` };
    if (typeof s.provider !== 'string' || s.provider === '') {
      return { ok: false, error: `slots[${i}].provider is required` };
    }
    const start = parseInstant(s.start);
    const end = parseInstant(s.end);
    if (!start) return { ok: false, error: `slots[${i}].start must be an ISO 8601 date-time` };
    if (!end) return { ok: false, error: `slots[${i}].end must be an ISO 8601 date-time` };
    if (seen.has(s.id)) return { ok: false, error: `duplicate slot id "${s.id}"` };
    seen.add(s.id);
    out.push({
      id: s.id,
      provider: s.provider,
      startAt: start.iso,
      endAt: end.iso,
      startRaw: start.raw,
      endRaw: end.raw,
    });
  }
  return { ok: true, value: out };
}
