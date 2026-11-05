import { Body, Controller, Delete, Get, Injectable, Module, Param, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles, SupUser } from '../../common/auth';
import { DbService } from '../../common/db.service';
import { forbidden, notFound } from '../../common/errors';
import { assertNotNull, assertRequired, Bool, Int, Nested, OneOf, Str } from '../../common/fields';
import { newId } from '../../common/format';
import { toTemplate } from '../../common/mappers';
import { assertPoster } from '../../common/poster';

export class TemplateSettingsDto {
  @Bool({ optional: true }) capLimit?: boolean;
  @Int({ optional: true, min: 0, max: 9999 }) capacity?: number;
  @Bool({ optional: true }) walkIn?: boolean;
  @OneOf(['dynamic', 'static'], { optional: true }) qrMode?: string;
  @OneOf([10, 15], { optional: true }) qrInterval?: number;
  @OneOf(['on', 'off'], { optional: true }) locMode?: string;
  @Int({ optional: true, min: 1, max: 100000 }) radius?: number;
}

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

  async list(user: SupUser) {
    const { rows } = await this.db.query('SELECT * FROM templates WHERE org_code = $1 ORDER BY created_at ASC', [user.orgCode]);
    return rows.map(toTemplate);
  }

  async create(user: SupUser, dto: TemplateDto) {
    assertRequired(dto as Record<string, unknown>, ['title', 'hours']);
    if (dto.poster) assertPoster(dto.poster);
    const row = await this.db.one(`INSERT INTO templates (id, org_code, title, poster, description, hours, settings, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`, [
      newId(),
      user.orgCode,
      dto.title,
      dto.poster ?? '',
      dto.description ?? '',
      dto.hours,
      JSON.stringify(dto.settings ?? {}),
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
    if (dto.poster) assertPoster(dto.poster);
    await this.assertOwn(user, id);
    const row = await this.db.one(
      `UPDATE templates SET title = COALESCE($2, title), poster = COALESCE($3, poster), description = COALESCE($4, description),
         hours = COALESCE($5, hours), settings = COALESCE($6::jsonb, settings)
       WHERE id = $1 RETURNING *`,
      [id, dto.title ?? null, dto.poster ?? null, dto.description ?? null, dto.hours ?? null, dto.settings ? JSON.stringify(dto.settings) : null],
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
  list(@CurrentUser() user: SupUser) {
    return this.templates.list(user);
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
