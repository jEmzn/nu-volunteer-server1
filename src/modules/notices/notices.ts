import { Body, Controller, Get, HttpCode, Injectable, Module, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Public, Roles, StudentUser } from '../../common/auth';
import { DbService } from '../../common/db.service';
import { notFound } from '../../common/errors';
import { OneOf, Str } from '../../common/fields';
import { toAnnouncement, toNotice } from '../../common/mappers';

export class NewNoticeDto {
  /** The only kind a student may send: "registration has opened". The server creates all the others. */
  @OneOf(['open']) kind: 'open';
  @Str({ min: 1, max: 200 }) title: string;
  @Str({ optional: true, max: 1000 }) body?: string | null;
  @Str({ optional: true, max: 100 }) activityId?: string | null;
  @Str({ optional: true, max: 200, matches: /^\// }) to?: string | null;
}

@Injectable()
export class NoticesService {
  constructor(private readonly db: DbService) {}

  async list(user: StudentUser) {
    const { rows } = await this.db.query('SELECT * FROM notices WHERE student_id = $1 ORDER BY at DESC LIMIT 60', [user.sub]);
    return rows.map(toNotice);
  }

  async add(user: StudentUser, dto: NewNoticeDto) {
    const row = await this.db.one(`INSERT INTO notices (student_id, kind, title, body, activity_id, "to") VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`, [
      user.sub,
      dto.kind,
      dto.title,
      dto.body ?? '',
      dto.activityId ?? null,
      dto.to ?? null,
    ]);
    return toNotice(row!);
  }

  async markRead(user: StudentUser) {
    const { rowCount } = await this.db.query('UPDATE notices SET read = true WHERE student_id = $1 AND read = false', [user.sub]);
    return { changed: rowCount ?? 0 };
  }

  async announcements(activityId: string) {
    const activity = await this.db.one('SELECT id FROM activities WHERE id = $1', [activityId]);
    if (!activity) throw notFound('ไม่พบกิจกรรม');
    const { rows } = await this.db.query('SELECT * FROM announcements WHERE activity_id = $1 ORDER BY at DESC', [activityId]);
    return rows.map(toAnnouncement);
  }
}

@ApiTags('notices')
@Controller()
export class NoticesController {
  constructor(private readonly notices: NoticesService) {}

  @Get('students/me/notices')
  @Roles('student')
  @ApiOperation({ summary: 'กล่องแจ้งเตือน ใหม่สุด 60 รายการ' })
  list(@CurrentUser() user: StudentUser) {
    return this.notices.list(user);
  }

  @Post('students/me/notices')
  @Roles('student')
  @ApiOperation({ summary: 'เพิ่มการแจ้งเตือนเปิดรับสมัคร (รับเฉพาะ kind open)' })
  add(@CurrentUser() user: StudentUser, @Body() dto: NewNoticeDto) {
    return this.notices.add(user, dto);
  }

  @Post('students/me/notices/read')
  @HttpCode(200)
  @Roles('student')
  @ApiOperation({ summary: 'ทำเครื่องหมายอ่านทั้งหมด' })
  read(@CurrentUser() user: StudentUser) {
    return this.notices.markRead(user);
  }

  @Get('activities/:id/announcements')
  @Public()
  @ApiOperation({ summary: 'ประกาศของกิจกรรม ใหม่สุดก่อน' })
  announcements(@Param('id') id: string) {
    return this.notices.announcements(id);
  }
}

@Module({ controllers: [NoticesController], providers: [NoticesService] })
export class NoticesModule {}
