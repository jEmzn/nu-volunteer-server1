// Starts one real PostgreSQL 16 for the whole test run and creates the schema from db/schema.sql.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 54329;
const PASSWORD = 'test-only';

module.exports = async () => {
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nuvol-test-pg-'));
  const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: PASSWORD, port: PORT, persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'], postgresFlags: ['-c', 'max_connections=200'], onLog: () => {}, onError: () => {} });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('nuvol');

  const client = pg.getPgClient('nuvol');
  await client.connect();
  await client.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  await client.end();

  globalThis.__NUVOL_PG__ = pg;
};
