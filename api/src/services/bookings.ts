import crypto from 'node:crypto';
import { pool, withTransaction } from '../db.js';
import { ApiError, CreateBookingInput } from '../validation.js';
import { hashPayload } from '../util/canonical.js';
import { decodeCursor, encodeCursor } from '../util/cursor.js';

export interface BookingDTO {
  id: string;
  slot_id: string;
  slotId: string;
  name: string;
  patient_name: string;
  patientName: string;
  email: string;
  patient_email: string;
  patientEmail: string;
  patientPhone: string | null;
  patient_phone: string | null;
  reason: string | null;
  status: 'confirmed' | 'cancelled';
  created_at: string;
  createdAt: string;
  cancelled_at: string | null;
  cancelledAt: string | null;
  slot?: {
    id: string;
    provider: string;
    doctorName: string;
    doctor_name: string;
    start: string;
    startTime: string;
    start_time: string;
    end: string;
    endTime: string;
    end_time: string;
  };
}

export function mapBookingRow(row: any): BookingDTO {
  const createdIso = new Date(row.created_at).toISOString();
  const cancelledIso = row.cancelled_at ? new Date(row.cancelled_at).toISOString() : null;
  const statusLower = String(row.status || 'confirmed').toLowerCase() as 'confirmed' | 'cancelled';

  const dto: BookingDTO = {
    id: String(row.id),
    slot_id: String(row.slot_id),
    slotId: String(row.slot_id),
    name: row.patient_name,
    patientName: row.patient_name,
    patient_name: row.patient_name,
    email: row.patient_email,
    patientEmail: row.patient_email,
    patient_email: row.patient_email,
    patientPhone: row.patient_phone ?? null,
    patient_phone: row.patient_phone ?? null,
    reason: row.reason ?? null,
    status: statusLower,
    createdAt: createdIso,
    created_at: createdIso,
    cancelledAt: cancelledIso,
    cancelled_at: cancelledIso,
  };

  if (row.start_time && row.end_time) {
    const startIso = new Date(row.start_time).toISOString();
    const endIso = new Date(row.end_time).toISOString();
    const provider = row.provider || row.doctor_name || 'Clinic Physician';
    dto.slot = {
      id: String(row.slot_id),
      provider,
      doctorName: provider,
      doctor_name: provider,
      start: startIso,
      startTime: startIso,
      start_time: startIso,
      end: endIso,
      endTime: endIso,
      end_time: endIso,
    };
  }

  return dto;
}

export async function getIdempotencyRecord(key: string, clientScope = 'global') {
  const { rows } = await pool.query(
    `SELECT request_hash, response_status, response_body, status
     FROM idempotency_keys
     WHERE client_scope = $1 AND idempotency_key = $2 AND expires_at > NOW()`,
    [clientScope, key]
  );
  return rows[0] || null;
}

