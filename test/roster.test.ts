import { NestExpressApplication } from '@nestjs/platform-express';
import ExcelJS from 'exceljs';
import { SchedulerService } from '../src/modules/scheduler/scheduler';
import { activityRow, api, creditRow, DAY, dbOf, HOUR, newActivity, noticesOf, ORG_ADMIN, ORG_B, regRow, resetDb, startApp, student, sup } from './helpers';

let app: NestExpressApplication;
beforeAll(async () => {
  app = await startApp();
});
afterAll(() => app.close());
beforeEach(() => resetDb(app));

const later = () => ({ start: Date.now() + 5 * DAY, end: Date.now() + 5 * DAY + HOUR });

describe('registering', () => {
  it('registers, counts and tells the student', async () => {
    const s = await student(app);
    const id = await newActivity(app, await sup(app), later());
    expect((await api(app, s).post(`/activities/${id}/registrations`).expect(200)).body).toEqual({ result: 'ok' });
    expect((await activityRow(app, id)).reg_count).toBe(1);
    expect(await regRow(app, id, '65000001')).toMatchObject({ name: 'สมชาย ใจดี', walk_in: false, cancelled_at: null });
    expect((await noticesOf(app, '65000001'))[0]).toMatchObject({ kind: 'registered', title: 'ลงทะเบียนสำเร็จ', body: 'บริจาคโลหิต', activity_id: id });
  });

  it('answers already the second time, without a second count or notice', async () => {
    const s = await student(app);
    const id = await newActivity(app, await sup(app), later());
    await api(app, s).post(`/activities/${id}/registrations`).expect(200);
    expect((await api(app, s).post(`/activities/${id}/registrations`).expect(200)).body.result).toBe('already');
    expect((await activityRow(app, id)).reg_count).toBe(1);
    expect(await noticesOf(app, '65000001')).toHaveLength(1);
  });

  it('answers full when the seats are gone', async () => {
    const a = await student(app, '65000001', 'ก');
    const b = await student(app, '65000002', 'ข');
    const id = await newActivity(app, await sup(app), { ...later(), capLimit: true, capacity: 1 });
    await api(app, a).post(`/activities/${id}/registrations`).expect(200);
    expect((await api(app, b).post(`/activities/${id}/registrations`).expect(200)).body.result).toBe('full');
    expect(await regRow(app, id, '65000002')).toBeUndefined();
    expect(await noticesOf(app, '65000002')).toHaveLength(0);
  });

  it('never oversells when many register at once', async () => {
    const id = await newActivity(app, await sup(app), { ...later(), capLimit: true, capacity: 5 });
    const tokens = await Promise.all(Array.from({ length: 20 }, (_, i) => student(app, String(66000000 + i), `นิสิต ${i}`)));
    const results = await Promise.all(tokens.map((t) => api(app, t).post(`/activities/${id}/registrations`)));
    expect(results.filter((r) => r.body.result === 'ok')).toHaveLength(5);
    expect(results.filter((r) => r.body.result === 'full')).toHaveLength(15);
    expect((await activityRow(app, id)).reg_count).toBe(5);
  });

  it('can register again after cancelling', async () => {
    const s = await student(app);
    const id = await newActivity(app, await sup(app), later());
    await api(app, s).post(`/activities/${id}/registrations`).expect(200);
    await api(app, s).delete(`/activities/${id}/registrations/me`).expect(200);
    expect((await activityRow(app, id)).reg_count).toBe(0);
    expect((await api(app, s).post(`/activities/${id}/registrations`).expect(200)).body.result).toBe('ok');
    expect(await regRow(app, id, '65000001')).toMatchObject({ cancelled_at: null, walk_in: false });
    expect((await activityRow(app, id)).reg_count).toBe(1);
  });

  describe('when the activity is not open', () => {
    const refused = async (id: string, token: string, code: string) => {
      const res = await api(app, token).post(`/activities/${id}/registrations`).expect(409);
      expect(res.body.error.code).toBe(code);
    };
    const nothingWritten = async (id: string) => {
      expect(await regRow(app, id, '65000001')).toBeUndefined();
      expect((await activityRow(app, id)).reg_count).toBe(0);
      expect(await noticesOf(app, '65000001')).toHaveLength(0);
    };

    it('refuses before opensAt and takes no seat, even with seats left', async () => {
      const s = await student(app);
      const id = await newActivity(app, await sup(app), { ...later(), capLimit: true, capacity: 1, opensAt: Date.now() + DAY });
      await refused(id, s, 'REG_NOT_OPEN');
      await nothingWritten(id);
    });

    it('accepts once opensAt has passed', async () => {
      const s = await student(app);
      const id = await newActivity(app, await sup(app), { ...later(), opensAt: Date.now() - 1000 });
      expect((await api(app, s).post(`/activities/${id}/registrations`).expect(200)).body.result).toBe('ok');
    });

    it('refuses after the end and accepts while it is running', async () => {
      const s = await student(app);
      const owner = await sup(app);
      const now = Date.now();
      const ended = await newActivity(app, owner, { start: now - 2 * HOUR, end: now - 1000 });
      await refused(ended, s, 'REG_ENDED');
      await nothingWritten(ended);
      const running = await newActivity(app, owner, { start: now - HOUR, end: now + HOUR });
      expect((await api(app, s).post(`/activities/${running}/registrations`).expect(200)).body.result).toBe('ok');
    });

    it('refuses a hidden activity until it is shown again', async () => {
      const s = await student(app);
      const owner = await sup(app);
      const id = await newActivity(app, owner, { ...later(), hidden: true });
      await refused(id, s, 'REG_HIDDEN');
      await nothingWritten(id);
      await api(app, owner).patch(`/activities/${id}`, { hidden: null }).expect(200);
      expect((await api(app, s).post(`/activities/${id}/registrations`).expect(200)).body.result).toBe('ok');
    });

    it('still answers already to someone registered before it closed', async () => {
      const s = await student(app);
      const owner = await sup(app);
      const id = await newActivity(app, owner, later());
      await api(app, s).post(`/activities/${id}/registrations`).expect(200);
      await api(app, owner).patch(`/activities/${id}`, { hidden: true }).expect(200);
      expect((await api(app, s).post(`/activities/${id}/registrations`).expect(200)).body.result).toBe('already');
      expect((await activityRow(app, id)).reg_count).toBe(1);
    });

    it('applies to registering again after a cancel', async () => {
      const s = await student(app);
      const owner = await sup(app);
      const id = await newActivity(app, owner, later());
      await api(app, s).post(`/activities/${id}/registrations`).expect(200);
      await api(app, s).delete(`/activities/${id}/registrations/me`).expect(200);
      await api(app, owner).patch(`/activities/${id}`, { hidden: true }).expect(200);
      await refused(id, s, 'REG_HIDDEN');
      expect((await regRow(app, id, '65000001')).cancelled_at).not.toBeNull();
      expect((await activityRow(app, id)).reg_count).toBe(0);
    });

    it('does not stop a supervisor adding someone', async () => {
      const owner = await sup(app);
      const id = await newActivity(app, owner, { ...later(), hidden: true, opensAt: Date.now() + DAY });
      await api(app, owner).post(`/activities/${id}/credits`, { studentId: '65000001', name: 'สมชาย ใจดี' }).expect(200);
      expect(await regRow(app, id, '65000001')).toMatchObject({ walk_in: true });
    });
  });

  describe('after a late cancel', () => {
    const soon = () => ({ start: Date.now() + HOUR, end: Date.now() + 2 * HOUR });
    let s: string;
    let owner: string;
    let id: string;
    beforeEach(async () => {
      s = await student(app);
      owner = await sup(app);
      id = await newActivity(app, owner, soon());
      await api(app, s).post(`/activities/${id}/registrations`).expect(200);
      expect((await api(app, s).delete(`/activities/${id}/registrations/me`).expect(200)).body.late).toBe(true);
    });

    it('refuses registering again and changes nothing', async () => {
      const res = await api(app, s).post(`/activities/${id}/registrations`).expect(409);
      expect(res.body.error.code).toBe('REG_LATE_CANCELLED');
      expect(await regRow(app, id, '65000001')).toMatchObject({ late: true });
      expect((await regRow(app, id, '65000001')).cancelled_at).not.toBeNull();
      expect((await activityRow(app, id)).reg_count).toBe(0);
    });

    it('stays refused when the lost credit was given back', async () => {
      await dbOf(app).query('UPDATE registrations SET waived = true WHERE activity_id = $1', [id]);
      expect((await api(app, s).post(`/activities/${id}/registrations`).expect(409)).body.error.code).toBe('REG_LATE_CANCELLED');
    });

    it('does not stop a supervisor adding them back', async () => {
      await api(app, owner).post(`/activities/${id}/credits`, { studentId: '65000001', name: 'สมชาย ใจดี' }).expect(200);
      expect(await regRow(app, id, '65000001')).toMatchObject({ walk_in: true, late: false, cancelled_at: null });
      expect((await api(app, s).post(`/activities/${id}/registrations`).expect(200)).body.result).toBe('already');
    });
  });

  describe('with lost credits', () => {
    const soon = () => ({ start: Date.now() + HOUR, end: Date.now() + 2 * HOUR });
    let s: string;
    let owner: string;
    beforeEach(async () => {
      s = await student(app);
      owner = await sup(app);
    });
    const lateCancels = async (n: number, token = s) => {
      const ids: string[] = [];
      for (let i = 0; i < n; i++) {
        const id = await newActivity(app, owner, soon());
        await api(app, token).post(`/activities/${id}/registrations`).expect(200);
        expect((await api(app, token).delete(`/activities/${id}/registrations/me`).expect(200)).body.late).toBe(true);
        ids.push(id);
      }
      return ids;
    };
    /** Registers, then the activity ends 2 hours ago. Its roster is still open unless closed below. */
    const registeredAndEnded = async (token = s) => {
      const id = await newActivity(app, owner, later());
      await api(app, token).post(`/activities/${id}/registrations`).expect(200);
      await dbOf(app).query(`UPDATE activities SET start_at = now() - interval '3 hours', end_at = now() - interval '2 hours' WHERE id = $1`, [id]);
      return id;
    };
    const closeRoster = (id: string) => dbOf(app).query('UPDATE activities SET closed_at = now() WHERE id = $1', [id]);
    const tryRegister = async (token = s) => api(app, token).post(`/activities/${await newActivity(app, owner, later())}/registrations`);

    it('registers with 2 and refuses with 3, writing nothing', async () => {
      await lateCancels(2);
      expect((await tryRegister()).body.result).toBe('ok');
      await lateCancels(1);
      const target = await newActivity(app, owner, later());
      const res = await api(app, s).post(`/activities/${target}/registrations`).expect(409);
      expect(res.body.error.code).toBe('REG_NO_CREDITS');
      expect(await regRow(app, target, '65000001')).toBeUndefined();
      expect((await activityRow(app, target)).reg_count).toBe(0);
    });

    it('does not count free cancels', async () => {
      for (let i = 0; i < 3; i++) {
        const id = await newActivity(app, owner, later());
        await api(app, s).post(`/activities/${id}/registrations`).expect(200);
        expect((await api(app, s).delete(`/activities/${id}/registrations/me`).expect(200)).body.late).toBe(false);
      }
      expect((await tryRegister()).body.result).toBe('ok');
    });

    it('does not count another student or one given back', async () => {
      const [first] = await lateCancels(3);
      const other = await student(app, '65000002', 'ข');
      expect((await tryRegister(other)).body.result).toBe('ok');
      await dbOf(app).query('UPDATE registrations SET waived = true WHERE activity_id = $1', [first]);
      expect((await tryRegister()).body.result).toBe('ok');
    });

    it('does not count last semester', async () => {
      const ids = await lateCancels(3);
      await dbOf(app).query(`UPDATE registrations SET cancelled_at = '2000-01-01' WHERE activity_id = ANY ($1)`, [ids]);
      expect((await tryRegister()).body.result).toBe('ok');
    });

    it('counts a no-show once the roster closes, by the supervisor or after 24 hours', async () => {
      await lateCancels(2);
      const id = await registeredAndEnded();
      expect((await tryRegister()).body.result).toBe('ok');
      await closeRoster(id);
      expect((await tryRegister()).body.error.code).toBe('REG_NO_CREDITS');
      await dbOf(app).query(`UPDATE activities SET closed_at = NULL, start_at = now() - interval '26 hours', end_at = now() - interval '25 hours' WHERE id = $1`, [id]);
      expect((await tryRegister()).body.error.code).toBe('REG_NO_CREDITS');
    });

    it('does not count a no-show with hours, a walk-in, or one given back', async () => {
      await lateCancels(2);
      const credited = await registeredAndEnded();
      await api(app, owner).post(`/activities/${credited}/credits`, { studentId: '65000001', hours: 0, reason: 'มาสาย' }).expect(200);
      await closeRoster(credited);
      const walkIn = await newActivity(app, owner, later());
      await dbOf(app).query(`INSERT INTO registrations (activity_id, student_id, name, walk_in) VALUES ($1, '65000001', 'ก', true)`, [walkIn]);
      await closeRoster(walkIn);
      const waived = await registeredAndEnded();
      await dbOf(app).query('UPDATE registrations SET waived = true WHERE activity_id = $1', [waived]);
      await closeRoster(waived);
      expect((await tryRegister()).body.result).toBe('ok');
    });

    it('still answers already, lets them cancel, and lets a supervisor add them', async () => {
      const held = await newActivity(app, owner, later());
      await api(app, s).post(`/activities/${held}/registrations`).expect(200);
      await lateCancels(3);
      expect((await api(app, s).post(`/activities/${held}/registrations`).expect(200)).body.result).toBe('already');
      await api(app, s).delete(`/activities/${held}/registrations/me`).expect(200);
      const id = await newActivity(app, owner, later());
      await api(app, owner).post(`/activities/${id}/credits`, { studentId: '65000001' }).expect(200);
      expect(await regRow(app, id, '65000001')).toMatchObject({ walk_in: true });
    });
  });

  describe('the lost credit summary and giving credits back', () => {
    const soon = () => ({ start: Date.now() + HOUR, end: Date.now() + 2 * HOUR });
    let s: string;
    let owner: string;
    let admin: string;
    beforeEach(async () => {
      s = await student(app);
      owner = await sup(app);
      admin = await sup(app, ORG_ADMIN);
    });
    const lateCancel = async () => {
      const id = await newActivity(app, owner, soon());
      await api(app, s).post(`/activities/${id}/registrations`).expect(200);
      await api(app, s).delete(`/activities/${id}/registrations/me`).expect(200);
      return id;
    };
    const summary = async (token = s, id = '65000001') => (await api(app, token).get(`/students/${id}/strikes`).expect(200)).body;
    const waive = (id: string, waived: boolean, token = admin, studentId = '65000001') => api(app, token).patch(`/activities/${id}/registrations/${studentId}`, { waived });

    it('lists what was lost this semester, newest first, with what is left and when it resets', async () => {
      expect(await summary()).toMatchObject({ limit: 3, left: 3, strikes: [] });
      const first = await lateCancel();
      await dbOf(app).query(`UPDATE registrations SET cancelled_at = now() - interval '1 minute' WHERE activity_id = $1`, [first]);
      const second = await lateCancel();
      const res = await summary();
      expect(res).toMatchObject({ limit: 3, left: 1 });
      expect(res.strikes).toEqual([
        { activityId: second, title: 'บริจาคโลหิต', kind: 'late', at: expect.any(Number), waived: false },
        { activityId: first, title: 'บริจาคโลหิต', kind: 'late', at: expect.any(Number), waived: false },
      ]);
      expect([1, 2]).toContain(res.semester.number);
      expect(res.semester.start).toBeLessThanOrEqual(Date.now());
      expect(res.semester.end).toBeGreaterThan(Date.now());
    });

    it('is for the student themself and the centre admin only', async () => {
      await summary(admin);
      await api(app, await student(app, '65000002', 'ข')).get('/students/65000001/strikes').expect(403);
      await api(app, owner).get('/students/65000001/strikes').expect(403);
      await api(app).get('/students/65000001/strikes').expect(401);
    });

    it('lets the admin give a credit back, so the student can register again, and take it back', async () => {
      const ids = [await lateCancel(), await lateCancel(), await lateCancel()];
      const blocked = await newActivity(app, owner, later());
      expect((await api(app, s).post(`/activities/${blocked}/registrations`).expect(409)).body.error.code).toBe('REG_NO_CREDITS');

      expect((await waive(ids[1], true).expect(200)).body).toMatchObject({ studentId: '65000001', waived: true, late: true });
      const res = await summary();
      expect(res.left).toBe(1);
      expect(res.strikes.find((x: { activityId: string }) => x.activityId === ids[1]).waived).toBe(true);
      expect((await api(app, s).post(`/activities/${blocked}/registrations`).expect(200)).body.result).toBe('ok');

      await waive(ids[1], false).expect(200);
      expect((await summary()).left).toBe(0);
    });

    it('is for the centre admin only', async () => {
      const id = await lateCancel();
      await waive(id, true, owner).expect(403);
      await waive(id, true, s).expect(403);
      expect((await regRow(app, id, '65000001')).waived).toBe(false);
    });

    it('refuses what is not a lost credit, and answers 404 for nothing to waive', async () => {
      const live = await newActivity(app, owner, later());
      await api(app, s).post(`/activities/${live}/registrations`).expect(200);
      expect((await waive(live, true).expect(409)).body.error.code).toBe('NOT_A_STRIKE');
      const free = await newActivity(app, owner, later());
      await api(app, s).post(`/activities/${free}/registrations`).expect(200);
      await api(app, s).delete(`/activities/${free}/registrations/me`).expect(200);
      expect((await waive(free, true).expect(409)).body.error.code).toBe('NOT_A_STRIKE');
      const old = await lateCancel();
      await dbOf(app).query(`UPDATE registrations SET cancelled_at = '2000-01-01' WHERE activity_id = $1`, [old]);
      expect((await waive(old, true).expect(409)).body.error.code).toBe('NOT_A_STRIKE');
      await waive(live, true, admin, '65000009').expect(404);
      await waive('nope', true).expect(404);
      await waive(live, 'yes' as never).expect(400);
      expect((await regRow(app, live, '65000001')).waived).toBe(false);
    });

    it('works on a recorded activity, past the roster lock', async () => {
      const id = await lateCancel();
      await dbOf(app).query('UPDATE activities SET submitted_at = now(), recorded_at = now() WHERE id = $1', [id]);
      await waive(id, true).expect(200);
    });
  });

  it('answers 404 for an unknown activity and is for students', async () => {
    await api(app, await student(app)).post('/activities/nope/registrations').expect(404);
    const id = await newActivity(app, await sup(app));
    await api(app, await sup(app)).post(`/activities/${id}/registrations`).expect(403);
  });
});

