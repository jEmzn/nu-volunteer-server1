import { NestExpressApplication } from '@nestjs/platform-express';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { activityBody, activityRow, api, DAY, dbOf, HOUR, http, newActivity, ORG_ADMIN, ORG_B, regRow, resetDb, startApp, student, sup } from './helpers';

let app: NestExpressApplication;
beforeAll(async () => {
  app = await startApp();
});
afterAll(() => app.close());
beforeEach(() => resetDb(app));

const later = () => ({ start: Date.now() + 5 * DAY, end: Date.now() + 5 * DAY + HOUR });

const QUESTIONS = [
  { id: 'q1', label: 'ชั้นปี', type: 'choice', options: ['ปี 1', 'ปี 2', 'ปี 3'], required: true },
  { id: 'q2', label: 'โรคประจำตัว', type: 'text', required: false },
  { id: 'q3', label: 'ขนาดเสื้อ', type: 'choice', options: ['S', 'M', 'L'], required: false },
];

const withQuestions = (over: Record<string, unknown> = {}) => ({ ...later(), questions: QUESTIONS, ...over });
const FORM = { phone: '081-234 5678', faculty: 'คณะวิศวกรรมศาสตร์', consentAt: 1_700_000_000_000, answers: { q1: 'ปี 2', q2: 'ไม่มี' } };

describe('questions on activities and templates', () => {
  it('saves questions on create, returns them to everyone, and defaults to none', async () => {
    const owner = await sup(app);
    const id = await newActivity(app, owner, withQuestions());
    const expected = QUESTIONS;
    expect((await api(app).get(`/activities/${id}`).expect(200)).body.questions).toEqual(expected);
    expect((await api(app).get('/activities').expect(200)).body[0].questions).toEqual(expected);
    const plain = await newActivity(app, owner, later());
    expect((await api(app).get(`/activities/${plain}`).expect(200)).body.questions).toEqual([]);
  });

  it('replaces questions on PATCH, clears them with [], and refuses null', async () => {
    const owner = await sup(app);
    const id = await newActivity(app, owner, withQuestions());
    const one = [{ id: 'a', label: 'เบอร์ผู้ปกครอง', type: 'text', required: true }];
    expect((await api(app, owner).patch(`/activities/${id}`, { questions: one }).expect(200)).body.questions).toEqual(one);
    expect((await api(app, owner).patch(`/activities/${id}`, { title: 'ชื่อใหม่' }).expect(200)).body.questions).toEqual(one);
    expect((await api(app, owner).patch(`/activities/${id}`, { questions: [] }).expect(200)).body.questions).toEqual([]);
    await api(app, owner).patch(`/activities/${id}`, { questions: null }).expect(400);
  });

  describe('rejects a bad question list', () => {
    const base = { id: 'q', label: 'ข้อ', type: 'text', required: false };
    const choice = (options: unknown) => ({ ...base, type: 'choice', options });
    const bad: [string, unknown][] = [
      ['more than 10 questions', Array.from({ length: 11 }, (_, i) => ({ ...base, id: `q${i}` }))],
      ['a label over 120', [{ ...base, label: 'ก'.repeat(121) }]],
      ['an empty label', [{ ...base, label: '' }]],
      ['an unknown type', [{ ...base, type: 'date' }]],
      ['a missing required flag', [{ id: 'q', label: 'ข้อ', type: 'text' }]],
      ['a missing id', [{ label: 'ข้อ', type: 'text', required: false }]],
      ['duplicate ids', [base, { ...base, label: 'อีกข้อ' }]],
      ['a choice without options', [{ ...base, type: 'choice' }]],
      ['a choice with one option', [choice(['เดียว'])]],
      ['a choice with 11 options', [choice(Array.from({ length: 11 }, (_, i) => `ตัวเลือก ${i}`))]],
      ['an option over 60', [choice(['ก', 'ก'.repeat(61)])]],
      ['an empty option', [choice(['ก', ''])]],
      ['options that are not strings', [choice(['ก', 2])]],
      ['questions that are not a list', { id: 'q' }],
    ];
    it.each(bad)('%s', async (_, questions) => {
      const owner = await sup(app);
      const res = await api(app, owner).post('/activities', activityBody({ ...later(), questions })).expect(400);
      expect(res.body.error.code).toBe('VALIDATION');
      expect(res.body.error.fields.some((f: string) => f.startsWith('questions'))).toBe(true);
      const id = await newActivity(app, owner, later());
      await api(app, owner).patch(`/activities/${id}`, { questions }).expect(400);
    });

    it('accepts the largest list: 10 questions, 10 options of 60, labels of 120', async () => {
      const owner = await sup(app);
      const full = Array.from({ length: 10 }, (_, i) => ({ id: `q${i}`, label: 'ก'.repeat(120), type: 'choice', options: Array.from({ length: 10 }, (_, j) => `${j}`.padEnd(60, 'ข')), required: true }));
      await newActivity(app, owner, withQuestions({ questions: full }));
    });
  });

  it('keeps a text question free of options', async () => {
    const owner = await sup(app);
    const id = await newActivity(app, owner, withQuestions({ questions: [{ id: 't', label: 'ข้อ', type: 'text', required: false, options: ['x', 'y'] }] }));
    expect((await api(app).get(`/activities/${id}`).expect(200)).body.questions).toEqual([{ id: 't', label: 'ข้อ', type: 'text', required: false }]);
  });

  it('keeps questions in template settings, with [] for old templates', async () => {
    const owner = await sup(app);
    const body = { title: 'เทมเพลต', hours: 3 };
    const old = (await api(app, owner).post('/templates', { ...body, settings: { capacity: 10 } }).expect(201)).body;
    expect(old.settings.questions).toEqual([]);
    const made = (await api(app, owner).post('/templates', { ...body, settings: { questions: QUESTIONS } }).expect(201)).body;
    expect(made.settings.questions).toEqual(QUESTIONS);
    expect((await api(app, owner).get('/templates').expect(200)).body.find((t: { id: string }) => t.id === made.id).settings.questions).toEqual(QUESTIONS);
    const one = [QUESTIONS[1]];
    expect((await api(app, owner).patch(`/templates/${made.id}`, { settings: { questions: one } }).expect(200)).body.settings.questions).toEqual(one);
    await api(app, owner).post('/templates', { ...body, settings: { questions: [{ id: 'x', label: 'x', type: 'nope', required: true }] } }).expect(400);
  });
});

