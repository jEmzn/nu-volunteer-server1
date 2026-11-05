import { HttpException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AllExceptionsFilter } from '../src/common/errors';
import { cleanName, fmtHours, newId, thDate, thTime } from '../src/common/format';
import { assertPoster, base64Bytes, MAX_POSTER_BYTES } from '../src/common/poster';
import { acceptScannedAt, bottleHours, distanceM, judgeLocation } from '../src/modules/claims/rules';
import { semesterOf } from '../src/modules/roster/strikes';
import { adminRows, safeCell, supRows } from '../src/modules/export/rows';
import { checkTime, makeDynamicToken, makeStaticToken, matchesMode, parseToken, windowOf } from '../src/modules/qr/qr-token';

const SECRET = 'unit-secret-unit-secret-unit-secret';
const NOW = 1_800_000_000_000;
const activity = { start: NOW - 3_600_000, end: NOW + 3_600_000 };

describe('QR token', () => {
  it('signs and verifies, with the documented shape', () => {
    const token = makeDynamicToken(SECRET, 'act1', NOW, 10, { la: 16.7, lo: 100.2, ac: 12 });
    const parsed = parseToken(SECRET, token)!;
    expect(parsed.payload).toEqual({ v: 3, a: 'act1', w: windowOf(NOW, 10), la: 16.7, lo: 100.2, ac: 12 });
    expect(token).not.toContain('=');
    // No hours inside: the server reads them from the activity.
    expect(JSON.stringify(parsed.payload)).not.toContain('"h"');
    const sig = token.split('.')[1];
    expect(Buffer.from(sig, 'base64url')).toHaveLength(12);
    expect(parsed.ref).toBe(createHash('sha256').update(sig).digest('hex').slice(0, 8).toUpperCase());
  });

  it('writes the interval only when it is not 10', () => {
    expect(parseToken(SECRET, makeDynamicToken(SECRET, 'a', NOW, 10))!.payload.i).toBeUndefined();
    expect(parseToken(SECRET, makeDynamicToken(SECRET, 'a', NOW, 15))!.payload.i).toBe(15);
  });

  it('rejects one changed character anywhere', () => {
    const token = makeDynamicToken(SECRET, 'act1', NOW, 10);
    for (let i = 0; i < token.length; i++) {
      if (token[i] === '.') continue;
      const changed = token.slice(0, i) + (token[i] === 'A' ? 'B' : 'A') + token.slice(i + 1);
      expect(parseToken(SECRET, changed)).toBeNull();
    }
  });

  it('rejects malformed tokens, other secrets and other versions', () => {
    const good = makeStaticToken(SECRET, 'a');
    expect(parseToken(SECRET, '')).toBeNull();
    expect(parseToken(SECRET, 'abc')).toBeNull();
    expect(parseToken(SECRET, `${good}.x`)).toBeNull();
    expect(parseToken('another-secret', good)).toBeNull();
    expect(parseToken(SECRET, 42)).toBeNull();
    const { createHmac } = jest.requireActual('node:crypto');
    const forge = (payload: unknown) => {
      const body = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload)).toString('base64url');
      return `${body}.${createHmac('sha256', SECRET).update(body).digest().subarray(0, 12).toString('base64url')}`;
    };
    expect(parseToken(SECRET, forge('{not json'))).toBeNull();
    expect(parseToken(SECRET, forge({ v: 2, a: 'x', h: 99 }))).toBeNull();
    expect(parseToken(SECRET, forge({ v: 3 }))).toBeNull();
  });

  it.each([
    [10, 6],
    [15, 4],
  ])('dynamic at %i s accepts %i windows back and one ahead, and nothing more', (interval, back) => {
    const cur = windowOf(NOW, interval);
    const at = (w: number) => checkTime({ v: 3, a: 'x', w, ...(interval !== 10 && { i: interval }) }, NOW, activity);
    expect(at(cur)).toBeNull();
    expect(at(cur - back)).toBeNull();
    expect(at(cur - back - 1)).toBe('QR_EXPIRED');
    expect(at(cur + 1)).toBeNull();
    expect(at(cur + 2)).toBe('QR_EXPIRED');
  });

  it('dynamic without a window is expired', () => {
    expect(checkTime({ v: 3, a: 'x' }, NOW, activity)).toBe('QR_EXPIRED');
  });

  it('static works from start - 30 minutes to end + 30 minutes', () => {
    const p = { v: 3 as const, a: 'x', s: 1 as const };
    const M30 = 30 * 60_000;
    expect(checkTime(p, activity.start - M30, activity)).toBeNull();
    expect(checkTime(p, activity.start - M30 - 1, activity)).toBe('QR_EARLY');
    expect(checkTime(p, activity.end + M30, activity)).toBeNull();
    expect(checkTime(p, activity.end + M30 + 1, activity)).toBe('QR_LATE');
  });

  it('knows when the token kind no longer matches the activity', () => {
    expect(matchesMode({ v: 3, a: 'x', s: 1 }, 'static')).toBe(true);
    expect(matchesMode({ v: 3, a: 'x', s: 1 }, 'dynamic')).toBe(false);
    expect(matchesMode({ v: 3, a: 'x', w: 1 }, 'dynamic')).toBe(true);
    expect(matchesMode({ v: 3, a: 'x', w: 1 }, 'static')).toBe(false);
  });
});

