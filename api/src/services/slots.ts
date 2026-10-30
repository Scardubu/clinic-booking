import { pool } from '../db.js';
import { ApiError } from '../validation.js';

export interface SlotDTO {
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
  available: boolean;
  isAvailable: boolean;
  is_available: boolean;
  status: 'AVAILABLE' | 'BOOKED';
}

export function mapSlotRow(row: any): SlotDTO {
  const startIso = new Date(row.start_time).toISOString();
  const endIso = new Date(row.end_time).toISOString();
  const isAvailable = Boolean(row.is_available);
  const provider = row.provider || row.doctor_name || 'Clinic Physician';

  return {
    id: String(row.id),
    provider,
    doctorName: provider,
    doctor_name: provider,
    start: startIso,
    startTime: startIso,
    start_time: startIso,
    end: endIso,
    endTime: endIso,
    end_time: endIso,
    available: isAvailable,
    isAvailable,
    is_available: isAvailable,
    status: isAvailable ? 'AVAILABLE' : 'BOOKED',
  };
}

export async function listSlots(provider?: string, onlyAvailable = false): Promise<SlotDTO[]> {
  const values: any[] = [];
  const filters: string[] = [];

  if (provider && provider.trim()) {
    values.push(provider.trim());
    filters.push(`(provider = $${values.length} OR doctor_name = $${values.length})`);
  }

  if (onlyAvailable) {
    filters.push('is_available = TRUE');
  }

  const whereClause = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
  const sql = `
    SELECT id, COALESCE(provider, doctor_name) AS provider, doctor_name, start_time, end_time, is_available
    FROM slots
    ${whereClause}
    ORDER BY start_time ASC, id ASC
  `;

  const { rows } = await pool.query(sql, values);
  return rows.map(mapSlotRow);
}

export async function getSlotById(slotId: string): Promise<SlotDTO> {
  const cleanId = String(slotId || '').trim();
  if (!cleanId) {
    throw new ApiError(404, 'SLOT_NOT_FOUND', "The slot doesn't exist");
  }
  const { rows, rowCount } = await pool.query(
    `SELECT id, COALESCE(provider, doctor_name) AS provider, doctor_name, start_time, end_time, is_available
     FROM slots
     WHERE id = $1`,
    [cleanId]
  );
  if (!rowCount || !rows[0]) {
    throw new ApiError(404, 'SLOT_NOT_FOUND', "The slot doesn't exist");
  }
  return mapSlotRow(rows[0]);
}