import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';

/** An error the web is meant to read: a stable code, plus the field names for VALIDATION. */
export class ApiError extends HttpException {
  constructor(
    status: number,
    readonly code: string,
    message: string,
    readonly fields?: string[],
  ) {
    super(message, status);
  }
}

export const notFound = (what = 'ไม่พบข้อมูล') => new ApiError(404, 'NOT_FOUND', what);
export const forbidden = (why = 'ไม่มีสิทธิ์') => new ApiError(403, 'FORBIDDEN', why);
export const rosterLocked = () => new ApiError(409, 'ROSTER_LOCKED', 'รายชื่อถูกส่งหรือบันทึกแล้ว แก้ไขไม่ได้');
export const validation = (fields: string[], message = 'ข้อมูลไม่ถูกต้อง') => new ApiError(400, 'VALIDATION', message, fields);

const CODE_BY_STATUS: Record<number, string> = {
  400: 'VALIDATION',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  413: 'TOO_LARGE',
  429: 'RATE_LIMITED',
};

/** Postgres: invalid byte sequence (NUL), numeric out of range, datetime out of range. */
const BAD_VALUE_SQLSTATES = new Set(['22021', '22003', '22008']);

/** One error shape for everything, and never a stack trace to the client. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly log = new Logger('Error');

  catch(e: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (e instanceof ApiError) {
      return res.status(e.getStatus()).json({ error: { code: e.code, message: e.message, ...(e.fields && { fields: e.fields }) } });
    }
    if (e instanceof HttpException && e.getStatus() < 500) {
      const status = e.getStatus();
      return res.status(status).json({ error: { code: CODE_BY_STATUS[status] ?? 'ERROR', message: e.message } });
    }
    // Express middleware (the body parser) reports bad requests with a status on a plain error: over 1 MB, broken JSON.
    const status = (e as { status?: unknown } | null)?.status;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      const message = status === 413 ? 'ข้อมูลใหญ่เกิน 1 MB' : 'รูปแบบข้อมูลไม่ถูกต้อง';
      return res.status(status).json({ error: { code: CODE_BY_STATUS[status] ?? 'ERROR', message } });
    }
    // Values no field rule catches but the database cannot hold, such as a NUL character or an out-of-range number.
    if (BAD_VALUE_SQLSTATES.has((e as { code?: string } | null)?.code ?? '')) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'ข้อมูลไม่ถูกต้อง' } });
    }
    this.log.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    return res.status(500).json({ error: { code: 'INTERNAL', message: 'เกิดข้อผิดพลาดภายในระบบ' } });
  }
}