describe('location', () => {
  const token = { v: 3 as const, a: 'x', la: 16.7466, lo: 100.1948, ac: 20 };
  const on = { loc_mode: 'on', radius: 150 };

  it('measures distance with haversine', () => {
    // One degree of latitude is about 111.2 km with R = 6,371,000 m.
    expect(distanceM({ lat: 0, lng: 0 }, { lat: 1, lng: 0 })).toBeCloseTo(111194.9, 0);
    expect(distanceM({ lat: 16, lng: 100 }, { lat: 16, lng: 100 })).toBe(0);
  });

  it('inside the radius has no flag and keeps distance and accuracy', () => {
    const r = judgeLocation(on, token, { lat: 16.7466, lng: 100.1948, accuracy: 10 });
    expect(r).toEqual({ flags: [], distance: 0, accuracy: 10 });
  });

  it('counts each side accuracy, capped at 100 m', () => {
    // 0.0036 degrees is about 400 m: inside 150 + 100 + 100 + ... only if accuracy counts.
    const far = { lat: 16.7466 + 0.0036, lng: 100.1948 };
    const big = { ...token, ac: 5000 };
    expect(judgeLocation(on, big, { ...far, accuracy: 5000 }).flags).toEqual(['location']);
    const near = { lat: 16.7466 + 0.0027, lng: 100.1948 }; // about 300 m, under 150 + 100 + 100
    expect(judgeLocation(on, big, { ...near, accuracy: 5000 }).flags).toEqual([]);
    expect(judgeLocation(on, { ...token, ac: 0 }, { ...near, accuracy: 0 }).flags).toEqual(['location']);
  });

  it('flags a missing position but never blocks', () => {
    expect(judgeLocation(on, token, {})).toEqual({ flags: ['location'] });
    expect(judgeLocation(on, token, { lat: null, lng: null })).toEqual({ flags: ['location'] });
  });

  it('flags a QR screen without a position and keeps the accuracy', () => {
    expect(judgeLocation(on, { v: 3, a: 'x' }, { lat: 16, lng: 100, accuracy: 33 })).toEqual({ flags: ['location'], accuracy: 33 });
  });

  it('does not check when location is off', () => {
    expect(judgeLocation({ loc_mode: 'off', radius: 150 }, token, { lat: 1, lng: 1, accuracy: 1 })).toEqual({ flags: [] });
  });
});

describe('offline scan time', () => {
  const H = 3_600_000;
  const a = { start: NOW - 10 * H, end: NOW + 10 * H };

  it('accepts a time in range', () => expect(acceptScannedAt(NOW - H, NOW, a)).toBe(NOW - H));
  it('rejects a missing value', () => expect(acceptScannedAt(undefined, NOW, a)).toBeNull());
  it('allows one minute in the future, no more', () => {
    expect(acceptScannedAt(NOW + 60_000, NOW, a)).toBe(NOW + 60_000);
    expect(acceptScannedAt(NOW + 60_001, NOW, a)).toBeNull();
  });
  it('allows 48 hours back, no more', () => {
    const old = { start: NOW - 100 * H, end: NOW };
    expect(acceptScannedAt(NOW - 48 * H, NOW, old)).toBe(NOW - 48 * H);
    expect(acceptScannedAt(NOW - 48 * H - 1, NOW, old)).toBeNull();
  });
  it('must fall within start - 1 hour and end + 24 hours', () => {
    const b = { start: NOW - 5 * H, end: NOW - 2 * H };
    expect(acceptScannedAt(NOW - 6 * H, NOW, b)).toBe(NOW - 6 * H);
    expect(acceptScannedAt(NOW - 6 * H - 1, NOW, b)).toBeNull();
    const c = { start: NOW - 40 * H, end: NOW - 30 * H };
    expect(acceptScannedAt(NOW - 6 * H, NOW, c)).toBe(NOW - 6 * H);
    expect(acceptScannedAt(NOW - 5 * H, NOW, c)).toBeNull();
  });
});

describe('bottles', () => {
  it('counts whole hours and never above the maximum', () => {
    expect(bottleHours(19, 20, 5)).toBe(0);
    expect(bottleHours(20, 20, 5)).toBe(1);
    expect(bottleHours(10000, 20, 5)).toBe(5);
    expect(bottleHours(10, 0, 5)).toBe(0);
  });
});

