import { Global, Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import { AuditInterceptor } from './common/audit.interceptor';
import { AuthGuard } from './common/auth';
import { AppConfig } from './common/config';
import { RateLimitGuard, WRITE_LIMIT } from './common/rate-limit';
import { DbService } from './common/db.service';
import { ActivitiesModule } from './modules/activities/activities';
import { AuthModule } from './modules/auth/auth';
import { ChatModule } from './modules/chat/chat';
import { ClaimsModule } from './modules/claims/claims';
import { ExportModule } from './modules/export/export';
import { HealthModule } from './modules/health/health';
import { NoticesModule } from './modules/notices/notices';
import { QrModule } from './modules/qr/qr';
import { RealtimeModule } from './modules/realtime/realtime';
import { RosterModule } from './modules/roster/roster';
import { SchedulerModule } from './modules/scheduler/scheduler';
import { StatsModule } from './modules/stats/stats';
import { StudentsModule } from './modules/students/students';
import { TemplatesModule } from './modules/templates/templates';

const jwt = JwtModule.registerAsync({
  useFactory: () => ({ secret: process.env.JWT_SECRET, verifyOptions: { algorithms: ['HS256'] }, signOptions: { algorithm: 'HS256' } }),
});
// The default applies to every write; sign-in and claims override it per route.
const throttler = ThrottlerModule.forRoot({ throttlers: [WRITE_LIMIT], errorMessage: 'เรียกถี่เกินไป กรุณารอสักครู่' });

@Global()
@Module({
  imports: [jwt, throttler],
  providers: [AppConfig, DbService],
  exports: [AppConfig, DbService, jwt, throttler],
})
export class CoreModule {}

@Module({
  imports: [
    CoreModule,
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        genReqId: (req) => (req.headers['x-request-id'] as string) ?? randomUUID(),
        // Method, path without query, and id only. Tokens never reach the log.
        serializers: {
          req: (req) => ({ id: req.id, method: req.method, url: String(req.url).split('?')[0] }),
          res: (res) => ({ status: res.statusCode }),
        },
        customProps: (req) => {
          const user = (req as unknown as { user?: { role: string; sub: string } }).user;
          return user ? { role: user.role, sub: user.sub } : {};
        },
      },
    }),
    ScheduleModule.forRoot(),
    RealtimeModule,
    AuthModule,
    StudentsModule,
    ActivitiesModule,
    QrModule,
    ClaimsModule,
    RosterModule,
    NoticesModule,
    ChatModule,
    TemplatesModule,
    StatsModule,
    ExportModule,
    SchedulerModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    // After AuthGuard, so writes are counted per user.
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
})
export class AppModule {}
