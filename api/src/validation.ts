const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_REGEX = /^\+?[0-9\s\-().]{7,25}$/;

export interface CreateBookingInput {
  slotId: string;
  patientName: string;
  patientEmail: string;
  patientPhone?: string;
  reason?: string;
}

export class ApiError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: string[];

  constructor(statusCode: number, code: string, message: string, details?: string[]) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function isValidUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value.trim());
}

export function validateCreateBooking(body: unknown): CreateBookingInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'INVALID_PAYLOAD', 'Request body must be a valid JSON object.');
  }

  const raw = body as Record<string, unknown>;
  const patientObj =
    raw.patient && typeof raw.patient === 'object' && !Array.isArray(raw.patient)
      ? (raw.patient as Record<string, unknown>)
      : {};

  const slotId = String(raw.slotId ?? raw.slot_id ?? '').trim();
  const patientName = String(
    raw.patientName ?? raw.patient_name ?? raw.name ?? patientObj.name ?? ''
  ).trim();
  const patientEmail = String(
    raw.patientEmail ?? raw.patient_email ?? raw.email ?? patientObj.email ?? ''
  )
    .trim()
    .toLowerCase();

  const rawPhone = raw.patientPhone ?? raw.patient_phone ?? raw.phone ?? patientObj.phone;
  const rawReason = raw.reason ?? raw.notes ?? raw.description;

  const errors: string[] = [];

  if (!slotId) {
    errors.push('slot_id is required.');
  }

  if (!patientName) {
    errors.push('name is required.');
  } else if (patientName.length < 1 || patientName.length > 120) {
    errors.push('name must be between 1 and 120 characters.');
  }

  if (!patientEmail) {
    errors.push('email is required.');
  } else if (!EMAIL_REGEX.test(patientEmail) || patientEmail.length > 255) {
    errors.push('email must be a valid email address.');
  }

  let patientPhone: string | undefined;
  if (rawPhone !== undefined && rawPhone !== null && String(rawPhone).trim() !== '') {
    patientPhone = String(rawPhone).trim();
    if (!PHONE_REGEX.test(patientPhone)) {
      errors.push('patientPhone must be a valid phone number.');
    }
  }

  let reason: string | undefined;
  if (rawReason !== undefined && rawReason !== null && String(rawReason).trim() !== '') {
    reason = String(rawReason).trim();
    if (reason.length > 500) {
      errors.push('reason must not exceed 500 characters.');
    }
  }

  if (errors.length > 0) {
    throw new ApiError(400, 'VALIDATION_ERROR', errors[0], errors);
  }

  return { slotId, patientName, patientEmail, patientPhone, reason };
}