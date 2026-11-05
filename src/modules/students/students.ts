import { Body, Controller, Get, Injectable, Module, Param, Patch } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, isStudent, Roles, StudentUser, User } from '../../common/auth';
import { AppConfig } from '../../common/config';
import { DbService } from '../../common/db.service';
import { forbidden, notFound } from '../../common/errors';
import { assertNotNull, Bool, Nested, StrArray } from '../../common/fields';
import { toMyCredit, toMyRegistration, toStudent, toStudentBrief } from '../../common/mappers';
import { strikeSummary } from '../roster/strikes';

export class NotifyDto {
  @Bool({ optional: true }) enabled?: boolean;
  @Bool({ optional: true }) openings?: boolean;
  @Bool({ optional: true }) announcements?: boolean;
  @Bool({ optional: true }) messages?: boolean;
}

export class UpdateStudentDto {
  @StrArray({ optional: true, maxItems: 500 }) reminders?: string[];
  @Nested(NotifyDto, { optional: true }) notify?: NotifyDto;
}

@Injectable()
export class StudentsService {
  constructor(
    private readonly db: DbService,
    private readonly config: AppConfig,
  ) {}

  /** A student sees their own record; a supervisor looks up the name while adding someone. */
  async get(user: User, id: string) {
    if (isStudent(user) && user.sub !== id) throw forbidden();
    const row = await this.db.one('SELECT * FROM students WHERE id = $1', [id]);
    if (!row) throw notFound('ไม่พบนิสิต');
    return isStudent(user) ? toStudent(row) : toStudentBrief(row);
  }

  async update(user: StudentUser, dto: UpdateStudentDto) {
    assertNotNull(dto as Record<string, unknown>, ['reminders', 'notify']);
    const row = await this.db.one(
      `UPDATE students SET reminders = COALESCE($2, reminders), notify = COALESCE($3::jsonb, notify) WHERE id = $1 RETURNING *`,
      [user.sub, dto.reminders ?? null, dto.notify ? JSON.stringify(dto.notify) : null],
    );
    if (!row) throw notFound('ไม่พบนิสิต');
    return toStudent(row);
  }

  async registrations(user: StudentUser) {
    return (await this.db.query('SELECT * FROM registrations WHERE student_id = $1', [user.sub])).rows.map(toMyRegistration);
  }

  /** The student's own, or anyone's for the centre admin, who gives credits back. Roles already kept other supervisors out. */
  async strikes(user: User, id: string) {
    if (isStudent(user) && user.sub !== id) throw forbidden();
    return strikeSummary(this.db, id, this.config.tzDisplay);
  }

  async credits(user: StudentUser) {
    return (await this.db.query('SELECT * FROM credits WHERE student_id = $1', [user.sub])).rows.map(toMyCredit);
  }
}

@ApiTags('students')
@Controller('students')
export class StudentsController {
  constructor(private readonly students: StudentsService) {}

  @Patch('me')
  @Roles('student')
  @ApiOperation({ summary: 'แก้รายการตั้งเตือนและการตั้งค่าแจ้งเตือนของตัวเอง' })
  update(@CurrentUser() user: StudentUser, @Body() dto: UpdateStudentDto) {
    return this.students.update(user, dto);
  }

  @Get('me/registrations')
  @Roles('student')
  @ApiOperation({ summary: 'การลงทะเบียนของตัวเอง' })
  registrations(@CurrentUser() user: StudentUser) {
    return this.students.registrations(user);
  }

  @Get('me/credits')
  @Roles('student')
  @ApiOperation({ summary: 'ชั่วโมงของตัวเอง' })
  credits(@CurrentUser() user: StudentUser) {
    return this.students.credits(user);
  }

  @Get(':id/strikes')
  @Roles('student', 'admin')
  @ApiOperation({ summary: 'สิทธิ์ยกเลิกในภาคนี้: เหลือเท่าไร และรายการที่ถูกหัก รวมที่คืนแล้ว; นิสิตดูของตัวเอง admin ดูได้ทุกคน' })
  strikes(@CurrentUser() user: User, @Param('id') id: string) {
    return this.students.strikes(user, id);
  }

  @Get(':id')
  @Roles('student', 'sup')
  @ApiOperation({ summary: 'ข้อมูลนิสิต: ตัวเองเห็นครบ ผู้ดูแลเห็น id, name, createdAt' })
  get(@CurrentUser() user: User, @Param('id') id: string) {
    return this.students.get(user, id);
  }
}

@Module({ controllers: [StudentsController], providers: [StudentsService] })
export class StudentsModule {}
