import { NestExpressApplication } from '@nestjs/platform-express';
import { AddressInfo } from 'node:net';
import { io, Socket } from 'socket.io-client';
import { api, dbOf, newActivity, ORG_A, ORG_ADMIN, ORG_B, resetDb, startApp, student, sup } from './helpers';

let app: NestExpressApplication;
beforeAll(async () => {
  app = await startApp();
});
afterAll(() => app.close());
beforeEach(() => resetDb(app));

describe('own student data', () => {
  it('reads and updates reminders and settings', async () => {
    const s = await student(app);
    const res = (await api(app, s).patch('/students/me', { reminders: ['a1', 'a2'], notify: { enabled: true, openings: false } }).expect(200)).body;
    expect(res).toMatchObject({ id: '65000001', reminders: ['a1', 'a2'], notify: { enabled: true, openings: false } });
    const partial = (await api(app, s).patch('/students/me', { reminders: [] }).expect(200)).body;
    expect(partial).toMatchObject({ reminders: [], notify: { enabled: true, openings: false } });
    expect((await api(app, s).get('/students/65000001').expect(200)).body.reminders).toEqual([]);
  });

  it('cannot read someone else, and the id in the body means nothing', async () => {
    const a = await student(app, '65000001', 'ก');
    await student(app, '65000002', 'ข');
    await api(app, a).get('/students/65000002').expect(403);
    await api(app, a).patch('/students/me', { id: '65000002', name: 'ปลอม', reminders: ['x'] }).expect(200);
    const row = (await dbOf(app).query(`SELECT * FROM students WHERE id = '65000002'`)).rows[0];
    expect(row).toMatchObject({ name: 'ข', reminders: [] });
    expect((await dbOf(app).query(`SELECT name FROM students WHERE id = '65000001'`)).rows[0].name).toBe('ก');
  });

  it('a supervisor can look up a name, not the settings', async () => {
    await student(app);
    const res = (await api(app, await sup(app)).get('/students/65000001').expect(200)).body;
    expect(Object.keys(res).sort()).toEqual(['createdAt', 'id', 'name']);
    await api(app, await sup(app)).get('/students/65000099').expect(404);
    await api(app).get('/students/65000001').expect(401);
  });

  it('lists only own registrations and credits, with the activity id', async () => {
    const owner = await sup(app);
    const id = await newActivity(app, owner);
    const a = await student(app, '65000001', 'ก');
    const b = await student(app, '65000002', 'ข');
    await api(app, a).post(`/activities/${id}/registrations`).expect(200);
    await api(app, owner).post(`/activities/${id}/credits`, { studentId: '65000001' }).expect(200);
    expect((await api(app, a).get('/students/me/registrations').expect(200)).body[0]).toMatchObject({ activityId: id, studentId: '65000001' });
    expect((await api(app, a).get('/students/me/credits').expect(200)).body[0]).toMatchObject({ activityId: id, hours: 6 });
    expect((await api(app, b).get('/students/me/registrations').expect(200)).body).toEqual([]);
    expect((await api(app, b).get('/students/me/credits').expect(200)).body).toEqual([]);
  });
});

describe('notices', () => {
  it('a student can only send kind open, always to themselves', async () => {
    const s = await student(app);
    const res = (await api(app, s).post('/students/me/notices', { kind: 'open', title: 'เปิดรับสมัครแล้ว', body: 'กิจกรรม', activityId: 'a1', studentId: '65000002' }).expect(201)).body;
    expect(res).toMatchObject({ studentId: '65000001', kind: 'open', title: 'เปิดรับสมัครแล้ว', body: 'กิจกรรม', activityId: 'a1', read: false });
    for (const kind of ['registered', 'credit', 'recorded', 'announce', 'chat']) {
      expect((await api(app, s).post('/students/me/notices', { kind, title: 'ปลอม' }).expect(400)).body.error.fields).toEqual(['kind']);
    }
  });

  it('lists the newest 60, newest first, and marks all read', async () => {
    const s = await student(app);
    const other = await student(app, '65000002', 'ข');
    await dbOf(app).query(`INSERT INTO notices (student_id, kind, title, at) SELECT '65000001', 'open', 'n' || g, now() + g * interval '1 second' FROM generate_series(1, 65) g`);
    const list = (await api(app, s).get('/students/me/notices').expect(200)).body;
    expect(list).toHaveLength(60);
    expect(list[0].title).toBe('n65');
    expect(list[59].title).toBe('n6');
    expect((await api(app, other).get('/students/me/notices').expect(200)).body).toEqual([]);
    expect((await api(app, s).post('/students/me/notices/read').expect(200)).body.changed).toBe(65);
    expect((await api(app, s).get('/students/me/notices').expect(200)).body.every((n: { read: boolean }) => n.read)).toBe(true);
  });
});

