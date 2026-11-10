import { randomInt } from 'node:crypto';

/** Trims the ends and collapses inner runs of whitespace to one space. Applied to every name before it is stored. */
export const cleanName = (s: string) => s.trim().replace(/\s+/g, ' ');

const graphemes = new Intl.Segmenter('th', { granularity: 'grapheme' });
/** Up to 3 characters and never more than half the word, so a short surname is not shown whole. */
function hideWord(w: string) {
  const chars = Array.from(graphemes.segment(w), (g) => g.segment);
  return `${chars.slice(0, Math.min(3, Math.ceil(chars.length / 2))).join('')}•••`;
}

/**
 * "วอเมด เทสเทส" → "วอเมด เทส•••": enough for a student to recognise their own name, not someone else's surname.
 * Counts whole characters, so a Thai vowel mark is never cut off its consonant.
 */
export function maskName(name: string) {
  const [first, ...rest] = cleanName(name).split(' ');
  return rest.length ? [first, ...rest.map(hideWord)].join(' ') : hideWord(first);
}

/** Hours as typed by the supervisor: whole numbers stay whole. */
export const fmtHours = (h: number) => (Number.isInteger(h) ? String(h) : h.toFixed(1));

const ID_CHARS = '0123456789abcdefghijklmnopqrstuvwxyz';

/** 10 random characters from [0-9a-z], about 52 bits. */
export function newId(): string {
  let s = '';
  for (let i = 0; i < 10; i++) s += ID_CHARS[randomInt(ID_CHARS.length)];
  return s;
}

const MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

export function zonedParts(ms: number, tz: string) {
  const out: Record<string, string> = {};
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  for (const p of fmt.formatToParts(new Date(ms))) out[p.type] = p.value;
  return out;
}

/** "20 พ.ย. 2569" in the display time zone. */
export function thDate(ms: number, tz: string) {
  const p = zonedParts(ms, tz);
  return `${Number(p.day)} ${MONTHS[Number(p.month) - 1]} ${Number(p.year) + 543}`;
}

/** "09:05" in the display time zone. */
export function thTime(ms: number, tz: string) {
  const p = zonedParts(ms, tz);
  return `${p.hour.padStart(2, '0')}:${p.minute.padStart(2, '0')}`;
}