export async function createBooking(
  input: CreateBookingInput,
  idempotencyKey?: string,
  clientScope = 'global',
  rawBody?: any
): Promise<{ statusCode: number; body: any; replayed: boolean }> {
  const cleanIdemKey = idempotencyKey?.trim();
  const requestHash = hashPayload(rawBody ?? input);

  return withTransaction(async (client) => {
    if (cleanIdemKey) {
      if (cleanIdemKey.length > 255) {
        throw new ApiError(
          400,
          'INVALID_IDEMPOTENCY_KEY',
          'Idempotency-Key must not exceed 255 characters.'
        );
      }

      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `${clientScope}:${cleanIdemKey}`,
      ]);

      const idemRes = await client.query(
        `SELECT request_hash, response_status, response_body, status
         FROM idempotency_keys
         WHERE client_scope = $1 AND idempotency_key = $2 AND expires_at > NOW()
         FOR UPDATE`,
        [clientScope, cleanIdemKey]
      );

      if (idemRes.rowCount && idemRes.rows[0]) {
        const existing = idemRes.rows[0];
        if (existing.request_hash !== requestHash) {
          throw new ApiError(
            422,
            'IDEMPOTENCY_KEY_CONFLICT',
            'Idempotency-Key reused with a different body'
          );
        }
        if (existing.status === 'COMPLETED' && existing.response_body) {
          return {
            statusCode: existing.response_status || 201,
            body: existing.response_body,
            replayed: true,
          };
        }
      } else {
        await client.query(
          `INSERT INTO idempotency_keys (client_scope, idempotency_key, request_hash, status)
           VALUES ($1, $2, $3, 'IN_PROGRESS')
           ON CONFLICT (client_scope, idempotency_key) DO UPDATE
           SET request_hash = EXCLUDED.request_hash,
               status = 'IN_PROGRESS',
               expires_at = NOW() + INTERVAL '24 hours'`,
          [clientScope, cleanIdemKey, requestHash]
        );
      }
    }

    const slotRes = await client.query(
      `SELECT id, COALESCE(provider, doctor_name) AS provider, doctor_name, start_time, end_time, is_available
       FROM slots
       WHERE id = $1
       FOR UPDATE`,
      [input.slotId]
    );

    if (!slotRes.rowCount || !slotRes.rows[0]) {
      throw new ApiError(404, 'SLOT_NOT_FOUND', "The slot doesn't exist");
    }

    const slot = slotRes.rows[0];

    // Level 2: 400 if the slot has already started
    if (new Date(slot.start_time).getTime() <= Date.now()) {
      throw new ApiError(400, 'SLOT_ALREADY_STARTED', 'The slot has already started.');
    }

    // Level 3: 409 if slot already has a confirmed booking
    if (!slot.is_available) {
      throw new ApiError(
        409,
        'SLOT_ALREADY_BOOKED',
        'Slot already booked'
      );
    }

    const newBookingId = crypto.randomUUID();
    let insertedBooking: any;
    try {
      const insertRes = await client.query(
        `INSERT INTO bookings (id, slot_id, patient_name, patient_email, patient_phone, reason, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'confirmed')
         RETURNING *`,
        [
          newBookingId,
          input.slotId,
          input.patientName,
          input.patientEmail,
          input.patientPhone ?? null,
          input.reason ?? null,
        ]
      );
      insertedBooking = insertRes.rows[0];
    } catch (err: any) {
      if (err?.code === '23505') {
        throw new ApiError(
          409,
          'SLOT_ALREADY_BOOKED',
          'Slot already booked'
        );
      }
      throw err;
    }

    await client.query(
      `UPDATE slots SET is_available = FALSE, updated_at = NOW() WHERE id = $1`,
      [input.slotId]
    );

    const dto = mapBookingRow({
      ...insertedBooking,
      provider: slot.provider,
      doctor_name: slot.doctor_name,
      start_time: slot.start_time,
      end_time: slot.end_time,
    });

    const responseBody = {
      ...dto,
      booking: dto,
    };

    if (cleanIdemKey) {
      await client.query(
        `UPDATE idempotency_keys
         SET status = 'COMPLETED',
             response_status = 201,
             response_body = $3::jsonb,
             booking_id = $4
         WHERE client_scope = $1 AND idempotency_key = $2`,
        [clientScope, cleanIdemKey, JSON.stringify(responseBody), dto.id]
      );
    }

    return {
      statusCode: 201,
      body: responseBody,
      replayed: false,
    };
  });
}

export async function getBookingById(bookingId: string): Promise<BookingDTO> {
  const cleanId = String(bookingId || '').trim();
  if (!cleanId) {
    throw new ApiError(404, 'BOOKING_NOT_FOUND', 'No booking with that id');
  }

  const { rows, rowCount } = await pool.query(
    `SELECT b.*, COALESCE(s.provider, s.doctor_name) AS provider, s.doctor_name, s.start_time, s.end_time
     FROM bookings b
     JOIN slots s ON s.id = b.slot_id
     WHERE b.id = $1`,
    [cleanId]
  );

  if (!rowCount || !rows[0]) {
    throw new ApiError(404, 'BOOKING_NOT_FOUND', 'No booking with that id');
  }

  return mapBookingRow(rows[0]);
}