describe('registering with the form', () => {
  it('still registers with no body at all (an older app)', async () => {
    const s = await student(app);
    const id = await newActivity(app, await sup(app), later());
    expect((await api(app, s).post(`/activities/${id}/registrations`).expect(200)).body).toEqual({ result: 'ok' });
    expect(await regRow(app, id, '65000001')).toMatchObject({ phone: null, faculty: null, consent_at: null, answers: {} });
  });

  it('registers with no request body and no content type', async () => {
    const s = await student(app);
    const id = await newActivity(app, await sup(app), later());
    expect((await http(app).post(`/activities/${id}/registrations`).set('Authorization', `Bearer ${s}`).expect(200)).body).toEqual({ result: 'ok' });
  });

  it('stores phone, faculty, consent time and answers', async () => {
    const s = await student(app);
    const id = await newActivity(app, await sup(app), withQuestions());
    await api(app, s).post(`/activities/${id}/registrations`, FORM).expect(200);
    const row = await regRow(app, id, '65000001');
    expect(row).toMatchObject({ phone: '081-234 5678', faculty: 'คณะวิศวกรรมศาสตร์', answers: { q1: 'ปี 2', q2: 'ไม่มี' } });
    expect(row.consent_at.getTime()).toBe(1_700_000_000_000);
  });

  it('takes the new answers when registering again after a cancel', async () => {
    const s = await student(app);
    const id = await newActivity(app, await sup(app), withQuestions());
    await api(app, s).post(`/activities/${id}/registrations`, FORM).expect(200);
    await api(app, s).delete(`/activities/${id}/registrations/me`).expect(200);
    await api(app, s).post(`/activities/${id}/registrations`, { ...FORM, phone: '0899999999', answers: { q1: 'ปี 3' } }).expect(200);
    expect(await regRow(app, id, '65000001')).toMatchObject({ phone: '0899999999', answers: { q1: 'ปี 3' } });
  });

  it('keeps the first answers when the same student registers twice', async () => {
    const s = await student(app);
    const id = await newActivity(app, await sup(app), withQuestions());
    await api(app, s).post(`/activities/${id}/registrations`, FORM).expect(200);
    expect((await api(app, s).post(`/activities/${id}/registrations`, { ...FORM, phone: '0000000000' }).expect(200)).body.result).toBe('already');
    expect((await regRow(app, id, '65000001')).phone).toBe('081-234 5678');
  });

  describe('field rules', () => {
    const refuse = async (body: object, field: string) => {
      const s = await student(app);
      const id = await newActivity(app, await sup(app), withQuestions());
      const res = await api(app, s).post(`/activities/${id}/registrations`, body).expect(400);
      expect(res.body.error.code).toBe('VALIDATION');
      expect(res.body.error.fields).toContain(field);
      expect(await regRow(app, id, '65000001')).toBeUndefined();
      expect((await activityRow(app, id)).reg_count).toBe(0);
    };
    const ok = { answers: { q1: 'ปี 1' } };

    it.each([
      ['letters in the phone', { ...ok, phone: '08x-123' }, 'phone'],
      ['a phone over 20', { ...ok, phone: '1'.repeat(21) }, 'phone'],
      ['a phone that is not a string', { ...ok, phone: 812345678 }, 'phone'],
      ['a faculty over 80', { ...ok, faculty: 'ก'.repeat(81) }, 'faculty'],
      ['a consent time that is not a number', { ...ok, consentAt: 'วันนี้' }, 'consentAt'],
      ['answers that are not an object', { answers: 'ปี 1' }, 'answers'],
      ['answers as a list', { answers: ['ปี 1'] }, 'answers'],
      ['an answer that is not a string', { answers: { q1: 2 } }, 'answers'],
      ['an answer over 500', { answers: { q1: 'ปี 1', q2: 'ก'.repeat(501) } }, 'answers'],
    ])('refuses %s', (_, body, field) => refuse(body, field));

    it('refuses a missing required answer, and one that is only spaces', async () => {
      await refuse({ answers: {} }, 'answers.q1');
      await refuse({ answers: { q1: '   ' } }, 'answers.q1');
      await refuse({}, 'answers.q1');
    });

    it('refuses a choice that is not one of the options, required or not', async () => {
      await refuse({ answers: { q1: 'ปี 4' } }, 'answers.q1');
      await refuse({ answers: { q1: 'ปี 1', q3: 'XL' } }, 'answers.q3');
    });

    it('accepts phone and faculty as null, and the largest valid values', async () => {
      const s = await student(app);
      const id = await newActivity(app, await sup(app), withQuestions());
      await api(app, s).post(`/activities/${id}/registrations`, { phone: null, faculty: null, consentAt: null, answers: { q1: 'ปี 1', q2: 'ก'.repeat(500) } }).expect(200);
      expect(await regRow(app, id, '65000001')).toMatchObject({ phone: null, faculty: null, consent_at: null });
      const t = await student(app, '65000002', 'ข');
      await api(app, t).post(`/activities/${id}/registrations`, { phone: '0'.repeat(20), faculty: 'ก'.repeat(80), answers: { q1: 'ปี 1' } }).expect(200);
    });
  });

  it('drops answers to questions that do not exist and empty optional answers', async () => {
    const s = await student(app);
    const id = await newActivity(app, await sup(app), withQuestions());
    await api(app, s).post(`/activities/${id}/registrations`, { answers: { q1: ' ปี 1 ', q2: '', zz: 'ลบ', constructor: 'y' } }).expect(200);
    expect((await regRow(app, id, '65000001')).answers).toEqual({ q1: 'ปี 1' });
  });

  it('ignores a __proto__ key in the answers', async () => {
    const s = await student(app);
    const id = await newActivity(app, await sup(app), withQuestions());
    await http(app).post(`/activities/${id}/registrations`).set('Authorization', `Bearer ${s}`).set('Content-Type', 'application/json').send('{"answers":{"__proto__":"x","q1":"ปี 1"}}').expect(200);
    expect((await regRow(app, id, '65000001')).answers).toEqual({ q1: 'ปี 1' });
  });

  it('does not ask for answers on an activity without questions, and drops what was sent', async () => {
    const s = await student(app);
    const id = await newActivity(app, await sup(app), later());
    await api(app, s).post(`/activities/${id}/registrations`, { answers: { q1: 'x' } }).expect(200);
    expect((await regRow(app, id, '65000001')).answers).toEqual({});
  });

  it('a refused form takes no seat and sends no notice', async () => {
    const s = await student(app);
    const id = await newActivity(app, await sup(app), withQuestions({ capLimit: true, capacity: 1 }));
    await api(app, s).post(`/activities/${id}/registrations`, { answers: {} }).expect(400);
    expect((await dbOf(app).query('SELECT count(*)::int AS n FROM notices')).rows[0].n).toBe(0);
    const t = await student(app, '65000002', 'ข');
    expect((await api(app, t).post(`/activities/${id}/registrations`, { answers: { q1: 'ปี 1' } }).expect(200)).body.result).toBe('ok');
  });
});

