import { Controller, Get, Injectable, Module, Param, Query, Res, StreamableFile } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import ExcelJS from 'exceljs';
import type { Response } from 'express';
import { assertOwner, CurrentUser, Roles, SupUser } from '../../common/auth';
import { AppConfig } from '../../common/config';
import { DbService } from '../../common/db.service';
import { forbidden, notFound, validation } from '../../common/errors';
import { ADMIN_COLUMNS, ADMIN_WIDTHS, adminRows, SUP_COLUMNS, SUP_WIDTHS, supRows } from './rows';

async function workbook(sheet: string, columns: readonly string[], widths: number[], rows: (string | number)[][]) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheet);
  ws.columns = columns.map((header, i) => ({ header, width: widths[i] }));
  ws.getRow(1).font = { bold: true };
  ws.addRows(rows);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

@Injectable()
export class ExportService {
  constructor(
    private readonly db: DbService,
    private readonly config: AppConfig,
  ) {}

  async build(user: SupUser, activityId: string, kind: string | undefined) {
    if (kind !== 'sup' && kind !== 'admin') throw validation(['kind']);
    const activity = await this.db.one('SELECT id, title, org, org_code, category_key, start_at FROM activities WHERE id = $1', [activityId]);
    if (!activity) throw notFound('ไม่พบกิจกรรม');
    if (kind === 'admin' && !user.admin) throw forbidden('ไฟล์นี้สำหรับผู้ดูแลศูนย์');
    assertOwner(user, activity);

    const credits = (await this.db.query('SELECT * FROM credits WHERE activity_id = $1', [activityId])).rows;
    const title = String(activity.title).slice(0, 40);
    if (kind === 'admin') {
      return { name: `${title} บันทึกชั่วโมง.xlsx`, data: await workbook('บันทึกชั่วโมง', ADMIN_COLUMNS, ADMIN_WIDTHS, adminRows(activity, credits, this.config.tzDisplay)) };
    }
    const regs = (await this.db.query('SELECT * FROM registrations WHERE activity_id = $1', [activityId])).rows;
    return { name: `${title} รายชื่อ.xlsx`, data: await workbook('รายชื่อ', SUP_COLUMNS, SUP_WIDTHS, supRows(activity, regs, credits, this.config.tzDisplay)) };
  }
}

@ApiTags('export')
@Controller('activities/:id/export')
export class ExportController {
  constructor(private readonly exports: ExportService) {}

  @Get()
  @Roles('sup')
  @ApiQuery({ name: 'kind', enum: ['sup', 'admin'] })
  @ApiOperation({ summary: 'ไฟล์ Excel: sup 11 คอลัมน์ (owner/admin), admin 7 คอลัมน์ (ผู้ดูแลศูนย์)' })
  async export(@CurrentUser() user: SupUser, @Param('id') id: string, @Query('kind') kind: string | undefined, @Res({ passthrough: true }) res: Response) {
    const { name, data } = await this.exports.build(user, id, kind);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    // The plain filename is a fallback for clients that cannot read the UTF-8 form (RFC 5987).
    res.setHeader('Content-Disposition', `attachment; filename="roster.xlsx"; filename*=UTF-8''${encodeURIComponent(name)}`);
    return new StreamableFile(data);
  }
}

@Module({ controllers: [ExportController], providers: [ExportService] })
export class ExportModule {}
