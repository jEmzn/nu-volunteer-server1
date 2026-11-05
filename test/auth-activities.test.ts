import { NestExpressApplication } from '@nestjs/platform-express';
import { api, activityBody, activityRow, DAY, dbOf, http, newActivity, ORG_A, ORG_ADMIN, ORG_B, resetDb, startApp, student, sup } from './helpers';

let app: NestExpressApplication;
beforeAll(async () => {
  app = await startApp();
});
afterAll(() => app.close());
beforeEach(() => resetDb(app));

const decode = (t: string) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString());

describe('student sign-in', () => {
  it('creates a student the first time, with a cleaned name and a 30-day token', async () => {
    const res = await http(app).post('/auth/student').send({ studentId: '65000001', name: '  สมชาย   ใจดี ' }).expect(200);
    expect(res.body.isNew).toBe(true);
    expect(res.body.student).toMatchObject({ id: '65000001', name: 'สมชาย ใจดี', reminders: [], notify: {} });
    const c = decode(res.body.token);
    expect(c).toMatchObject({ role: 'student', sub: '65000001', name: 'สมชาย ใจดี' });
    expect(c.exp - c.iat).toBe(30 * 86400);
  });

  it('keeps the stored name the next time', async () => {
    await student(app, '65000001', 'ชื่อเดิม');
    const res = await http(app).post('/auth/student').send({ studentId: '65000001', name: 'ชื่อใหม่' }).expect(200);
    expect(res.body.isNew).toBe(false);
    expect(res.body.student.name).toBe('ชื่อเดิม');
  });

  it('asks for a name when the id is new, however the empty name is sent', async () => {
    for (const body of [{}, { name: '' }, { name: '   ' }, { name: null }]) {
      const res = await http(app).post('/auth/student').send({ studentId: '65000001', ...body }).expect(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    }
  });

  it('a returning student needs no name, even an empty one', async () => {
    await student(app, '65000001', 'ชื่อเดิม');
    for (const body of [{}, { name: '' }]) {
      expect((await http(app).post('/auth/student').send({ studentId: '65000001', ...body }).expect(200)).body.student.name).toBe('ชื่อเดิม');
    }
  });

  it.each(['1234567', '123456789', 'abcdefgh', ''])('refuses the id "%s" and names the field', async (studentId) => {
    const res = await http(app).post('/auth/student').send({ studentId, name: 'ก' }).expect(400);
    expect(res.body.error).toMatchObject({ code: 'VALIDATION', fields: ['studentId'] });
  });
});

describe('supervisor sign-in', () => {
  it('ignores case and surrounding spaces, gives a 12-hour token', async () => {
    const res = await http(app).post('/auth/sup').send({ supName: ' ผู้ดูแล   ก ', orgCode: `  ${ORG_A.toLowerCase()} ` }).expect(200);
    expect(res.body.sup).toEqual({ name: 'ผู้ดูแล ก', orgCode: ORG_A, orgName: 'หน่วยงาน A', admin: false });
    const c = decode(res.body.token);
    expect(c).toMatchObject({ role: 'sup', supName: 'ผู้ดูแล ก', orgCode: ORG_A, orgName: 'หน่วยงาน A', admin: false });
    expect(c.exp - c.iat).toBe(12 * 3600);
  });

  it('refuses a wrong code', async () => {
    const res = await http(app).post('/auth/sup').send({ supName: 'ก', orgCode: 'NOPE' }).expect(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('marks the centre admin', async () => {
    const res = await http(app).post('/auth/sup').send({ supName: 'ก', orgCode: ORG_ADMIN }).expect(200);
    expect(res.body.sup.admin).toBe(true);
  });
});

describe('the API as a whole', () => {
  it('reports health, checking the database', async () => {
    expect((await http(app).get('/health').expect(200)).body).toEqual({ status: 'ok', db: 'ok' });
  });

  it('gives the server time', async () => {
    const before = Date.now();
    const { now } = (await http(app).get('/time').expect(200)).body;
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });

  it('serves the OpenAPI document', async () => {
    const res = await http(app).get('/api/docs-json').expect(200);
    expect(res.body.paths['/claims'].post).toBeDefined();
    expect(res.body.components.schemas.ClaimDto.properties.token).toBeDefined();
  });

  it('closes routes by default', async () => {
    const res = await http(app).get('/students/me/credits').expect(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
    await http(app).get('/students/me/credits').set('Authorization', 'Bearer not-a-token').expect(401);
  });

  it('treats a bad token on a public route as anonymous', async () => {
    await http(app).get('/activities').set('Authorization', 'Bearer not-a-token').expect(200);
  });

  it('refuses a body over 1 MB, in the common error shape', async () => {
    const token = await sup(app);
    const res = await api(app, token).post('/activities', activityBody({ description: 'ก'.repeat(1_100_000) })).expect(413);
    expect(res.body.error.code).toBe('TOO_LARGE');
  });

  it('refuses broken JSON in the common error shape', async () => {
    const res = await http(app).post('/auth/student').set('Content-Type', 'application/json').send('{not json').expect(400);
    expect(res.body.error.code).toBe('VALIDATION');
    expect(JSON.stringify(res.body)).not.toContain('Unexpected');
  });

  it('answers unknown routes in the common shape, with no stack', async () => {
    const res = await http(app).get('/nope').set('Authorization', `Bearer ${await student(app)}`).expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(JSON.stringify(res.body)).not.toContain('stack');
  });

  it('sets security headers and only the configured CORS origin', async () => {
    const res = await http(app).get('/health').set('Origin', 'https://web.example').expect(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['access-control-allow-origin']).toBe('https://web.example');
    const other = await http(app).get('/health').set('Origin', 'https://evil.example').expect(200);
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('refuses values that would otherwise fail deep in the database, with 400 and not 500', async () => {
    const token = await sup(app);
    expect((await api(app, token).post('/activities', activityBody({ start: 8.64e15 + 1, end: 8.64e15 + 2 })).expect(400)).body.error.fields).toEqual(expect.arrayContaining(['start', 'end']));
    for (const field of ['poster', 'description', 'place']) {
      expect((await api(app, token).post('/activities', activityBody({ [field]: null })).expect(400)).body.error.fields).toEqual([field]);
    }
    expect((await api(app, token).post('/activities', activityBody({ title: 'ก\u0000ข' })).expect(400)).body.error.code).toBe('VALIDATION');
    await api(app).get('/activities/a%00b').expect(400);
  });
});

describe('creating an activity', () => {
  it('takes the organisation from the token, whatever the body says', async () => {
    const id = await newActivity(app, await sup(app), { org: 'ปลอม', orgCode: ORG_B, regCount: 99, submittedAt: 1 });
    expect(id).toMatch(/^[0-9a-z]{10}$/);
    const row = await activityRow(app, id);
    expect(row).toMatchObject({ org: 'หน่วยงาน A', org_code: ORG_A, reg_count: 0, credit_count: 0, submitted_at: null });
  });

  it('stores and returns every field', async () => {
    const token = await sup(app);
    const body = activityBody({ openChatUrl: 'https://line.me/x', opensAt: Date.now() + DAY, cancelDays: 3, hideUntilOpen: true, templateId: 'tmpl123456', itemsPerHour: 20, hidden: false });
    const { id } = (await api(app, token).post('/activities', body).expect(201)).body;
    const got = (await api(app, token).get(`/activities/${id}`).expect(200)).body;
    expect(got).toMatchObject({ ...body, id, org: 'หน่วยงาน A', orgCode: ORG_A, regCount: 0, creditCount: 0 });
    expect(got.createdAt).toBeGreaterThan(0);
  });

  it('leaves empty optional fields out of the JSON', async () => {
    const token = await sup(app);
    const { lat: _l, lng: _g, ...body } = activityBody();
    const { id } = (await api(app, token).post('/activities', body).expect(201)).body;
    const got = (await api(app, token).get(`/activities/${id}`)).body;
    for (const k of ['lat', 'lng', 'opensAt', 'cancelDays', 'closedAt', 'submittedAt', 'recordedAt', 'itemsPerHour', 'templateId', 'openChatUrl', 'hidden']) expect(got).not.toHaveProperty(k);
  });

  it('names missing fields', async () => {
    const res = await api(app, await sup(app)).post('/activities', { title: 'ก' }).expect(400);
    expect(res.body.error.code).toBe('VALIDATION');
    expect(res.body.error.fields).toEqual(expect.arrayContaining(['categoryKey', 'start', 'end', 'hours', 'supervisor']));
  });

  it('names wrong and nested fields', async () => {
    const token = await sup(app);
    const res = await api(app, token).post('/activities', activityBody({ hours: 100, qrMode: 'x', qrInterval: 11, supervisor: { name: '', phone: '1' } })).expect(400);
    expect(res.body.error.fields).toEqual(expect.arrayContaining(['hours', 'qrMode', 'qrInterval', 'supervisor.name']));
  });

  it('needs the end after the start', async () => {
    const now = Date.now();
    const res = await api(app, await sup(app)).post('/activities', activityBody({ start: now, end: now })).expect(400);
    expect(res.body.error.fields).toEqual(['end']);
  });

  it.each([[0], [100], [1.5]])('refuses %d hours', async (hours) => {
    await api(app, await sup(app)).post('/activities', activityBody({ hours })).expect(400);
  });

  it('refuses a poster over 300 KB with 413 and a bad one with 400', async () => {
    const token = await sup(app);
    const big = `data:image/jpeg;base64,${Buffer.alloc(300 * 1024 + 1).toString('base64')}`;
    expect((await api(app, token).post('/activities', activityBody({ poster: big })).expect(413)).body.error.code).toBe('TOO_LARGE');
    await api(app, token).post('/activities', activityBody({ poster: 'https://x.example/a.jpg' })).expect(400);
  });

  it('is for supervisors', async () => {
    await api(app, await student(app)).post('/activities', activityBody()).expect(403);
    await api(app).post('/activities', activityBody()).expect(401);
  });
});

describe('who sees the organisation code', () => {
  let id: string;
  beforeEach(async () => {
    id = await newActivity(app, await sup(app, ORG_A));
  });

  const seen = async (token?: string) => {
    const list = (await api(app, token).get('/activities').expect(200)).body;
    const one = (await api(app, token).get(`/activities/${id}`).expect(200)).body;
    return { list: list[0], one };
  };

  it('nobody signed out', async () => {
    const { list, one } = await seen();
    expect(list).not.toHaveProperty('orgCode');
    expect(one).not.toHaveProperty('orgCode');
    expect(JSON.stringify([list, one])).not.toContain(ORG_A);
  });

  it('no student', async () => {
    const { list, one } = await seen(await student(app));
    expect(JSON.stringify([list, one])).not.toContain(ORG_A);
  });

  it('no supervisor of another organisation', async () => {
    const { list, one } = await seen(await sup(app, ORG_B));
    expect(JSON.stringify([list, one])).not.toContain(ORG_A);
  });

  it('the organisation itself', async () => {
    const { list, one } = await seen(await sup(app, ORG_A));
    expect(list.orgCode).toBe(ORG_A);
    expect(one.orgCode).toBe(ORG_A);
  });

  it('the centre admin', async () => {
    const { list, one } = await seen(await sup(app, ORG_ADMIN));
    expect(list.orgCode).toBe(ORG_A);
    expect(one.orgCode).toBe(ORG_A);
  });

  it('not through the chat, even when a supervisor posts', async () => {
    const owner = await sup(app, ORG_A);
    await api(app, owner).post(`/activities/${id}/messages`, { text: 'สวัสดี' }).expect(201);
    const msgs = (await api(app, await student(app)).get(`/activities/${id}/messages`).expect(200)).body;
    expect(msgs).toHaveLength(1);
    expect(JSON.stringify(msgs)).not.toContain(ORG_A);
  });
});

describe('editing an activity', () => {
  let owner: string;
  let id: string;
  beforeEach(async () => {
    owner = await sup(app, ORG_A);
    id = await newActivity(app, owner, { cancelDays: 3, opensAt: Date.now() });
  });

  it('changes only what was sent', async () => {
    const res = await api(app, owner).patch(`/activities/${id}`, { title: 'ชื่อใหม่', hidden: true }).expect(200);
    expect(res.body).toMatchObject({ title: 'ชื่อใหม่', hidden: true, place: 'อาคารอเนกประสงค์', cancelDays: 3 });
  });

  it('clears an optional field with null', async () => {
    const res = await api(app, owner).patch(`/activities/${id}`, { cancelDays: null, opensAt: null, lat: null }).expect(200);
    for (const k of ['cancelDays', 'opensAt', 'lat']) expect(res.body).not.toHaveProperty(k);
  });

  it('refuses null for a field that cannot be empty', async () => {
    const res = await api(app, owner).patch(`/activities/${id}`, { title: null }).expect(400);
    expect(res.body.error.fields).toEqual(['title']);
  });

  it('checks the end against the stored start', async () => {
    const row = await activityRow(app, id);
    await api(app, owner).patch(`/activities/${id}`, { end: row.start_at.getTime() - 1 }).expect(400);
  });

  it('cannot move an activity to another organisation', async () => {
    await api(app, owner).patch(`/activities/${id}`, { orgCode: ORG_B, org: 'ปลอม', regCount: 5 }).expect(200);
    expect(await activityRow(app, id)).toMatchObject({ org_code: ORG_A, org: 'หน่วยงาน A', reg_count: 0 });
  });

  it('is refused for another organisation and allowed for the admin', async () => {
    expect((await api(app, await sup(app, ORG_B)).patch(`/activities/${id}`, { title: 'x' }).expect(403)).body.error.code).toBe('FORBIDDEN');
    await api(app, await student(app)).patch(`/activities/${id}`, { title: 'x' }).expect(403);
    await api(app, await sup(app, ORG_ADMIN)).patch(`/activities/${id}`, { title: 'โดยศูนย์' }).expect(200);
  });

  it('locks the owner after sending and the admin after recording', async () => {
    const admin = await sup(app, ORG_ADMIN);
    await api(app, owner).post(`/activities/${id}/submit`).expect(200);
    expect((await api(app, owner).patch(`/activities/${id}`, { title: 'x' }).expect(409)).body.error.code).toBe('ROSTER_LOCKED');
    await api(app, admin).patch(`/activities/${id}`, { title: 'ศูนย์แก้' }).expect(200);
    await api(app, admin).post(`/activities/${id}/record`).expect(200);
    await api(app, admin).patch(`/activities/${id}`, { title: 'x' }).expect(409);
  });

  it('answers 404 for an unknown activity', async () => {
    await api(app, owner).patch('/activities/nope', { title: 'x' }).expect(404);
    await api(app).get('/activities/nope').expect(404);
  });

  it('lists hidden activities too: the screens decide', async () => {
    await api(app, owner).patch(`/activities/${id}`, { hidden: true }).expect(200);
    const list = (await api(app).get('/activities').expect(200)).body;
    expect(list.map((a: { id: string }) => a.id)).toContain(id);
  });
});

describe('announcements', () => {
  it('are public and newest first', async () => {
    const id = await newActivity(app, await sup(app));
    const db = dbOf(app);
    await db.query(`INSERT INTO announcements (activity_id, text, images, at) VALUES ($1, 'เก่า', '{}', now() - interval '1 hour'), ($1, 'ใหม่', '{./posters/a.jpg}', now())`, [id]);
    const res = (await api(app).get(`/activities/${id}/announcements`).expect(200)).body;
    expect(res.map((a: { text: string }) => a.text)).toEqual(['ใหม่', 'เก่า']);
    expect(res[0]).toMatchObject({ activityId: id, images: ['./posters/a.jpg'] });
    await api(app).get('/activities/nope/announcements').expect(404);
  });
});

describe('uploaded posters', () => {
  const jpeg = (fill: number, size = 2000) => Buffer.alloc(size, fill);
  const dataUrl = (b: Buffer) => `data:image/jpeg;base64,${b.toString('base64')}`;
  const binary = (r: any) =>
    r.buffer(true).parse((res: any, cb: any) => {
      const parts: Buffer[] = [];
      res.on('data', (d: Buffer) => parts.push(d));
      res.on('end', () => cb(null, Buffer.concat(parts)));
    });
  const shown = async (id: string) => (await api(app).get(`/activities/${id}`).expect(200)).body.poster as string;

  it('come as a URL from the list and from a single read, and paths and empty ones stay as they are', async () => {
    const owner = await sup(app);
    const uploaded = await newActivity(app, owner, { poster: dataUrl(jpeg(1)) });
    const bundled = await newActivity(app, owner, { poster: './posters/blood.jpg' });
    const none = await newActivity(app, owner, { poster: '' });
    const url = await shown(uploaded);
    expect(url).toMatch(new RegExp(`^/activities/${uploaded}/poster\\?v=\\d+-[0-9a-f]{32}$`));
    expect(await shown(bundled)).toBe('./posters/blood.jpg');
    expect(await shown(none)).toBe('');
    const list = (await api(app).get('/activities').expect(200)).body;
    expect(Object.fromEntries(list.map((a: { id: string; poster: string }) => [a.id, a.poster]))).toEqual({ [uploaded]: url, [bundled]: './posters/blood.jpg', [none]: '' });
  });

  it('keep the list small however many there are', async () => {
    const owner = await sup(app);
    for (let i = 0; i < 5; i++) await newActivity(app, owner, { poster: dataUrl(Buffer.alloc(300 * 1024, i + 1)) });
    const res = await api(app).get('/activities').expect(200);
    expect(res.text.length).toBeLessThan(5 * 2000);
  });

  it('are served as the same JPEG to anyone, cacheable, and across origins', async () => {
    const image = jpeg(7);
    const id = await newActivity(app, await sup(app), { poster: dataUrl(image) });
    const res = await binary(http(app).get(await shown(id)).expect(200));
    expect(Buffer.compare(res.body, image)).toBe(0);
    expect(res.headers['content-type']).toContain('image/jpeg');
    expect(res.headers['cache-control']).toBe('public, max-age=86400');
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(res.headers.etag).toBeTruthy();
  });

  it('answer 304 when the browser already has the image', async () => {
    const id = await newActivity(app, await sup(app), { poster: dataUrl(jpeg(7)) });
    const url = await shown(id);
    const { headers } = await http(app).get(url).expect(200);
    await http(app).get(url).set('If-None-Match', headers.etag).expect(304);
  });

  it('answer 404 for no upload and for an unknown activity', async () => {
    const owner = await sup(app);
    const bundled = await newActivity(app, owner, { poster: './posters/blood.jpg' });
    const none = await newActivity(app, owner, { poster: '' });
    await http(app).get(`/activities/${bundled}/poster`).expect(404);
    await http(app).get(`/activities/${none}/poster`).expect(404);
    await http(app).get('/activities/nope/poster').expect(404);
  });

  it('keep their URL when something else changes, even a counter', async () => {
    const owner = await sup(app);
    const id = await newActivity(app, owner, { poster: dataUrl(jpeg(7)) });
    const url = await shown(id);
    await api(app, owner).patch(`/activities/${id}`, { title: 'ชื่อใหม่' }).expect(200);
    await api(app, await student(app)).post(`/activities/${id}/registrations`).expect(200);
    expect(await shown(id)).toBe(url);
  });

  it('get a new URL and image when replaced, including with one of the same size', async () => {
    const owner = await sup(app);
    const id = await newActivity(app, owner, { poster: dataUrl(jpeg(7)) });
    const before = await shown(id);
    const replaced = (await api(app, owner).patch(`/activities/${id}`, { poster: dataUrl(jpeg(8)) }).expect(200)).body.poster;
    expect(replaced).not.toBe(before);
    expect((await binary(http(app).get(replaced).expect(200))).body[0]).toBe(8);
  });

  it('refuse their own URL on write: leave poster out to keep the image', async () => {
    const owner = await sup(app);
    const id = await newActivity(app, owner, { poster: dataUrl(jpeg(7)) });
    await api(app, owner).patch(`/activities/${id}`, { poster: await shown(id) }).expect(400);
  });
});