describe('who gets the personal answers', () => {
  const PRIVATE = ['phone', 'faculty', 'consentAt', 'answers'];
  const leaks = (v: unknown) => JSON.stringify(v);

  async function setup() {
    const owner = await sup(app);
    const id = await newActivity(app, owner, withQuestions());
    const s = await student(app);
    await api(app, s).post(`/activities/${id}/registrations`, FORM).expect(200);
    // Someone registered through an older app: the fields are simply not there.
    const old = await student(app, '65000002', 'ข');
    await api(app, old).post(`/activities/${id}/registrations`, { answers: { q1: 'ปี 1' } }).expect(200);
    return { owner, id, s, old };
  }

  it('the owning organisation sees them in the list and for one student', async () => {
    const { owner, id } = await setup();
    const list = (await api(app, owner).get(`/activities/${id}/registrations`).expect(200)).body;
    expect(list.find((r: { studentId: string }) => r.studentId === '65000001')).toMatchObject({ phone: '081-234 5678', faculty: 'คณะวิศวกรรมศาสตร์', consentAt: 1_700_000_000_000, answers: { q1: 'ปี 2', q2: 'ไม่มี' } });
    const second = list.find((r: { studentId: string }) => r.studentId === '65000002');
    expect(second.answers).toEqual({ q1: 'ปี 1' });
    expect(second).not.toHaveProperty('phone');
    expect(second).not.toHaveProperty('consentAt');
    const one = (await api(app, owner).get(`/activities/${id}/registrations/65000001`).expect(200)).body;
    expect(one).toMatchObject({ phone: '081-234 5678', answers: { q1: 'ปี 2' } });
  });

  it('the centre admin sees them too', async () => {
    const { id } = await setup();
    const admin = await sup(app, ORG_ADMIN, 'แอดมิน');
    const list = (await api(app, admin).get(`/activities/${id}/registrations`).expect(200)).body;
    expect(list.find((r: { studentId: string }) => r.studentId === '65000001').phone).toBe('081-234 5678');
  });

  it('another organisation is refused', async () => {
    const { id } = await setup();
    const other = await sup(app, ORG_B, 'ผู้ดูแล ข');
    await api(app, other).get(`/activities/${id}/registrations`).expect(403);
    await api(app, other).get(`/activities/${id}/registrations/65000001`).expect(403);
  });

  it('students do not get them back, not even their own, and not from anyone else', async () => {
    const { id, s, old } = await setup();
    const mine = (await api(app, s).get(`/activities/${id}/registrations/65000001`).expect(200)).body;
    const all = (await api(app, s).get('/students/me/registrations').expect(200)).body;
    for (const body of [mine, all]) for (const k of PRIVATE) expect(leaks(body)).not.toContain(`"${k}"`);
    await api(app, old).get(`/activities/${id}/registrations/65000001`).expect(403);
    await api(app, old).get(`/activities/${id}/registrations`).expect(403);
  });

  it('nothing public carries them: activity, activity list, credits, notices, chat', async () => {
    const { owner, id } = await setup();
    const reader = await student(app, '65000009', 'ค');
    const urls = [`/activities/${id}`, '/activities', `/activities/${id}/credits`, `/activities/${id}/announcements`, `/activities/${id}/messages`, '/notices'];
    for (const token of [undefined, reader, owner]) {
      for (const url of urls) {
        const res = await api(app, token).get(url);
        const text = leaks(res.body);
        expect(text).not.toContain('081-234 5678');
        expect(text).not.toContain('คณะวิศวกรรมศาสตร์');
        expect(text).not.toContain('consentAt');
      }
    }
  });

  it('the admin waiving a credit does not return the personal fields', async () => {
    const { id } = await setup();
    const admin = await sup(app, ORG_ADMIN, 'แอดมิน');
    const res = await api(app, admin).patch(`/activities/${id}/registrations/65000001`, { waived: true });
    expect(leaks(res.body)).not.toContain('081-234 5678');
  });
});

