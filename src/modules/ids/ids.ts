import type { PoolClient } from 'pg';
import { cleanName } from '../../common/format';

/**
 * Item 23: two people on one student id. Whoever confirms the id is theirs while another name holds it gets an account
 * of their own stored as "<id>#<n>" (n from 2), so every table keeps working without a schema change. Every account of an
 * id that has such a twin is flagged until the centre admin checks the cards. An account the admin kept as a twin
 * because the right id is not known yet carries `idReview` in its notify settings and is flagged "รอรหัสที่ถูก" instead.
 */

type Queryable = { query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }> };

/** The flag a credit or registration carries, added on read: never stored. */
export type IdFlag = 'idconflict' | 'idpending';

export const REVIEW_KEY = 'idReview';

/** The 8 digits, without the twin number. */
export const baseOf = (id: string) => id.split('#')[0];
export const isTwin = (id: string) => id.includes('#');

const PREFIX = /^(นางสาว|นาง|นาย|น\.\s*ส\.)\s*/;
/** A name as compared: no title, single spaces, any case. */
export const nameKey = (name: string) => cleanName(cleanName(name).replace(PREFIX, '')).toLowerCase();
export const sameName = (a: string, b: string) => nameKey(a) === nameKey(b);

/** The id and its twins, the plain id first. Lock them with `forUpdate` when about to change them. */
export async function accountsOf(q: Queryable, base: string, forUpdate = false) {
  const { rows } = await q.query(
    `SELECT * FROM students WHERE id = $1 OR (strpos(id, '#') > 0 AND split_part(id, '#', 1) = $1)
     ORDER BY (id = $1) DESC, created_at, id ${forUpdate ? 'FOR UPDATE' : ''}`,
    [base],
  );
  return rows;
}

const twinNo = (id: string) => Number(id.split('#')[1] ?? 1);

export async function nextTwinId(c: Queryable, base: string) {
  const ids = (await accountsOf(c, base)).map((r) => r.id as string);
  return `${base}#${Math.max(1, ...ids.map(twinNo)) + 1}`;
}

/** Same words in every account's inbox. Names nobody: the other person may be the one who typed the id wrong. */
export async function tellTwins(c: Queryable, base: string) {
  const ids = (await accountsOf(c, base)).map((r) => r.id as string);
  await c.query(
    `INSERT INTO notices (student_id, kind, title, body) SELECT s, 'idconflict', $2, $3 FROM unnest($1::text[]) AS t(s)`,
    [ids, `รหัสนิสิต ${base} มีผู้ใช้ ${ids.length} ชื่อ`, 'ชั่วโมงของคุณบันทึกไว้ครบ เจ้าหน้าที่จะตรวจสอบ ถ้ารหัสนี้ไม่ใช่ของคุณ ออกจากระบบแล้วเข้าใหม่ด้วยรหัสที่ถูก'],
  );
}

/**
 * A new account on an id someone else holds. The plain id is locked first, so two people confirming at once get
 * different numbers. Must run in a transaction.
 */
export async function createTwin(c: PoolClient, base: string, name: string) {
  await c.query('SELECT id FROM students WHERE id = $1 FOR UPDATE', [base]);
  const id = await nextTwinId(c, base);
  const row = (await c.query('INSERT INTO students (id, name) VALUES ($1, $2) RETURNING *', [id, name])).rows[0];
  await tellTwins(c, base);
  return row;
}

/** Which of these accounts carry a flag. One small query: twins are few, and only rows with "#" are read. */
export async function idFlags(q: Queryable, ids: string[]): Promise<Map<string, IdFlag>> {
  const out = new Map<string, IdFlag>();
  const bases = [...new Set(ids.map(baseOf))];
  if (!bases.length) return out;
  const { rows } = await q.query(
    `SELECT id, notify ? '${REVIEW_KEY}' AS reviewed FROM students WHERE strpos(id, '#') > 0 AND split_part(id, '#', 1) = ANY($1::text[])`,
    [bases],
  );
  const open = new Set(rows.filter((r) => !r.reviewed).map((r) => baseOf(r.id)));
  for (const id of ids) {
    if (open.has(baseOf(id))) out.set(id, 'idconflict');
    else if (rows.some((r) => r.id === id && r.reviewed)) out.set(id, 'idpending');
  }
  return out;
}

