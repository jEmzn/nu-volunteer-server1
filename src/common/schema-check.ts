import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DbService } from './db.service';

/**
 * Every column the code reads or writes, the same as db/schema.sql (a test compares the two). New code on a database
 * that missed a migration fails only on the requests that touch the missing column, so nothing notices until a
 * student scans. This list lets the server say so at start and through /health.
 */
export const REQUIRED_COLUMNS: Record<string, readonly string[]> = {
  students: ['id', 'name', 'created_at', 'reminders', 'notify'],
  orgs: ['code', 'name', 'admin'],
  activities: [
    'id', 'title', 'category_key', 'org', 'org_code', 'poster', 'description', 'place', 'lat', 'lng', 'start_at', 'end_at', 'hours', 'cap_limit', 'capacity',
    'walk_in', 'qr_mode', 'loc_mode', 'radius', 'qr_interval', 'supervisor_name', 'supervisor_phone', 'chat_enabled', 'open_chat_url', 'opens_at', 'cancel_days',
    'closed_at', 'submitted_at', 'recorded_at', 'hidden', 'hide_until_open', 'created_at', 'reg_count', 'credit_count', 'items_per_hour', 'template_id',
  ],
  templates: ['id', 'org_code', 'title', 'poster', 'description', 'hours', 'settings', 'created_by', 'created_at'],
  registrations: ['activity_id', 'student_id', 'name', 'at', 'walk_in', 'cancelled_at', 'late', 'waived'],
  credits: [
    'activity_id', 'student_id', 'name', 'hours', 'full_hours', 'at', 'method', 'distance', 'accuracy', 'flags', 'device_id', 'ref', 'edited_by', 'edited_at',
    'reason', 'reason_shared', 'items',
  ],
  announcements: ['id', 'activity_id', 'text', 'images', 'at'],
  messages: ['id', 'activity_id', 'author_id', 'author_name', 'text', 'at', 'sup'],
  dms: ['id', 'activity_id', 'student_id', 'from_sup', 'author_name', 'text', 'at', 'read'],
  notices: ['id', 'student_id', 'kind', 'title', 'body', 'activity_id', 'to', 'at', 'read'],
};

@Injectable()
export class SchemaCheck implements OnModuleInit {
  private readonly logger = new Logger('SchemaCheck');

  constructor(private readonly db: DbService) {}

  /** Columns the code needs that the database does not have, as "table.column". */
  async missing(): Promise<string[]> {
    const { rows } = await this.db.query(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ANY ($1)`, [
      Object.keys(REQUIRED_COLUMNS),
    ]);
    const have = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
    return Object.entries(REQUIRED_COLUMNS).flatMap(([table, cols]) => cols.map((c) => `${table}.${c}`).filter((c) => !have.has(c)));
  }

  /** Says so in the log at start. The server still comes up, so /health can report it and a late migration is picked up without a restart. */
  async onModuleInit() {
    try {
      const missing = await this.missing();
      if (missing.length) this.logger.error(`Database schema is behind this code. Missing: ${missing.join(', ')}. Run the files in db/migrations, then check /health.`);
    } catch (e) {
      this.logger.error(`Could not check the database schema: ${e instanceof Error ? e.message : e}`);
    }
  }
}