describe('cancelling', () => {
  const cancelAt = async (startIn: number, cancelDays?: number) => {
    const s = await student(app);
    const id = await newActivity(app, await sup(app), { start: Date.now() + startIn, end: Date.now() + startIn + HOUR, ...(cancelDays !== undefined && { cancelDays }) });
    await api(app, s).post(`/activities/${id}/registrations`).expect(200);
    return { id, res: (await api(app, s).delete(`/activities/${id}/registrations/me`).expect(200)).body };
  };

  it('is free more than 2 days before the start', async () => {
    const { id, res } = await cancelAt(3 * DAY);
    expect(res).toEqual({ late: false });
    expect((await regRow(app, id, '65000001')).late).toBe(false);
  });

  it('is late within 2 days of the start', async () => {
    const { id, res } = await cancelAt(DAY);
    expect(res).toEqual({ late: true });
    expect((await regRow(app, id, '65000001')).late).toBe(true);
  });

  it('follows the activity cancel_days', async () => {
    expect((await cancelAt(3 * DAY, 5)).res.late).toBe(true);
    await resetDb(app);
    expect((await cancelAt(DAY, 0)).res.late).toBe(false);
  });

  it('ignores a late value from the client', async () => {
    const s = await student(app);
    const id = await newActivity(app, await sup(app), { start: Date.now() + HOUR, end: Date.now() + 2 * HOUR });
    await api(app, s).post(`/activities/${id}/registrations`).expect(200);
    const res = await api(app, s).delete(`/activities/${id}/registrations/me`).send({ late: false }).expect(200);
    expect(res.body.late).toBe(true);
  });

  it('answers 404 without an active registration, and the count stays at 0', async () => {
    const s = await student(app);
    const id = await newActivity(app, await sup(app), later());
    await api(app, s).delete(`/activities/${id}/registrations/me`).expect(404);
    await api(app, s).post(`/activities/${id}/registrations`).expect(200);
    await api(app, s).delete(`/activities/${id}/registrations/me`).expect(200);
    await api(app, s).delete(`/activities/${id}/registrations/me`).expect(404);
    expect((await activityRow(app, id)).reg_count).toBe(0);
  });
});

