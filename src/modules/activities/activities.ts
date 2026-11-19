import { Body, Controller, Get, Injectable, Module, Param, Patch, Post, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { assertCanEdit, CurrentUser, Public, Roles, SupUser, Viewer } from '../../common/auth';
import type { PoolClient } from 'pg';
import { DbService, lockActivity, Row } from '../../common/db.service';
import { ApiError, notFound, validation } from '../../common/errors';
import { assertNotNull, assertRequired, Bool, Int, MAX_TIME_MS, Name, Nested, Num, OneOf, Str } from '../../common/fields';
import { fmtHours, newId } from '../../common/format';
import { toActivity } from '../../common/mappers';
import { POSTER_CACHE, POSTER_COLUMN, posterImage, posterToStore } from '../../common/poster';
import { cleanQuestions, QuestionDto, QuestionList } from '../../common/questions';
import { HoursRule, lowersHours, raisedHours } from '../claims/rules';
import { RealtimeService, rooms } from '../realtime/realtime';

export class SupervisorDto {
  @Name() name: string;
  @Str({ max: 40 }) phone: string;
}

/** Used by POST and PATCH alike. In a PATCH, null clears a field that may be empty; see CLEARABLE. */
export class ActivityDto {
  @Str({ optional: true, min: 1, max: 200 }) title?: string;
  @OneOf(['blood', 'setup', 'bottle', 'other'], { optional: true }) categoryKey?: string;
  @Str({ optional: true, raw: true }) poster?: string;
  @Str({ optional: true, max: 10000 }) description?: string;
  @Str({ optional: true, max: 500 }) place?: string;
  @Num({ optional: true, min: -90, max: 90 }) lat?: number | null;
  @Num({ optional: true, min: -180, max: 180 }) lng?: number | null;
  @Int({ optional: true, min: 0, max: MAX_TIME_MS }) start?: number;
  @Int({ optional: true, min: 0, max: MAX_TIME_MS }) end?: number;
  @Int({ optional: true, min: 1, max: 99 }) hours?: number;
  @Int({ optional: true, min: 1, max: 999 }) itemsPerHour?: number | null;
  @Bool({ optional: true }) capLimit?: boolean;
  @Int({ optional: true, min: 0, max: 9999 }) capacity?: number;
  @Bool({ optional: true }) walkIn?: boolean;
  @OneOf(['dynamic', 'static'], { optional: true }) qrMode?: string;
  @OneOf(['on', 'off'], { optional: true }) locMode?: string;
  @Int({ optional: true, min: 1, max: 100000 }) radius?: number;
  @OneOf([10, 15], { optional: true }) qrInterval?: number;
  @Nested(SupervisorDto, { optional: true }) supervisor?: SupervisorDto;
  @Bool({ optional: true }) chatEnabled?: boolean;
  @Str({ optional: true, max: 500, matches: /^https:\/\// }) openChatUrl?: string | null;
  @Int({ optional: true, min: 0, max: MAX_TIME_MS }) opensAt?: number | null;
  @Int({ optional: true, min: 0, max: 14 }) cancelDays?: number | null;
  @Bool({ optional: true }) hidden?: boolean | null;
  @Bool({ optional: true }) hideUntilOpen?: boolean | null;
  @Str({ optional: true, max: 100 }) templateId?: string | null;
  /** The registration form: up to 10 questions. Send [] to clear; null is refused. */
  @QuestionList({ optional: true }) questions?: QuestionDto[];
  /** PATCH only, with more hours: also lift everyone who has exactly what the old rule gave. Hours set by hand stay. */
  @Bool({ optional: true }) raiseCredited?: boolean;
}

const REQUIRED = ['title', 'categoryKey', 'start', 'end', 'hours', 'capLimit', 'capacity', 'walkIn', 'qrMode', 'locMode', 'radius', 'qrInterval', 'supervisor', 'chatEnabled'] as const;
/** Fields a PATCH cannot set to null because the column has no empty state. */
const NOT_CLEARABLE = [...REQUIRED, 'poster', 'description', 'place', 'questions'] as const;

/** Every column toActivity reads, with the poster as a URL. Reading the images here would defeat the point. */
const ACTIVITY_COLUMNS = `id, title, category_key, org, org_code, description, place, lat, lng, start_at, end_at, hours, cap_limit, capacity, walk_in,
  qr_mode, loc_mode, radius, qr_interval, supervisor_name, supervisor_phone, chat_enabled, open_chat_url, opens_at, cancel_days, closed_at, submitted_at,
  recorded_at, hidden, hide_until_open, created_at, reg_count, credit_count, items_per_hour, template_id, questions, ${POSTER_COLUMN}`;

const date = (v: number | null | undefined) => (v === null || v === undefined ? null : new Date(v));

/** Column values per request field. Org and org code never come from here: they come from the token. */
const COLUMNS: Record<string, (v: any) => Record<string, unknown>> = {
  title: (v) => ({ title: v }),
  categoryKey: (v) => ({ category_key: v }),
  poster: (v) => ({ poster: v }),
  description: (v) => ({ description: v }),
  place: (v) => ({ place: v }),
  lat: (v) => ({ lat: v }),
  lng: (v) => ({ lng: v }),
  start: (v) => ({ start_at: date(v) }),
  end: (v) => ({ end_at: date(v) }),
  hours: (v) => ({ hours: v }),
  itemsPerHour: (v) => ({ items_per_hour: v }),
  capLimit: (v) => ({ cap_limit: v }),
  capacity: (v) => ({ capacity: v }),
  walkIn: (v) => ({ walk_in: v }),
  qrMode: (v) => ({ qr_mode: v }),
  locMode: (v) => ({ loc_mode: v }),
  radius: (v) => ({ radius: v }),
  qrInterval: (v) => ({ qr_interval: v }),
  supervisor: (v) => ({ supervisor_name: v.name, supervisor_phone: v.phone }),
  chatEnabled: (v) => ({ chat_enabled: v }),
  openChatUrl: (v) => ({ open_chat_url: v }),
  opensAt: (v) => ({ opens_at: date(v) }),
  cancelDays: (v) => ({ cancel_days: v }),
  hidden: (v) => ({ hidden: v }),
  hideUntilOpen: (v) => ({ hide_until_open: v }),
  templateId: (v) => ({ template_id: v }),
  questions: (v) => ({ questions: JSON.stringify(cleanQuestions(v)) }),
};

const LOWER_MESSAGE: Record<'hours' | 'itemsPerHour', string> = {
  hours: 'มีคนได้รับชั่วโมงแล้ว ลดชั่วโมงของกิจกรรมไม่ได้ ถ้าต้องการลดให้แก้ชั่วโมงรายคนในรายชื่อ',
  itemsPerHour: 'มีคนได้รับชั่วโมงแล้ว เพิ่มจำนวนขวดต่อชั่วโมงไม่ได้ ถ้าต้องการลดให้แก้ชั่วโมงรายคนในรายชื่อ',
};

function columnsOf(dto: ActivityDto): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(dto)) {
    if (value !== undefined && COLUMNS[key]) Object.assign(out, COLUMNS[key](value));
  }
  return out;
}

@Injectable()
export class ActivitiesService {
  constructor(
    private readonly db: DbService,
    private readonly realtime: RealtimeService,
  ) {}

  async list(viewer: Viewer) {
    const { rows } = await this.db.query(`SELECT ${ACTIVITY_COLUMNS} FROM activities ORDER BY start_at`);
    return rows.map((r) => toActivity(r, viewer));
  }

  async get(viewer: Viewer, id: string) {
    const row = await this.db.one(`SELECT ${ACTIVITY_COLUMNS} FROM activities WHERE id = $1`, [id]);
    if (!row) throw notFound('ไม่พบกิจกรรม');
    return toActivity(row, viewer);
  }

  async poster(id: string) {
    const row = await this.db.one('SELECT poster FROM activities WHERE id = $1', [id]);
    const image = row && posterImage(row.poster);
    if (!image) throw notFound('ไม่พบรูป');
    return image;
  }

  async create(user: SupUser, dto: ActivityDto) {
    assertRequired(dto as Record<string, unknown>, REQUIRED);
    assertNotNull(dto as Record<string, unknown>, NOT_CLEARABLE);
    if (dto.end! <= dto.start!) throw validation(['end'], 'เวลาสิ้นสุดต้องหลังเวลาเริ่ม');
    if (dto.poster) dto.poster = await posterToStore(this.db, user.orgCode, dto.poster);
    const cols = { id: newId(), org: user.orgName, org_code: user.orgCode, ...columnsOf(dto) };
    const names = Object.keys(cols);
    const row = await this.db.one(`INSERT INTO activities (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, Object.values(cols));
    this.realtime.notify([...rooms.afterActivity(row!.id), rooms.catalog]);
    return { id: row!.id as string };
  }

  async update(user: SupUser, id: string, dto: ActivityDto) {
    assertNotNull(dto as Record<string, unknown>, NOT_CLEARABLE);
    if (dto.poster) dto.poster = await posterToStore(this.db, user.orgCode, dto.poster);
    const cols = columnsOf(dto);
    const raised = await this.db.tx(async (c) => {
      const activity = await lockActivity(c, id);
      if (!activity) throw notFound('ไม่พบกิจกรรม');
      assertCanEdit(user, activity);
      const start = dto.start ?? activity.start_at.getTime();
      const end = dto.end ?? activity.end_at.getTime();
      if (end <= start) throw validation(['end'], 'เวลาสิ้นสุดต้องหลังเวลาเริ่ม');
      const names = Object.keys(cols);
      if (!names.length) return 0;

      const before: HoursRule = { category_key: activity.category_key, hours: activity.hours, items_per_hour: activity.items_per_hour };
      const after: HoursRule = {
        category_key: dto.categoryKey ?? before.category_key,
        hours: dto.hours ?? before.hours,
        items_per_hour: dto.itemsPerHour === undefined ? before.items_per_hour : dto.itemsPerHour,
      };
      // Hours people already hold are a promise to them. Giving less is a decision about each person, made in the roster.
      const lowered = lowersHours(before, after);
      if (lowered && (await c.query('SELECT 1 FROM credits WHERE activity_id = $1 AND hours > 0 LIMIT 1', [id])).rowCount) throw new ApiError(409, 'HOURS_IN_USE', LOWER_MESSAGE[lowered], [lowered]);

      await c.query(`UPDATE activities SET ${names.map((n, i) => `${n} = $${i + 2}`).join(', ')} WHERE id = $1`, [id, ...Object.values(cols)]);
      // Every credit is measured against the activity's hours as they are now.
      if (Number(after.hours) !== Number(before.hours)) await c.query('UPDATE credits SET full_hours = $2 WHERE activity_id = $1', [id, after.hours]);
      return dto.raiseCredited ? this.raiseCredited(c, { ...activity, title: dto.title ?? activity.title }, before, after, user.supName) : 0;
    });
    this.realtime.notify([...rooms.afterActivity(id), rooms.catalog, ...(raised ? [rooms.credits(id)] : [])]);
    const activity = await this.get(user, id);
    return dto.raiseCredited === undefined ? activity : { ...activity, raised };
  }

  /** Lifts everyone still at what the old rule gave to what the new one gives, and tells them. Answers how many. */
  private async raiseCredited(c: PoolClient, activity: Row, before: HoursRule, after: HoursRule, by: string): Promise<number> {
    const credits = (await c.query('SELECT student_id, hours, items FROM credits WHERE activity_id = $1', [activity.id])).rows;
    const moved = credits.flatMap((r) => {
      const hours = raisedHours(r as { hours: number; items: number | null }, before, after);
      return hours === null ? [] : [{ studentId: r.student_id as string, from: Number(r.hours), hours }];
    });
    if (!moved.length) return 0;
    await c.query(
      `UPDATE credits SET hours = t.h, edited_by = $4, edited_at = now()
       FROM unnest($2::text[], $3::float8[]) AS t(s, h) WHERE activity_id = $1 AND student_id = t.s`,
      [activity.id, moved.map((m) => m.studentId), moved.map((m) => m.hours), by],
    );
    const bottle = after.category_key === 'bottle';
    // A bottle exchange counts only people with hours (N2), so the ones who just reached their first hour now count.
    const firstHour = moved.filter((m) => m.from === 0).length;
    if (bottle && firstHour) await c.query('UPDATE activities SET credit_count = credit_count + $2 WHERE id = $1', [activity.id, firstHour]);
    // Same wording as hoursChangedNotice, written in one statement because this can be a few hundred people.
    const title = (m: { from: number; hours: number }) => (m.from === 0 ? `ได้รับ ${fmtHours(m.hours)} ชั่วโมง` : bottle ? `ได้รับรวม ${fmtHours(m.hours)} ชั่วโมง` : `แก้ชั่วโมงเป็น ${fmtHours(m.hours)} ชั่วโมง`);
    await c.query(
      `INSERT INTO notices (student_id, kind, title, body, activity_id)
       SELECT s, 'credit', t, $3, $4 FROM unnest($1::text[], $2::text[]) AS x(s, t)`,
      [moved.map((m) => m.studentId), moved.map(title), activity.title, activity.id],
    );
    return moved.length;
  }
}

@ApiTags('activities')
@Controller('activities')
export class ActivitiesController {
  constructor(private readonly activities: ActivitiesService) {}

  @Get()
  @Public()
  @ApiOperation({ summary: 'กิจกรรมทั้งหมด รวมที่ซ่อน; orgCode มีเฉพาะเมื่อส่ง token ของ admin หรือผู้ดูแลหน่วยงานนั้น' })
  list(@CurrentUser() viewer: Viewer) {
    return this.activities.list(viewer);
  }

  @Get(':id')
  @Public()
  @ApiOperation({ summary: 'กิจกรรมเดียว กฎของ orgCode เหมือน GET /activities' })
  get(@CurrentUser() viewer: Viewer, @Param('id') id: string) {
    return this.activities.get(viewer, id);
  }

  @Get(':id/poster')
  @Public()
  @ApiOperation({ summary: 'รูปโปสเตอร์ที่อัปโหลด เป็นไฟล์ JPEG; ใช้ค่า poster จากกิจกรรมเป็น URL' })
  async poster(@Param('id') id: string, @Res() res: Response) {
    // Express adds the ETag and answers 304 itself when the browser already has this image.
    res.type('jpeg').set('Cache-Control', POSTER_CACHE).send(await this.activities.poster(id));
  }

  @Post()
  @Roles('sup')
  @ApiOperation({ summary: 'สร้างกิจกรรม หน่วยงานมาจาก token' })
  create(@CurrentUser() user: SupUser, @Body() dto: ActivityDto) {
    return this.activities.create(user, dto);
  }

  @Patch(':id')
  @Roles('sup')
  @ApiOperation({ summary: 'แก้กิจกรรม ตั้งค่าเช็คชื่อ หรือซ่อน/แสดง (hidden); null คือล้างค่า; owner จนกว่าจะส่ง admin จนกว่าจะบันทึก; ลดชั่วโมงหลังมีคนได้ชั่วโมงได้ 409 HOURS_IN_USE' })
  update(@CurrentUser() user: SupUser, @Param('id') id: string, @Body() dto: ActivityDto) {
    return this.activities.update(user, id, dto);
  }
}

@Module({ controllers: [ActivitiesController], providers: [ActivitiesService] })
export class ActivitiesModule {}