describe('activity chat', () => {
  let owner: string;
  let id: string;
  beforeEach(async () => {
    owner = await sup(app);
    id = await newActivity(app, owner);
  });

  it('takes the author from the token, not the body', async () => {
    const s = await student(app);
    const res = (await api(app, s).post(`/activities/${id}/messages`, { text: ' สวัสดี ', authorId: '99999999', authorName: 'ปลอม', sup: true }).expect(201)).body;
    expect(res).toMatchObject({ authorId: '65000001', authorName: 'สมชาย ใจดี', sup: false, text: 'สวัสดี' });
  });

  it('marks supervisors and never exposes the org code', async () => {
    const res = (await api(app, owner).post(`/activities/${id}/messages`, { text: 'ประกาศ' }).expect(201)).body;
    expect(res).toMatchObject({ sup: true, authorName: 'ผู้ดูแล ก', authorId: 'ผู้ดูแล ก' });
    expect(JSON.stringify(res)).not.toContain(ORG_A);
  });

  it('reads oldest first for anyone signed in', async () => {
    const s = await student(app);
    await dbOf(app).query(`INSERT INTO messages (activity_id, author_id, author_name, text, at) VALUES ($1, 'x', 'x', 'หลัง', now()), ($1, 'x', 'x', 'ก่อน', now() - interval '1 hour')`, [id]);
    expect((await api(app, s).get(`/activities/${id}/messages`).expect(200)).body.map((m: { text: string }) => m.text)).toEqual(['ก่อน', 'หลัง']);
    await api(app).get(`/activities/${id}/messages`).expect(401);
  });

  it('keeps showing new messages after 500', async () => {
    await dbOf(app).query(`INSERT INTO messages (activity_id, author_id, author_name, text, at) SELECT $1, 'x', 'x', 'm' || g, now() + g * interval '1 second' FROM generate_series(1, 510) g`, [id]);
    const list = (await api(app, await student(app)).get(`/activities/${id}/messages`).expect(200)).body;
    expect(list).toHaveLength(500);
    expect(list[0].text).toBe('m11');
    expect(list[499].text).toBe('m510');
  });

  it('cannot send when chat is off, or from another organisation', async () => {
    const closed = await newActivity(app, owner, { chatEnabled: false });
    const s = await student(app);
    expect((await api(app, s).post(`/activities/${closed}/messages`, { text: 'x' }).expect(403)).body.error.code).toBe('CHAT_DISABLED');
    await api(app, owner).post(`/activities/${closed}/messages`, { text: 'x' }).expect(403);
    await api(app, s).get(`/activities/${closed}/messages`).expect(200);
    await api(app, await sup(app, ORG_B)).post(`/activities/${id}/messages`, { text: 'x' }).expect(403);
    await api(app, s).post('/activities/nope/messages', { text: 'x' }).expect(404);
  });

  it('refuses empty and oversized text', async () => {
    const s = await student(app);
    await api(app, s).post(`/activities/${id}/messages`, { text: '   ' }).expect(400);
    await api(app, s).post(`/activities/${id}/messages`, { text: 'ก'.repeat(2001) }).expect(400);
  });
});

