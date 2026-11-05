import { Body, Controller, HttpCode, Injectable, Module, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/auth';
import { DbService } from '../../common/db.service';
import { StrArray } from '../../common/fields';

export class CreditHoursDto {
  @StrArray({ maxItems: 5000, itemMax: 100 }) activityIds: string[];
}

@Injectable()
export class StatsService {
  constructor(private readonly db: DbService) {}

  /** Sum of hours per activity. Activities with no credits are 0. */
  async creditHours(ids: string[]): Promise<Record<string, number>> {
    const out: Record<string, number> = Object.fromEntries(ids.map((id) => [id, 0]));
    const { rows } = await this.db.query('SELECT activity_id, SUM(hours) AS total FROM credits WHERE activity_id = ANY($1::text[]) GROUP BY activity_id', [ids]);
    for (const r of rows) out[r.activity_id] = Number(r.total);
    return out;
  }
}

@ApiTags('stats')
@Controller('stats')
export class StatsController {
  constructor(private readonly stats: StatsService) {}

  // POST because a year's worth of ids does not fit in a URL.
  @Post('credit-hours')
  @HttpCode(200)
  @Roles('admin')
  @ApiOperation({ summary: 'ผลรวมชั่วโมงต่อกิจกรรม (ผู้ดูแลศูนย์)' })
  creditHours(@Body() dto: CreditHoursDto) {
    return this.stats.creditHours(dto.activityIds);
  }
}

@Module({ controllers: [StatsController], providers: [StatsService] })
export class StatsModule {}
