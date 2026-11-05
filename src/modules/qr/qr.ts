import { Body, Controller, HttpCode, Injectable, Module, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { assertOwner, CurrentUser, Roles, SupUser } from '../../common/auth';
import { AppConfig } from '../../common/config';
import { DbService } from '../../common/db.service';
import { notFound, rosterLocked } from '../../common/errors';
import { Num } from '../../common/fields';
import { makeDynamicToken, makeStaticToken, QR_INTERVAL_DEFAULT, QrCoords, windowOf } from './qr-token';

export class QrRequestDto {
  @Num({ optional: true, min: -90, max: 90 }) la?: number | null;
  @Num({ optional: true, min: -180, max: 180 }) lo?: number | null;
  @Num({ optional: true, min: 0 }) ac?: number | null;
}

@Injectable()
export class QrService {
  constructor(
    private readonly db: DbService,
    private readonly config: AppConfig,
  ) {}

  /** Signs a token for the QR screen. Coordinates go into the token only if this activity checks location. */
  async issue(user: SupUser, activityId: string, dto: QrRequestDto) {
    const activity = await this.db.one('SELECT id, org_code, qr_mode, loc_mode, qr_interval, submitted_at FROM activities WHERE id = $1', [activityId]);
    if (!activity) throw notFound('ไม่พบกิจกรรม');
    assertOwner(user, activity);
    if (activity.submitted_at) throw rosterLocked();

    const coords: QrCoords =
      activity.loc_mode !== 'off' && typeof dto.la === 'number' && typeof dto.lo === 'number'
        ? { la: +dto.la.toFixed(6), lo: +dto.lo.toFixed(6), ...(typeof dto.ac === 'number' && { ac: Math.round(dto.ac) }) }
        : {};
    const now = Date.now();
    const secret = this.config.qrSecret;

    if (activity.qr_mode === 'static') {
      const token = makeStaticToken(secret, activity.id, coords);
      return { token, url: this.url(token), mode: 'static', now };
    }
    const interval = activity.qr_interval > 0 ? activity.qr_interval : QR_INTERVAL_DEFAULT;
    const window = windowOf(now, interval);
    const token = makeDynamicToken(secret, activity.id, now, interval, coords);
    return { token, url: this.url(token), mode: 'dynamic', interval, window, refreshAt: (window + 1) * interval * 1000, now };
  }

  private url(token: string) {
    return `${this.config.webOrigin}/#/claim?t=${token}`;
  }
}

@ApiTags('qr')
@Controller('activities/:id/qr')
export class QrController {
  constructor(private readonly qr: QrService) {}

  @Post()
  @HttpCode(200)
  @Roles('sup')
  @ApiOperation({ summary: 'ขอ token ของ QR พร้อมพิกัดจอ; dynamic ขอใหม่เมื่อถึง refreshAt' })
  issue(@CurrentUser() user: SupUser, @Param('id') id: string, @Body() dto: QrRequestDto) {
    return this.qr.issue(user, id, dto);
  }
}

@Module({ controllers: [QrController], providers: [QrService] })
export class QrModule {}