describe('formatting', () => {
  it('cleans names', () => expect(cleanName('  สมชาย   \t ใจดี ')).toBe('สมชาย ใจดี'));
  it('keeps whole hours whole', () => {
    expect(fmtHours(6)).toBe('6');
    expect(fmtHours(1.5)).toBe('1.5');
  });
  it('makes ids of 10 characters from [0-9a-z]', () => {
    const ids = new Set(Array.from({ length: 500 }, newId));
    expect(ids.size).toBe(500);
    for (const id of ids) expect(id).toMatch(/^[0-9a-z]{10}$/);
  });
  it('shows dates and times in the display zone, not UTC', () => {
    const t = Date.UTC(2026, 10, 19, 20, 5); // 03:05 on the 20th in Bangkok
    expect(thDate(t, 'Asia/Bangkok')).toBe('20 พ.ย. 2569');
    expect(thTime(t, 'Asia/Bangkok')).toBe('03:05');
    expect(thTime(Date.UTC(2026, 10, 19, 17, 0), 'Asia/Bangkok')).toBe('00:00');
  });
});

describe('semesters', () => {
  it.each([
    [Date.UTC(2026, 4, 1), '2026-05-01'],
    [Date.UTC(2026, 9, 31, 16, 59), '2026-05-01'], // 23:59 on 31 Oct in Bangkok
    [Date.UTC(2026, 9, 31, 17, 0), '2026-11-01'], // 00:00 on 1 Nov in Bangkok
    [Date.UTC(2026, 11, 31), '2026-11-01'],
    [Date.UTC(2027, 0, 5), '2026-11-01'],
    [Date.UTC(2027, 3, 30, 16, 59), '2026-11-01'], // 23:59 on 30 Apr in Bangkok
    [Date.UTC(2027, 3, 30, 17, 0), '2027-05-01'], // 00:00 on 1 May in Bangkok
  ])('%i starts its semester on %s', (t, start) => {
    expect(semesterOf(t, 'Asia/Bangkok').start).toBe(start);
  });
  it('numbers them and ends each where the next begins', () => {
    expect(semesterOf(Date.UTC(2026, 6, 1), 'Asia/Bangkok')).toEqual({ number: 1, start: '2026-05-01', end: '2026-11-01' });
    expect(semesterOf(Date.UTC(2026, 11, 1), 'Asia/Bangkok')).toEqual({ number: 2, start: '2026-11-01', end: '2027-05-01' });
    expect(semesterOf(Date.UTC(2027, 1, 1), 'Asia/Bangkok')).toEqual({ number: 2, start: '2026-11-01', end: '2027-05-01' });
  });
});

describe('posters', () => {
  const dataUrl = (bytes: number) => `data:image/jpeg;base64,${Buffer.alloc(bytes, 1).toString('base64')}`;

  it('measures decoded size', () => {
    for (const n of [1, 2, 3, 299, 300]) expect(base64Bytes(Buffer.alloc(n).toString('base64'))).toBe(n);
  });
  it('accepts empty, a bundled path and a small JPEG', () => {
    expect(() => assertPoster('')).not.toThrow();
    expect(() => assertPoster('./posters/blood-2.jpg')).not.toThrow();
    expect(() => assertPoster(dataUrl(MAX_POSTER_BYTES))).not.toThrow();
  });
  it('answers 413 over 300 KB', () => {
    expect(() => assertPoster(dataUrl(MAX_POSTER_BYTES + 1))).toThrow(expect.objectContaining({ code: 'TOO_LARGE', status: 413 }));
  });
  it.each(['https://evil.example/a.jpg', './posters/../../etc.jpg', 'data:image/png;base64,AAAA', 'data:image/jpeg;base64,<script>', './posters/a.png'])('refuses %s', (v) => {
    expect(() => assertPoster(v)).toThrow(expect.objectContaining({ code: 'VALIDATION' }));
  });
});

describe('the error filter', () => {
  const run = (e: unknown) => {
    const sent: { status?: number; body?: any } = {};
    const res = { status: (s: number) => ((sent.status = s), res), json: (b: unknown) => ((sent.body = b), res) };
    const host = { switchToHttp: () => ({ getResponse: () => res }) } as any;
    const filter = new AllExceptionsFilter();
    (filter as any).log = { error: () => undefined };
    filter.catch(e, host);
    return sent;
  };

  it('hides what went wrong on a real failure', () => {
    const { status, body } = run(new Error('connect ECONNREFUSED 10.0.0.5:5432 password=secret'));
    expect(status).toBe(500);
    expect(body).toEqual({ error: { code: 'INTERNAL', message: expect.any(String) } });
    expect(JSON.stringify(body)).not.toMatch(/ECONNREFUSED|secret|stack/);
  });

  it('does not pass through the wording of other HTTP errors above 499', () => {
    expect(run(new HttpException('database is on fire', 503)).status).toBe(500);
  });
});

