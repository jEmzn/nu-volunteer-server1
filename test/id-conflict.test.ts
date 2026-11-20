import { NestExpressApplication } from '@nestjs/platform-express';
import ExcelJS from 'exceljs';
import { nameKey } from '../src/modules/ids/ids';
import { activityRow, api, creditRow, dbOf, http, newActivity, noticesOf, ORG_ADMIN, regRow, resetDb, startApp, sup } from './helpers';

/** Item 23: two people on one student id. */

let app: NestExpressApplication;
const sup_admin = () => sup(app, ORG_ADMIN, 'แอดมิน');
beforeAll(async () => {
  app = await startApp();
});
afterAll(() => app.close());
beforeEach(() => resetDb(app));

const ID = '65001234';
const OWNER = 'ธนพร ใจดี';
const TYPO = 'วอเมด เทสต์';
const at = { lat: 16.7466, lng: 100.1948, accuracy: 10 };

const login = (body: object) => http(app).post('/auth/student').send(body).expect(200);
const qr = async (owner: string, id: string) => (await api(app, owner).post(`/activities/${id}/qr`, { la: at.lat, lo: at.lng, ac: 10 }).expect(200)).body.token;
const claim = async (token: string, qrToken: string, deviceId = 'dev-1') => (await api(app, token).post('/claims', { token: qrToken, ...at, deviceId }).expect(200)).body;
const twins = async () => (await dbOf(app).query(`SELECT id, name FROM students WHERE strpos(id, '#') > 0 ORDER BY id`)).rows;

/** The one who typed the owner's id first, then the owner confirming it is theirs. Both claim the same activity. */
async function sharedId() {
  const owner = await sup(app);
  const act = await newActivity(app, owner);
  const typo = (await login({ studentId: ID, name: TYPO })).body.token;
  await claim(typo, await qr(owner, act), 'dev-typo');
  const first = (await login({ studentId: ID, name: OWNER })).body;
  const mine = (await login({ studentId: ID, name: OWNER, own: true })).body;
  return { owner, act, typo, first, mine };
}

describe('names', () => {
  it('compares names without titles or extra spaces', () => {
    expect(nameKey('นางสาว ธนพร  ใจดี')).toBe(nameKey('ธนพร ใจดี'));
    expect(nameKey('น.ส.ธนพร ใจดี')).toBe(nameKey('ธนพร ใจดี'));
    expect(nameKey('นาย สมชาย ใจดี')).toBe(nameKey('สมชาย ใจดี'));
    expect(nameKey('นาง สมศรี ดี')).toBe(nameKey('สมศรี ดี'));
    expect(nameKey('ธนพร ใจดี')).not.toBe(nameKey('ธนพร ใจงาม'));
  });
});

