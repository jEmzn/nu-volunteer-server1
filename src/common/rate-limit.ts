import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

const MINUTE = 60_000;
const READS = new Set(['GET', 'HEAD', 'OPTIONS']);
const perMinute = (key: string, fallback: number) => ({ ttl: MINUTE, limit: () => Number(process.env[key] ?? fallback) });
/** Sign-in counts per IP even when a token is sent: student tokens are free to get, so per-user would let anyone guess org codes faster. */
const byIp = (req: Record<string, any>) => req.ip as string;

/** Guessing an organisation code is the main thing to slow down. */
export const AUTH_SUP_LIMIT = { default: { ...perMinute('RATE_AUTH_SUP', 5), getTracker: byIp } };
/**
 * Higher than the spec's 20 per IP on purpose: a whole hall shares one Wi-Fi address, and 20 would keep most
 * first-time students queuing for minutes. Agreed with the project owner; see docs/WORKLOG.md.
 */
export const AUTH_STUDENT_LIMIT = { default: { ...perMinute('RATE_AUTH_STUDENT', 600), getTracker: byIp } };
export const CLAIMS_LIMIT = { default: perMinute('RATE_CLAIMS', 10) };
/** Every other write, per user and per endpoint: stops chat spam and filling the database with posters. */
export const WRITE_LIMIT = perMinute('RATE_WRITES', 60);

/**
 * The one throttler, global. Reads are free; writes count per signed-in user (a supervisor by org and name, since
 * their sub is only the typed name). Runs after AuthGuard, so req.user is already set.
 */
@Injectable()
export class RateLimitGuard extends ThrottlerGuard {
  protected async shouldSkip(ctx: ExecutionContext): Promise<boolean> {
    return ctx.getType() !== 'http' || READS.has(ctx.switchToHttp().getRequest().method);
  }

  protected async getTracker(req: Record<string, any>): Promise<string> {
    const u = req.user;
    return u ? `${u.role}:${u.orgCode ?? ''}:${u.sub}` : req.ip;
  }
}
