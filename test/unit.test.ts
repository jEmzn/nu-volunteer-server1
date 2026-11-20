import { HttpException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { FACULTIES } from '../src/common/contact';
import { AllExceptionsFilter } from '../src/common/errors';
import { cleanName, fmtHours, maskName, newId, thDate, thTime } from '../src/common/format';
import { assertPoster, base64Bytes, MAX_POSTER_BYTES } from '../src/common/poster';
import { acceptScannedAt, bottleHours, distanceM, judgeLocation } from '../src/modules/claims/rules';
import { semesterOf } from '../src/modules/roster/strikes';
import { adminColumns, adminRows, adminWidths, confirmedAt, distanceText, fileTitle, safeCell, SUP_COLUMNS, supColumns, supRows, supWidths, xlsxName } from '../src/modules/export/rows';
import { checkTime, makeDynamicToken, makeStaticToken, matchesMode, parseToken, windowOf } from '../src/modules/qr/qr-token';

const SECRET = 'unit-secret-unit-secret-unit-secret';
const NOW = 1_800_000_000_000;
const activity = { start: NOW - 3_600_000, end: NOW + 3_600_000 };

describe('faculty list', () => {
  it('spells the college as the university does and has no "อื่น ๆ" entry, the same as the web', () => {
    expect(FACULTIES).toContain('วิทยาลัยพลังงานทดแทนและสมาร์ตกริดเทคโนโลยี');
    expect(FACULTIES.some((f) => f.includes('สมาร์ท'))).toBe(false);
    expect(FACULTIES).not.toContain('อื่น ๆ');
    expect(FACULTIES).toHaveLength(19);
  });
});

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

  it('dynamic also works only from start - 30 minutes to end + 30 minutes, however fresh', () => {
    const M30 = 30 * 60_000;
    const fresh = (t: number) => checkTime({ v: 3, a: 'x', w: windowOf(t) }, t, activity);
    expect(fresh(activity.start - M30)).toBeNull();
    expect(fresh(activity.start - M30 - 1)).toBe('QR_EARLY');
    expect(fresh(activity.end + M30)).toBeNull();
    expect(fresh(activity.end + M30 + 1)).toBe('QR_LATE');
  });

  it('a token made ahead for a later window passes once that window comes', () => {
    const w = windowOf(NOW) + 12;
    const p = parseToken(SECRET, makeDynamicToken(SECRET, 'x', w * 10_000, 10))!.payload;
    expect(checkTime(p, NOW, activity)).toBe('QR_EXPIRED');
    expect(checkTime(p, w * 10_000, activity)).toBeNull();
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

  it.each([
    ['วอเมด เทสเทส', 'วอเมด เทส•••'],
    ['  สมชาย   ใจดี ', 'สมชาย ใจ•••'],
    ['สมหญิง ณ อยุธยา', 'สมหญิง ณ••• อยุธ•••'],
    ['ชื่อเดิม', 'ชื่อเ•••'],
    ['John Smith', 'John Smi•••'],
  ])('masks "%s" as "%s", keeping Thai marks on their letter', (name, masked) => expect(maskName(name)).toBe(masked));
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
      { ...base, student_id: '6', name: 'วอล์คอิน', at: new Date(Date.UTC(2026, 10, 20, 1, 30)), method: 'manual', edited_by: 'ผู้ดูแล ข', flags: ['location'] },
    ];
    const closed = { ...act, category_key: 'setup', closed_at: new Date() };
    const rows = supRows(closed, regs, credits, TZ);
    expect(rows.map((r) => r[1])).toEqual(['6', '1', '2', '4', '3']); // oldest credit first, then no-shows in Thai order
    expect(rows.map((r) => r[0])).toEqual([1, 2, 3, 4, 5]);
    expect(rows[2]).toEqual([3, '2', 'คนมาหลัง', '', '', 'เก็บขยะ', 'จัดสถานที่', '20 พ.ย. 2569', 3, 'ได้ชั่วโมง', '20 พ.ย. 2569 10:00 น.', 'สแกน QR', 'กลับก่อน, ห่าง 413 ม., ใช้เครื่องซ้ำ, ส่งภายหลัง']);
    expect(rows[0].slice(8)).toEqual([5, 'walk-in', '20 พ.ย. 2569 08:30 น.', 'ผู้ดูแล ข', 'ไม่มีตำแหน่ง']);
    expect(rows[3].slice(8)).toEqual([0, 'ไม่มา', '', '', '']);
  });

  it('says how many bottles make an hour for someone still below it (N2)', () => {
    const bottle = { ...act, items_per_hour: 20, closed_at: new Date() };
    const credits = [
      { ...base, student_id: '1', name: 'ก', method: 'manual', items: 12, hours: 0, at: new Date(Date.UTC(2026, 10, 20, 2)) },
      { ...base, student_id: '2', name: 'ข', method: 'manual', items: 40, hours: 2, at: new Date(Date.UTC(2026, 10, 20, 3)) },
    ];
    const regs = [{ student_id: '2', name: 'ข', walk_in: true, cancelled_at: null }];
    expect(supRows(bottle, regs, credits, TZ).map((r) => r.slice(8, 10))).toEqual([
      [0, 'ยังไม่ครบ 20 ขวด'],
      [2, 'ได้ชั่วโมง'],
    ]);
  });

  it('says ไม่ได้ชั่วโมง, with the reason, for someone left at 0 hours in an ordinary activity (VB-26)', () => {
    const setup = { ...act, category_key: 'setup', closed_at: new Date() };
    const credits = [
      { ...base, student_id: '1', name: 'ก', method: 'manual', hours: 0, reason: 'ไม่ได้ทำงาน', at: new Date(Date.UTC(2026, 10, 20, 2)) },
      { ...base, student_id: '2', name: 'ข', hours: 0, reason: 'กลับก่อน', at: new Date(Date.UTC(2026, 10, 20, 3)) },
    ];
    const regs = [
      { student_id: '1', name: 'ก', walk_in: true, cancelled_at: null },
      { student_id: '2', name: 'ข', walk_in: false, cancelled_at: null },
    ];
    expect(supRows(setup, regs, credits, TZ).map((r) => [r[8], r[9], r[12]])).toEqual([
      [0, 'ไม่ได้ชั่วโมง', 'ไม่ได้ทำงาน'],
      [0, 'ไม่ได้ชั่วโมง', 'กลับก่อน'],
    ]);
  });

  it('calls nobody a no-show until the roster closes, by hand or a day after the end (R15)', () => {
    const regs = [{ student_id: '3', name: 'ขวัญ', walk_in: false, cancelled_at: null }];
    const open = { ...act, category_key: 'setup', end_at: new Date(Date.UTC(2026, 10, 20, 9)) };
    const during = Date.UTC(2026, 10, 20, 5);
    expect(supRows(open, regs, [], TZ, during)[0].slice(8, 10)).toEqual([null, 'ยังไม่สแกน']);
    expect(supRows(open, regs, [], TZ, Date.UTC(2026, 10, 21, 9))[0].slice(8, 10)).toEqual([0, 'ไม่มา']);
    expect(supRows({ ...open, closed_at: new Date(during) }, regs, [], TZ, during)[0].slice(8, 10)).toEqual([0, 'ไม่มา']);
  });

  it('writes the distance as the app chip does, in kilometres past 1 km (R39)', () => {
    expect(distanceText(413.2)).toBe('ห่าง 413 ม.');
    expect(distanceText(10714)).toBe('ห่าง 10.7 กม.');
  });

  it('names files by kind, the activity day and the title cut between words (R22)', () => {
    const a = { ...act, title: 'ค่ายอาสาสร้างฝายชะลอน้ำและซ่อมแซมอาคารเรียนโรงเรียนบ้านห้วยไร่' };
    const name = xlsxName('sup', a, TZ);
    expect(name).toMatch(/^รายชื่อ 20-11-2569 ค่ายอาสา/);
    expect(name.endsWith('.xlsx')).toBe(true);
    const title = name.slice('รายชื่อ 20-11-2569 '.length, -'.xlsx'.length);
    expect(title.length).toBeLessThanOrEqual(40);
    expect(a.title.startsWith(title)).toBe(true);
    // Cut at a word boundary: the next character starts a new word, never mid-word like "อาคารเร".
    expect(['อาคาร', 'เรียน', 'โรงเรียน', 'และ', 'ซ่อมแซม'].some((w) => a.title.slice(title.length).startsWith(w))).toBe(true);
    expect(xlsxName('admin', { ...act, title: 'a/b: c?' }, TZ)).toBe('บันทึกชั่วโมง 20-11-2569 a b c.xlsx');
    expect(fileTitle('สั้น')).toBe('สั้น');
  });

  it('repeats the activity on every row, through safeCell', () => {
    const day = { ...act, category_key: 'setup', closed_at: new Date() };
    const regs = [{ student_id: '1', name: 'ก', walk_in: false, cancelled_at: null }];
    expect(supRows(day, regs, [], TZ)[0].slice(5, 8)).toEqual(['เก็บขยะ', 'จัดสถานที่', '20 พ.ย. 2569']);
    expect(supRows({ ...day, title: '=HYPERLINK("x")' }, regs, [], TZ)[0][5]).toBe(`'=HYPERLINK("x")`);
  });

  it('gives the confirm time with the full date', () => {
    expect(confirmedAt(Date.UTC(2026, 10, 20, 3, 52), TZ)).toBe('20 พ.ย. 2569 10:52 น.');
    // After midnight in Thailand is the next day even though it is the same day in UTC.
    expect(confirmedAt(Date.UTC(2026, 10, 20, 17, 5), TZ)).toBe('21 พ.ย. 2569 00:05 น.');
  });

  it('never calls anyone unregistered on a bottle activity, with or without a count', () => {
    const rows = supRows(act, [{ student_id: '1', name: 'ก', walk_in: true, cancelled_at: null }], [{ ...base, student_id: '1', name: 'ก', at: new Date(), method: 'manual' }], TZ);
    expect(rows[0][9]).toBe('ได้ชั่วโมง');
  });

  it('notes bottles', () => {
    const rows = supRows(act, [{ student_id: '1', name: 'ก', walk_in: true, cancelled_at: null }], [{ ...base, student_id: '1', name: 'ก', at: new Date(), method: 'manual', items: 45, edited_by: null }], TZ);
    expect(rows[0][9]).toBe('ได้ชั่วโมง');
    expect(rows[0][11]).toBe('ผู้ดูแล');
    expect(rows[0][12]).toBe('45 ขวด');
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
      ['1', 'ก', '', '', 'เก็บขยะ', 'หน่วยงาน A', 'แลกขวด', '20 พ.ย. 2569', 2, 'ได้ชั่วโมง'],
      ['2', 'ข', '', '', 'เก็บขยะ', 'หน่วยงาน A', 'แลกขวด', '20 พ.ย. 2569', 1, 'ได้ชั่วโมง'],
    ]);
  });

  describe('the registration form', () => {
    const qs = [
      { id: 'a', label: 'ชั้นปี', type: 'choice', options: ['ปี 1', 'ปี 2'], required: true },
      { id: 'b', label: 'โรคประจำตัว', type: 'text', required: false },
    ];
    const withForm = { ...act, category_key: 'setup', closed_at: new Date(), questions: qs };
    const regs = [
      { student_id: '1', name: 'ก', walk_in: false, cancelled_at: null, phone: '081-234 5678', faculty: 'วิศวกรรมศาสตร์', answers: { a: 'ปี 2', gone: 'ไม่มีข้อนี้แล้ว' } },
      { student_id: '2', name: 'ข', walk_in: true, cancelled_at: null, phone: null, faculty: null, answers: {} },
    ];
    const credits = [{ ...base, student_id: '3', name: 'ค', at: new Date(Date.UTC(2026, 10, 20, 2)) }];

    it('names the columns after the name and id, ahead of the activity', () => {
      expect(supColumns(qs)).toEqual(['ลำดับ', 'รหัสนิสิต', 'ชื่อ', 'เบอร์โทร', 'คณะ', 'ชั้นปี', 'โรคประจำตัว', 'กิจกรรม', 'หมวด', 'วันที่', 'ชั่วโมง', 'สถานะ', 'เวลายืนยัน', 'ยืนยันโดย', 'หมายเหตุ']);
      expect(adminColumns(qs)).toEqual(['รหัสนิสิต', 'ชื่อ', 'เบอร์โทร', 'คณะ', 'ชั้นปี', 'โรคประจำตัว', 'กิจกรรม', 'หน่วยงาน', 'หมวด', 'วันที่', 'ชั่วโมง', 'สถานะ']);
      expect(supColumns([])).toEqual(SUP_COLUMNS);
      expect(supWidths(qs)).toHaveLength(supColumns(qs).length);
      expect(adminWidths(qs)).toHaveLength(adminColumns(qs).length);
      expect(supColumns([{ ...qs[0], label: '=1+1' }])[5]).toBe("'=1+1");
    });

    it('fills the form cells per person, blank for no form, and ignores answers to questions that are gone', () => {
      const rows = supRows(withForm, regs, credits, TZ);
      const byId = Object.fromEntries(rows.map((r) => [r[1], r]));
      expect(byId['1'].slice(3, 7)).toEqual(['081-234 5678', 'วิศวกรรมศาสตร์', 'ปี 2', '']);
      expect(byId['2'].slice(3, 7)).toEqual(['', '', '', '']);
      // Credit without a registration (walk-in from the supervisor).
      expect(byId['3'].slice(3, 7)).toEqual(['', '', '', '']);
      expect(rows.every((r) => r.length === supColumns(qs).length)).toBe(true);
    });

    it('does not read a cancelled registration', () => {
      const cancelled = [{ ...regs[0], cancelled_at: new Date() }];
      const credit = [{ ...base, student_id: '1', name: 'ก', at: new Date() }];
      expect(supRows(withForm, cancelled, credit, TZ)[0].slice(3, 7)).toEqual(['', '', '', '']);
    });

    it('stops a formula in an answer and in a phone', () => {
      const evil = [{ ...regs[0], phone: '-1', answers: { b: '@cmd' } }];
      expect(supRows(withForm, evil, [], TZ)[0].slice(3, 7)).toEqual(["'-1", 'วิศวกรรมศาสตร์', '', "'@cmd"]);
    });

    it('gives the centre file the same cells', () => {
      const rows = adminRows(withForm, [{ ...base, student_id: '1', name: 'ก', hours: 2 }, { ...base, student_id: '3', name: 'ค', hours: 1 }], TZ, new Map(), regs);
      expect(rows.map((r) => r.slice(0, 6))).toEqual([
        ['1', 'ก', '081-234 5678', 'วิศวกรรมศาสตร์', 'ปี 2', ''],
        ['3', 'ค', '', '', '', ''],
      ]);
      expect(rows.every((r) => r.length === adminColumns(qs).length)).toBe(true);
    });
  });
});
