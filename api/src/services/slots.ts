import { pool } from '../db.js';
import { ApiError, isValidUuid } from '../validation.js';

export interface SlotDTO {
  id: string;
  doctorName: string;
  doctor_name: string;
  startTime: string;
  start_time: string;
  endTime: string;
  end_time: string;
  available: boolean;
  isAvailable: boolean;
  is_available: boolean;
  status: 'AVAILABLE' | 'BOOKED';
}

export function mapSlotRow(row: any): SlotDTO {
  const startIso = new Date(row.start_time).toISOString();
  const endIso = new Date(row.end_time).toISOString();
  const isAvailable = Boolean(row.is_available);

  return {
    id: row.id,
    doctorName: row.doctor_name,
    doctor_name: row.doctor_name,
    startTime: startIso,
    start_time: startIso,
    endTime: endIso,
    end_time: endIso,
    available: isAvailable,
    isAvailable,
    is_available: isAvailable,
    status: isAvailable ? 'AVAILABLE' : 'BOOKED',
  };
}

export async function listSlots(onlyAvailable = true): Promise<SlotDTO[]> {
  const sql = onlyAvailable
    ? `SELECT id, doctor_name, start_time, end_time, is_available
       FROM slots
       WHERE is_available = TRUE
       ORDER BY start_time ASC, id ASC`
    : `SELECT id, doctor_name, start_time, end_time, is_available
       FROM slots
       ORDER BY start_time ASC, id ASC`;

  const { rows } = await pool.query(sql);
  return rows.map(mapSlotRow);
}

export async function getSlotById(slotId: string): Promise<SlotDTO> {
  if (!isValidUuid(slotId)) {
    throw new ApiError(400, 'INVALID_SLOT_ID', 'Slot ID must be a valid UUID.');
  }
  const { rows, rowCount } = await pool.query(
    `SELECT id, doctor_name, start_time, end_time, is_available
     FROM slots
     WHERE id = $1`,
    [slotId]
  );
  if (!rowCount || !rows[0]) {
    throw new ApiError(404, 'SLOT_NOT_FOUND', 'Slot not found.');
  }
  return mapSlotRow(rows[0]);
}