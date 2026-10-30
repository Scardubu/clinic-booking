export interface BookingCursor {
  createdAt: string;
  id: string;
}

export function encodeCursor(cursor: BookingCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeCursor(token: string): BookingCursor | null {
  try {
    const json = Buffer.from(token, 'base64url').toString('utf8');
    const parsed = JSON.parse(json);
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.createdAt === 'string' &&
      typeof parsed.id === 'string' &&
      !Number.isNaN(Date.parse(parsed.createdAt))
    ) {
      return { createdAt: parsed.createdAt, id: parsed.id };
    }
    return null;
  } catch {
    return null;
  }
}