describe('private messages', () => {
  let owner: string;
  let id: string;
  let a: string;
  let b: string;
  beforeEach(async () => {
    owner = await sup(app);
    id = await newActivity(app, owner);
    a = await student(app, '65000001', 'ก');
    b = await student(app, '65000002', 'ข');
  });

  it('a student and the owner talk in one thread', async () => {
    const mine = (await api(app, a).post(`/activities/${id}/dms/65000001`, { text: 'ถาม', authorName: 'ปลอม', fromSup: true }).expect(201)).body;
    expect(mine).toMatchObject({ studentId: '65000001', fromSup: false, authorName: 'ก', read: false, text: 'ถาม' });
    const reply = (await api(app, owner).post(`/activities/${id}/dms/65000001`, { text: 'ตอบ' }).expect(201)).body;
    expect(reply).toMatchObject({ fromSup: true, authorName: 'ผู้ดูแล ก' });
    expect((await api(app, a).get(`/activities/${id}/dms/65000001`).expect(200)).body.map((m: { text: string }) => m.text)).toEqual(['ถาม', 'ตอบ']);
  });

  it('nobody else can read or write it', async () => {
    await api(app, a).post(`/activities/${id}/dms/65000001`, { text: 'ความลับ' }).expect(201);
    await api(app, b).get(`/activities/${id}/dms/65000001`).expect(403);
    await api(app, b).post(`/activities/${id}/dms/65000001`, { text: 'x' }).expect(403);
    await api(app, b).post(`/activities/${id}/dms/65000001/read`).expect(403);
    await api(app, await sup(app, ORG_B)).get(`/activities/${id}/dms/65000001`).expect(403);
    await api(app, await sup(app, ORG_ADMIN)).get(`/activities/${id}/dms/65000001`).expect(200);
    await api(app).get(`/activities/${id}/dms/65000001`).expect(401);
  });

  it('read marks only the other side, decided by the token', async () => {
    await api(app, a).post(`/activities/${id}/dms/65000001`, { text: 'จากนิสิต' }).expect(201);
    await api(app, owner).post(`/activities/${id}/dms/65000001`, { text: 'จากผู้ดูแล' }).expect(201);
    expect((await api(app, a).post(`/activities/${id}/dms/65000001/read`, { readerIsSup: true }).expect(200)).body.changed).toBe(1);
    const rows = (await api(app, a).get(`/activities/${id}/dms/65000001`).expect(200)).body;
    expect(rows.find((m: { fromSup: boolean }) => m.fromSup).read).toBe(true);
    expect(rows.find((m: { fromSup: boolean }) => !m.fromSup).read).toBe(false);
    expect((await api(app, owner).post(`/activities/${id}/dms/65000001/read`).expect(200)).body.changed).toBe(1);
  });

  it('the owner sees the list of threads with unread counts', async () => {
    await api(app, a).post(`/activities/${id}/dms/65000001`, { text: 'หนึ่ง' }).expect(201);
    await api(app, a).post(`/activities/${id}/dms/65000001`, { text: 'สอง' }).expect(201);
    await api(app, b).post(`/activities/${id}/dms/65000002`, { text: 'สาม' }).expect(201);
    await dbOf(app).query(`UPDATE dms SET at = now() - interval '1 hour' WHERE student_id = '65000001'`);
    await dbOf(app).query(`UPDATE dms SET at = now() - interval '2 hours' WHERE text = 'หนึ่ง'`);
    const threads = (await api(app, owner).get(`/activities/${id}/dms`).expect(200)).body;
    expect(threads.map((t: { studentId: string }) => t.studentId)).toEqual(['65000002', '65000001']);
    expect(threads[1]).toMatchObject({ name: 'ก', lastText: 'สอง', unread: 2, lastFromSup: false });
    await api(app, a).get(`/activities/${id}/dms`).expect(403);
  });
});

