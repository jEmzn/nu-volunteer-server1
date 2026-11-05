import { thDate, thTime } from '../../common/format';
import type { Row } from '../../common/db.service';

/** The rows of both Excel files as pure data, so their columns and values can be tested without Excel. */

export const SUP_COLUMNS = ['ลำดับ', 'รหัสนิสิต', 'ชื่อ', 'กิจกรรม', 'หมวด', 'วันที่', 'ชั่วโมง', 'สถานะ', 'เวลายืนยัน', 'ยืนยันโดย', 'หมายเหตุ'] as const;
export const SUP_WIDTHS = [7, 12, 28, 40, 16, 14, 9, 16, 12, 16, 36];
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
      flags.includes('location') && (typeof c?.distance === 'number' ? `อยู่นอกพื้นที่ ${Math.round(c.distance)} ม.` : 'อยู่นอกพื้นที่'),
      flags.includes('device') && 'เครื่องซ้ำ',
      flags.includes('offline') && 'ส่งภายหลัง',
    ].filter(Boolean);
    return [
      i + 1,
      p.id,
      p.name,
      activity.title,
      categoryLabel(activity.category_key),
      thDate(activity.start_at.getTime(), tz),
      c ? Number(c.hours) : 0,
      !c ? 'ไม่มา' : p.reg?.walk_in && activity.category_key !== 'bottle' ? 'ไม่ได้ลงทะเบียน' : 'ได้ชั่วโมง',
      c ? `${thTime(new Date(c.at).getTime(), tz)} น.` : '',
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
