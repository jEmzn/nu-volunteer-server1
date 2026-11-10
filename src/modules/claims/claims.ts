import { Body, Controller, HttpCode, Injectable, Module, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser, Roles, StudentUser } from '../../common/auth';
import { AppConfig } from '../../common/config';
import { ACTIVITY_RULE_COLUMNS, DbService, lockActivity, Row } from '../../common/db.service';
import { ApiError, rosterLocked } from '../../common/errors';
import { Bool, MAX_TIME_MS, Num, Str } from '../../common/fields';
import { toCredit } from '../../common/mappers';
import { CLAIMS_LIMIT } from '../../common/rate-limit';
import { checkTime, matchesMode, parseToken } from '../qr/qr-token';
import { RealtimeService, rooms } from '../realtime/realtime';
import { writeCredit } from './credit-writer';
import { acceptScannedAt, judgeLocation } from './rules';

export class ClaimDto {
  @Str({ max: 2000, raw: true }) token: string;
  @Num({ optional: true, min: -90, max: 90 }) lat?: number | null;
  @Num({ optional: true, min: -180, max: 180 }) lng?: number | null;
  @Num({ optional: true, min: 0 }) accuracy?: number | null;
  @Str({ optional: true, max: 100 }) deviceId?: string | null;
  /** Server-time ms when the claim link was opened (or a kept offline scan). Not always whole: the web's clock offset can be fractional. */
  @Num({ optional: true, min: 0, max: MAX_TIME_MS }) scannedAt?: number | null;
  /** The phone kept this scan while it was offline and is sending it now. */
  @Bool({ optional: true }) offline?: boolean | null;
}

const invalid = () => new ApiError(400, 'QR_INVALID', 'QR นี้ใช้รับชั่วโมงไม่ได้');
const TIME_MESSAGE = { QR_EXPIRED: 'QR หมดอายุ', QR_EARLY: 'ยังไม่ถึงเวลารับชั่วโมง', QR_LATE: 'หมดเวลารับชั่วโมงแล้ว' };

/**
 * The web sends the moment the claim link was opened with every claim, so a student filling in the form keeps a fresh
 * QR. A scan is flagged as sent afterwards when the phone says it kept it offline, or when it arrives later than this.
 */
const OFFLINE_FLAG_MS = 3 * 60_000;

const times = (a: Row) => ({ start: (a.start_at as Date).getTime(), end: (a.end_at as Date).getTime() });

@Injectable()
export class ClaimsService {
  constructor(
    private readonly db: DbService,
    private readonly config: AppConfig,
    private readonly realtime: RealtimeService,
  ) {}

  /** Checks in spec 8.2 order. The token is checked before taking the lock, so bad QR codes never join the queue. */
  async claim(user: StudentUser, dto: ClaimDto) {
    const now = Date.now();
    const parsed = parseToken(this.config.qrSecret, dto.token);
    if (!parsed) throw invalid();
    const { payload, ref } = parsed;

    const seen = await this.db.one<any>(`SELECT ${ACTIVITY_RULE_COLUMNS} FROM activities WHERE id = $1`, [payload.a]);
    if (!seen || !matchesMode(payload, seen.qr_mode)) throw invalid();
    const scannedAt = acceptScannedAt(dto.scannedAt, now, times(seen));
    const timeError = checkTime(payload, scannedAt ?? now, times(seen));
    if (timeError) throw new ApiError(400, timeError, TIME_MESSAGE[timeError]);

    const result = await this.db.tx(async (c) => {
      const activity = await lockActivity(c, payload.a);
      if (!activity) throw invalid();

      const existing = await c.query('SELECT * FROM credits WHERE activity_id = $1 AND student_id = $2', [activity.id, user.sub]);
      if (existing.rows[0]) return { ok: false as const, row: existing.rows[0] };

      // A credit arriving now would land in a list the centre is already reviewing.
      if (activity.submitted_at) throw rosterLocked();

      if (!activity.walk_in) {
        const reg = await c.query('SELECT cancelled_at FROM registrations WHERE activity_id = $1 AND student_id = $2', [activity.id, user.sub]);
        if (!reg.rows[0] || reg.rows[0].cancelled_at) throw new ApiError(403, 'NOT_REGISTERED', 'ไม่ได้ลงทะเบียนกิจกรรมนี้');
      }

      const location = judgeLocation({ loc_mode: activity.loc_mode, radius: activity.radius }, payload, dto);
      const at = acceptScannedAt(dto.scannedAt, now, times(activity));
      return writeCredit(c, activity, {
        studentId: user.sub,
        name: user.name,
        hours: Number(activity.hours),
        method: 'qr',
        at: at ?? now,
        flags: at !== null && (dto.offline === true || now - at > OFFLINE_FLAG_MS) ? [...location.flags, 'offline'] : location.flags,
        distance: location.distance,
        accuracy: location.accuracy,
        deviceId: dto.deviceId || undefined,
        ref,
      });
    });

    if (!result.ok) return { ok: false, reason: 'already', credit: toCredit(result.row) };
    this.realtime.notify(rooms.afterCredit(payload.a));
    return { ok: true, credit: toCredit(result.row) };
  }
}

@ApiTags('claims')
@Controller('claims')
export class ClaimsController {
  constructor(private readonly claims: ClaimsService) {}

  @Post()
  @HttpCode(200)
  @Roles('student')
  @Throttle(CLAIMS_LIMIT)
  @ApiOperation({ summary: 'เช็คชื่อด้วย QR: ส่ง token และพิกัดดิบ server ตรวจและติด flag เอง' })
  claim(@CurrentUser() user: StudentUser, @Body() dto: ClaimDto) {
    return this.claims.claim(user, dto);
  }
}

@Module({ controllers: [ClaimsController], providers: [ClaimsService] })
export class ClaimsModule {}
