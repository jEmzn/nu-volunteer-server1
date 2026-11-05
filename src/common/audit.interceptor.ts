import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { Observable, tap } from 'rxjs';

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Who changed what: every supervisor write, successful or not, because anyone holding an org code can act as a supervisor. */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private readonly log: PinoLogger) {
    log.setContext('audit');
  }

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest();
    if (req.user?.role !== 'sup' || READS.has(req.method)) return next.handle();
    const entry = {
      audit: true,
      supName: req.user.supName,
      orgCode: req.user.orgCode,
      command: `${ctx.getClass().name}.${ctx.getHandler().name}`,
      activityId: req.params?.id,
      studentId: req.params?.studentId,
    };
    return next.handle().pipe(
      tap({
        next: () => this.log.info({ ...entry, ok: true }, 'supervisor write'),
        error: (e) => this.log.info({ ...entry, ok: false, error: e?.code ?? e?.message }, 'supervisor write'),
      }),
    );
  }
}