describe('adding someone by hand', () => {
  it('needs no QR or registration, and registers them as walk-in', async () => {
    const owner = await sup(app);
    const id = await newActivity(app, owner, { walkIn: false });
    const res = (await api(app, owner).post(`/activities/${id}/credits`, { studentId: '65000009', name: 'คน  ใหม่' }).expect(200)).body;
    expect(res.ok).toBe(true);
    expect(res.credit).toMatchObject({ studentId: '65000009', name: 'คน ใหม่', hours: 6, fullHours: 6, method: 'manual', editedBy: 'ผู้ดูแล ก', flags: [] });
    expect(await regRow(app, id, '65000009')).toMatchObject({ walk_in: true });
    expect(await activityRow(app, id)).toMatchObject({ reg_count: 1, credit_count: 1 });
    expect((await dbOf(app).query('SELECT name FROM students WHERE id = $1', ['65000009'])).rows[0].name).toBe('คน ใหม่');
    expect((await noticesOf(app, '65000009'))[0]).toMatchObject({ kind: 'credit', title: 'ได้รับ 6 ชั่วโมง' });
  });

  it('keeps the stored name of a known student', async () => {
    await student(app, '65000001', 'ชื่อจริง');
    const owner = await sup(app);
    const id = await newActivity(app, owner);
    const { credit } = (await api(app, owner).post(`/activities/${id}/credits`, { studentId: '65000001', name: 'พิมพ์ผิด' }).expect(200)).body;
    expect(credit.name).toBe('ชื่อจริง');
  });

  it('needs a name for someone new', async () => {
    const owner = await sup(app);
    const id = await newActivity(app, owner);
    expect((await api(app, owner).post(`/activities/${id}/credits`, { studentId: '65000009' }).expect(400)).body.error.fields).toEqual(['name']);
  });

  describe('with less than full hours', () => {
    let owner: string;
    let id: string;
    beforeEach(async () => {
      owner = await sup(app);
      id = await newActivity(app, owner);
    });

    it('saves the reason with the hours in one call', async () => {
      const res = await api(app, owner).post(`/activities/${id}/credits`, { studentId: '65000001', name: 'ก', hours: 3, reason: 'มาสาย' }).expect(200);
      expect(res.body.credit).toMatchObject({ hours: 3, reason: 'มาสาย', method: 'manual' });
      expect(await creditRow(app, id, '65000001')).toMatchObject({ hours: 3, reason: 'มาสาย' });
    });

    it.each([
      ['missing', {}],
      ['empty', { reason: '' }],
      ['null', { reason: null }],
    ])('refuses a reason that is %s and writes nothing', async (_name, reason) => {
      const res = await api(app, owner).post(`/activities/${id}/credits`, { studentId: '65000001', name: 'ก', hours: 0, ...reason }).expect(400);
      expect(res.body.error).toMatchObject({ code: 'VALIDATION', fields: ['reason'] });
      expect(await creditRow(app, id, '65000001')).toBeUndefined();
      expect(await regRow(app, id, '65000001')).toBeUndefined();
      expect((await activityRow(app, id)).credit_count).toBe(0);
      expect(await noticesOf(app, '65000001')).toHaveLength(0);
    });

    it('needs no reason for full hours, given or by default', async () => {
      await api(app, owner).post(`/activities/${id}/credits`, { studentId: '65000001', name: 'ก', hours: 6 }).expect(200);
      await api(app, owner).post(`/activities/${id}/credits`, { studentId: '65000002', name: 'ข' }).expect(200);
      expect((await creditRow(app, id, '65000001')).reason).toBeNull();
      expect((await creditRow(app, id, '65000002')).reason).toBeNull();
    });

    it('leaves an existing credit alone and answers already', async () => {
      await api(app, owner).post(`/activities/${id}/credits`, { studentId: '65000001', name: 'ก', hours: 3, reason: 'มาสาย' }).expect(200);
      const res = await api(app, owner).post(`/activities/${id}/credits`, { studentId: '65000001', hours: 1, reason: 'อื่น ๆ' }).expect(200);
      expect(res.body).toMatchObject({ ok: false, reason: 'already', credit: { hours: 3, reason: 'มาสาย' } });
    });
  });

  it('takes hours from 0 up to the activity hours, and 0 sends no notice', async () => {
    const owner = await sup(app);
    const id = await newActivity(app, owner);
    expect((await api(app, owner).post(`/activities/${id}/credits`, { studentId: '65000001', name: 'ก', hours: 0, reason: 'กลับก่อน' }).expect(200)).body.credit.hours).toBe(0);
    expect(await noticesOf(app, '65000001')).toHaveLength(0);
    expect((await api(app, owner).post(`/activities/${id}/credits`, { studentId: '65000002', name: 'ข', hours: 4, reason: 'กลับก่อน' }).expect(200)).body.credit).toMatchObject({ hours: 4, fullHours: 6 });
    await api(app, owner).post(`/activities/${id}/credits`, { studentId: '65000003', name: 'ค', hours: 7 }).expect(400);
  });

  it('answers already for someone with hours', async () => {
    const owner = await sup(app);
    const id = await newActivity(app, owner);
    await api(app, owner).post(`/activities/${id}/credits`, { studentId: '65000001', name: 'ก' }).expect(200);
    expect((await api(app, owner).post(`/activities/${id}/credits`, { studentId: '65000001', name: 'ก' }).expect(200)).body).toMatchObject({ ok: false, reason: 'already' });
    expect((await activityRow(app, id)).credit_count).toBe(1);
  });
});