/** The rows with the id flag added to `flags`, for credits as the supervisor sees them. */
export function withIdFlags<T extends Record<string, any>>(rows: T[], flags: Map<string, IdFlag>): T[] {
  return rows.map((r) => {
    const f = flags.get(r.student_id);
    return f ? { ...r, flags: [...(r.flags ?? []), f] } : r;
  });
}

/**
 * Moves everything one account owns to another id, in the caller's transaction: credits, registrations (and so the
 * lost credits worked out from them), notices, private messages and group chat lines. When `to` already exists the two
 * are merged: per activity the credit with more hours stays, and a live registration beats a cancelled one, with the
 * activity counters put right. Returns the activities touched, for realtime.
 */
export async function moveAccount(c: PoolClient, from: string, to: string): Promise<string[]> {
  if (from === to) return [];
  const exists = (await c.query('SELECT 1 FROM students WHERE id = $1', [to])).rowCount;
  if (exists) await c.query('DELETE FROM students WHERE id = $1', [from]);
  else await c.query('UPDATE students SET id = $2 WHERE id = $1', [from, to]);

  const touched = new Set<string>();
  const clashes = (
    await c.query(
      `SELECT f.activity_id, f.hours AS fh, t.hours AS th FROM credits f JOIN credits t ON t.activity_id = f.activity_id AND t.student_id = $2 WHERE f.student_id = $1`,
      [from, to],
    )
  ).rows;
  for (const k of clashes) {
    const dropFrom = Number(k.fh) <= Number(k.th);
    await c.query('DELETE FROM credits WHERE activity_id = $1 AND student_id = $2', [k.activity_id, dropFrom ? from : to]);
    // Both were counted while they had hours; one person now holds one credit.
    if (Number(dropFrom ? k.fh : k.th) > 0) await c.query('UPDATE activities SET credit_count = GREATEST(0, credit_count - 1) WHERE id = $1', [k.activity_id]);
  }
  const moved = await c.query('UPDATE credits SET student_id = $2 WHERE student_id = $1 RETURNING activity_id', [from, to]);
  moved.rows.forEach((r) => touched.add(r.activity_id));

  const regClashes = (
    await c.query(
      `SELECT f.activity_id, f.cancelled_at AS fc, f.walk_in AS fw, t.cancelled_at AS tc, t.walk_in AS tw
       FROM registrations f JOIN registrations t ON t.activity_id = f.activity_id AND t.student_id = $2 WHERE f.student_id = $1`,
      [from, to],
    )
  ).rows;
  for (const k of regClashes) {
    const keepFrom = !!k.tc && !k.fc;
    await c.query('DELETE FROM registrations WHERE activity_id = $1 AND student_id = $2', [k.activity_id, keepFrom ? to : from]);
    const dropped = keepFrom ? { cancelled: k.tc, walkIn: k.tw } : { cancelled: k.fc, walkIn: k.fw };
    if (!dropped.cancelled && !dropped.walkIn) await c.query('UPDATE activities SET reg_count = GREATEST(0, reg_count - 1) WHERE id = $1', [k.activity_id]);
    touched.add(k.activity_id);
  }
  const regs = await c.query('UPDATE registrations SET student_id = $2 WHERE student_id = $1 RETURNING activity_id', [from, to]);
  regs.rows.forEach((r) => touched.add(r.activity_id));

  await c.query('UPDATE notices SET student_id = $2 WHERE student_id = $1', [from, to]);
  await c.query('UPDATE dms SET student_id = $2 WHERE student_id = $1', [from, to]);
  await c.query('UPDATE messages SET author_id = $2 WHERE author_id = $1 AND NOT sup', [from, to]);
  return [...touched];
}
