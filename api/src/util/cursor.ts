/** Opaque cursor = base64url of the last-seen bookings.seq. */
export function encodeCursor(seq: string): string {
  return Buffer.from(seq, 'utf8').toString('base64url');
}

/** Returns the seq as a digit string (bigint-safe), or null if the cursor is not one we issued. */
export function decodeCursor(cursor: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(cursor)) return null;
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  return /^[0-9]{1,18}$/.test(decoded) ? decoded : null;
}