describe('editing hours', () => {
  let owner: string;
  let id: string;
  beforeEach(async () => {
    owner = await sup(app);
    id = await newActivity(app, owner);
    await api(app, owner).post(`/activities/${id}/credits`, { studentId: '65000001', name: 'ก' }).expect(200);
  });

  it('records who, when and why', async () => {
    const res = (await api(app, owner).patch(`/activities/${id}/credits/65000001`, { hours: 3, reason: 'กลับก่อน' }).expect(200)).body;
    expect(res).toMatchObject({ hours: 3, reason: 'กลับก่อน', editedBy: 'ผู้ดูแล ก' });
    expect(res.editedAt).toBeGreaterThan(0);
  });

  it('needs a reason when below full hours', async () => {
    expect((await api(app, owner).patch(`/activities/${id}/credits/65000001`, { hours: 3 }).expect(400)).body.error.fields).toEqual(['reason']);
    await api(app, owner).patch(`/activities/${id}/credits/65000001`, { hours: 3, reason: '   ' }).expect(400);
  });

  it('needs no reason to give back full hours, and clears the old one', async () => {
    await api(app, owner).patch(`/activities/${id}/credits/65000001`, { hours: 3, reason: 'มาสาย' }).expect(200);
    const res = (await api(app, owner).patch(`/activities/${id}/credits/65000001`, { hours: 6, reason: '' }).expect(200)).body;
    expect(res.hours).toBe(6);
    expect(res).not.toHaveProperty('reason');
  });

  it('cannot go above full hours', async () => {
    await api(app, owner).patch(`/activities/${id}/credits/65000001`, { hours: 7, reason: 'x' }).expect(400);
  });

  it('answers 404 for someone without hours', async () => {
    await api(app, owner).patch(`/activities/${id}/credits/65000002`, { hours: 3, reason: 'x' }).expect(404);
  });

  it('tells the student when the hours change, and not when they stay the same', async () => {
    await api(app, owner).patch(`/activities/${id}/credits/65000001`, { hours: 3, reason: 'กลับก่อน' }).expect(200);
    await api(app, owner).patch(`/activities/${id}/credits/65000001`, { hours: 3, reason: 'กลับก่อนเวลา' }).expect(200);
    await api(app, owner).patch(`/activities/${id}/credits/65000001`, { hours: 0, reason: 'ไม่ได้ทำงาน' }).expect(200);
    const titles = (await noticesOf(app, '65000001')).map((n) => n.title);
    expect(titles).toEqual(['ได้รับ 6 ชั่วโมง', 'ชั่วโมงเปลี่ยนเป็น 3 ชั่วโมง', 'ชั่วโมงเปลี่ยนเป็น 0 ชั่วโมง']);
  });
});