describe('ก. someone typed my id before I ever used it', () => {
  it('the owner gets an account of their own and the hours at once, in the same activity', async () => {
    const { owner, act, first, mine } = await sharedId();
    // Without "รหัสนี้เป็นของฉันเอง" the id answers with the name already on it, masked.
    expect(first.isNew).toBe(false);
    expect(first.student.id).toBe(ID);
    expect(first.student.name).not.toBe(TYPO);
    expect(mine).toMatchObject({ isNew: true, student: { id: `${ID}#2`, name: OWNER } });

    const res = await claim(mine.token, await qr(owner, act), 'dev-owner');
    expect(res).toMatchObject({ ok: true, credit: { studentId: `${ID}#2`, name: OWNER, hours: 6 } });
    expect(await creditRow(app, act, ID)).toMatchObject({ name: TYPO, hours: 6 });
    expect((await activityRow(app, act)).credit_count).toBe(2);

    // The supervisor sees both, flagged, with hours for both.
    const credits = (await api(app, owner).get(`/activities/${act}/credits`).expect(200)).body;
    expect(credits.map((c: any) => [c.studentId, c.flags.includes('idconflict')])).toEqual([
      [ID, true],
      [`${ID}#2`, true],
    ]);
    const single = (await api(app, owner).get(`/activities/${act}/credits/${encodeURIComponent(`${ID}#2`)}`).expect(200)).body;
    expect(single.flags).toContain('idconflict');
  });

  it('both inboxes get the same neutral notice that names nobody', async () => {
    await sharedId();
    for (const id of [ID, `${ID}#2`]) {
      const n = (await noticesOf(app, id)).find((x) => x.kind === "idconflict")!;
      expect(n).toMatchObject({
        title: `รหัสนิสิต ${ID} มีผู้ใช้ 2 ชื่อ`,
        body: 'ชั่วโมงของคุณบันทึกแยกไว้ในชื่อคุณ เจ้าหน้าที่จะตรวจสอบ ถ้ารหัสนี้ไม่ใช่ของคุณ ออกจากระบบแล้วเข้าใหม่ด้วยรหัสที่ถูก',
      });
      expect(`${n.title}${n.body}`).not.toContain('ธนพร');
      expect(`${n.title}${n.body}`).not.toContain('วอเมด');
    }
  });

  it('signing in again does not make another account, whatever the spacing or title', async () => {
    const { mine } = await sharedId();
    const again = (await login({ studentId: ID, name: OWNER })).body;
    expect(again).toMatchObject({ isNew: false, student: { id: `${ID}#2` } });
    expect(again.student.name).not.toBe(OWNER);
    const titled = (await login({ studentId: ID, name: 'นางสาว ธนพร   ใจดี', own: true })).body;
    expect(titled).toMatchObject({ isNew: false, student: { id: `${ID}#2` } });
    expect(await twins()).toEqual([{ id: `${ID}#2`, name: OWNER }]);
    // The full record is theirs to read with their own token.
    const me = (await api(app, mine.token).get(`/students/${encodeURIComponent(`${ID}#2`)}`).expect(200)).body;
    expect(me).toMatchObject({ id: `${ID}#2`, name: OWNER });
    expect(me.notify).toEqual({});
  });

  it('each account sees only its own hours and registrations', async () => {
    const { typo, mine } = await sharedId();
    expect((await api(app, mine.token).get('/students/me/credits').expect(200)).body).toEqual([]);
    expect((await api(app, typo).get('/students/me/credits').expect(200)).body).toHaveLength(1);
    await api(app, typo).get(`/students/${encodeURIComponent(`${ID}#2`)}`).expect(403);
  });

  it('a third name gets #3 and every inbox hears there are 3', async () => {
    await sharedId();
    const third = (await login({ studentId: ID, name: 'คนที่ สาม', own: true })).body;
    expect(third.student.id).toBe(`${ID}#3`);
    expect((await noticesOf(app, ID)).filter((n) => n.kind === 'idconflict').map((n) => n.title)).toEqual([`รหัสนิสิต ${ID} มีผู้ใช้ 2 ชื่อ`, `รหัสนิสิต ${ID} มีผู้ใช้ 3 ชื่อ`]);
  });

  it('"own" needs a name, and on a new id it is an ordinary first sign-in', async () => {
    await http(app).post('/auth/student').send({ studentId: ID, own: true }).expect(400);
    const fresh = (await login({ studentId: '65009999', name: OWNER, own: true })).body;
    expect(fresh).toMatchObject({ isNew: true, student: { id: '65009999' } });
    expect(await twins()).toEqual([]);
  });
});

describe('ข. I typed someone else\'s id', () => {
  it('seeing the other name and typing again makes nothing', async () => {
    await login({ studentId: ID, name: OWNER });
    const wrong = (await login({ studentId: ID, name: TYPO })).body;
    expect(wrong).toMatchObject({ isNew: false, student: { id: ID } });
    const right = (await login({ studentId: '65001243', name: TYPO })).body;
    expect(right).toMatchObject({ isNew: true, student: { id: '65001243', name: TYPO } });
    expect(await twins()).toEqual([]);
  });
});

describe('ค. pretending to be someone', () => {
  it('"ใช่ ฉันเอง" still signs in to the account on the id (SPEC 15 item 2 accepts this)', async () => {
    await login({ studentId: ID, name: OWNER });
    const other = (await login({ studentId: ID, name: TYPO })).body;
    expect(other.student.id).toBe(ID);
    await api(app, other.token).get('/students/me/credits').expect(200);
    expect(await twins()).toEqual([]);
  });
});

describe('ง. a supervisor adds someone by hand on an id with another name', () => {
  it('keeps the stored name unless told it is someone else, then saves a flagged account of their own', async () => {
    const owner = await sup(app);
    const act = await newActivity(app, owner);
    await login({ studentId: ID, name: OWNER });
    const plain = (await api(app, owner).post(`/activities/${act}/credits`, { studentId: ID, name: TYPO }).expect(200)).body;
    expect(plain.credit).toMatchObject({ studentId: ID, name: OWNER });

    const act2 = await newActivity(app, owner);
    const sep = (await api(app, owner).post(`/activities/${act2}/credits`, { studentId: ID, name: TYPO, separate: true }).expect(200)).body;
    expect(sep).toMatchObject({ ok: true, credit: { studentId: `${ID}#2`, name: TYPO } });
    const flags = (await api(app, owner).get(`/activities/${act2}/credits`).expect(200)).body[0].flags;
    expect(flags).toContain('idconflict');

    // The same person again reuses that account.
    const act3 = await newActivity(app, owner);
    const again = (await api(app, owner).post(`/activities/${act3}/credits`, { studentId: ID, name: `นาย ${TYPO}`, separate: true }).expect(200)).body;
    expect(again.credit.studentId).toBe(`${ID}#2`);
    expect(await twins()).toHaveLength(1);
    // Registered people without hours carry the flag too.
    expect((await api(app, owner).get(`/activities/${act2}/registrations`).expect(200)).body[0]).toMatchObject({ studentId: `${ID}#2`, idFlag: 'idconflict' });
  });
});

describe('Excel', () => {
  const download = (r: any) =>
    r.buffer(true).parse((res: any, cb: any) => {
      const parts: Buffer[] = [];
      res.on('data', (d: Buffer) => parts.push(d));
      res.on('end', () => cb(null, Buffer.concat(parts)));
    });
  const read = async (body: Buffer) => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(body as any);
    const rows: unknown[][] = [];
    wb.worksheets[0].eachRow((r) => rows.push((r.values as unknown[]).slice(1)));
    return rows;
  };

  it('both files say รอตรวจรหัส on both rows, with the id as typed', async () => {
    const { owner, act, mine } = await sharedId();
    await claim(mine.token, await qr(owner, act), 'dev-owner');
    const sup = await read((await download(api(app, owner).get(`/activities/${act}/export?kind=sup`).expect(200))).body);
    expect(sup.slice(1).map((r) => [r[1], r[2], r[7]])).toEqual([
      [ID, TYPO, 'รอตรวจรหัส'],
      [ID, OWNER, 'รอตรวจรหัส'],
    ]);
    const admin = await sup_admin();
    const centre = await read((await download(api(app, admin).get(`/activities/${act}/export?kind=admin`).expect(200))).body);
    expect(centre.slice(1).map((r) => [r[0], r[7]])).toEqual([
      [ID, 'รอตรวจรหัส'],
      [ID, 'รอตรวจรหัส'],
    ]);
  });
});

describe('the admin checks and fixes', () => {
  const resolve = (admin: string, body: object) => api(app, admin).post(`/id-conflicts/${ID}/resolve`, body);

  async function withEverything() {
    const s = await sharedId();
    await claim(s.mine.token, await qr(s.owner, s.act), 'dev-owner');
    // Something in every table that follows an account: a registration elsewhere, a private message, a chat line.
    const later = await newActivity(app, s.owner, { start: Date.now() + 5 * 86_400_000, end: Date.now() + 5 * 86_400_000 + 3_600_000 });
    await api(app, s.typo).post(`/activities/${later}/registrations`).expect(200);
    await api(app, s.typo).post(`/activities/${s.act}/dms/${ID}`, { text: 'คำถาม' }).expect(201);
    await api(app, s.typo).post(`/activities/${s.act}/messages`, { text: 'สวัสดี' }).expect(201);
    return { ...s, later, admin: await sup_admin() };
  }

  it('lists ids waiting, with names, hours, activities, first use and devices', async () => {
    const { admin } = await withEverything();
    const list = (await api(app, admin).get('/id-conflicts').expect(200)).body;
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(ID);
    expect(list[0].accounts.map((a: any) => [a.accountId, a.name, a.activities, a.hours, a.devices])).toEqual([
      [ID, TYPO, 1, 6, 1],
      [`${ID}#2`, OWNER, 1, 6, 1],
    ]);
    expect(typeof list[0].foundAt).toBe('number');
    expect(typeof list[0].accounts[0].since).toBe('number');
    await api(app, await sup(app)).get('/id-conflicts').expect(403);
  });

  it('with the right id: the other person moves there in every table, the owner takes the plain id', async () => {
    const { act, later, typo, mine, admin, owner } = await withEverything();
    const res = (await resolve(admin, { ownerId: `${ID}#2`, correctId: '65001243' }).expect(200)).body;
    expect(res.accounts.map((a: any) => [a.accountId, a.name])).toEqual([[ID, OWNER]]);

    expect(await creditRow(app, act, '65001243')).toMatchObject({ name: TYPO, hours: 6 });
    expect(await creditRow(app, act, ID)).toMatchObject({ name: OWNER, hours: 6 });
    expect(await regRow(app, later, '65001243')).toMatchObject({ cancelled_at: null });
    expect((await noticesOf(app, '65001243')).some((n) => n.kind === 'registered')).toBe(true);
    expect((await dbOf(app).query('SELECT student_id FROM dms')).rows).toEqual([{ student_id: '65001243' }]);
    expect((await dbOf(app).query('SELECT author_id FROM messages')).rows).toEqual([{ author_id: '65001243' }]);
    expect(await twins()).toEqual([]);
    expect((await activityRow(app, act)).credit_count).toBe(2);
    expect((await activityRow(app, later)).reg_count).toBe(1);

    // No flag any more, and both old devices must sign in again.
    const flags = (await api(app, owner).get(`/activities/${act}/credits`).expect(200)).body.map((c: any) => c.flags);
    expect(flags.flat()).not.toContain('idconflict');
    for (const t of [typo, mine.token]) {
      const r = await api(app, t).get('/students/me/credits').expect(401);
      expect(r.body.error).toMatchObject({ code: 'ID_CHANGED' });
    }
    expect((await api(app, admin).get('/id-conflicts').expect(200)).body).toEqual([]);
  });

  it('owner on the plain id, right id given: only the other device signs in again', async () => {
    const { typo, mine, admin } = await withEverything();
    await resolve(admin, { ownerId: ID, correctId: '65001243' }).expect(200);
    await api(app, typo).get('/students/me/credits').expect(200);
    await api(app, mine.token).get('/students/me/credits').expect(401);
  });

  it('right id not known yet: nothing moves, nobody signs out, the other stays flagged รอรหัสที่ถูก', async () => {
    const { act, typo, mine, admin, owner } = await withEverything();
    await resolve(admin, { ownerId: ID }).expect(200);
    await api(app, typo).get('/students/me/credits').expect(200);
    await api(app, mine.token).get('/students/me/credits').expect(200);
    const credits = (await api(app, owner).get(`/activities/${act}/credits`).expect(200)).body;
    expect(credits.map((c: any) => [c.studentId, c.flags.filter((f: string) => f.startsWith('id'))])).toEqual([
      [ID, []],
      [`${ID}#2`, ['idpending']],
    ]);
    expect((await api(app, admin).get('/id-conflicts').expect(200)).body).toEqual([]);
    // The mark survives the student changing their settings, and is not shown to them.
    await api(app, mine.token).patch('/students/me', { notify: { enabled: true, openings: true, announcements: true, messages: true } }).expect(200);
    expect((await api(app, owner).get(`/activities/${act}/credits`).expect(200)).body[1].flags).toContain('idpending');
    expect((await api(app, mine.token).get(`/students/${encodeURIComponent(`${ID}#2`)}`).expect(200)).body.notify).not.toHaveProperty('idReview');
  });

  it('right id not known and the owner was the twin: the other moves to a new twin number, both sign in again', async () => {
    const { act, typo, mine, admin } = await withEverything();
    await resolve(admin, { ownerId: `${ID}#2` }).expect(200);
    expect(await creditRow(app, act, ID)).toMatchObject({ name: OWNER });
    expect(await creditRow(app, act, `${ID}#3`)).toMatchObject({ name: TYPO });
    await api(app, typo).get('/students/me/credits').expect(401);
    await api(app, mine.token).get('/students/me/credits').expect(401);
  });

  it('one person spelt two ways: the accounts merge into the plain id with the chosen spelling', async () => {
    const { act, later, typo, mine, admin } = await withEverything();
    await resolve(admin, { ownerId: `${ID}#2`, merge: true }).expect(200);
    expect(await twins()).toEqual([]);
    // One credit per activity, the one with more hours; the counter follows.
    expect((await dbOf(app).query('SELECT student_id, name FROM credits WHERE activity_id = $1', [act])).rows).toEqual([{ student_id: ID, name: OWNER }]);
    expect((await activityRow(app, act)).credit_count).toBe(1);
    expect(await regRow(app, later, ID)).toMatchObject({ name: OWNER });
    expect((await dbOf(app).query('SELECT name FROM students WHERE id = $1', [ID])).rows[0].name).toBe(OWNER);
    // The old twin's device and the old spelling's device both sign in again.
    await api(app, typo).get('/students/me/credits').expect(401);
    await api(app, mine.token).get('/students/me/credits').expect(401);
    const back = (await login({ studentId: ID, name: OWNER })).body;
    await api(app, back.token).get('/students/me/credits').expect(200);
  });

  it('a right id held by another name is refused and nothing moves', async () => {
    const { act, admin } = await withEverything();
    await login({ studentId: '65001243', name: 'คนอื่น จริง ๆ' });
    const r = await resolve(admin, { ownerId: `${ID}#2`, correctId: '65001243' }).expect(409);
    expect(r.body.error.code).toBe('ID_TAKEN');
    expect(await creditRow(app, act, ID)).toMatchObject({ name: TYPO });
    expect(await creditRow(app, act, `${ID}#2`)).toMatchObject({ name: OWNER });
  });

  it('only the centre admin may fix', async () => {
    await withEverything();
    await resolve(await sup(app), { ownerId: ID }).expect(403);
  });
});

describe('tokens', () => {
  it('an id nobody shares keeps working, and a public page ignores a refused token', async () => {
    const t = (await login({ studentId: '65000001', name: 'สมชาย ใจดี' })).body.token;
    await api(app, t).get('/students/me/credits').expect(200);
    await dbOf(app).query(`DELETE FROM students WHERE id = '65000001'`);
    await api(app, t).get('/students/me/credits').expect(401);
    await api(app, t).get('/activities').expect(200);
  });
});
