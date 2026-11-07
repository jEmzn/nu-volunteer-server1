import { NestExpressApplication } from '@nestjs/platform-express';
import { makeDynamicToken } from '../src/modules/qr/qr-token';
import { api, http, newActivity, ORG_A, QR_SECRET, resetDb, startApp, student, sup } from './helpers';

let app: NestExpressApplication;
const LIMITS = { RATE_AUTH_SUP: process.env.RATE_AUTH_SUP, RATE_AUTH_STUDENT: process.env.RATE_AUTH_STUDENT, RATE_CLAIMS: process.env.RATE_CLAIMS, RATE_WRITES: process.env.RATE_WRITES };

beforeEach(async () => {
  // Fresh app per test: the counters live in the app. Generous while setting up, tightened by each test.
  app = await startApp();
  await resetDb(app);
});
afterEach(async () => {
  Object.assign(process.env, LIMITS);
  await app.close();
});

describe('rate limits', () => {
  it('supervisor sign-in: 5 a minute per IP, by default', async () => {
    delete process.env.RATE_AUTH_SUP;
    for (let i = 0; i < 5; i++) await http(app).post('/auth/sup').send({ supName: 'ก', orgCode: 'WRONG' }).expect(401);
    const res = await http(app).post('/auth/sup').send({ supName: 'ก', orgCode: ORG_A }).expect(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
  });

  it('student sign-in: a whole hall on one address can get in, within the agreed ceiling', async () => {
    delete process.env.RATE_AUTH_STUDENT;
    // In batches: this checks the counter, not how many sockets the test client can open in one instant.
    const statuses: number[] = [];
    for (let batch = 0; batch < 15; batch++) {
      const results = await Promise.all(Array.from({ length: 20 }, (_, i) => http(app).post('/auth/student').send({ studentId: String(66000000 + batch * 20 + i), name: `นิสิต ${i}` })));
      statuses.push(...results.map((r) => r.status));
    }
    expect(statuses).toHaveLength(300);
    expect(statuses.every((s) => s === 200)).toBe(true);
  });

  it('student sign-in stops at the ceiling, which env can change', async () => {
    process.env.RATE_AUTH_STUDENT = '3';
    for (let i = 0; i < 3; i++) await http(app).post('/auth/student').send({ studentId: '65000001', name: 'ก' }).expect(200);
    await http(app).post('/auth/student').send({ studentId: '65000001', name: 'ก' }).expect(429);
  });

  it('supervisor sign-in stays per IP when a token is sent, so minting student tokens does not buy more guesses', async () => {
    const tokens = await Promise.all(Array.from({ length: 6 }, (_, i) => student(app, String(65000010 + i), 'ก')));
    delete process.env.RATE_AUTH_SUP;
    for (const t of tokens.slice(0, 5)) await api(app, t).post('/auth/sup', { supName: 'ก', orgCode: 'WRONG' }).expect(401);
    await api(app, tokens[5]).post('/auth/sup', { supName: 'ก', orgCode: ORG_A }).expect(429);
  });

  it('other writes: 60 a minute per user and endpoint, reads are not counted', async () => {
    const a = await student(app, '65000001', 'ก');
    const b = await student(app, '65000002', 'ข');
    delete process.env.RATE_WRITES;
    const notice = { kind: 'open', title: 'เปิดรับ' };
    for (let i = 0; i < 60; i++) await api(app, a).post('/students/me/notices', notice).expect(201);
    const res = await api(app, a).post('/students/me/notices', notice).expect(429);
    expect(res.body.error).toEqual({ code: 'RATE_LIMITED', message: 'เรียกถี่เกินไป กรุณารอสักครู่' });
    // Another endpoint, another user and reads all still work.
    await api(app, a).post('/students/me/notices/read').expect(200);
    await api(app, b).post('/students/me/notices', notice).expect(201);
    for (let i = 0; i < 70; i++) await api(app, a).get('/students/me/notices').expect(200);
  });

  it('claims: 10 a minute per student, not per IP', async () => {
    const a = await student(app, '65000001', 'ก');
    const b = await student(app, '65000002', 'ข');
    const id = await newActivity(app, await sup(app));
    const token = makeDynamicToken(QR_SECRET, id, Date.now(), 10);
    delete process.env.RATE_CLAIMS;
    for (let i = 0; i < 10; i++) await api(app, a).post('/claims', { token }).expect(200);
    expect((await api(app, a).post('/claims', { token }).expect(429)).body.error.code).toBe('RATE_LIMITED');
    // Same address, different student: unaffected.
    await api(app, b).post('/claims', { token }).expect(200);
  });
});