describe('removing', () => {
  let owner: string;
  let id: string;
  beforeEach(async () => {
    owner = await sup(app);
    id = await newActivity(app, owner);
  });

  it('a credit lowers credit_count only', async () => {
    await api(app, owner).post(`/activities/${id}/credits`, { studentId: '65000001', name: 'ก' }).expect(200);
    await api(app, owner).delete(`/activities/${id}/credits/65000001`).expect(200);
    expect(await creditRow(app, id, '65000001')).toBeUndefined();
    expect(await activityRow(app, id)).toMatchObject({ credit_count: 0, reg_count: 1 });
  });

  it('a registration takes its credit with it and lowers both counts', async () => {
    await api(app, owner).post(`/activities/${id}/credits`, { studentId: '65000001', name: 'ก' }).expect(200);
    await api(app, owner).delete(`/activities/${id}/registrations/65000001`).expect(200);
    expect(await regRow(app, id, '65000001')).toBeUndefined();
    expect(await creditRow(app, id, '65000001')).toBeUndefined();
    expect(await activityRow(app, id)).toMatchObject({ credit_count: 0, reg_count: 0 });
  });

  it('a cancelled registration does not count twice', async () => {
    const a = await student(app, '65000001', 'ก');
    const b = await student(app, '65000002', 'ข');
    await api(app, a).post(`/activities/${id}/registrations`).expect(200);
    await api(app, b).post(`/activities/${id}/registrations`).expect(200);
    await api(app, a).delete(`/activities/${id}/registrations/me`).expect(200);
    await api(app, owner).delete(`/activities/${id}/registrations/65000001`).expect(200);
    expect((await activityRow(app, id)).reg_count).toBe(1);
  });

  it('counters never go below 0', async () => {
    await api(app, owner).post(`/activities/${id}/credits`, { studentId: '65000001', name: 'ก' }).expect(200);
    await dbOf(app).query('UPDATE activities SET credit_count = 0, reg_count = 0 WHERE id = $1', [id]);
    await api(app, owner).delete(`/activities/${id}/registrations/65000001`).expect(200);
    expect(await activityRow(app, id)).toMatchObject({ credit_count: 0, reg_count: 0 });
  });

  it('removing someone who is not there changes nothing', async () => {
    await api(app, owner).delete(`/activities/${id}/credits/65000001`).expect(200);
    await api(app, owner).delete(`/activities/${id}/registrations/65000001`).expect(200);
    expect(await activityRow(app, id)).toMatchObject({ credit_count: 0, reg_count: 0 });
  });
});

