import { Body, Controller, Delete, Get, Injectable, Module, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser, Public, Roles, SupUser } from '../../common/auth';
import { DbService } from '../../common/db.service';
import { forbidden, notFound } from '../../common/errors';
import { assertNotNull, assertRequired, Bool, Int, Nested, OneOf, Str } from '../../common/fields';
import { newId } from '../../common/format';
import { toTemplate } from '../../common/mappers';
import { cleanQuestions, QuestionDto, QuestionList } from '../../common/questions';
import { POSTER_CACHE, posterImage, posterToStore, TEMPLATE_POSTER_COLUMN, templatePosterId } from '../../common/poster';

export class TemplateSettingsDto {
  @Bool({ optional: true }) capLimit?: boolean;
  @Int({ optional: true, min: 0, max: 9999 }) capacity?: number;
  @Bool({ optional: true }) walkIn?: boolean;
  @OneOf(['dynamic', 'static'], { optional: true }) qrMode?: string;
  @OneOf([10, 15], { optional: true }) qrInterval?: number;
  @OneOf(['on', 'off'], { optional: true }) locMode?: string;
  @Int({ optional: true, min: 1, max: 100000 }) radius?: number;
  @QuestionList({ optional: true }) questions?: QuestionDto[] | null;
}

/** Settings as stored: the questions without keys the form does not use. */
const storedSettings = (s: TemplateSettingsDto | undefined) => (s && s.questions !== undefined ? { ...s, questions: cleanQuestions(s.questions) } : s);

export class TemplateDto {
  @Str({ optional: true, min: 1, max: 200 }) title?: string;
  @Str({ optional: true, raw: true }) poster?: string;
  @Str({ optional: true, max: 10000 }) description?: string;
  @Int({ optional: true, min: 1, max: 99 }) hours?: number;
  @Nested(TemplateSettingsDto, { optional: true }) settings?: TemplateSettingsDto;
}

/** Templates are shared by everyone signed in with the same organisation code, the centre admin included. */
@Injectable()
export class TemplatesService {
  constructor(private readonly db: DbService) {}

  /** With urls, an uploaded poster comes as a URL (VB-27). Without, as the image, for a web deployed before that. */
  async list(user: SupUser, urls = false) {
    const columns = urls ? `id, org_code, title, description, hours, settings, created_by, created_at, ${TEMPLATE_POSTER_COLUMN}` : '*';
    const { rows } = await this.db.query(`SELECT ${columns} FROM templates WHERE org_code = $1 ORDER BY created_at ASC`, [user.orgCode]);
    return rows.map(toTemplate);
  }

  async poster(id: string) {
    const row = await this.db.one('SELECT poster FROM templates WHERE id = $1', [id]);
    const image = row && posterImage(row.poster);
    if (!image) throw notFound('ไม่พบรูป');
    return image;
  }

  async create(user: SupUser, dto: TemplateDto) {
    assertRequired(dto as Record<string, unknown>, ['title', 'hours']);
    if (dto.poster) dto.poster = await posterToStore(this.db, user.orgCode, dto.poster);
    const row = await this.db.one(`INSERT INTO templates (id, org_code, title, poster, description, hours, settings, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`, [
      newId(),
      user.orgCode,
      dto.title,
      dto.poster ?? '',
      dto.description ?? '',
      dto.hours,
      JSON.stringify(storedSettings(dto.settings) ?? {}),
      user.supName,
    ]);
    return toTemplate(row!);
  }

  private async assertOwn(user: SupUser, id: string) {
    const row = await this.db.one('SELECT org_code FROM templates WHERE id = $1', [id]);
    if (!row) throw notFound('ไม่พบเทมเพลต');
    if (row.org_code !== user.orgCode) throw forbidden('เทมเพลตนี้ไม่ใช่ของหน่วยงานคุณ');
  }

  async update(user: SupUser, id: string, dto: TemplateDto) {
    assertNotNull(dto as Record<string, unknown>, ['title', 'poster', 'description', 'hours', 'settings']);
    await this.assertOwn(user, id);
    // Its own URL back means the image did not change.
    if (dto.poster && templatePosterId(dto.poster) === id) delete dto.poster;
    if (dto.poster) dto.poster = await posterToStore(this.db, user.orgCode, dto.poster);
    const row = await this.db.one(
      `UPDATE templates SET title = COALESCE($2, title), poster = COALESCE($3, poster), description = COALESCE($4, description),
         hours = COALESCE($5, hours), settings = COALESCE($6::jsonb, settings)
       WHERE id = $1 RETURNING *`,
      [id, dto.title ?? null, dto.poster ?? null, dto.description ?? null, dto.hours ?? null, dto.settings ? JSON.stringify(storedSettings(dto.settings)) : null],
    );
    return toTemplate(row!);
  }

  /** Activities made from it keep their own copy of the values. */
  async remove(user: SupUser, id: string) {
    await this.assertOwn(user, id);
    await this.db.query('DELETE FROM templates WHERE id = $1', [id]);
    return { ok: true };
  }
}

@ApiTags('templates')
@Controller('templates')
@Roles('sup')
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  @Get()
  @ApiOperation({ summary: 'เทมเพลตของหน่วยงานตัวเอง เก่าสุดก่อน' })
  @ApiQuery({ name: 'posters', required: false, enum: ['url'], description: 'url: รูปที่อัปโหลดมาเป็น URL แทนตัวรูป' })
  list(@CurrentUser() user: SupUser, @Query('posters') posters?: string) {
    return this.templates.list(user, posters === 'url');
  }

  @Get(':id/poster')
  @Public()
  @ApiOperation({ summary: 'รูปโปสเตอร์ของเทมเพลต เป็นไฟล์ JPEG; ใช้ค่า poster จาก GET /templates?posters=url เป็น URL' })
  async poster(@Param('id') id: string, @Res() res: Response) {
    res.type('jpeg').set('Cache-Control', POSTER_CACHE).send(await this.templates.poster(id));
  }

  @Post()
  @ApiOperation({ summary: 'สร้างเทมเพลต' })
  create(@CurrentUser() user: SupUser, @Body() dto: TemplateDto) {
    return this.templates.create(user, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'แก้เทมเพลต' })
  update(@CurrentUser() user: SupUser, @Param('id') id: string, @Body() dto: TemplateDto) {
    return this.templates.update(user, id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'ลบเทมเพลต กิจกรรมที่สร้างไปแล้วไม่กระทบ' })
  remove(@CurrentUser() user: SupUser, @Param('id') id: string) {
    return this.templates.remove(user, id);
  }
}

@Module({ controllers: [TemplatesController], providers: [TemplatesService] })
export class TemplatesModule {}
