import type { QrPayload } from '../qr/qr-token';

/** Pure rules for checking in. No I/O, so they are easy to test against the cases from the old site. */

const ACC_CAP_M = 100;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export interface Fix {
  lat?: number | null;
  lng?: number | null;
  accuracy?: number | null;
}

export interface LocationResult {
  flags: string[];
  distance?: number;
  accuracy?: number;
}

/** Location never blocks a claim. Anyone outside the radius, or without a position, still gets hours but is flagged. */
export function judgeLocation(activity: { loc_mode: string; radius: number }, token: QrPayload, fix: Fix): LocationResult {
  if (activity.loc_mode === 'off') return { flags: [] };
  if (typeof fix.lat !== 'number' || typeof fix.lng !== 'number') return { flags: ['location'] };
  const accuracy = typeof fix.accuracy === 'number' ? fix.accuracy : undefined;
  if (typeof token.la !== 'number' || typeof token.lo !== 'number') return { flags: ['location'], accuracy };
  const distance = distanceM({ lat: token.la, lng: token.lo }, { lat: fix.lat, lng: fix.lng });
  const allowed = activity.radius + Math.min(ACC_CAP_M, token.ac ?? 0) + Math.min(ACC_CAP_M, accuracy ?? 0);
  return { flags: distance > allowed ? ['location'] : [], distance, accuracy };
}

/** A kept offline scan counts only inside these limits; otherwise server time is used. Returns the accepted time or null. */
export function acceptScannedAt(scannedAt: number | null | undefined, now: number, activity: { start: number; end: number }): number | null {
  if (typeof scannedAt !== 'number') return null;
  if (scannedAt > now + MINUTE || scannedAt < now - 48 * HOUR) return null;
  if (scannedAt < activity.start - HOUR || scannedAt > activity.end + 24 * HOUR) return null;
  return scannedAt;
}

/** The roster closes when the supervisor says so, or by itself this long after the end (the scheduler stamps it within 10 minutes). */
const AUTO_CLOSE_MS = 24 * HOUR;

/**
 * Whether the roster was closed at moment `at`: server time, or an accepted scan time for a scan kept offline. Closed
 * rosters take no more scans and give no QR. Adding people by hand stays open until the roster is sent.
 */
export function isRosterClosed(activity: { closed_at: Date | null; end_at: Date }, at: number): boolean {
  const closedAt = activity.closed_at ? activity.closed_at.getTime() : activity.end_at.getTime() + AUTO_CLOSE_MS;
  return at >= closedAt;
}

/** The most hours anyone can be given in the system, same as the limit on an activity's own hours. */
const MAX_HOURS = 99;

/**
 * The most hours one person can have in an activity. Work on site often runs longer than planned, so the supervisor
 * there decides, up to the field's own limit. A bottle exchange keeps its own limit per person, the university's rule.
 */
export function personHoursCap(activity: { hours: number | string; category_key: string }): number {
  return activity.category_key === 'bottle' ? Number(activity.hours) : MAX_HOURS;
}

/** Whole hours earned from a bottle count, never above `max`. */
export function bottleHours(items: number, perHour: number, max: number): number {
  if (!(perHour > 0) || !(items > 0)) return 0;
  return Math.min(Math.floor(items / perHour), max);
}

/** The part of an activity that decides how many hours a person gets. */
export interface HoursRule {
  category_key: string;
  hours: number | string;
  items_per_hour: number | null;
}

/** True if the new rule would give anyone less than the old one: fewer hours, or more bottles for each hour. */
export function lowersHours(before: HoursRule, after: HoursRule): 'hours' | 'itemsPerHour' | null {
  if (Number(after.hours) < Number(before.hours)) return 'hours';
  if (after.category_key === 'bottle' && before.category_key === 'bottle' && (after.items_per_hour ?? 0) > (before.items_per_hour ?? 0)) return 'itemsPerHour';
  return null;
}

/**
 * What a credit becomes when the activity's rule gets more generous, or null to leave it alone. Only credits still at
 * what the old rule gave are moved: hours a supervisor set by hand were a decision about that person.
 */
export function raisedHours(credit: { hours: number | string; items: number | null }, before: HoursRule, after: HoursRule): number | null {
  const now = Number(credit.hours);
  if (before.category_key !== after.category_key) return null;
  if (after.category_key === 'bottle') {
    if (credit.items === null || credit.items === undefined) return null;
    if (now !== bottleHours(credit.items, before.items_per_hour ?? 0, Number(before.hours))) return null;
    const next = bottleHours(credit.items, after.items_per_hour ?? 0, Number(after.hours));
    return next > now ? next : null;
  }
  return now === Number(before.hours) && Number(after.hours) > now ? Number(after.hours) : null;
}