export async function cancelBooking(bookingId: string): Promise<BookingDTO> {
  const cleanId = String(bookingId || '').trim();
  if (!cleanId) {
    throw new ApiError(404, 'BOOKING_NOT_FOUND', 'No booking with that id');
  }

  return withTransaction(async (client) => {
    const existingRes = await client.query(
      `SELECT b.*, COALESCE(s.provider, s.doctor_name) AS provider, s.doctor_name, s.start_time, s.end_time
       FROM bookings b
       JOIN slots s ON s.id = b.slot_id
       WHERE b.id = $1
       FOR UPDATE OF b, s`,
      [cleanId]
    );

    if (!existingRes.rowCount || !existingRes.rows[0]) {
      throw new ApiError(404, 'BOOKING_NOT_FOUND', 'No booking with that id');
    }

    const booking = existingRes.rows[0];
    if (String(booking.status).toLowerCase() === 'cancelled') {
      throw new ApiError(409, 'BOOKING_ALREADY_CANCELLED', 'Already cancelled');
    }

    const updatedRes = await client.query(
      `UPDATE bookings
       SET status = 'cancelled', cancelled_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [cleanId]
    );

    await client.query(
      `UPDATE slots
       SET is_available = TRUE, updated_at = NOW()
       WHERE id = $1`,
      [booking.slot_id]
    );

    return mapBookingRow({
      ...updatedRes.rows[0],
      provider: booking.provider,
      doctor_name: booking.doctor_name,
      start_time: booking.start_time,
      end_time: booking.end_time,
    });
  });
}

export interface ListBookingsQuery {
  patientEmail?: string;
  status?: string;
  limit?: number | string;
  page?: number | string;
  offset?: number | string;
  cursor?: string;
}

export async function listBookingsPaginated(params: ListBookingsQuery) {
  if (params.limit !== undefined) {
    const rawLimit = String(params.limit).trim();
    if (!/^\d+$/.test(rawLimit)) {
      throw new ApiError(400, 'INVALID_LIMIT', 'Invalid limit');
    }
    const num = Number(rawLimit);
    if (num < 1 || num > 50) {
      throw new ApiError(400, 'INVALID_LIMIT', 'Invalid limit');
    }
  }

  const limit = params.limit !== undefined ? Number(params.limit) : 10;
  const values: any[] = [];
  const filters: string[] = [];

  if (params.patientEmail) {
    values.push(params.patientEmail.trim().toLowerCase());
    filters.push(`LOWER(b.patient_email) = $${values.length}`);
  }

  if (params.status && ['CONFIRMED', 'CANCELLED'].includes(params.status.toUpperCase())) {
    values.push(params.status.toLowerCase());
    filters.push(`LOWER(b.status) = $${values.length}`);
  }

  const baseWhere = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
  const countRes = await pool.query(
    `SELECT COUNT(*)::int AS total FROM bookings b ${baseWhere}`,
    values
  );
  const total = countRes.rows[0]?.total ?? 0;

  if (params.cursor) {
    const decoded = decodeCursor(params.cursor);
    if (!decoded) {
      throw new ApiError(400, 'INVALID_CURSOR', 'Invalid pagination cursor.');
    }
    values.push(decoded.createdAt, decoded.id);
    filters.push(
      `((date_trunc('milliseconds', b.created_at), b.id) > (date_trunc('milliseconds', $${values.length - 1}::timestamptz), $${values.length}::text))`
    );
  }

  const whereClause = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
  const page = Math.max(1, Number(params.page) || 1);
  const offset =
    params.offset !== undefined ? Math.max(0, Number(params.offset)) : (page - 1) * limit;

  let offsetSql = '';
  if (!params.cursor && offset > 0) {
    values.push(offset);
    offsetSql = `OFFSET $${values.length}`;
  }

  values.push(limit + 1);
  const limitIdx = values.length;

  // OpenAPI spec: "That person's bookings, oldest first."
  const { rows } = await pool.query(
    `SELECT b.*, COALESCE(s.provider, s.doctor_name) AS provider, s.doctor_name, s.start_time, s.end_time
     FROM bookings b
     JOIN slots s ON s.id = b.slot_id
     ${whereClause}
     ORDER BY date_trunc('milliseconds', b.created_at) ASC, b.id ASC
     LIMIT $${limitIdx}
     ${offsetSql}`,
    values
  );

  const hasMore = rows.length > limit;
  const sliced = hasMore ? rows.slice(0, limit) : rows;
  const bookings = sliced.map(mapBookingRow);
  const last = bookings[bookings.length - 1];
  const nextCursor =
    hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null;

  return {
    bookings,
    next_cursor: nextCursor,
    nextCursor,
    data: bookings,
    items: bookings,
    pagination: {
      total,
      limit,
      page,
      offset: params.cursor ? undefined : offset,
      hasMore,
      has_more: hasMore,
      nextCursor,
      next_cursor: nextCursor,
    },
    total,
    limit,
    page,
    hasMore,
    has_more: hasMore,
  };
}