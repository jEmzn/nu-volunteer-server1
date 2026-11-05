import { Body, Controller, Get, HttpCode, Injectable, Module, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { assertOwner, CurrentUser, isStudent, Roles, SupUser, User } from '../../common/auth';
import { DbService, Row } from '../../common/db.service';
import { ApiError, forbidden, notFound } from '../../common/errors';
import { Str } from '../../common/fields';
import { toChatMsg, toDirectMsg } from '../../common/mappers';
import { RealtimeService, rooms } from '../realtime/realtime';

export class TextDto {
  @Str({ min: 1, max: 2000 }) text: string;
}

@Injectable()
export class ChatService {
  constructor(
    private readonly db: DbService,
    private readonly realtime: RealtimeService,
  ) {}

  private async activity(id: string): Promise<Row> {
    const row = await this.db.one('SELECT id, org_code, chat_enabled FROM activities WHERE id = $1', [id]);
    if (!row) throw notFound('ไม่พบกิจกรรม');
    return row;
  }

  /** The newest 500, oldest first, so a long chat keeps showing new messages. */
  async messages(activityId: string) {
    await this.activity(activityId);
    const { rows } = await this.db.query(`SELECT * FROM (SELECT * FROM messages WHERE activity_id = $1 ORDER BY at DESC LIMIT 500) m ORDER BY at ASC`, [activityId]);
    return rows.map(toChatMsg);
  }

  /** The author comes from the token. A supervisor's id is their name, never the org code: students read this chat. */
  async sendMessage(user: User, activityId: string, text: string) {
    const activity = await this.activity(activityId);
    if (!isStudent(user)) assertOwner(user, activity);
    if (!activity.chat_enabled) throw new ApiError(403, 'CHAT_DISABLED', 'กิจกรรมนี้ปิดแชท');
    const [authorId, authorName, sup] = isStudent(user) ? [user.sub, user.name, false] : [user.supName, user.supName, true];
    const row = await this.db.one('INSERT INTO messages (activity_id, author_id, author_name, text, sup) VALUES ($1, $2, $3, $4, $5) RETURNING *', [activityId, authorId, authorName, text, sup]);
    this.realtime.notify([rooms.messages(activityId)]);
    return toChatMsg(row!);
  }

  private async assertThreadAccess(user: User, activity: Row, studentId: string) {
    if (isStudent(user)) {
      if (user.sub !== studentId) throw forbidden();
      return;
    }
    assertOwner(user, activity);
  }

  async dms(user: User, activityId: string, studentId: string) {
    await this.assertThreadAccess(user, await this.activity(activityId), studentId);
    const { rows } = await this.db.query('SELECT * FROM dms WHERE activity_id = $1 AND student_id = $2 ORDER BY at ASC', [activityId, studentId]);
    return rows.map(toDirectMsg);
  }

  async sendDm(user: User, activityId: string, studentId: string, text: string) {
    await this.assertThreadAccess(user, await this.activity(activityId), studentId);
    const [fromSup, authorName] = isStudent(user) ? [false, user.name] : [true, user.supName];
    const row = await this.db.one('INSERT INTO dms (activity_id, student_id, from_sup, author_name, text) VALUES ($1, $2, $3, $4, $5) RETURNING *', [activityId, studentId, fromSup, authorName, text]);
    this.realtime.notify([rooms.dmThread(activityId, studentId), rooms.dmThreads(activityId)]);
    return toDirectMsg(row!);
  }

  /** Marks the other side's messages as read; which side the reader is on comes from the token. */
  async markDmsRead(user: User, activityId: string, studentId: string) {
    await this.assertThreadAccess(user, await this.activity(activityId), studentId);
    const { rowCount } = await this.db.query('UPDATE dms SET read = true WHERE activity_id = $1 AND student_id = $2 AND from_sup = $3 AND read = false', [activityId, studentId, isStudent(user)]);
    if (rowCount) this.realtime.notify([rooms.dmThread(activityId, studentId), rooms.dmThreads(activityId)]);
    return { changed: rowCount ?? 0 };
  }

  /** Who has written about this activity, so a supervisor can find the threads to answer. Newest first. */
  async threads(user: SupUser, activityId: string) {
    assertOwner(user, await this.activity(activityId));
    const { rows } = await this.db.query(
      `SELECT d.student_id, COALESCE(s.name, d.student_id) AS name, d.text, d.at, d.from_sup, d.unread
       FROM (
         SELECT DISTINCT ON (student_id) student_id, text, at, from_sup,
                count(*) FILTER (WHERE NOT from_sup AND NOT read) OVER (PARTITION BY student_id) AS unread
         FROM dms WHERE activity_id = $1 ORDER BY student_id, at DESC
       ) d LEFT JOIN students s ON s.id = d.student_id
       ORDER BY d.at DESC`,
      [activityId],
    );
    return rows.map((r) => ({ studentId: r.student_id, name: r.name, lastText: r.text, lastAt: new Date(r.at).getTime(), lastFromSup: r.from_sup, unread: Number(r.unread) }));
  }
}

@ApiTags('chat')
@Controller('activities/:id')
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Get('messages')
  @Roles('student', 'sup')
  @ApiOperation({ summary: 'แชทกิจกรรม 500 ข้อความล่าสุด เก่าสุดก่อน' })
  messages(@Param('id') id: string) {
    return this.chat.messages(id);
  }

  @Post('messages')
  @Roles('student', 'sup')
  @ApiOperation({ summary: 'ส่งแชท ได้เมื่อ chatEnabled; ผู้ดูแลส่งได้เฉพาะ owner/admin' })
  send(@CurrentUser() user: User, @Param('id') id: string, @Body() dto: TextDto) {
    return this.chat.sendMessage(user, id, dto.text);
  }

  @Get('dms')
  @Roles('sup')
  @ApiOperation({ summary: 'รายการ thread ข้อความส่วนตัวของกิจกรรม' })
  threads(@CurrentUser() user: SupUser, @Param('id') id: string) {
    return this.chat.threads(user, id);
  }

  @Get('dms/:studentId')
  @Roles('student', 'sup')
  @ApiOperation({ summary: 'ข้อความส่วนตัว เก่าสุดก่อน: เจ้าของ thread หรือ owner/admin' })
  dms(@CurrentUser() user: User, @Param('id') id: string, @Param('studentId') studentId: string) {
    return this.chat.dms(user, id, studentId);
  }

  @Post('dms/:studentId')
  @Roles('student', 'sup')
  @ApiOperation({ summary: 'ส่งข้อความส่วนตัว' })
  sendDm(@CurrentUser() user: User, @Param('id') id: string, @Param('studentId') studentId: string, @Body() dto: TextDto) {
    return this.chat.sendDm(user, id, studentId, dto.text);
  }

  @Post('dms/:studentId/read')
  @HttpCode(200)
  @Roles('student', 'sup')
  @ApiOperation({ summary: 'ทำเครื่องหมายว่าอ่านข้อความของอีกฝั่งแล้ว' })
  read(@CurrentUser() user: User, @Param('id') id: string, @Param('studentId') studentId: string) {
    return this.chat.markDmsRead(user, id, studentId);
  }
}

@Module({ controllers: [ChatController], providers: [ChatService] })
export class ChatModule {}
