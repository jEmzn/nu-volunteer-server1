import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

const MINUTE = 60_000;
const perMinute = (key: string, fallback: number) => ({ ttl: MINUTE, limit: () => Number(process.env[key] ?? fallback) });

/** Guessing an organisation code is the main thing to slow down. */
export const AUTH_SUP_LIMIT = { default: perMinute('RATE_AUTH_SUP', 5) };
/**
 * Higher than the spec's 20 per IP on purpose: a whole hall shares one Wi-Fi address, and 20 would keep most
 * first-time students queuing for minutes. Agreed with the project owner; see docs/WORKLOG.md.
 */
export const AUTH_STUDENT_LIMIT = { default: perMinute('RATE_AUTH_STUDENT', 600) };
export const CLAIMS_LIMIT = { default: perMinute('RATE_CLAIMS', 10) };

/** Counts per signed-in user rather than per IP. The global auth guard runs first, so req.user is already set. */
@Injectable()
export class PerUserThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    return req.user?.sub ?? req.ip;
  }
}
