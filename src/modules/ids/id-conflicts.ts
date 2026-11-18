import { Body, Controller, Get, HttpCode, Injectable, Module, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/auth';
import { DbService } from '../../common/db.service';
import { ApiError, notFound, validation } from '../../common/errors';
import { Bool, Str } from '../../common/fields';
import { RealtimeService, rooms } from '../realtime/realtime';
import { accountsOf, baseOf, isTwin, moveAccount, nextTwinId, REVIEW_KEY, sameName } from './ids';

const BASE_ID = /^\d{8}$/;

export class ResolveDto {
  /** The account whose name is the id's real owner, after the admin checked the student card. */
  @Str({ matches: /^\d{8}(#\d+)?$/ }) ownerId: string;
  /** The right id of the other person, when known. Only when the id has one other account. */
  @Str({ optional: true, matches: BASE_ID }) correctId?: string | null;
  /** The names are one person spelt two ways: every account becomes the owner's. */
  @Bool({ optional: true }) merge?: boolean;
}

@Injectable()
export class IdConflictsService {
  constructor(
    private readonly db: DbService,
    private readonly realtime: RealtimeService,
  ) {}

  /** Every id with a twin nobody has checked yet, newest first, with what each account holds. */
  async list() {
    const { rows } = await this.db.query(
      `SELECT split_part(id, '#', 1) AS base, max(created_at) AS found_at FROM students
       WHERE strpos(id, '#') > 0 AND NOT notify ? '${REVIEW_KEY}' GROUP BY 1 ORDER BY 2 DESC`,
    );
    return Promise.all(
      rows.map(async (r) => ({ id: r.base as string, foundAt: (r.found_at as Date).getTime(), accounts: await this.accounts(r.base) })),
    );
  }

  private async accounts(base: string) {
    const accounts = await accountsOf(this.db, base);
    const { rows } = await this.db.query(
      `SELECT student_id, count(*) FILTER (WHERE hours > 0)::int AS activities, COALESCE(sum(hours), 0)::float AS hours,
         count(DISTINCT device_id)::int AS devices
       FROM credits WHERE student_id = ANY($1::text[]) GROUP BY student_id`,
      [accounts.map((a) => a.id)],
    );
    const by = new Map(rows.map((r) => [r.student_id, r]));
    return accounts.map((a) => ({
      accountId: a.id as string,
      name: a.name as string,
      since: (a.created_at as Date).getTime(),
      activities: by.get(a.id)?.activities ?? 0,
      hours: by.get(a.id)?.hours ?? 0,
      devices: by.get(a.id)?.devices ?? 0,
      waiting: !!a.notify?.[REVIEW_KEY] || undefined,
    }));
  }

  /**
   * The admin names the owner. The owner ends up on the plain id. Each other account goes to the right id when given,
   * joins the owner when they are one person, or else stays a twin flagged "รอรหัสที่ถูก". All in one transaction, so
   * nobody is ever half moved. A device holding an account that moved is refused by the guard and signs in again.
   */
  async resolve(base: string, dto: ResolveDto) {
    if (!BASE_ID.test(base)) throw notFound('ไม่พบรหัสนี้');
    if (baseOf(dto.ownerId) !== base) throw validation(['ownerId']);
    if (dto.correctId && dto.merge) throw validation(['correctId']);
    if (dto.correctId === base) throw validation(['correctId'], 'รหัสที่ถูกต้องไม่ใช่รหัสเดิม');

    const touched = await this.db.tx(async (c) => {
      const accounts = await accountsOf(c, base, true);
      const owner = accounts.find((a) => a.id === dto.ownerId);
      if (!owner || accounts.length < 2) throw notFound('ไม่พบรหัสซ้อนนี้');
      const others = accounts.filter((a) => a.id !== owner.id);
      if (dto.correctId && others.length !== 1) throw validation(['correctId'], 'รหัสนี้มีผู้ใช้มากกว่า 2 ชื่อ');
      const out = new Set<string>();
      const add = (ids: string[]) => ids.forEach((i) => out.add(i));

      if (dto.merge) {
        for (const o of others) add(await moveAccount(c, o.id, owner.id));
        add(await moveAccount(c, owner.id, base));
        // One person, one spelling: the one the admin picked.
        await c.query('UPDATE credits SET name = $2 WHERE student_id = $1', [base, owner.name]);
        await c.query('UPDATE registrations SET name = $2 WHERE student_id = $1', [base, owner.name]);
        await c.query('UPDATE students SET name = $2 WHERE id = $1', [base, owner.name]);
      } else {
        for (const o of others) {
          if (dto.correctId) {
            const there = (await c.query('SELECT name FROM students WHERE id = $1 FOR UPDATE', [dto.correctId])).rows[0];
            if (there && !sameName(there.name, o.name)) throw new ApiError(409, 'ID_TAKEN', `รหัส ${dto.correctId} มีนิสิตชื่ออื่นใช้อยู่แล้ว`);
            add(await moveAccount(c, o.id, dto.correctId));
          } else {
            // Kept as a twin until the right id is known. The plain id must go to the owner, so it moves to a new number.
            const id = isTwin(o.id) ? o.id : await nextTwinId(c, base);
            add(await moveAccount(c, o.id, id));
            await c.query(`UPDATE students SET notify = notify || jsonb_build_object('${REVIEW_KEY}', $2::bigint) WHERE id = $1`, [id, Date.now()]);
          }
        }
        add(await moveAccount(c, owner.id, base));
      }
      await c.query(`UPDATE students SET notify = notify - '${REVIEW_KEY}' WHERE id = $1`, [base]);
      return [...out];
    });
    for (const id of touched) this.realtime.notify(rooms.afterCredit(id));
    return { ok: true, accounts: await this.accounts(base) };
  }
}

@ApiTags('id-conflicts')
@Controller('id-conflicts')
export class IdConflictsController {
  constructor(private readonly ids: IdConflictsService) {}

  @Get()
  @Roles('admin')
  @ApiOperation({ summary: 'รหัสซ้อนรอตรวจ (admin): รหัส วันที่เจอ และแต่ละบัญชี ชื่อ กิจกรรม ชั่วโมง วันที่เริ่มใช้ จำนวนเครื่อง' })
  list() {
    return this.ids.list();
  }

  @Post(':id/resolve')
  @HttpCode(200)
  @Roles('admin')
  @ApiOperation({ summary: 'admin แก้รหัสซ้อน: เลือกเจ้าของ ใส่รหัสที่ถูกของอีกคนถ้ารู้ หรือ merge เมื่อเป็นคนเดียวกัน ย้ายทุกตารางใน transaction เดียว' })
  resolve(@Param('id') id: string, @Body() dto: ResolveDto) {
    return this.ids.resolve(id, dto);
  }
}

@Module({ controllers: [IdConflictsController], providers: [IdConflictsService] })
export class IdConflictsModule {}
