import { Controller, Get, Module } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/auth';
import { DbService } from '../../common/db.service';
import { ApiError } from '../../common/errors';

@ApiTags('system')
@Controller()
export class HealthController {
  constructor(private readonly db: DbService) {}

  @Get('health')
  @Public()
  @ApiOperation({ summary: 'ตรวจว่า API และฐานข้อมูลทำงาน' })
  async health() {
    try {
      await this.db.query('SELECT 1');
      return { status: 'ok', db: 'ok' };
    } catch {
      throw new ApiError(503, 'DB_DOWN', 'ฐานข้อมูลไม่พร้อมใช้งาน');
    }
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