describe('bottles', () => {
  let owner: string;
  let id: string;
  const add = (n: number, token = owner) => api(app, token).post(`/activities/${id}/bottles`, { studentId: '65000001', name: 'ก', add: n });
  beforeEach(async () => {
    owner = await sup(app);
    id = await newActivity(app, owner, { categoryKey: 'bottle', itemsPerHour: 20, hours: 3, qrMode: 'static', locMode: 'off' });
  });

  it('19 bottles is 0 hours, one more is 1, and the credit is manual', async () => {
    const first = (await add(19).expect(200)).body;
    expect(first).toMatchObject({ items: 19, hours: 0 });
    expect(first.credit).toMatchObject({ method: 'manual', items: 19, hours: 0, fullHours: 3, editedBy: 'ผู้ดูแล ก' });
    expect((await add(1).expect(200)).body).toMatchObject({ items: 20, hours: 1 });
    expect((await activityRow(app, id)).credit_count).toBe(1);
  });

  it('stops at the activity hours', async () => {
    expect((await add(1000).expect(200)).body).toMatchObject({ items: 1000, hours: 3 });
  });

  it('tells the student when the hours first go above 0, and again each time they change', async () => {
    await add(19).expect(200);
    expect(await noticesOf(app, '65000001')).toHaveLength(0);
    await add(1).expect(200);
    await add(5).expect(200);
    await add(15).expect(200);
    const notices = await noticesOf(app, '65000001');
    expect(notices.map((n) => n.title)).toEqual(['ได้รับ 1 ชั่วโมง', 'ชั่วโมงเปลี่ยนเป็น 2 ชั่วโมง']);
    expect(notices.every((n) => n.kind === 'credit')).toBe(true);
  });

  it('counts every bottle when two requests arrive at once', async () => {
    const results = await Promise.all(Array.from({ length: 25 }, () => add(1)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(await creditRow(app, id, '65000001')).toMatchObject({ items: 25, hours: 1 });
    expect((await activityRow(app, id)).credit_count).toBe(1);
  });

  it('answers NOT_BOTTLE on another kind of activity', async () => {
    const other = await newActivity(app, owner);
    expect((await api(app, owner).post(`/activities/${other}/bottles`, { studentId: '65000001', name: 'ก', add: 1 }).expect(409)).body.error.code).toBe('NOT_BOTTLE');
  });

  it('needs a positive whole number', async () => {
    await add(0).expect(400);
    await add(-1).expect(400);
    await add(1.5).expect(400);
  });
});

describe('roster life cycle', () => {
  let owner: string;
  let admin: string;
  let id: string;
  beforeEach(async () => {
    owner = await sup(app);
    admin = await sup(app, ORG_ADMIN, 'แอดมิน');
    id = await newActivity(app, owner);
  });

  it('closing sets the time once', async () => {
    expect((await api(app, owner).post(`/activities/${id}/close`).expect(200)).body.changed).toBe(true);
    const first = (await activityRow(app, id)).closed_at;
    expect((await api(app, owner).post(`/activities/${id}/close`).expect(200)).body.changed).toBe(false);
    expect((await activityRow(app, id)).closed_at).toEqual(first);
  });

  it('sending sets the time once, and closes if still open', async () => {
    expect((await api(app, owner).post(`/activities/${id}/submit`).expect(200)).body.changed).toBe(true);
    const row = await activityRow(app, id);
    expect(row.submitted_at).not.toBeNull();
    expect(row.closed_at).not.toBeNull();
    expect((await api(app, owner).post(`/activities/${id}/submit`).expect(200)).body.changed).toBe(false);
    expect((await activityRow(app, id)).submitted_at).toEqual(row.submitted_at);
  });

  it('after sending, the owner cannot change the roster but the admin can', async () => {
    await api(app, owner).post(`/activities/${id}/credits`, { studentId: '65000001', name: 'ก' }).expect(200);
    await api(app, owner).post(`/activities/${id}/submit`).expect(200);
    const url = `/activities/${id}/credits/65000001`;
    expect((await api(app, owner).patch(url, { hours: 1, reason: 'x' }).expect(409)).body.error.code).toBe('ROSTER_LOCKED');
    await api(app, owner).delete(url).expect(409);
    await api(app, owner).delete(`/activities/${id}/registrations/65000001`).expect(409);
    await api(app, owner).post(`/activities/${id}/credits`, { studentId: '65000002', name: 'ข' }).expect(409);
    await api(app, admin).patch(url, { hours: 1, reason: 'ศูนย์แก้' }).expect(200);
    await api(app, admin).post(`/activities/${id}/credits`, { studentId: '65000002', name: 'ข' }).expect(200);
    await api(app, admin).delete(`/activities/${id}/credits/65000002`).expect(200);
  });

  it('recording before sending is refused', async () => {
    expect((await api(app, admin).post(`/activities/${id}/record`).expect(409)).body.error.code).toBe('NOT_SUBMITTED');
    expect((await activityRow(app, id)).recorded_at).toBeNull();
  });

  it('is for the admin only', async () => {
    await api(app, owner).post(`/activities/${id}/submit`).expect(200);
    await api(app, owner).post(`/activities/${id}/record`).expect(403);
    await api(app, await student(app)).post(`/activities/${id}/record`).expect(403);
  });

  it('recording tells everyone with hours, once, and locks everyone', async () => {
    await api(app, owner).post(`/activities/${id}/credits`, { studentId: '65000001', name: 'ก', hours: 4, reason: 'กลับก่อน' }).expect(200);
    await api(app, owner).post(`/activities/${id}/credits`, { studentId: '65000002', name: 'ข', hours: 0, reason: 'กลับก่อน' }).expect(200);
    await api(app, owner).post(`/activities/${id}/submit`).expect(200);
    expect((await api(app, admin).post(`/activities/${id}/record`).expect(200)).body.changed).toBe(true);
    expect((await api(app, admin).post(`/activities/${id}/record`).expect(200)).body.changed).toBe(false);
    const recorded = (await noticesOf(app, '65000001')).filter((n) => n.kind === 'recorded');
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ title: 'บันทึกชั่วโมงลงระบบแล้ว', body: 'บริจาคโลหิต 4 ชั่วโมง', activity_id: id });
    expect((await noticesOf(app, '65000002')).filter((n) => n.kind === 'recorded')).toHaveLength(0);
    await api(app, admin).patch(`/activities/${id}/credits/65000001`, { hours: 1, reason: 'x' }).expect(409);
  });

  it('two recordings at once still tell everyone once', async () => {
    await api(app, owner).post(`/activities/${id}/credits`, { studentId: '65000001', name: 'ก' }).expect(200);
    await api(app, owner).post(`/activities/${id}/submit`).expect(200);
    await Promise.all([api(app, admin).post(`/activities/${id}/record`), api(app, admin).post(`/activities/${id}/record`), api(app, admin).post(`/activities/${id}/record`)]);
    expect((await noticesOf(app, '65000001')).filter((n) => n.kind === 'recorded')).toHaveLength(1);
  });
});

