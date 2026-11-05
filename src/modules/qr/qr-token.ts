import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** QR tokens: base64url(JSON payload) + "." + base64url(first 12 bytes of HMAC-SHA256 of the first part), no padding. */

export const QR_INTERVAL_DEFAULT = 10;
/** A dynamic QR stays valid for about this long after it is shown, whatever the interval. */
const QR_LIFETIME_S = 60;
/** ...and one window ahead, for clocks that run slightly fast. */
const QR_AHEAD = 1;
/** A static QR works from this long before start until this long after end. */
const STATIC_SLACK_MS = 30 * 60_000;

export interface QrPayload {
  v: 3;
  a: string;
  w?: number;
  s?: 1;
  i?: number;
  la?: number;
  lo?: number;
  ac?: number;
}

export type QrCoords = Pick<QrPayload, 'la' | 'lo' | 'ac'>;
export type QrTimeError = 'QR_EXPIRED' | 'QR_EARLY' | 'QR_LATE';

const sign = (secret: string, body: string) => createHmac('sha256', secret).update(body).digest().subarray(0, 12).toString('base64url');

export const windowOf = (t: number, interval = QR_INTERVAL_DEFAULT) => Math.floor(t / (interval * 1000));

function encode(secret: string, payload: QrPayload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(secret, body)}`;
}

export function makeDynamicToken(secret: string, activityId: string, now: number, interval: number, coords: QrCoords = {}) {
  return encode(secret, {
    v: 3,
    a: activityId,
    w: windowOf(now, interval),
    ...(interval !== QR_INTERVAL_DEFAULT && { i: interval }),
    ...coords,
  });
}

export function makeStaticToken(secret: string, activityId: string, coords: QrCoords = {}) {
  return encode(secret, { v: 3, a: activityId, s: 1, ...coords });
}

/** Checks the signature and the shape. Null means QR_INVALID. */
export function parseToken(secret: string, token: unknown): { payload: QrPayload; ref: string } | null {
  if (typeof token !== 'string') return null;
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return null;
  const want = Buffer.from(sign(secret, body));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  let payload: QrPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (payload?.v !== 3 || typeof payload.a !== 'string' || !payload.a) return null;
  return { payload, ref: createHash('sha256').update(sig).digest('hex').slice(0, 8).toUpperCase() };
}

/** Whether the token's kind still matches the activity. Switching mode cancels QR codes of the old kind. */
export const matchesMode = (p: QrPayload, qrMode: string) => (p.s === 1) === (qrMode === 'static');

/** Checks the token's time rule at moment `at`, which is server time or an accepted offline scan time. */
export function checkTime(p: QrPayload, at: number, activity: { start: number; end: number }): QrTimeError | null {
  if (p.s === 1) {
    if (at < activity.start - STATIC_SLACK_MS) return 'QR_EARLY';
    if (at > activity.end + STATIC_SLACK_MS) return 'QR_LATE';
    return null;
  }
  const interval = typeof p.i === 'number' && p.i > 0 ? p.i : QR_INTERVAL_DEFAULT;
  const cur = windowOf(at, interval);
  if (typeof p.w !== 'number' || p.w < cur - Math.ceil(QR_LIFETIME_S / interval) || p.w > cur + QR_AHEAD) return 'QR_EXPIRED';
  return null;
}
