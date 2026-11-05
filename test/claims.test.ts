import { NestExpressApplication } from '@nestjs/platform-express';
import { makeDynamicToken, makeStaticToken, windowOf } from '../src/modules/qr/qr-token';
import { activityRow, api, creditRow, dbOf, HOUR, newActivity, noticesOf, ORG_ADMIN, ORG_B, QR_SECRET, regRow, resetDb, startApp, student, sup } from './helpers';

let app: NestExpressApplication;
beforeAll(async () => {
  app = await startApp();
});
afterAll(() => app.close());
beforeEach(() => resetDb(app));

const LAT = 16.7466;
const LNG = 100.1948;
const at = { lat: LAT, lng: LNG, accuracy: 10 };

/** Asks the real endpoint for the token, the way the QR screen will. */
async function qr(owner: string, id: string, coords: object = { la: LAT, lo: LNG, ac: 10 }) {
  return (await api(app, owner).post(`/activities/${id}/qr`, coords).expect(200)).body;
}

describe('asking for a QR', () => {
  it('gives a dynamic token with its URL and refresh time', async () => {
    const owner = await sup(app);
    const id = await newActivity(app, owner, { qrInterval: 15 });
    const before = Date.now();
    const res = await qr(owner, id);
    expect(res.url).toBe(`https://web.example/#/claim?t=${res.token}`);
    expect(res).toMatchObject({ mode: 'dynamic', interval: 15 });
    expect(res.window).toBeGreaterThanOrEqual(windowOf(before, 15));
    expect(res.refreshAt).toBe((res.window + 1) * 15000);
    const payload = JSON.parse(Buffer.from(res.token.split('.')[0], 'base64url').toString());
    expect(payload).toEqual({ v: 3, a: id, w: res.window, i: 15, la: LAT, lo: LNG, ac: 10 });
  });

  it('gives a static token with no window', async () => {
    const owner = await sup(app);
    const id = await newActivity(app, owner, { qrMode: 'static' });
    const res = await qr(owner, id);
    expect(res.mode).toBe('static');
    expect(JSON.parse(Buffer.from(res.token.split('.')[0], 'base64url').toString())).toEqual({ v: 3, a: id, s: 1, la: LAT, lo: LNG, ac: 10 });
  });

  it('leaves coordinates out when the activity does not check location', async () => {
    const owner = await sup(app);
    const id = await newActivity(app, owner, { locMode: 'off' });
    const payload = JSON.parse(Buffer.from((await qr(owner, id)).token.split('.')[0], 'base64url').toString());
    expect(payload).not.toHaveProperty('la');
  });

  it('is for the owner and admin, and stops once the roster is sent', async () => {
    const owner = await sup(app);
    const id = await newActivity(app, owner);
    await api(app, await sup(app, ORG_B)).post(`/activities/${id}/qr`).expect(403);
    await api(app, await student(app)).post(`/activities/${id}/qr`).expect(403);
    await api(app, await sup(app, ORG_ADMIN)).post(`/activities/${id}/qr`).expect(200);
    await api(app, owner).post(`/activities/${id}/submit`).expect(200);
    expect((await api(app, owner).post(`/activities/${id}/qr`).expect(409)).body.error.code).toBe('ROSTER_LOCKED');
  });
});

