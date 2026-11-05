import { Injectable, Module } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DbService } from '../../common/db.service';
import { RealtimeService, rooms } from '../realtime/realtime';

@Injectable()
export class SchedulerService {
  constructor(
    private readonly db: DbService,
    private readonly realtime: RealtimeService,
  ) {}

  /** Rosters close on their own 24 hours after the end. Runs every 10 minutes and stamps the time they were due. */
  @Cron('*/10 * * * *')
  async closeOverdueRosters() {
    const { rows } = await this.db.query(`UPDATE activities SET closed_at = end_at + interval '24 hours' WHERE closed_at IS NULL AND now() >= end_at + interval '24 hours' RETURNING id`);
    for (const r of rows) this.realtime.notify(rooms.afterActivity(r.id));
    return rows.length;
  }
}

@Module({ providers: [SchedulerService] })
export class SchedulerModule {}
