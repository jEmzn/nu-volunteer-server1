import 'reflect-metadata';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { DbService } from '../src/common/db.service';

export const QR_SECRET = process.env.QR_SECRET!;
export const ORG_A = 'ORG-A-CODE';
export const ORG_B = 'ORG-B-CODE';
export const ORG_ADMIN = 'ORG-ADMIN-CODE';

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

/** The real application, on a real port so WebSocket tests can connect, against the real database. */
export async function startApp(): Promise<NestExpressApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false, logger: false });
  configureApp(app);
  await app.listen(0);
  return app;
}

/** Empties every table and puts the three test organisations back. */
export async function resetDb(app: NestExpressApplication) {
  const db = app.get(DbService);
  await db.query('TRUNCATE students, orgs, activities, registrations, credits, announcements, messages, dms, notices, templates');
  await db.query(`INSERT INTO orgs (code, name, admin) VALUES ($1, 'หน่วยงาน A', false), ($2, 'หน่วยงาน B', false), ($3, 'ศูนย์จิตอาสา', true)`, [ORG_A, ORG_B, ORG_ADMIN]);
}

export const dbOf = (app: NestExpressApplication) => app.get(DbService);

export const http = (app: NestExpressApplication) => request(app.getHttpServer());

/** Sends the request with a bearer token, or none if token is empty. */
export function api(app: NestExpressApplication, token?: string) {
  const agent = http(app);
  const auth = (r: request.Test) => (token ? r.set('Authorization', `Bearer ${token}`) : r);
  return {
    get: (url: string) => auth(agent.get(url)),
    post: (url: string, body?: object) => auth(agent.post(url)).send(body ?? {}),
    patch: (url: string, body?: object) => auth(agent.patch(url)).send(body ?? {}),
    delete: (url: string) => auth(agent.delete(url)),
  };
}

export async function student(app: NestExpressApplication, id = '65000001', name = 'สมชาย ใจดี'): Promise<string> {
  const res = await http(app).post('/auth/student').send({ studentId: id, name }).expect(200);
  return res.body.token;
}

export async function sup(app: NestExpressApplication, orgCode = ORG_A, supName = 'ผู้ดูแล ก'): Promise<string> {
  const res = await http(app).post('/auth/sup').send({ orgCode, supName }).expect(200);
  return res.body.token;
}

/** A running walk-in activity with a dynamic QR, unless overridden. */
export function activityBody(over: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    title: 'บริจาคโลหิต',
    categoryKey: 'blood',
    poster: './posters/blood.jpg',
    description: 'รายละเอียด',
    place: 'อาคารอเนกประสงค์',
    lat: 16.7466,
    lng: 100.1948,
    start: now - HOUR,
    end: now + HOUR,
    hours: 6,
    capLimit: false,
    capacity: 0,
    walkIn: true,
    qrMode: 'dynamic',
    locMode: 'on',
    radius: 150,
    qrInterval: 10,
    supervisor: { name: 'ผู้ดูแล ก', phone: '055000000' },
    chatEnabled: true,
    ...over,
  };
}

export async function newActivity(app: NestExpressApplication, supToken: string, over: Record<string, unknown> = {}): Promise<string> {
  const res = await api(app, supToken).post('/activities', activityBody(over)).expect(201);
  return res.body.id;
}

export const activityRow = async (app: NestExpressApplication, id: string) => (await dbOf(app).query('SELECT * FROM activities WHERE id = $1', [id])).rows[0];
export const creditRow = async (app: NestExpressApplication, id: string, s: string) => (await dbOf(app).query('SELECT * FROM credits WHERE activity_id = $1 AND student_id = $2', [id, s])).rows[0];
export const regRow = async (app: NestExpressApplication, id: string, s: string) => (await dbOf(app).query('SELECT * FROM registrations WHERE activity_id = $1 AND student_id = $2', [id, s])).rows[0];
export const noticesOf = async (app: NestExpressApplication, s: string) => (await dbOf(app).query('SELECT * FROM notices WHERE student_id = $1 ORDER BY at', [s])).rows;
