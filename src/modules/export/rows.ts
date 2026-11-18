import { thDate, thTime, zonedParts } from '../../common/format';
import type { Row } from '../../common/db.service';

/** The rows of both Excel files as pure data, so their columns and values can be tested without Excel. */

/** A flat table, header in row 1: the activity's title, category and date repeat on every row, like the centre file. */
export const SUP_COLUMNS = ['ลำดับ', 'รหัสนิสิต', 'ชื่อ', 'กิจกรรม', 'หมวด', 'วันที่', 'ชั่วโมง', 'สถานะ', 'เวลายืนยัน', 'ยืนยันโดย', 'หมายเหตุ'] as const;
export const SUP_WIDTHS = [7, 12, 28, 40, 16, 14, 9, 12, 20, 18, 40];
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

/** When the hours were confirmed, with the full date: "20 พ.ย. 2569 10:52 น.". The app shows the time alone. */
export function confirmedAt(at: number, tz: string) {
  return `${thDate(at, tz)} ${thTime(at, tz)} น.`;
}

/** Hours after the end the roster closes by itself when nobody closed it (the scheduler does the same). */
const AUTO_CLOSE_MS = 24 * 3600_000;

/** The roster is closed: by hand, or a day after the end. Only then is someone without hours a no-show. */
export function rosterClosed(activity: Row, now: number) {
  return !!activity.closed_at || (time(activity.end_at) >= 0 && now >= time(activity.end_at) + AUTO_CLOSE_MS);
}

/**
 * One row per person, numbered in the order hours were given (oldest first, as on the student's roster), then everyone
 * without hours in Thai name order. Before the roster closes they have not scanned yet; after, they did not come.
 */
/** Same words as the app's roster chip: "ห่าง 213 ม.", "ห่าง 10.7 กม.". */
export function distanceText(m: number) {
  const r = Math.round(m);
  return r < 1000 ? `ห่าง ${r} ม.` : `ห่าง ${(r / 1000).toLocaleString('th-TH', { maximumFractionDigits: 1 })} กม.`;
}

/** The status cell. A bottle exchange below one hour says how many bottles make an hour, not "ได้ชั่วโมง" next to 0 (N2). */
function status(activity: Row, reg: Row | undefined, c: Row | undefined, closed: boolean) {
  if (!c) return closed ? 'ไม่มา' : 'ยังไม่สแกน';
  if (activity.category_key === 'bottle') return Number(c.hours) > 0 ? 'ได้ชั่วโมง' : `ยังไม่ครบ ${activity.items_per_hour} ขวด`;
  // Left at 0 by the supervisor: in the roster with the reason in the notes, but without hours (VB-26).
  if (!(Number(c.hours) > 0)) return 'ไม่ได้ชั่วโมง';
  return reg?.walk_in ? 'walk-in' : 'ได้ชั่วโมง';
}

export function supRows(activity: Row, regs: Row[], credits: Row[], tz: string, now = Date.now()): (string | number | null)[][] {
  const closed = rosterClosed(activity, now);
  const people = new Map<string, { id: string; name: string; reg?: Row; credit?: Row }>();
  for (const r of regs) if (!r.cancelled_at) people.set(r.student_id, { id: r.student_id, name: r.name, reg: r });
  for (const c of credits) people.set(c.student_id, { ...people.get(c.student_id), id: c.student_id, name: c.name, credit: c });

  const last = Number.MAX_SAFE_INTEGER;
  const sorted = [...people.values()].sort((a, b) => (a.credit ? time(a.credit.at) : last) - (b.credit ? time(b.credit.at) : last) || thai.compare(a.name, b.name));
  return sorted.map((p, i) => {
    const c = p.credit;
    const flags: string[] = c?.flags ?? [];
    const notes = [
      c && c.items !== null && c.items !== undefined && `${c.items} ขวด`,
      c?.reason,
      flags.includes('location') && (typeof c?.distance === 'number' ? distanceText(c.distance) : 'ไม่มีตำแหน่ง'),
      flags.includes('device') && 'ใช้เครื่องซ้ำ',
      flags.includes('offline') && 'ส่งภายหลัง',
    ].filter(Boolean);
    return [
      i + 1,
      p.id,
      p.name,
      activity.title,
      categoryLabel(activity.category_key),
      thDate(time(activity.start_at), tz),
      // An empty cell, not 0, while they may still come.
      c ? Number(c.hours) : closed ? 0 : null,
      status(activity, p.reg, c, closed),
      c ? confirmedAt(new Date(c.at).getTime(), tz) : '',
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

const words = new Intl.Segmenter('th', { granularity: 'word' });

/** The title for a file name: no characters a file system refuses, at most `max` characters, cut between words. */
export function fileTitle(title: string, max = 40) {
  const clean = title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  let out = '';
  for (const { segment } of words.segment(clean)) {
    if ((out + segment).length > max) break;
    out += segment;
  }
  // One word longer than the limit: cut it rather than give no title.
  return (out.trim() || clean.slice(0, max)).trim();
}

/** "รายชื่อ 20-11-2569 บริจาคโลหิต ครั้งที่ 2.xlsx": what it is, the activity's day, then the title, so files sort by day. */
export function xlsxName(kind: 'sup' | 'admin', activity: Row, tz: string) {
  const p = zonedParts(time(activity.start_at), tz);
  const day = `${p.day.padStart(2, '0')}-${p.month.padStart(2, '0')}-${Number(p.year) + 543}`;
  return `${kind === 'sup' ? 'รายชื่อ' : 'บันทึกชั่วโมง'} ${day} ${fileTitle(String(activity.title))}.xlsx`;
}
