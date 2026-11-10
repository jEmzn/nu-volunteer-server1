import { Body, Controller, HttpCode, Injectable, Module, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { assertOwner, CurrentUser, Roles, SupUser } from '../../common/auth';
import { AppConfig } from '../../common/config';
import { DbService, Row } from '../../common/db.service';
import { notFound, rosterLocked } from '../../common/errors';
import { Num } from '../../common/fields';
import { makeDynamicToken, makeStaticToken, QR_INTERVAL_DEFAULT, QR_PREFETCH_S, QrCoords, windowOf } from './qr-token';

export class QrRequestDto {
  @Num({ optional: true, min: -90, max: 90 }) la?: number | null;
  @Num({ optional: true, min: -180, max: 180 }) lo?: number | null;
  @Num({ optional: true, min: 0 }) ac?: number | null;
}

/**
 * Where the token says the activity is. A static QR is usually printed away from the venue, so the place saved on the
 * activity comes first; a dynamic one is on a screen at the venue, so the screen's fix comes first.
 */
function pickCoords(activity: Row, dto: QrRequestDto): QrCoords {
  const screen: QrCoords | null =
    typeof dto.la === 'number' && typeof dto.lo === 'number'
      ? { la: +dto.la.toFixed(6), lo: +dto.lo.toFixed(6), ...(typeof dto.ac === 'number' && { ac: Math.round(dto.ac) }) }
      : null;
  const saved: QrCoords | null = typeof activity.lat === 'number' && typeof activity.lng === 'number' ? { la: +activity.lat.toFixed(6), lo: +activity.lng.toFixed(6) } : null;
  return (activity.qr_mode === 'static' ? (saved ?? screen) : (screen ?? saved)) ?? {};
}

@Injectable()
export class QrService {
  constructor(
    private readonly db: DbService,
    private readonly config: AppConfig,
  ) {}

  /**
   * Signs a token for the QR screen. Coordinates go into the token only if this activity checks location. A dynamic
   * screen also gets the tokens of the next QR_PREFETCH_S seconds, each valid only once its own window comes.
   */
  async issue(user: SupUser, activityId: string, dto: QrRequestDto) {
    const activity = await this.db.one('SELECT id, org_code, qr_mode, loc_mode, qr_interval, lat, lng, submitted_at FROM activities WHERE id = $1', [activityId]);
    if (!activity) throw notFound('ไม่พบกิจกรรม');
    assertOwner(user, activity);
    if (activity.submitted_at) throw rosterLocked();

    const coords = activity.loc_mode === 'off' ? {} : pickCoords(activity, dto);
    const now = Date.now();
    const secret = this.config.qrSecret;

    if (activity.qr_mode === 'static') {
      const token = makeStaticToken(secret, activity.id, coords);
      return { token, url: this.url(token), mode: 'static', now };
    }
    const interval = activity.qr_interval > 0 ? activity.qr_interval : QR_INTERVAL_DEFAULT;
    const window = windowOf(now, interval);
    const token = makeDynamicToken(secret, activity.id, now, interval, coords);
    const upcoming = Array.from({ length: Math.ceil(QR_PREFETCH_S / interval) }, (_, i) => {
      const w = window + 1 + i;
      const t = makeDynamicToken(secret, activity.id, w * interval * 1000, interval, coords);
      return { window: w, token: t, url: this.url(t) };
    });
    return { token, url: this.url(token), mode: 'dynamic', interval, window, refreshAt: (window + 1) * interval * 1000, now, upcoming };
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
