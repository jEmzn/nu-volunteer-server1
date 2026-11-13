import { Body, Controller, Delete, Get, HttpCode, Injectable, Module, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { PoolClient } from 'pg';
import { assertCanEdit, assertOwner, CurrentUser, isOwner, isStudent, Roles, StudentUser, SupUser, User } from '../../common/auth';
import { AppConfig } from '../../common/config';
import { ACTIVITY_RULE_COLUMNS, DbService, lockActivity, Row } from '../../common/db.service';
import { ApiError, forbidden, notFound, validation } from '../../common/errors';
import { Bool, Int, Name, Str } from '../../common/fields';
import { fmtHours } from '../../common/format';
import { toCredit, toCreditForPeer, toRegistration } from '../../common/mappers';
import { hoursChangedNotice, writeCredit } from '../claims/credit-writer';
import { bottleHours } from '../claims/rules';
import { RealtimeService, rooms } from '../realtime/realtime';
import { countStrikes, listStrikes, STRIKE_LIMIT } from './strikes';

const STUDENT_ID = /^\d{8}$/;

/**
 * Stricter than spec 8.4, agreed with the project owner: the screen hides these cases, but only the server can stop
 * someone taking a limited seat before the opening time. Same comparisons as the web's phase() and notOpenYet().
 */
function assertOpenForRegistration(activity: Row) {
  const now = Date.now();
  if (activity.hidden) throw new ApiError(409, 'REG_HIDDEN', 'กิจกรรมนี้ถูกซ่อนอยู่ ลงทะเบียนไม่ได้');
  if (now > (activity.end_at as Date).getTime()) throw new ApiError(409, 'REG_ENDED', 'กิจกรรมนี้จบแล้ว ลงทะเบียนไม่ได้');
  if (activity.opens_at && now < (activity.opens_at as Date).getTime()) throw new ApiError(409, 'REG_NOT_OPEN', 'ยังไม่ถึงเวลาเปิดรับสมัคร');
}

export class AddCreditDto {
  @Str({ matches: STUDENT_ID }) studentId: string;
  /** Needed only if this student is not in the system yet. A known id keeps the stored name. */
  @Name({ optional: true, allowEmpty: true }) name?: string | null;
  /** 0 up to the activity's hours. Missing means full hours. */
  @Int({ optional: true, min: 0, max: 99 }) hours?: number | null;
  /** Required when the hours are below full. */
  @Str({ optional: true, max: 500 }) reason?: string | null;
}

export class WaiveDto {
  @Bool() waived: boolean;
}

export class SetHoursDto {
  @Int({ min: 0, max: 99 }) hours: number;
  /** Required when the hours are below full. */
  @Str({ optional: true, max: 500 }) reason?: string | null;
}

export class AddBottlesDto {
  @Str({ matches: STUDENT_ID }) studentId: string;
  @Name({ optional: true, allowEmpty: true }) name?: string | null;
  @Int({ min: 1, max: 100000 }) add: number;
}

const NO_ACTIVITY = 'ไม่พบกิจกรรม';

@Injectable()
export class RosterService {
  constructor(
    private readonly db: DbService,
    private readonly realtime: RealtimeService,
    private readonly config: AppConfig,
  ) {}

  private async readActivity(id: string): Promise<Row> {
    const activity = await this.db.one(`SELECT ${ACTIVITY_RULE_COLUMNS} FROM activities WHERE id = $1`, [id]);
    if (!activity) throw notFound(NO_ACTIVITY);
    return activity;
  }

  // Registration ----------------------------------------------------------------------------------

  async register(user: StudentUser, activityId: string) {
    const result = await this.db.tx(async (c) => {
      const activity = await lockActivity(c, activityId);
      if (!activity) throw notFound(NO_ACTIVITY);
      const reg = await c.query('SELECT cancelled_at, late FROM registrations WHERE activity_id = $1 AND student_id = $2', [activityId, user.sub]);
      if (reg.rows[0] && !reg.rows[0].cancelled_at) return 'already' as const;
      assertOpenForRegistration(activity);
      if (reg.rows[0]?.late) throw new ApiError(409, 'REG_LATE_CANCELLED', 'ยกเลิกหลังกำหนดไปแล้ว ลงทะเบียนกิจกรรมนี้ซ้ำไม่ได้');
      if ((await countStrikes(c, user.sub, this.config.tzDisplay)) >= STRIKE_LIMIT) throw new ApiError(409, 'REG_NO_CREDITS', 'สิทธิ์ยกเลิกหมดแล้ว ลงทะเบียนกิจกรรมใหม่ได้ในภาคหน้า');
      if (activity.cap_limit && activity.reg_count >= activity.capacity) return 'full' as const;
      await c.query(
        `INSERT INTO registrations (activity_id, student_id, name) VALUES ($1, $2, $3)
         ON CONFLICT (activity_id, student_id) DO UPDATE SET name = excluded.name, at = now(), cancelled_at = null, walk_in = false`,
        [activityId, user.sub, user.name],
      );
      await c.query('UPDATE activities SET reg_count = reg_count + 1 WHERE id = $1', [activityId]);
      await c.query(`INSERT INTO notices (student_id, kind, title, body, activity_id) VALUES ($1, 'registered', 'ลงทะเบียนสำเร็จ', $2, $3)`, [user.sub, activity.title, activityId]);
      return 'ok' as const;
    });
    if (result === 'ok') this.realtime.notify(rooms.afterRegistration(activityId));
    return { result };
  }

  /**
   * The centre admin gives a lost credit back, or takes the decision back. Only for a credit lost this semester, so a
   * live registration cannot be waived ahead of a no-show. Not held by the roster lock: lost credits come after the end.
   */
  async setWaived(activityId: string, studentId: string, waived: boolean) {
    const row = await this.db.tx(async (c) => {
      if (!(await lockActivity(c, activityId))) throw notFound(NO_ACTIVITY);
      const { strikes } = await listStrikes(c, studentId, this.config.tzDisplay);
      if (!strikes.some((s) => s.activity_id === activityId)) {
        const reg = await c.query('SELECT 1 FROM registrations WHERE activity_id = $1 AND student_id = $2', [activityId, studentId]);
        if (!reg.rowCount) throw notFound('ไม่พบการลงทะเบียน');
        throw new ApiError(409, 'NOT_A_STRIKE', 'การลงทะเบียนนี้ไม่ได้ถูกหักสิทธิ์ในภาคนี้');
      }
      return (await c.query('UPDATE registrations SET waived = $3 WHERE activity_id = $1 AND student_id = $2 RETURNING *', [activityId, studentId, waived])).rows[0];
    });
    this.realtime.notify(rooms.afterRegistration(activityId));
    return toRegistration(row);
  }

  /** The server decides whether this cancel is late, in the same transaction, so a client cannot avoid the penalty. */
  async cancel(user: StudentUser, activityId: string) {
    const late = await this.db.tx(async (c) => {
      const activity = await lockActivity(c, activityId);
      if (!activity) throw notFound(NO_ACTIVITY);
      const updated = await c.query(
        `UPDATE registrations SET cancelled_at = now(), late = now() > $3::timestamptz - make_interval(days => $4)
         WHERE activity_id = $1 AND student_id = $2 AND cancelled_at IS NULL RETURNING late, walk_in`,
        [activityId, user.sub, activity.start_at, activity.cancel_days ?? 2],
      );
      if (!updated.rows[0]) throw notFound('ไม่พบการลงทะเบียน');
      if (!updated.rows[0].walk_in) await c.query('UPDATE activities SET reg_count = GREATEST(0, reg_count - 1) WHERE id = $1', [activityId]);
      return updated.rows[0].late as boolean;
    });
    this.realtime.notify(rooms.afterRegistration(activityId));
    return { late };
  }

  async registrations(user: SupUser, activityId: string) {
    assertOwner(user, await this.readActivity(activityId));
    const { rows } = await this.db.query('SELECT * FROM registrations WHERE activity_id = $1 ORDER BY at DESC', [activityId]);
    return rows.map(toRegistration);
  }

  async registration(user: User, activityId: string, studentId: string) {
    await this.assertSelfOrOwner(user, activityId, studentId);
    const row = await this.db.one('SELECT * FROM registrations WHERE activity_id = $1 AND student_id = $2', [activityId, studentId]);
    if (!row) throw notFound('ไม่พบการลงทะเบียน');
    return toRegistration(row);
  }

  /** Deletes the registration and its credit, if any. A cancelled registration was already out of reg_count, and a walk-in was never in it. */
  async removeRegistration(user: SupUser, activityId: string, studentId: string) {
    await this.db.tx(async (c) => {
      const activity = await lockActivity(c, activityId);
      if (!activity) throw notFound(NO_ACTIVITY);
      assertCanEdit(user, activity);
      const reg = await c.query('DELETE FROM registrations WHERE activity_id = $1 AND student_id = $2 RETURNING cancelled_at, walk_in', [activityId, studentId]);
      if (reg.rows[0] && !reg.rows[0].cancelled_at && !reg.rows[0].walk_in) await c.query('UPDATE activities SET reg_count = GREATEST(0, reg_count - 1) WHERE id = $1', [activityId]);
      await this.deleteCredit(c, activityId, studentId);
    });
    this.realtime.notify(rooms.afterCredit(activityId));
    return { ok: true };
  }

  // Credits ---------------------------------------------------------------------------------------

  /** Students may read the sign-in sheet, without other people's device and position. Supervisors only their own activities. */
  async credits(user: User, activityId: string, order: string | undefined) {
    const activity = await this.readActivity(activityId);
    if (!isStudent(user)) assertOwner(user, activity);
    const { rows } = await this.db.query(`SELECT * FROM credits WHERE activity_id = $1 ORDER BY at ${order === 'desc' ? 'DESC' : 'ASC'}`, [activityId]);
    return rows.map((r) => (isStudent(user) && r.student_id !== user.sub ? toCreditForPeer(r) : toCredit(r)));
  }

  async credit(user: User, activityId: string, studentId: string) {
    await this.assertSelfOrOwner(user, activityId, studentId);
    const row = await this.db.one('SELECT * FROM credits WHERE activity_id = $1 AND student_id = $2', [activityId, studentId]);
    if (!row) throw notFound('ไม่พบชั่วโมง');
    return toCredit(row);
  }

  /** Someone who cannot scan. Skips QR, location and the registration check. */
  async addCredit(user: SupUser, activityId: string, dto: AddCreditDto) {
    const result = await this.db.tx(async (c) => {
      const activity = await lockActivity(c, activityId);
      if (!activity) throw notFound(NO_ACTIVITY);
      assertCanEdit(user, activity);
      const full = Number(activity.hours);
      const hours = dto.hours ?? full;
      if (hours > full) throw validation(['hours'], 'ชั่วโมงเกินของกิจกรรม');
      if (hours < full && !dto.reason) throw validation(['reason'], 'ต้องระบุเหตุผล');
      const name = await this.ensureStudent(c, dto.studentId, dto.name);
      return writeCredit(c, activity, { studentId: dto.studentId, name, hours, method: 'manual', at: Date.now(), editedBy: user.supName, reason: dto.reason || undefined });
    });
    if (!result.ok) return { ok: false, reason: 'already', credit: toCredit(result.row) };
    this.realtime.notify(rooms.afterCredit(activityId));
    return { ok: true, credit: toCredit(result.row) };
  }

  async setHours(user: SupUser, activityId: string, studentId: string, dto: SetHoursDto) {
    const row = await this.db.tx(async (c) => {
      const activity = await lockActivity(c, activityId);
      if (!activity) throw notFound(NO_ACTIVITY);
      assertCanEdit(user, activity);
      const current = (await c.query('SELECT hours, full_hours FROM credits WHERE activity_id = $1 AND student_id = $2', [activityId, studentId])).rows[0];
      if (!current) throw notFound('ไม่พบชั่วโมง');
      const full = Number(current.full_hours);
      if (dto.hours > full) throw validation(['hours'], 'ชั่วโมงเกินของกิจกรรม');
      // The screen sends no reason when giving back full hours; anything less must say why.
      if (dto.hours < full && !dto.reason) throw validation(['reason'], 'ต้องระบุเหตุผล');
      const updated = await c.query(`UPDATE credits SET hours = $3, reason = $4, edited_by = $5, edited_at = now() WHERE activity_id = $1 AND student_id = $2 RETURNING *`, [
        activityId,
        studentId,
        dto.hours,
        dto.reason || null,
        user.supName,
      ]);
      await hoursChangedNotice(c, activity, studentId, Number(current.hours), dto.hours);
      return updated.rows[0];
    });
    this.realtime.notify([rooms.credits(activityId)]);
    return toCredit(row);
  }

  async removeCredit(user: SupUser, activityId: string, studentId: string) {
    await this.db.tx(async (c) => {
      const activity = await lockActivity(c, activityId);
      if (!activity) throw notFound(NO_ACTIVITY);
      assertCanEdit(user, activity);
      await this.deleteCredit(c, activityId, studentId);
    });
    this.realtime.notify([rooms.credits(activityId), ...rooms.afterActivity(activityId)]);
    return { ok: true };
  }

  /** One call adds bottles and works the hours out again from the new total. */
  async addBottles(user: SupUser, activityId: string, dto: AddBottlesDto) {
    const row = await this.db.tx(async (c) => {
      const activity = await lockActivity(c, activityId);
      if (!activity) throw notFound(NO_ACTIVITY);
      assertCanEdit(user, activity);
      if (activity.category_key !== 'bottle' || !(activity.items_per_hour > 0)) throw new ApiError(409, 'NOT_BOTTLE', 'กิจกรรมนี้ไม่ได้แลกขวด');
      const current = (await c.query('SELECT hours, items FROM credits WHERE activity_id = $1 AND student_id = $2', [activityId, dto.studentId])).rows[0];
      const items = (current?.items ?? 0) + dto.add;
      const hours = bottleHours(items, activity.items_per_hour, Number(activity.hours));
      if (!current) {
        const name = await this.ensureStudent(c, dto.studentId, dto.name);
        return (await writeCredit(c, activity, { studentId: dto.studentId, name, hours, method: 'manual', at: Date.now(), editedBy: user.supName, items })).row;
      }
      const updated = await c.query(`UPDATE credits SET hours = $3, items = $4, edited_by = $5, edited_at = now() WHERE activity_id = $1 AND student_id = $2 RETURNING *`, [
        activityId,
        dto.studentId,
        hours,
        items,
        user.supName,
      ]);
      // The first save may have been below one hour, so this can be when the student first hears about it.
      await hoursChangedNotice(c, activity, dto.studentId, Number(current.hours), hours);
      return updated.rows[0];
    });
    this.realtime.notify(rooms.afterCredit(activityId));
    return { items: row.items as number, hours: Number(row.hours), credit: toCredit(row) };
  }

  // Roster lifecycle ------------------------------------------------------------------------------

  async close(user: SupUser, activityId: string) {
    assertOwner(user, await this.readActivity(activityId));
    const { rowCount } = await this.db.query('UPDATE activities SET closed_at = now() WHERE id = $1 AND closed_at IS NULL', [activityId]);
    if (rowCount) this.realtime.notify(rooms.afterActivity(activityId));
    return { changed: !!rowCount };
  }

  async submit(user: SupUser, activityId: string) {
    assertOwner(user, await this.readActivity(activityId));
    const { rowCount } = await this.db.query('UPDATE activities SET submitted_at = now(), closed_at = COALESCE(closed_at, now()) WHERE id = $1 AND submitted_at IS NULL', [activityId]);
    if (rowCount) this.realtime.notify(rooms.afterActivity(activityId));
    return { changed: !!rowCount };
  }

  /** Tells each student who earned hours, in the same transaction. A second tap does nothing. */
  async record(activityId: string) {
    const changed = await this.db.tx(async (c) => {
      const activity = await lockActivity(c, activityId);
      if (!activity) throw notFound(NO_ACTIVITY);
      if (activity.recorded_at) return false;
      if (!activity.submitted_at) throw new ApiError(409, 'NOT_SUBMITTED', 'ยังไม่ได้ส่งรายชื่อ');
      await c.query('UPDATE activities SET recorded_at = now() WHERE id = $1', [activityId]);
      const credits = (await c.query('SELECT student_id, hours FROM credits WHERE activity_id = $1 AND hours > 0', [activityId])).rows;
      if (credits.length) {
        await c.query(
          `INSERT INTO notices (student_id, kind, title, body, activity_id)
           SELECT s, 'recorded', 'บันทึกชั่วโมงลงระบบแล้ว', b, $3 FROM unnest($1::text[], $2::text[]) AS t(s, b)`,
          [credits.map((r) => r.student_id), credits.map((r) => `${activity.title} ${fmtHours(Number(r.hours))} ชั่วโมง`), activityId],
        );
      }
      return true;
    });
    if (changed) this.realtime.notify(rooms.afterActivity(activityId));
    return { changed };
  }

  // Helpers ---------------------------------------------------------------------------------------

  private async assertSelfOrOwner(user: User, activityId: string, studentId: string) {
    if (isStudent(user) && user.sub === studentId) return;
    const activity = await this.readActivity(activityId);
    if (!isOwner(user, activity)) throw forbidden();
  }

  private async deleteCredit(c: PoolClient, activityId: string, studentId: string) {
    const removed = await c.query('DELETE FROM credits WHERE activity_id = $1 AND student_id = $2', [activityId, studentId]);
    if (removed.rowCount) await c.query('UPDATE activities SET credit_count = GREATEST(0, credit_count - 1) WHERE id = $1', [activityId]);
  }

  /** A supervisor can add someone who never opened the app. A known id always keeps the stored name. */
  private async ensureStudent(c: PoolClient, studentId: string, name: string | null | undefined): Promise<string> {
    const known = (await c.query('SELECT name FROM students WHERE id = $1', [studentId])).rows[0];
    if (known) return known.name;
    if (!name) throw validation(['name'], 'ต้องระบุชื่อของนิสิตใหม่');
    await c.query('INSERT INTO students (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [studentId, name]);
    return name;
  }
}

@ApiTags('roster')
@Controller('activities/:id')
export class RosterController {
  constructor(private readonly roster: RosterService) {}

  @Post('registrations')
  @HttpCode(200)
  @Roles('student')
  @ApiOperation({ summary: 'ลงทะเบียน คืน result: ok, full หรือ already; 409 ถ้ากิจกรรมถูกซ่อน จบแล้ว ยังไม่เปิดรับ เคยยกเลิกช้า หรือสิทธิ์หมด' })
  register(@CurrentUser() user: StudentUser, @Param('id') id: string) {
    return this.roster.register(user, id);
  }

  @Delete('registrations/me')
  @Roles('student')
  @ApiOperation({ summary: 'ยกเลิกการลงทะเบียน server ตัดสิน late' })
  cancel(@CurrentUser() user: StudentUser, @Param('id') id: string) {
    return this.roster.cancel(user, id);
  }

  @Get('registrations')
  @Roles('sup')
  @ApiOperation({ summary: 'รายชื่อลงทะเบียน ใหม่สุดก่อน' })
  registrations(@CurrentUser() user: SupUser, @Param('id') id: string) {
    return this.roster.registrations(user, id);
  }

  @Get('registrations/:studentId')
  @Roles('student', 'sup')
  @ApiOperation({ summary: 'การลงทะเบียนรายคน: ตัวเอง หรือ owner/admin' })
  registration(@CurrentUser() user: User, @Param('id') id: string, @Param('studentId') studentId: string) {
    return this.roster.registration(user, id, studentId);
  }

  @Patch('registrations/:studentId')
  @Roles('admin')
  @ApiOperation({ summary: 'admin คืนสิทธิ์ยกเลิก (waived: true) หรือยกเลิกการคืน; ใช้ได้กับการลงทะเบียนที่ถูกหักสิทธิ์ในภาคนี้เท่านั้น' })
  setWaived(@Param('id') id: string, @Param('studentId') studentId: string, @Body() dto: WaiveDto) {
    return this.roster.setWaived(id, studentId, dto.waived);
  }

  @Delete('registrations/:studentId')
  @Roles('sup')
  @ApiOperation({ summary: 'ลบออกจากรายชื่อพร้อมชั่วโมง' })
  removeRegistration(@CurrentUser() user: SupUser, @Param('id') id: string, @Param('studentId') studentId: string) {
    return this.roster.removeRegistration(user, id, studentId);
  }

  @Get('credits')
  @Roles('student', 'sup')
  @ApiQuery({ name: 'order', required: false, enum: ['asc', 'desc'] })
  @ApiOperation({ summary: 'ผู้ได้ชั่วโมง ค่าเริ่มต้นเก่าสุดก่อน; นิสิตไม่เห็น deviceId, distance, accuracy ของคนอื่น' })
  credits(@CurrentUser() user: User, @Param('id') id: string, @Query('order') order?: string) {
    return this.roster.credits(user, id, order);
  }

  @Post('credits')
  @HttpCode(200)
  @Roles('sup')
  @ApiOperation({ summary: 'เพิ่มคนเอง (manual) สร้างนิสิตใหม่และลงทะเบียน walk-in ให้ถ้ายังไม่มี' })
  addCredit(@CurrentUser() user: SupUser, @Param('id') id: string, @Body() dto: AddCreditDto) {
    return this.roster.addCredit(user, id, dto);
  }

  @Get('credits/:studentId')
  @Roles('student', 'sup')
  @ApiOperation({ summary: 'ชั่วโมงรายคน: ตัวเอง หรือ owner/admin' })
  credit(@CurrentUser() user: User, @Param('id') id: string, @Param('studentId') studentId: string) {
    return this.roster.credit(user, id, studentId);
  }

  @Patch('credits/:studentId')
  @Roles('sup')
  @ApiOperation({ summary: 'แก้ชั่วโมงรายคน ต้องมีเหตุผลเมื่อต่ำกว่าชั่วโมงเต็ม' })
  setHours(@CurrentUser() user: SupUser, @Param('id') id: string, @Param('studentId') studentId: string, @Body() dto: SetHoursDto) {
    return this.roster.setHours(user, id, studentId, dto);
  }

  @Delete('credits/:studentId')
  @Roles('sup')
  @ApiOperation({ summary: 'ลบชั่วโมง' })
  removeCredit(@CurrentUser() user: SupUser, @Param('id') id: string, @Param('studentId') studentId: string) {
    return this.roster.removeCredit(user, id, studentId);
  }

  @Post('bottles')
  @HttpCode(200)
  @Roles('sup')
  @ApiOperation({ summary: 'เพิ่มขวดและคำนวณชั่วโมงใหม่ในคำสั่งเดียว' })
  addBottles(@CurrentUser() user: SupUser, @Param('id') id: string, @Body() dto: AddBottlesDto) {
    return this.roster.addBottles(user, id, dto);
  }

  @Post('close')
  @HttpCode(200)
  @Roles('sup')
  @ApiOperation({ summary: 'ปิดรายชื่อ' })
  close(@CurrentUser() user: SupUser, @Param('id') id: string) {
    return this.roster.close(user, id);
  }

  @Post('submit')
  @HttpCode(200)
  @Roles('sup')
  @ApiOperation({ summary: 'ส่งรายชื่อให้ศูนย์ ตั้งครั้งเดียว' })
  submit(@CurrentUser() user: SupUser, @Param('id') id: string) {
    return this.roster.submit(user, id);
  }

  @Post('record')
  @HttpCode(200)
  @Roles('admin')
  @ApiOperation({ summary: 'บันทึกลงระบบ ต้องส่งแล้ว กดซ้ำไม่เกิดอะไร' })
  record(@Param('id') id: string) {
    return this.roster.record(id);
  }
}

@Module({ controllers: [RosterController], providers: [RosterService] })
export class RosterModule {}