describe('the closing job', () => {
  it('closes rosters 24 hours past the end at that time, and leaves the rest', async () => {
    const owner = await sup(app);
    const db = dbOf(app);
    const overdue = await newActivity(app, owner);
    const recent = await newActivity(app, owner);
    const closed = await newActivity(app, owner);
    await db.query(`UPDATE activities SET start_at = now() - interval '30 hours', end_at = now() - interval '25 hours' WHERE id = $1`, [overdue]);
    await db.query(`UPDATE activities SET start_at = now() - interval '30 hours', end_at = now() - interval '23 hours' WHERE id = $1`, [recent]);
    await db.query(`UPDATE activities SET start_at = now() - interval '30 hours', end_at = now() - interval '25 hours', closed_at = now() - interval '26 hours' WHERE id = $1`, [closed]);
    const earlierClose = (await activityRow(app, closed)).closed_at;

    expect(await app.get(SchedulerService).closeOverdueRosters()).toBe(1);

    const row = await activityRow(app, overdue);
    expect(row.closed_at.getTime()).toBe(row.end_at.getTime() + 24 * HOUR);
    expect((await activityRow(app, recent)).closed_at).toBeNull();
    expect((await activityRow(app, closed)).closed_at).toEqual(earlierClose);
    expect(await app.get(SchedulerService).closeOverdueRosters()).toBe(0);
  });
});

describe('who can read what', () => {
  let owner: string;
  let other: string;
  let admin: string;
  let id: string;
  beforeEach(async () => {
    owner = await sup(app);
    other = await sup(app, ORG_B);
    admin = await sup(app, ORG_ADMIN);
    id = await newActivity(app, owner);
    await api(app, await student(app, '65000001', 'ก')).post(`/activities/${id}/registrations`).expect(200);
    await api(app, owner).post(`/activities/${id}/credits`, { studentId: '65000001' }).expect(200);
  });

  it.each(['registrations', 'credits', 'registrations/65000001', 'credits/65000001', 'export?kind=sup', 'dms'])('another organisation cannot read %s', async (path) => {
    expect((await api(app, other).get(`/activities/${id}/${path}`).expect(403)).body.error.code).toBe('FORBIDDEN');
  });

  it.each(['registrations', 'credits', 'registrations/65000001', 'credits/65000001', 'export?kind=sup', 'dms'])('the owner and admin can read %s', async (path) => {
    await api(app, owner).get(`/activities/${id}/${path}`).expect(200);
    await api(app, admin).get(`/activities/${id}/${path}`).expect(200);
  });

  it.each([
    ['patch', 'credits/65000001', { hours: 1, reason: 'x' }],
    ['delete', 'credits/65000001', undefined],
    ['delete', 'registrations/65000001', undefined],
    ['post', 'credits', { studentId: '65000002', name: 'ข' }],
    ['post', 'close', {}],
    ['post', 'submit', {}],
  ])('another organisation cannot %s %s', async (method, path, body) => {
    const client = api(app, other) as any;
    await client[method](`/activities/${id}/${path}`, body).expect(403);
    await (api(app, await student(app, '65000005', 'ฉ')) as any)[method](`/activities/${id}/${path}`, body).expect(403);
  });

  it('a student reads only their own registration and credit', async () => {
    const me = await student(app, '65000001', 'ก');
    const peer = await student(app, '65000002', 'ข');
    await api(app, me).get(`/activities/${id}/credits/65000001`).expect(200);
    await api(app, me).get(`/activities/${id}/registrations/65000001`).expect(200);
    await api(app, peer).get(`/activities/${id}/credits/65000001`).expect(403);
    await api(app, peer).get(`/activities/${id}/registrations/65000001`).expect(403);
    await api(app, peer).get(`/activities/${id}/registrations`).expect(403);
  });

  it('a student who has nothing gets 404, so the screen can show "none"', async () => {
    const peer = await student(app, '65000002', 'ข');
    await api(app, peer).get(`/activities/${id}/credits/65000002`).expect(404);
    await api(app, peer).get(`/activities/${id}/registrations/65000002`).expect(404);
  });

  it('students see the sign-in sheet with only who and when for others', async () => {
    const s = await student(app, '65000002', 'ข');
    await dbOf(app).query(
      `UPDATE credits SET device_id = 'secret-device', distance = 5, accuracy = 7, flags = '{location,device}', reason = 'ป่วย', edited_by = 'ผู้ดูแล ก', ref = 'ABCD1234', items = 3 WHERE activity_id = $1`,
      [id],
    );
    const rows = (await api(app, s).get(`/activities/${id}/credits`).expect(200)).body;
    expect(rows[0]).toEqual({ studentId: '65000001', name: 'ก', hours: 6, fullHours: 6, at: expect.any(Number), method: 'manual' });
    const mine = (await api(app, await student(app, '65000001', 'ก')).get(`/activities/${id}/credits`).expect(200)).body;
    expect(mine[0]).toMatchObject({ deviceId: 'secret-device', distance: 5, accuracy: 7 });
    expect((await api(app, owner).get(`/activities/${id}/credits`).expect(200)).body[0].deviceId).toBe('secret-device');
  });

  it('the sign-in sheet needs signing in', async () => {
    await api(app).get(`/activities/${id}/credits`).expect(401);
  });

  it('sorts credits both ways', async () => {
    await api(app, owner).post(`/activities/${id}/credits`, { studentId: '65000002', name: 'ข' }).expect(200);
    await dbOf(app).query(`UPDATE credits SET at = now() - interval '1 hour' WHERE student_id = '65000001'`);
    const ids = async (q: string) => (await api(app, owner).get(`/activities/${id}/credits${q}`).expect(200)).body.map((c: { studentId: string }) => c.studentId);
    expect(await ids('')).toEqual(['65000001', '65000002']);
    expect(await ids('?order=desc')).toEqual(['65000002', '65000001']);
  });

  it('JSON leaves out false and empty registration fields', async () => {
    const s = await student(app, '65000002', 'ข');
    await api(app, s).post(`/activities/${id}/registrations`).expect(200);
    const reg = (await api(app, s).get(`/activities/${id}/registrations/65000002`).expect(200)).body;
    expect(Object.keys(reg).sort()).toEqual(['at', 'name', 'studentId']);
    const walkIn = (await api(app, owner).get(`/activities/${id}/registrations/65000001`).expect(200)).body;
    expect(walkIn).not.toHaveProperty('walkIn');
  });
});

