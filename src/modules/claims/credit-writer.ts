import type { PoolClient } from 'pg';
import type { Row } from '../../common/db.service';
import { fmtHours } from '../../common/format';

export interface CreditInput {
  studentId: string;
  name: string;
  hours: number;
  method: 'qr' | 'manual';
  /** When it happened. Server time unless an offline scan was accepted. */
  at: number;
  flags?: string[];
  distance?: number;
  accuracy?: number;
  deviceId?: string;
  ref?: string;
  editedBy?: string;
  items?: number;
  reason?: string;
}

export type WriteResult = { ok: true; row: Row } | { ok: false; row: Row };

export const creditNotice = (c: PoolClient, activity: Row, studentId: string, hours: number) =>
  c.query(`INSERT INTO notices (student_id, kind, title, body, activity_id) VALUES ($1, 'credit', $2, $3, $4)`, [studentId, `ได้รับ ${fmtHours(hours)} ชั่วโมง`, activity.title, activity.id]);

/**
 * The shared credit write, for QR and manual alike. Must run in a transaction that already locked the activity
 * row (spec 8.3 steps 3 to 8). A credit of 0 hours gets no notice: "ได้รับ 0 ชั่วโมง" would only mislead.
 */
export async function writeCredit(c: PoolClient, activity: Row, input: CreditInput): Promise<WriteResult> {
  const { id: activityId } = activity;
  const existing = await c.query('SELECT * FROM credits WHERE activity_id = $1 AND student_id = $2', [activityId, input.studentId]);
  if (existing.rows[0]) return { ok: false, row: existing.rows[0] };

  const flags = [...(input.flags ?? [])];
  if (input.deviceId) {
    const dup = await c.query(`UPDATE credits SET flags = CASE WHEN 'device' = ANY (flags) THEN flags ELSE array_append(flags, 'device') END WHERE activity_id = $1 AND device_id = $2`, [activityId, input.deviceId]);
    if (dup.rowCount && !flags.includes('device')) flags.push('device');
  }

  const inserted = await c.query(
    `INSERT INTO credits (activity_id, student_id, name, hours, full_hours, at, method, distance, accuracy, flags, device_id, ref, edited_by, items, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (activity_id, student_id) DO NOTHING
     RETURNING *`,
    [
      activityId,
      input.studentId,
      input.name,
      input.hours,
      activity.hours,
      new Date(input.at),
      input.method,
      input.distance ?? null,
      input.accuracy ?? null,
      flags,
      input.deviceId ?? null,
      input.ref ?? null,
      input.editedBy ?? null,
      input.items ?? null,
      input.reason ?? null,
    ],
  );
  const row = inserted.rows[0];
  if (!row) {
    const again = await c.query('SELECT * FROM credits WHERE activity_id = $1 AND student_id = $2', [activityId, input.studentId]);
    return { ok: false, row: again.rows[0] };
  }

  await c.query('UPDATE activities SET credit_count = credit_count + 1 WHERE id = $1', [activityId]);

  const reg = await c.query('SELECT cancelled_at FROM registrations WHERE activity_id = $1 AND student_id = $2', [activityId, input.studentId]);
  if (!reg.rows[0] || reg.rows[0].cancelled_at) {
    await c.query(
      `INSERT INTO registrations (activity_id, student_id, name, at, walk_in) VALUES ($1, $2, $3, $4, true)
       ON CONFLICT (activity_id, student_id) DO UPDATE
       SET name = excluded.name, at = excluded.at, walk_in = true, cancelled_at = null, late = false, waived = false`,
      [activityId, input.studentId, input.name, row.at],
    );
    await c.query('UPDATE activities SET reg_count = reg_count + 1 WHERE id = $1', [activityId]);
  }

  if (input.hours > 0) await creditNotice(c, activity, input.studentId, input.hours);
  return { ok: true, row };
}
