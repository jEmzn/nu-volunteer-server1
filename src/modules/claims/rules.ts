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

/** Whole hours earned from a bottle count, never above `max`. */
export function bottleHours(items: number, perHour: number, max: number): number {
  if (!(perHour > 0) || !(items > 0)) return 0;
  return Math.min(Math.floor(items / perHour), max);
}
