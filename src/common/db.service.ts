import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { AppConfig } from './config';

export type Row = Record<string, any>;

/** Thin wrapper over pg. Rules that must not interleave run inside tx() with SELECT ... FOR UPDATE on the activity. */
@Injectable()
export class DbService implements OnModuleDestroy {
  readonly pool: Pool;

  constructor(config: AppConfig) {
    this.pool = new Pool({ connectionString: config.databaseUrl, max: config.dbPoolMax });
  }

  query<T extends QueryResultRow = Row>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    return this.pool.query<T>(sql, params as any[]);
  }

  async one<T extends QueryResultRow = Row>(sql: string, params: unknown[] = []): Promise<T | null> {
    return (await this.query<T>(sql, params)).rows[0] ?? null;
  }

  /** Runs fn in one transaction. Send realtime events after this resolves, never inside fn. */
  async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  onModuleDestroy() {
    return this.pool.end();
  }
}

/**
 * Every activity column the rules read. Leaves out poster and description: a poster can be 300 KB, and this
 * is read on every scan while 300 people queue on the same row.
 */
export const ACTIVITY_RULE_COLUMNS = `id, title, org, org_code, category_key, start_at, end_at, hours, cap_limit, capacity, walk_in,
  qr_mode, loc_mode, radius, qr_interval, chat_enabled, cancel_days, closed_at, submitted_at, recorded_at,
  reg_count, credit_count, items_per_hour, opens_at, hidden`;

/** Locks the activity row so requests on the same activity run one at a time. */
export async function lockActivity(c: PoolClient, id: string): Promise<Row | null> {
  return (await c.query(`SELECT ${ACTIVITY_RULE_COLUMNS} FROM activities WHERE id = $1 FOR UPDATE`, [id])).rows[0] ?? null;
}