describe('templates', () => {
  const body = { title: 'เทมเพลต', poster: '', description: 'ก', hours: 3, settings: { capLimit: true, capacity: 50, walkIn: true, qrMode: 'static', qrInterval: 15, locMode: 'off', radius: 200 } };

  it('are shared inside the organisation, with owner and author from the token', async () => {
    const one = await sup(app, ORG_A, 'คนแรก');
    const two = await sup(app, ORG_A, 'คนที่สอง');
    const t = (await api(app, one).post('/templates', { ...body, orgCode: ORG_B, createdBy: 'ปลอม' }).expect(201)).body;
    expect(t.id).toMatch(/^[0-9a-z]{10}$/);
    expect(t).toMatchObject({ orgCode: ORG_A, createdBy: 'คนแรก', title: 'เทมเพลต', hours: 3, settings: body.settings });
    expect((await api(app, two).get('/templates').expect(200)).body.map((x: { id: string }) => x.id)).toEqual([t.id]);
    await api(app, two).patch(`/templates/${t.id}`, { title: 'แก้แล้ว' }).expect(200);
    await api(app, two).delete(`/templates/${t.id}`).expect(200);
    expect((await api(app, one).get('/templates').expect(200)).body).toEqual([]);
  });

  it('are out of reach for other organisations and students', async () => {
    const one = await sup(app);
    const other = await sup(app, ORG_B);
    const t = (await api(app, one).post('/templates', body).expect(201)).body;
    expect((await api(app, other).get('/templates').expect(200)).body).toEqual([]);
    await api(app, other).patch(`/templates/${t.id}`, { title: 'x' }).expect(403);
    await api(app, other).delete(`/templates/${t.id}`).expect(403);
    await api(app, await student(app)).get('/templates').expect(403);
    await api(app, one).delete('/templates/nope').expect(404);
  });

  it('fill missing settings with the defaults', async () => {
    const t = (await api(app, await sup(app)).post('/templates', { title: 'ก', hours: 1, settings: {} }).expect(201)).body;
    expect(t.settings).toEqual({ capLimit: false, capacity: 30, walkIn: false, qrMode: 'dynamic', qrInterval: 10, locMode: 'on', radius: 150 });
    expect(t).toMatchObject({ poster: '', description: '' });
  });

  it('keep activities made from them when deleted', async () => {
    const owner = await sup(app);
    const t = (await api(app, owner).post('/templates', body).expect(201)).body;
    const id = await newActivity(app, owner, { categoryKey: 'other', templateId: t.id });
    await api(app, owner).delete(`/templates/${t.id}`).expect(200);
    expect((await api(app, owner).get(`/activities/${id}`).expect(200)).body.templateId).toBe(t.id);
  });

  it('check the poster and the fields', async () => {
    const owner = await sup(app);
    await api(app, owner).post('/templates', { ...body, poster: 'http://x.example/a.jpg' }).expect(400);
    await api(app, owner).post('/templates', { ...body, poster: `data:image/jpeg;base64,${Buffer.alloc(300 * 1024 + 1).toString('base64')}` }).expect(413);
    expect((await api(app, owner).post('/templates', {}).expect(400)).body.error.fields).toEqual(['title', 'hours']);
    const t = (await api(app, owner).post('/templates', body).expect(201)).body;
    await api(app, owner).patch(`/templates/${t.id}`, { title: null }).expect(400);
  });
});