describe('token checks at check-in', () => {
  let owner: string;
  let s: string;
  beforeEach(async () => {
    owner = await sup(app);
    s = await student(app);
  });
  const claim = (body: object, token = s) => api(app, token).post('/claims', body);

  it('gets hours with a good token', async () => {
    const id = await newActivity(app, owner);
    const { token } = await qr(owner, id);
    const res = await claim({ token, ...at, deviceId: 'd1' }).expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.credit).toMatchObject({ studentId: '65000001', name: 'สมชาย ใจดี', hours: 6, fullHours: 6, method: 'qr', flags: [], deviceId: 'd1', distance: 0, accuracy: 10 });
    expect(res.body.credit.ref).toMatch(/^[0-9A-F]{8}$/);
  });

  it('refuses one changed character', async () => {
    const id = await newActivity(app, owner);
    const { token } = await qr(owner, id);
    const changed = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
    expect((await claim({ token: changed, ...at }).expect(400)).body.error.code).toBe('QR_INVALID');
  });

  it('refuses a token signed with the old public secret', async () => {
    const id = await newActivity(app, owner);
    const forged = makeDynamicToken('nu-volunteer/2569', id, Date.now(), 10);
    expect((await claim({ token: forged, ...at }).expect(400)).body.error.code).toBe('QR_INVALID');
  });

  it('refuses garbage and an activity that does not exist', async () => {
    expect((await claim({ token: 'garbage', ...at }).expect(400)).body.error.code).toBe('QR_INVALID');
    expect((await claim({ token: makeStaticToken(QR_SECRET, 'nope'), ...at }).expect(400)).body.error.code).toBe('QR_INVALID');
  });

  it('refuses a dynamic token over 60 seconds old, takes one ahead', async () => {
    const id = await newActivity(app, owner);
    const old = makeDynamicToken(QR_SECRET, id, Date.now() - 80_000, 10);
    expect((await claim({ token: old, ...at }).expect(400)).body.error.code).toBe('QR_EXPIRED');
    const ahead = makeDynamicToken(QR_SECRET, id, Date.now() + 10_000, 10);
    expect((await claim({ token: ahead, ...at }).expect(200)).body.ok).toBe(true);
  });

  it('refuses a static token too early and too late, reading times from the database', async () => {
    const now = Date.now();
    const id = await newActivity(app, owner, { qrMode: 'static', start: now + HOUR, end: now + 2 * HOUR });
    const token = makeStaticToken(QR_SECRET, id);
    expect((await claim({ token, ...at }).expect(400)).body.error.code).toBe('QR_EARLY');
    await dbOf(app).query(`UPDATE activities SET start_at = now() - interval '3 hours', end_at = now() - interval '2 hours' WHERE id = $1`, [id]);
    expect((await claim({ token, ...at }).expect(400)).body.error.code).toBe('QR_LATE');
    await dbOf(app).query(`UPDATE activities SET end_at = now() + interval '1 hour' WHERE id = $1`, [id]);
    await claim({ token, ...at }).expect(200);
  });

  it('cancels old QR codes when the mode changes', async () => {
    const id = await newActivity(app, owner, { qrMode: 'static' });
    const { token } = await qr(owner, id);
    await api(app, owner).patch(`/activities/${id}`, { qrMode: 'dynamic' }).expect(200);
    expect((await claim({ token, ...at }).expect(400)).body.error.code).toBe('QR_INVALID');
  });

  it('is for students', async () => {
    const id = await newActivity(app, owner);
    const { token } = await qr(owner, id);
    await claim({ token, ...at }, owner).expect(403);
    await api(app).post('/claims', { token }).expect(401);
  });

  it('does not trust hours, flags or identity from the body', async () => {
    const id = await newActivity(app, owner);
    const { token } = await qr(owner, id);
    const res = await claim({ token, ...at, hours: 99, flags: [], distance: 0, studentId: '99999999', name: 'ปลอม', method: 'manual' }).expect(200);
    expect(res.body.credit).toMatchObject({ studentId: '65000001', name: 'สมชาย ใจดี', hours: 6, method: 'qr' });
    expect(await creditRow(app, id, '99999999')).toBeUndefined();
  });
});