describe('migration', () => {
  const sql = readFileSync(join(__dirname, '..', 'db', 'migrations', '2026-11-19-registration-form.sql'), 'utf8');
  const newColumns = (client: Client) =>
    client
      .query(
        `SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns
         WHERE table_schema = current_schema() AND column_name IN ('phone', 'faculty', 'consent_at', 'answers', 'questions') ORDER BY table_name, column_name`,
      )
      .then((r) => r.rows);

  it('adds the columns to a database that has the old tables, twice, without touching rows', async () => {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      await client.query('CREATE SCHEMA mig_regform');
      await client.query('SET search_path TO mig_regform');
      // Only the columns that exist before this change, on the two tables it touches.
      await client.query(`
        create table activities (id text primary key, title text not null, template_id text);
        create table registrations (activity_id text not null, student_id text not null, name text not null, at timestamptz not null default now(), primary key (activity_id, student_id));
        insert into activities (id, title) values ('a1', 'เดิม');
        insert into registrations (activity_id, student_id, name) values ('a1', '65000001', 'เดิม');`);
      await client.query(sql);
      await client.query(sql);
      expect((await client.query('SELECT * FROM registrations')).rows[0]).toMatchObject({ student_id: '65000001', name: 'เดิม', phone: null, faculty: null, consent_at: null, answers: {} });
      expect((await client.query('SELECT * FROM activities')).rows[0]).toMatchObject({ id: 'a1', title: 'เดิม', questions: [] });
      const migrated = await newColumns(client);

      // The same columns, types and defaults as a database built from db/schema.sql.
      await client.query('SET search_path TO public');
      const fresh = await newColumns(client);
      expect(migrated).toHaveLength(5);
      expect(migrated).toEqual(fresh);
    } finally {
      await client.query('SET search_path TO public').catch(() => undefined);
      await client.query('DROP SCHEMA IF EXISTS mig_regform CASCADE').catch(() => undefined);
      await client.end();
    }
  });

  it('a fresh database from schema.sql starts with empty defaults', async () => {
    const owner = await sup(app);
    const id = await newActivity(app, owner, later());
    expect((await activityRow(app, id)).questions).toEqual([]);
  });
});
