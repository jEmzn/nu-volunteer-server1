import { Injectable } from '@nestjs/common';

const list = (v: string | undefined) =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

function required(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`Missing environment variable ${key}`);
  return v;
}

/** Everything read from the environment, checked once at startup. The server refuses to start on a weak or shared secret. */
@Injectable()
export class AppConfig {
  readonly databaseUrl: string;
  readonly jwtSecret: string;
  readonly qrSecret: string;
  readonly webOrigin: string;
  readonly corsOrigins: string[];
  readonly port: number;
  readonly tzDisplay: string;
  readonly trustProxy: number;
  readonly dbPoolMax: number;

  constructor() {
    const env = process.env;
    this.databaseUrl = required(env, 'DATABASE_URL');
    this.jwtSecret = required(env, 'JWT_SECRET');
    this.qrSecret = required(env, 'QR_SECRET');
    if (Buffer.byteLength(this.jwtSecret) < 32) throw new Error('JWT_SECRET must be at least 32 bytes');
    if (Buffer.byteLength(this.qrSecret) < 32) throw new Error('QR_SECRET must be at least 32 bytes');
    if (this.jwtSecret === this.qrSecret) throw new Error('JWT_SECRET and QR_SECRET must be different');
    this.webOrigin = required(env, 'WEB_ORIGIN').replace(/\/+$/, '');
    this.corsOrigins = list(env.CORS_ORIGINS);
    this.port = Number(env.PORT ?? 3000);
    this.tzDisplay = env.TZ_DISPLAY ?? 'Asia/Bangkok';
    this.trustProxy = Number(env.TRUST_PROXY ?? 0);
    this.dbPoolMax = Number(env.DB_POOL_MAX ?? 20);
  }
}