describe('location', () => {
  let owner: string;
  let s: string;
  beforeEach(async () => {
    owner = await sup(app);
    s = await student(app);
  });
  const claimed = async (id: string, token: string, body: object) => (await api(app, s).post('/claims', { token, ...body }).expect(200)).body.credit;

  it('inside the radius has no flag', async () => {
    const id = await newActivity(app, owner);
    const c = await claimed(id, (await qr(owner, id)).token, { lat: LAT + 0.001, lng: LNG, accuracy: 5 });
    expect(c.flags).toEqual([]);
    expect(c.distance).toBeGreaterThan(100);
    expect(c.distance).toBeLessThan(120);
    expect(c.accuracy).toBe(5);
  });

  it('outside the radius still gets hours, flagged', async () => {
    const id = await newActivity(app, owner);
    const c = await claimed(id, (await qr(owner, id)).token, { lat: LAT + 1, lng: LNG, accuracy: 5 });
    expect(c.hours).toBe(6);
    expect(c.flags).toEqual(['location']);
    expect(c.distance).toBeGreaterThan(100000);
  });

  it('no position from the student still gets hours, flagged', async () => {
    const id = await newActivity(app, owner);
    const c = await claimed(id, (await qr(owner, id)).token, {});
    expect(c.hours).toBe(6);
    expect(c.flags).toEqual(['location']);
    expect(c).not.toHaveProperty('distance');
  });

  it('no position on the QR screen still gets hours, flagged, keeping accuracy', async () => {
    const id = await newActivity(app, owner);
    const c = await claimed(id, (await qr(owner, id, {})).token, at);
    expect(c.hours).toBe(6);
    expect(c.flags).toEqual(['location']);
    expect(c.accuracy).toBe(10);
    expect(c).not.toHaveProperty('distance');
  });

  it('location off has no flag', async () => {
    const id = await newActivity(app, owner, { locMode: 'off' });
    const c = await claimed(id, (await qr(owner, id)).token, { lat: 0, lng: 0, accuracy: 5 });
    expect(c.flags).toEqual([]);
    expect(c).not.toHaveProperty('distance');
  });
});

