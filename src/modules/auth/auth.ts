import { Body, Controller, HttpCode, Injectable, Module, Post } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public, StudentUser, SupUser } from '../../common/auth';
import { DbService } from '../../common/db.service';
import { ApiError, notFound } from '../../common/errors';
import { Name, Str } from '../../common/fields';
import { maskName } from '../../common/format';
import { toStudent, toStudentBrief } from '../../common/mappers';
import { AUTH_STUDENT_LIMIT, AUTH_SUP_LIMIT } from '../../common/rate-limit';

export class StudentLoginDto {
  @Str({ matches: /^\d{8}$/ }) studentId: string;
  /** Needed only the first time. A known id keeps the name already stored. */
  @Name({ optional: true, allowEmpty: true }) name?: string | null;
}

export class SupLoginDto {
  @Name() supName: string;
  @Str({ min: 1, max: 200 }) orgCode: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly db: DbService,
    private readonly jwt: JwtService,
  ) {}

  async student(dto: StudentLoginDto) {
    let row = await this.db.one('SELECT * FROM students WHERE id = $1', [dto.studentId]);
    let isNew = false;
    if (!row) {
      if (!dto.name) throw notFound('ไม่พบรหัสนิสิตนี้ กรุณากรอกชื่อ-นามสกุล');
      row = await this.db.one('INSERT INTO students (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING RETURNING *', [dto.studentId, dto.name]);
      isNew = !!row;
      row ??= await this.db.one('SELECT * FROM students WHERE id = $1', [dto.studentId]);
    }
    const claims: StudentUser = { role: 'student', sub: row!.id, name: row!.name };
    // Shortcut until SSO: anyone may type a known id, so they see only a masked name and none of its settings. The
    // full name is still in the token and behind GET /students/:id with it.
    const student = isNew ? toStudent(row!) : { ...toStudentBrief(row!), name: maskName(row!.name) };
    return { token: this.jwt.sign(claims, { expiresIn: '30d' }), student, isNew };
  }

  async sup(dto: SupLoginDto) {
    const org = await this.db.one('SELECT code, name, admin FROM orgs WHERE upper(code) = upper($1) ORDER BY code LIMIT 1', [dto.orgCode]);
    if (!org) throw new ApiError(401, 'UNAUTHENTICATED', 'รหัสหน่วยงานไม่ถูกต้อง');
    const claims: SupUser = { role: 'sup', sub: dto.supName, supName: dto.supName, orgCode: org.code, orgName: org.name, admin: org.admin };
    return {
      // Long enough to sign in the day before an event without being logged out of the QR screen mid-event.
      token: this.jwt.sign(claims, { expiresIn: '7d' }),
      sup: { name: dto.supName, orgCode: org.code, orgName: org.name, admin: org.admin },
    };
  }
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('student')
  @HttpCode(200)
  @Public()
  @Throttle(AUTH_STUDENT_LIMIT)
  @ApiOperation({ summary: 'นิสิตเข้าใช้งาน: รหัส 8 หลัก ครั้งแรกต้องมีชื่อ; ได้ token อายุ 30 วัน; รหัสที่มีอยู่แล้วได้ชื่อแบบปิดบางส่วน' })
  student(@Body() dto: StudentLoginDto) {
    return this.auth.student(dto);
  }

  @Post('sup')
  @HttpCode(200)
  @Public()
  @Throttle(AUTH_SUP_LIMIT)
  @ApiOperation({ summary: 'ผู้ดูแลเข้าใช้งาน: ชื่อ + รหัสหน่วยงาน (ไม่สนตัวพิมพ์); ได้ token อายุ 7 วัน' })
  sup(@Body() dto: SupLoginDto) {
    return this.auth.sup(dto);
  }
}

@Module({ controllers: [AuthController], providers: [AuthService] })
export class AuthModule {}
