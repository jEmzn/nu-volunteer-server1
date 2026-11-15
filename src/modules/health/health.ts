import { Controller, Get, Module } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/auth';
import { DbService } from '../../common/db.service';
import { ApiError } from '../../common/errors';
import { SchemaCheck } from '../../common/schema-check';

@ApiTags('system')
@Controller()
export class HealthController {
  constructor(
    private readonly db: DbService,
    private readonly schema: SchemaCheck,
  ) {}

  @Get('health')
  @Public()
  @ApiOperation({ summary: 'ตรวจว่า API และฐานข้อมูลทำงาน และฐานข้อมูลมีคอลัมน์ครบตามที่โค้ดใช้' })
  async health() {
    let missing: string[];
    try {
      await this.db.query('SELECT 1');
      // Checked on every call: one small catalogue query, and it turns ok by itself once the migration has run.
      missing = await this.schema.missing();
    } catch {
      throw new ApiError(503, 'DB_DOWN', 'ฐานข้อมูลไม่พร้อมใช้งาน');
    }
    if (missing.length) throw new ApiError(503, 'SCHEMA_OUTDATED', `ฐานข้อมูลยังไม่ได้อัปเดต ขาด ${missing.join(', ')}`);
    return { status: 'ok', db: 'ok' };
  }

  @Get('time')
  @Public()
  @ApiOperation({ summary: 'เวลา server (ms) ให้หน้าเว็บคำนวณส่วนต่างนาฬิกาเครื่อง' })
  time() {
    return { now: Date.now() };
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}
