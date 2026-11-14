import { sameDay, thDate, thDayMonth, thTime } from '../../common/format';
import type { Row } from '../../common/db.service';

/** The rows of both Excel files as pure data, so their columns and values can be tested without Excel. */

/** One activity per file: its title, date, category and organisation are header rows above the table, not columns. */
export const SUP_COLUMNS = ['ลำดับ', 'รหัสนิสิต', 'ชื่อ', 'ชั่วโมง', 'สถานะ', 'เวลายืนยัน', 'ยืนยันโดย', 'หมายเหตุ'] as const;
export const SUP_WIDTHS = [7, 12, 28, 9, 12, 16, 18, 40];
export const ADMIN_COLUMNS = ['รหัสนิสิต', 'ชื่อ', 'กิจกรรม', 'หน่วยงาน', 'หมวด', 'วันที่', 'ชั่วโมง'] as const;
export const ADMIN_WIDTHS = [12, 28, 40, 30, 16, 14, 9];

const CATEGORY_LABEL: Record<string, string> = { blood: 'บริจาคโลหิต', setup: 'จัดสถานที่', bottle: 'แลกขวด', other: 'อื่น ๆ' };
export const categoryLabel = (key: string) => CATEGORY_LABEL[key] ?? CATEGORY_LABEL.other;

const thai = new Intl.Collator('th');

/** A cell starting with one of these would run as a formula when the file is opened. */
export function safeCell<T>(v: T): T | string {
  return typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

const time = (d: Date | null | undefined) => (d ? new Date(d).getTime() : -1);

/** "20 พ.ย. 2569 เวลา 09:00–16:00 น.", or both ends in full for an activity that runs over more than one day. */
export function activityWhen(activity: Row, tz: string) {
  const start = time(activity.start_at);
  const end = time(activity.end_at);
  if (end < 0) return `${thDate(start, tz)} เวลา ${thTime(start, tz)} น.`;
  if (sameDay(start, end, tz)) return `${thDate(start, tz)} เวลา ${thTime(start, tz)}–${thTime(end, tz)} น.`;
  return `${thDate(start, tz)} ${thTime(start, tz)} น. – ${thDate(end, tz)} ${thTime(end, tz)} น.`;
}

/** The lines above the supervisor file's table. */
export function supHeader(activity: Row, tz: string): string[] {
  return [activity.title, activityWhen(activity, tz), `หมวด ${categoryLabel(activity.category_key)}`, `หน่วยงาน ${activity.org}`].map((v) => String(safeCell(v)));
}

/**
 * When the hours were confirmed. Only the time on a one-day activity's own day, since the header already gives the date;
 * the short date as well when it was another day, such as a supervisor adding someone afterwards.
 */
export function confirmedAt(at: number, activity: Row, tz: string) {
  const start = time(activity.start_at);
  const end = time(activity.end_at);
  const oneDay = end < 0 || sameDay(start, end, tz);
  return oneDay && sameDay(at, start, tz) ? `${thTime(at, tz)} น.` : `${thDayMonth(at, tz)} ${thTime(at, tz)} น.`;
}

/** One row per person: newest scans first, then everyone who did not come, by Thai name order. */
export function supRows(activity: Row, regs: Row[], credits: Row[], tz: string): (string | number)[][] {
  const people = new Map<string, { id: string; name: string; reg?: Row; credit?: Row }>();
  for (const r of regs) if (!r.cancelled_at) people.set(r.student_id, { id: r.student_id, name: r.name, reg: r });
  for (const c of credits) people.set(c.student_id, { ...people.get(c.student_id), id: c.student_id, name: c.name, credit: c });

  const sorted = [...people.values()].sort((a, b) => time(b.credit?.at) - time(a.credit?.at) || thai.compare(a.name, b.name));
  return sorted.map((p, i) => {
    const c = p.credit;
    const flags: string[] = c?.flags ?? [];
    const notes = [
      c && c.items !== null && c.items !== undefined && `${c.items} ขวด`,
      c?.reason,
      flags.includes('location') && (typeof c?.distance === 'number' ? `อยู่นอกพื้นที่ ${Math.round(c.distance)} ม.` : 'ไม่มีตำแหน่ง'),
      flags.includes('device') && 'เครื่องซ้ำ',
      flags.includes('offline') && 'ส่งภายหลัง',
    ].filter(Boolean);
    return [
      i + 1,
      p.id,
      p.name,
      c ? Number(c.hours) : 0,
      !c ? 'ไม่มา' : p.reg?.walk_in && activity.category_key !== 'bottle' ? 'walk-in' : 'ได้ชั่วโมง',
      c ? confirmedAt(new Date(c.at).getTime(), activity, tz) : '',
      !c ? '' : c.method === 'qr' ? 'สแกน QR' : (c.edited_by ?? 'ผู้ดูแล'),
      notes.join(', '),
    ].map(safeCell);
  });
}

/** One row per person who earned hours, by student id. No-shows and people left at 0 hours are not listed. */
export function adminRows(activity: Row, credits: Row[], tz: string): (string | number)[][] {
  return credits
    .filter((c) => Number(c.hours) > 0)
    .sort((a, b) => a.student_id.localeCompare(b.student_id))
    .map((c) => [c.student_id, c.name, activity.title, activity.org, categoryLabel(activity.category_key), thDate(activity.start_at.getTime(), tz), Number(c.hours)].map(safeCell));
}