describe('realtime', () => {
  let port: number;
  const sockets: Socket[] = [];

  const connect = async (token?: string) => {
    const socket = io(`http://localhost:${port}`, { auth: token ? { token } : {}, transports: ['websocket'], forceNew: true });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', reject);
    });
    return socket;
  };
  const join = (s: Socket, room: string) => new Promise<{ ok: boolean; code?: string }>((resolve) => s.emit('join', { room }, resolve));
  /** Everything a socket receives on `changed` for the next ms milliseconds. */
  const collect = (s: Socket, ms: number) =>
    new Promise<string[]>((resolve) => {
      const got: string[] = [];
      const on = (m: { room: string }) => got.push(m.room);
      s.on('changed', on);
      setTimeout(() => {
        s.off('changed', on);
        resolve(got);
      }, ms);
    });

  beforeAll(() => {
    port = (app.getHttpServer().address() as AddressInfo).port;
  });
  afterEach(() => {
    while (sockets.length) sockets.pop()!.disconnect();
  });

  const qrToken = async (owner: string, id: string) => (await api(app, owner).post(`/activities/${id}/qr`, {}).expect(200)).body.token;

  it('after a check-in, credits, registrations, activity and the list get changed', async () => {
    const owner = await sup(app);
    const id = await newActivity(app, owner);
    const socket = await connect(owner);
    for (const room of [`credits:${id}`, `registrations:${id}`, `activity:${id}`, 'activities']) expect((await join(socket, room)).ok).toBe(true);
    const events = collect(socket, 600);
    await api(app, await student(app)).post('/claims', { token: await qrToken(owner, id) }).expect(200);
    expect((await events).sort()).toEqual([`activity:${id}`, 'activities', `credits:${id}`, `registrations:${id}`].sort());
  });

  it('sends nothing when nothing changed', async () => {
    const owner = await sup(app);
    const id = await newActivity(app, owner);
    const s = await student(app);
    const token = await qrToken(owner, id);
    await api(app, s).post('/claims', { token }).expect(200);
    await new Promise((r) => setTimeout(r, 300));
    const socket = await connect(owner);
    await join(socket, `credits:${id}`);
    const events = collect(socket, 500);
    await api(app, s).post('/claims', { token }).expect(200); // already
    expect(await events).toEqual([]);
  });

  it('a burst becomes one signal per room', async () => {
    const owner = await sup(app);
    const id = await newActivity(app, owner);
    const token = await qrToken(owner, id);
    const students = await Promise.all(Array.from({ length: 15 }, (_, i) => student(app, String(66000000 + i), `นิสิต ${i}`)));
    await new Promise((r) => setTimeout(r, 300));
    const socket = await connect(owner);
    await join(socket, `credits:${id}`);
    const events = collect(socket, 900);
    await Promise.all(students.map((s) => api(app, s).post('/claims', { token }).expect(200)));
    const got = await events;
    expect(got.length).toBeGreaterThanOrEqual(1);
    expect(got.length).toBeLessThan(15 / 2);
  });

  it('does not signal before the write is committed', async () => {
    const owner = await sup(app);
    const id = await newActivity(app, owner);
    const socket = await connect(owner);
    await join(socket, `credits:${id}`);
    const seen = new Promise<number>((resolve) => {
      socket.once('changed', async () => {
        const row = (await dbOf(app).query('SELECT count(*)::int AS n FROM credits WHERE activity_id = $1', [id])).rows[0];
        resolve(row.n);
      });
    });
    await api(app, await student(app)).post('/claims', { token: await qrToken(owner, id) }).expect(200);
    expect(await seen).toBe(1);
  });

  it('refuses rooms without permission, with an error event', async () => {
    const owner = await sup(app, ORG_A);
    const id = await newActivity(app, owner);
    const otherOrg = await connect(await sup(app, ORG_B));
    const errored = new Promise<{ room: string; code: string }>((resolve) => otherOrg.once('error', resolve));
    expect(await join(otherOrg, `registrations:${id}`)).toEqual({ ok: false, code: 'FORBIDDEN' });
    expect(await errored).toEqual({ room: `registrations:${id}`, code: 'FORBIDDEN' });
    expect((await join(otherOrg, `credits:${id}`)).code).toBe('FORBIDDEN');
    expect((await join(otherOrg, `dms:${id}`)).code).toBe('FORBIDDEN');

    const anon = await connect();
    expect((await join(anon, `credits:${id}`)).code).toBe('UNAUTHENTICATED');
    expect((await join(anon, `messages:${id}`)).code).toBe('UNAUTHENTICATED');
    expect((await join(anon, `activity:${id}`)).ok).toBe(true);
    expect((await join(anon, 'activities')).ok).toBe(true);
    expect((await join(anon, 'anything')).code).toBe('INVALID_ROOM');
    expect((await join(anon, 'nonsense:1')).code).toBe('INVALID_ROOM');

    const s = await connect(await student(app, '65000001', 'ก'));
    expect((await join(s, `registrations:${id}`)).code).toBe('FORBIDDEN');
    expect((await join(s, `dms:${id}:65000002`)).code).toBe('FORBIDDEN');
    expect((await join(s, `dms:${id}:65000001`)).ok).toBe(true);
    expect((await join(s, `credits:${id}`)).ok).toBe(true);
    expect((await join(s, `messages:${id}`)).ok).toBe(true);

    const admin = await connect(await sup(app, ORG_ADMIN));
    expect((await join(admin, `registrations:${id}`)).ok).toBe(true);
    expect((await join(admin, `dms:${id}:65000002`)).ok).toBe(true);
  });

  it('delivers chat and private messages to their rooms only', async () => {
    const owner = await sup(app);
    const id = await newActivity(app, owner);
    const a = await student(app, '65000001', 'ก');
    const mine = await connect(a);
    await join(mine, `messages:${id}`);
    await join(mine, `dms:${id}:65000001`);
    const supSocket = await connect(owner);
    await join(supSocket, `dms:${id}`);
    const mineEvents = collect(mine, 600);
    const supEvents = collect(supSocket, 600);
    await api(app, a).post(`/activities/${id}/messages`, { text: 'ก' }).expect(201);
    await api(app, a).post(`/activities/${id}/dms/65000001`, { text: 'ข' }).expect(201);
    expect((await mineEvents).sort()).toEqual([`dms:${id}:65000001`, `messages:${id}`].sort());
    expect(await supEvents).toEqual([`dms:${id}`]);
  });

  it('a socket that left hears nothing more', async () => {
    const owner = await sup(app);
    const id = await newActivity(app, owner);
    const socket = await connect();
    await join(socket, `activity:${id}`);
    await new Promise((resolve) => socket.emit('leave', { room: `activity:${id}` }, resolve));
    const events = collect(socket, 500);
    await api(app, owner).patch(`/activities/${id}`, { title: 'ใหม่' }).expect(200);
    expect(await events).toEqual([]);
  });

  it('an expired-looking bad token is anonymous, not an error', async () => {
    const id = await newActivity(app, await sup(app));
    const socket = await connect('not-a-token');
    expect((await join(socket, `credits:${id}`)).code).toBe('UNAUTHENTICATED');
  });
});