describe('writing the credit', () => {
  let owner: string;
  beforeEach(async () => {
    owner = await sup(app);
  });

  it('a second claim answers already with the same row, and changes nothing', async () => {
    const s = await student(app);
    const id = await newActivity(app, owner);
    const { token } = await qr(owner, id);
    const first = (await api(app, s).post('/claims', { token, ...at }).expect(200)).body;
    const again = (await api(app, s).post('/claims', { token, lat: 0, lng: 0 }).expect(200)).body;
    expect(again).toEqual({ ok: false, reason: 'already', credit: first.credit });
    expect((await activityRow(app, id)).credit_count).toBe(1);
    expect((await noticesOf(app, '65000001')).filter((n) => n.kind === 'credit')).toHaveLength(1);
  });

  it('walk-in off without a registration answers NOT_REGISTERED', async () => {
    const s = await student(app);
    const id = await newActivity(app, owner, { walkIn: false });
    const { token } = await qr(owner, id);
    expect((await api(app, s).post('/claims', { token, ...at }).expect(403)).body.error.code).toBe('NOT_REGISTERED');
    expect(await creditRow(app, id, '65000001')).toBeUndefined();
  });

  it('walk-in off with a cancelled registration answers NOT_REGISTERED', async () => {
    const s = await student(app);
    const id = await newActivity(app, owner, { walkIn: false });
    await api(app, s).post(`/activities/${id}/registrations`).expect(200);
    await api(app, s).delete(`/activities/${id}/registrations/me`).expect(200);
    const { token } = await qr(owner, id);
    expect((await api(app, s).post('/claims', { token, ...at }).expect(403)).body.error.code).toBe('NOT_REGISTERED');
  });

  it('walk-in off with a registration gets hours and does not count the seat twice', async () => {
    const s = await student(app);
    const id = await newActivity(app, owner, { walkIn: false });
    await api(app, s).post(`/activities/${id}/registrations`).expect(200);
    const { token } = await qr(owner, id);
    await api(app, s).post('/claims', { token, ...at }).expect(200);
    const row = await activityRow(app, id);
    expect(row.reg_count).toBe(1);
    expect(row.credit_count).toBe(1);
    expect((await regRow(app, id, '65000001')).walk_in).toBe(false);
  });

  it('walk-in creates a registration and bumps reg_count', async () => {
    const s = await student(app);
    const id = await newActivity(app, owner);
    const { token } = await qr(owner, id);
    const { credit } = (await api(app, s).post('/claims', { token, ...at }).expect(200)).body;
    const reg = await regRow(app, id, '65000001');
    expect(reg).toMatchObject({ walk_in: true, cancelled_at: null, late: false, waived: false, name: 'สมชาย ใจดี' });
    expect(reg.at.getTime()).toBe(credit.at);
    expect(await activityRow(app, id)).toMatchObject({ reg_count: 1, credit_count: 1 });
  });

  it('walk-in reopens a cancelled registration and clears its penalty', async () => {
    const s = await student(app);
    const now = Date.now();
    const id = await newActivity(app, owner, { start: now + HOUR, end: now + 2 * HOUR, qrMode: 'static' });
    await api(app, s).post(`/activities/${id}/registrations`).expect(200);
    expect((await api(app, s).delete(`/activities/${id}/registrations/me`).expect(200)).body.late).toBe(true);
    await dbOf(app).query(`UPDATE activities SET start_at = now() WHERE id = $1`, [id]);
    const { token } = await qr(owner, id);
    await api(app, s).post('/claims', { token, ...at }).expect(200);
    expect(await regRow(app, id, '65000001')).toMatchObject({ walk_in: true, cancelled_at: null, late: false });
    expect((await activityRow(app, id)).reg_count).toBe(1);
  });

  it('makes a credit notice for the student', async () => {
    const s = await student(app);
    const id = await newActivity(app, owner);
    const { token } = await qr(owner, id);
    await api(app, s).post('/claims', { token, ...at }).expect(200);
    const notices = await noticesOf(app, '65000001');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ kind: 'credit', title: 'ได้รับ 6 ชั่วโมง', body: 'บริจาคโลหิต', activity_id: id });
  });

  it('one device, two students: flags both rows once', async () => {
    const a = await student(app, '65000001', 'ก');
    const b = await student(app, '65000002', 'ข');
    const c = await student(app, '65000003', 'ค');
    const id = await newActivity(app, owner);
    const { token } = await qr(owner, id);
    const first = (await api(app, a).post('/claims', { token, ...at, deviceId: 'same' }).expect(200)).body.credit;
    expect(first.flags).toEqual([]);
    const second = (await api(app, b).post('/claims', { token, ...at, deviceId: 'same' }).expect(200)).body.credit;
    expect(second.flags).toEqual(['device']);
    expect((await creditRow(app, id, '65000001')).flags).toEqual(['device']);
    await api(app, c).post('/claims', { token, ...at, deviceId: 'same' }).expect(200);
    expect((await creditRow(app, id, '65000001')).flags).toEqual(['device']);
    expect((await creditRow(app, id, '65000002')).flags).toEqual(['device']);
    expect((await creditRow(app, id, '65000003')).flags).toEqual(['device']);
  });

  it('different devices are not flagged', async () => {
    const a = await student(app, '65000001', 'ก');
    const b = await student(app, '65000002', 'ข');
    const id = await newActivity(app, owner);
    const { token } = await qr(owner, id);
    await api(app, a).post('/claims', { token, ...at, deviceId: 'd1' }).expect(200);
    expect((await api(app, b).post('/claims', { token, ...at, deviceId: 'd2' }).expect(200)).body.credit.flags).toEqual([]);
  });

  describe('a scan sent later', () => {
    it('counts its real time, with the flag, and the old token passes', async () => {
      const s = await student(app);
      const now = Date.now();
      const id = await newActivity(app, owner, { start: now - 10 * HOUR, end: now + HOUR });
      const scannedAt = now - 2 * HOUR;
      const token = makeDynamicToken(QR_SECRET, id, scannedAt, 10, { la: LAT, lo: LNG, ac: 10 });
      const { credit } = (await api(app, s).post('/claims', { token, ...at, scannedAt }).expect(200)).body;
      expect(credit.at).toBe(scannedAt);
      expect(credit.flags).toEqual(['offline']);
    });

    it('takes a fractional time, which the web clock offset can produce', async () => {
      const s = await student(app);
      const now = Date.now();
      const id = await newActivity(app, owner, { start: now - 10 * HOUR, end: now + HOUR });
      const scannedAt = now - 2 * HOUR + 0.5;
      const token = makeDynamicToken(QR_SECRET, id, scannedAt, 10, { la: LAT, lo: LNG, ac: 10 });
      const { credit } = (await api(app, s).post('/claims', { token, ...at, scannedAt }).expect(200)).body;
      expect(credit.at).toBe(Math.floor(scannedAt));
      expect(credit.flags).toEqual(['offline']);
    });

    it('older than 48 hours falls back to server time, so an old token is refused', async () => {
      const s = await student(app);
      const now = Date.now();
      const id = await newActivity(app, owner, { start: now - 100 * HOUR, end: now + HOUR });
      const scannedAt = now - 49 * HOUR;
      const token = makeDynamicToken(QR_SECRET, id, scannedAt, 10);
      expect((await api(app, s).post('/claims', { token, ...at, scannedAt }).expect(400)).body.error.code).toBe('QR_EXPIRED');
    });

    it('older than 48 hours with a current token uses server time and no flag', async () => {
      const s = await student(app);
      const now = Date.now();
      const id = await newActivity(app, owner, { start: now - 100 * HOUR, end: now + HOUR });
      const { token } = await qr(owner, id);
      const { credit } = (await api(app, s).post('/claims', { token, ...at, scannedAt: now - 49 * HOUR }).expect(200)).body;
      expect(credit.flags).toEqual([]);
      expect(Math.abs(credit.at - now)).toBeLessThan(30_000);
    });

    it('outside the activity window uses server time', async () => {
      const s = await student(app);
      const now = Date.now();
      const id = await newActivity(app, owner, { start: now - HOUR, end: now + HOUR });
      const { token } = await qr(owner, id);
      const { credit } = (await api(app, s).post('/claims', { token, ...at, scannedAt: now - 3 * HOUR }).expect(200)).body;
      expect(credit.flags).toEqual([]);
    });

    it('in the future uses server time', async () => {
      const s = await student(app);
      const now = Date.now();
      const id = await newActivity(app, owner);
      const { token } = await qr(owner, id);
      const { credit } = (await api(app, s).post('/claims', { token, ...at, scannedAt: now + 5 * 60_000 }).expect(200)).body;
      expect(credit.flags).toEqual([]);
      expect(credit.at).toBeLessThan(now + 60_000);
    });
  });

  describe('after the roster was sent', () => {
    it('refuses new credits with ROSTER_LOCKED', async () => {
      const s = await student(app);
      const id = await newActivity(app, owner);
      const { token } = await qr(owner, id);
      await api(app, owner).post(`/activities/${id}/submit`).expect(200);
      expect((await api(app, s).post('/claims', { token, ...at }).expect(409)).body.error.code).toBe('ROSTER_LOCKED');
      expect(await creditRow(app, id, '65000001')).toBeUndefined();
    });

    it('still answers already to someone who has the hours', async () => {
      const s = await student(app);
      const id = await newActivity(app, owner);
      const { token } = await qr(owner, id);
      await api(app, s).post('/claims', { token, ...at }).expect(200);
      await api(app, owner).post(`/activities/${id}/submit`).expect(200);
      expect((await api(app, s).post('/claims', { token, ...at }).expect(200)).body.reason).toBe('already');
    });
  });

  it('counts exactly right when many claim at once, including the same person twice', async () => {
    const id = await newActivity(app, owner);
    const { token } = await qr(owner, id);
    const tokens = await Promise.all(Array.from({ length: 40 }, (_, i) => student(app, String(66000000 + i), `นิสิต ${i}`)));
    const results = await Promise.all([...tokens, ...tokens].map((t) => api(app, t).post('/claims', { token, ...at })));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => r.body.ok)).toHaveLength(40);
    expect(results.filter((r) => r.body.reason === 'already')).toHaveLength(40);
    const row = await activityRow(app, id);
    expect(row).toMatchObject({ credit_count: 40, reg_count: 40 });
    expect((await dbOf(app).query('SELECT count(*)::int AS n FROM credits WHERE activity_id = $1', [id])).rows[0].n).toBe(40);
  });
});