describe('Excel files', () => {
  const read = async (body: Buffer) => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(body as any);
    const rows: unknown[][] = [];
    wb.worksheets[0].eachRow((r) => rows.push((r.values as unknown[]).slice(1)));
    return rows;
  };
  const download = (r: any) =>
    r.buffer(true).parse((res: any, cb: any) => {
      const parts: Buffer[] = [];
      res.on('data', (d: Buffer) => parts.push(d));
      res.on('end', () => cb(null, Buffer.concat(parts)));
    });

  let owner: string;
  let admin: string;
  let id: string;
  beforeEach(async () => {
    owner = await sup(app);
    admin = await sup(app, ORG_ADMIN);
    id = await newActivity(app, owner, { title: 'เก็บขยะริมน้ำ', categoryKey: 'setup', ...later() });
    await api(app, owner).post(`/activities/${id}/credits`, { studentId: '65000002', name: 'สมหญิง รักเรียน', hours: 3, reason: 'กลับก่อน' }).expect(200);
    await api(app, owner).post(`/activities/${id}/credits`, { studentId: '65000001', name: '=SUM(1)', hours: 0, reason: 'กลับก่อน' }).expect(200);
    const late = await student(app, '65000003', 'ปวีณา มาสาย');
    await api(app, late).post(`/activities/${id}/registrations`).expect(200);
    // The file's date column is checked against a fixed date. Set after registering, because an ended activity refuses it.
    await dbOf(app).query('UPDATE activities SET start_at = $2, end_at = $3 WHERE id = $1', [id, new Date(Date.UTC(2026, 10, 20, 1)), new Date(Date.UTC(2026, 10, 20, 8))]);
  });

  it('the supervisor file has 11 columns in order, Thai intact, formulas stopped', async () => {
    const res = await download(api(app, owner).get(`/activities/${id}/export?kind=sup`).expect(200));
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(decodeURIComponent(res.headers['content-disposition'])).toContain('เก็บขยะริมน้ำ รายชื่อ.xlsx');
    const rows = await read(res.body);
    expect(rows[0]).toEqual(['ลำดับ', 'รหัสนิสิต', 'ชื่อ', 'กิจกรรม', 'หมวด', 'วันที่', 'ชั่วโมง', 'สถานะ', 'เวลายืนยัน', 'ยืนยันโดย', 'หมายเหตุ']);
    expect(rows).toHaveLength(4);
    const byId = Object.fromEntries(rows.slice(1).map((r) => [r[1], r]));
    expect(byId['65000002'].slice(1, 8)).toEqual(['65000002', 'สมหญิง รักเรียน', 'เก็บขยะริมน้ำ', 'จัดสถานที่', '20 พ.ย. 2569', 3, 'ได้ชั่วโมง (ไม่ได้ลงทะเบียน)']);
    expect(byId['65000002'][8]).toMatch(/^\d{1,2} \S+ \d{4} \d{2}:\d{2} น\.$/);
    expect(byId['65000002'][9]).toBe('ผู้ดูแล ก');
    expect(byId['65000001'][2]).toBe("'=SUM(1)");
    expect(byId['65000003'].slice(6, 8)).toEqual([0, 'ไม่มา']);
  });

  it('the centre file has 7 columns, earners only, by id', async () => {
    const res = await download(api(app, admin).get(`/activities/${id}/export?kind=admin`).expect(200));
    expect(decodeURIComponent(res.headers['content-disposition'])).toContain('บันทึกชั่วโมง.xlsx');
    const rows = await read(res.body);
    expect(rows).toEqual([
      ['รหัสนิสิต', 'ชื่อ', 'กิจกรรม', 'หน่วยงาน', 'หมวด', 'วันที่', 'ชั่วโมง'],
      ['65000002', 'สมหญิง รักเรียน', 'เก็บขยะริมน้ำ', 'หน่วยงาน A', 'จัดสถานที่', '20 พ.ย. 2569', 3],
    ]);
  });

  it('the centre file is for the admin, and kind must be valid', async () => {
    await api(app, owner).get(`/activities/${id}/export?kind=admin`).expect(403);
    await api(app, owner).get(`/activities/${id}/export`).expect(400);
    await api(app, await student(app)).get(`/activities/${id}/export?kind=sup`).expect(403);
  });
});

describe('statistics', () => {
  it('sums hours per activity, with 0 for none, for the admin only', async () => {
    const owner = await sup(app);
    const admin = await sup(app, ORG_ADMIN);
    const a = await newActivity(app, owner);
    const b = await newActivity(app, owner);
    await api(app, owner).post(`/activities/${a}/credits`, { studentId: '65000001', name: 'ก', hours: 4, reason: 'กลับก่อน' }).expect(200);
    await api(app, owner).post(`/activities/${a}/credits`, { studentId: '65000002', name: 'ข', hours: 2, reason: 'กลับก่อน' }).expect(200);
    const res = (await api(app, admin).post('/stats/credit-hours', { activityIds: [a, b] }).expect(200)).body;
    expect(res).toEqual({ [a]: 6, [b]: 0 });
    await api(app, owner).post('/stats/credit-hours', { activityIds: [a] }).expect(403);
    await api(app, await student(app)).post('/stats/credit-hours', { activityIds: [a] }).expect(403);
  });
});