describe('Excel rows', () => {
  const TZ = 'Asia/Bangkok';
  const act = { title: 'เก็บขยะ', org: 'หน่วยงาน A', category_key: 'bottle', start_at: new Date(Date.UTC(2026, 10, 20, 1)) };
  const base = { method: 'qr', flags: [], hours: 5, edited_by: null, reason: null, items: null, distance: null };

  it('stops formulas', () => {
    for (const v of ['=1+1', '+1', '-1', '@x']) expect(safeCell(v)).toBe(`'${v}`);
    expect(safeCell('สมชาย')).toBe('สมชาย');
    expect(safeCell(-1)).toBe(-1);
  });

  it('builds the supervisor file in the agreed order with the agreed values', () => {
    const regs = [
      { student_id: '1', name: 'คนมาก่อน', walk_in: false, cancelled_at: null },
      { student_id: '2', name: 'คนมาหลัง', walk_in: false, cancelled_at: null },
      { student_id: '3', name: 'ขวัญ ไม่มา', walk_in: false, cancelled_at: null },
      { student_id: '4', name: 'กมล ไม่มา', walk_in: false, cancelled_at: null },
      { student_id: '5', name: 'ยกเลิก', walk_in: false, cancelled_at: new Date() },
      { student_id: '6', name: 'วอล์คอิน', walk_in: true, cancelled_at: null },
    ];
    const credits = [
      { ...base, student_id: '1', name: 'คนมาก่อน', at: new Date(Date.UTC(2026, 10, 20, 2, 0)) },
      { ...base, student_id: '2', name: 'คนมาหลัง', at: new Date(Date.UTC(2026, 10, 20, 3, 0)), hours: 3, reason: 'กลับก่อน', flags: ['location', 'device', 'offline'], distance: 412.6 },
      { ...base, student_id: '6', name: 'วอล์คอิน', at: new Date(Date.UTC(2026, 10, 20, 1, 30)), method: 'manual', edited_by: 'ผู้ดูแล ข' },
    ];
    const rows = supRows({ ...act, category_key: 'setup' }, regs, credits, TZ);
    expect(rows.map((r) => r[1])).toEqual(['2', '1', '6', '4', '3']); // newest credit first, then no-shows in Thai order
    expect(rows[0]).toEqual([1, '2', 'คนมาหลัง', 'เก็บขยะ', 'จัดสถานที่', '20 พ.ย. 2569', 3, 'ได้ชั่วโมง', '10:00 น.', 'สแกน QR', 'กลับก่อน, อยู่นอกพื้นที่ 413 ม., เครื่องซ้ำ, ส่งภายหลัง']);
    expect(rows[2].slice(6, 10)).toEqual([5, 'ไม่ได้ลงทะเบียน', '08:30 น.', 'ผู้ดูแล ข']);
    expect(rows[3].slice(6)).toEqual([0, 'ไม่มา', '', '', '']);
  });

  it('never calls anyone unregistered on a bottle activity, with or without a count', () => {
    const rows = supRows(act, [{ student_id: '1', name: 'ก', walk_in: true, cancelled_at: null }], [{ ...base, student_id: '1', name: 'ก', at: new Date(), method: 'manual' }], TZ);
    expect(rows[0][7]).toBe('ได้ชั่วโมง');
  });

  it('notes bottles', () => {
    const rows = supRows(act, [{ student_id: '1', name: 'ก', walk_in: true, cancelled_at: null }], [{ ...base, student_id: '1', name: 'ก', at: new Date(), method: 'manual', items: 45, edited_by: null }], TZ);
    expect(rows[0][7]).toBe('ได้ชั่วโมง');
    expect(rows[0][9]).toBe('ผู้ดูแล');
    expect(rows[0][10]).toBe('45 ขวด');
  });

  it('builds the centre file with earners only, by student id', () => {
    const rows = adminRows(
      act,
      [
        { ...base, student_id: '2', name: 'ข', hours: 1 },
        { ...base, student_id: '1', name: 'ก', hours: 2 },
        { ...base, student_id: '3', name: 'ค', hours: 0 },
      ],
      TZ,
    );
    expect(rows).toEqual([
      ['1', 'ก', 'เก็บขยะ', 'หน่วยงาน A', 'แลกขวด', '20 พ.ย. 2569', 2],
      ['2', 'ข', 'เก็บขยะ', 'หน่วยงาน A', 'แลกขวด', '20 พ.ย. 2569', 1],
    ]);
  });
});
