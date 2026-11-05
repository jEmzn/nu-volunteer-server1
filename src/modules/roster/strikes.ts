import { zonedParts } from '../../common/format';

/** Lost credits per semester before a student can no longer register. The web reads it from the summary. */
export const STRIKE_LIMIT = 3;

type Queryable = { query(sql: string, params: unknown[]): Promise<{ rows: any[] }> };

/** The semester holding this moment, as local dates: ภาค 1 is 1 May to 31 Oct, ภาค 2 is 1 Nov to 30 Apr. */
export function semesterOf(ms: number, tz: string) {
  const { year, month } = zonedParts(ms, tz);
  const y = Number(year);
  const m = Number(month);
  if (m >= 5 && m <= 10) return { number: 1, start: `${y}-05-01`, end: `${y}-11-01` };
  const from = m >= 11 ? y : y - 1;
  return { number: 2, start: `${from}-11-01`, end: `${from + 1}-05-01` };
}

/**
 * Every lost credit this semester, newest first, waived ones included. This is the only place the rule lives: the
 * register check counts these, and the web shows them. A late cancel counts from when it was cancelled. A no-show is
 * a live registration without hours once the roster closed, by the supervisor or 24 hours after the end. Walk-ins do
 * not count.
 */
export async function listStrikes(db: Queryable, studentId: string, tz: string) {
  const semester = semesterOf(Date.now(), tz);
  const { rows } = await db.query(
    `SELECT r.activity_id, a.title, r.waived, t.kind, t.at
     FROM registrations r
     JOIN activities a ON a.id = r.activity_id
     CROSS JOIN LATERAL (SELECT COALESCE(a.closed_at, a.end_at + interval '24 hours') AS closed) c
     CROSS JOIN LATERAL (SELECT CASE WHEN r.cancelled_at IS NULL THEN 'noshow' ELSE 'late' END AS kind, COALESCE(r.cancelled_at, c.closed) AS at) t
     WHERE r.student_id = $1 AND t.at >= $2::timestamp AT TIME ZONE $3 AND (
       (r.cancelled_at IS NOT NULL AND r.late)
       OR (r.cancelled_at IS NULL AND NOT r.walk_in AND c.closed <= now()
           AND NOT EXISTS (SELECT 1 FROM credits cr WHERE cr.activity_id = r.activity_id AND cr.student_id = r.student_id))
     )
     ORDER BY t.at DESC`,
    [studentId, semester.start, tz],
  );
  return { semester, strikes: rows };
}

export async function countStrikes(db: Queryable, studentId: string, tz: string) {
  return (await listStrikes(db, studentId, tz)).strikes.filter((s) => !s.waived).length;
}

/** What the student's screens show, and what the centre admin reviews before giving a credit back. */
export async function strikeSummary(db: Queryable, studentId: string, tz: string) {
  const { semester, strikes } = await listStrikes(db, studentId, tz);
  const bounds = (await db.query('SELECT $1::timestamp AT TIME ZONE $3 AS start_at, $2::timestamp AT TIME ZONE $3 AS end_at', [semester.start, semester.end, tz])).rows[0];
  const lost = strikes.filter((s) => !s.waived).length;
  return {
    limit: STRIKE_LIMIT,
    left: Math.max(0, STRIKE_LIMIT - lost),
    semester: { number: semester.number, start: (bounds.start_at as Date).getTime(), end: (bounds.end_at as Date).getTime() },
    strikes: strikes.map((s) => ({ activityId: s.activity_id as string, title: s.title as string, kind: s.kind as 'late' | 'noshow', at: (s.at as Date).getTime(), waived: s.waived as boolean })),
  };
}
