import { ApiError, validation } from './errors';

export const MAX_POSTER_BYTES = 300 * 1024;

const PATH = /^\.\/posters\/[A-Za-z0-9_-]+\.jpg$/;
const DATA_URL = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/;
const DATA_PREFIX = 'data:image/jpeg;base64,';

/**
 * An uploaded poster as a URL on this API, because a list of images inside JSON costs every reader megabytes.
 * The version is the size plus a hash of the first 8 KB: hashing whole posters took 84 ms per list at 100 posters,
 * against 6 ms. Two images with the same size and the same start would share a version until the next day's
 * revalidation (see POSTER_CACHE).
 */
export const POSTER_COLUMN = `CASE WHEN left(poster, ${DATA_PREFIX.length}) = '${DATA_PREFIX}'
  THEN '/activities/' || id || '/poster?v=' || octet_length(poster) || '-' || md5(left(poster, 8192))
  ELSE poster END AS poster`;

export const POSTER_CACHE = 'public, max-age=86400';

/** The JPEG inside an uploaded poster, or null for an empty one or a path inside the web bundle. */
export const posterImage = (poster: string) => (poster.startsWith(DATA_PREFIX) ? Buffer.from(poster.slice(DATA_PREFIX.length), 'base64') : null);

/** Decoded size of a base64 string in bytes. */
export function base64Bytes(b64: string) {
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

/** A poster is empty, a path inside the web bundle, or a JPEG data URL of at most 300 KB once decoded. */
export function assertPoster(value: string, field = 'poster') {
  if (value === '' || PATH.test(value)) return;
  const m = DATA_URL.exec(value);
  if (!m) throw validation([field], 'รูปต้องเป็น JPEG data URL หรือ path ของรูปในตัวเว็บ');
  if (base64Bytes(m[1]) > MAX_POSTER_BYTES) throw new ApiError(413, 'TOO_LARGE', 'รูปใหญ่เกิน 300 KB');
}
