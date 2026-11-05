// A real local PostgreSQL 16 without Docker, for development and joint testing. Data lives in .dev-db/ and survives restarts.
//   node scripts/dev-db.js           start (first run creates the schema and test organisations)
//   node scripts/dev-db.js --fresh   wipe and start over
// Prints the DATABASE_URL to use. Stop with Ctrl+C. The organisation codes below are for this local database only.
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.DEV_DB_PORT ?? 54330);
const PASSWORD = 'dev-only';
const DIR = path.join(__dirname, '..', '.dev-db');
const ROOT = path.join(__dirname, '..');

(async () => {
  if (process.argv.includes('--fresh')) fs.rmSync(DIR, { recursive: true, force: true });
  const isNew = !fs.existsSync(path.join(DIR, 'PG_VERSION'));
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const pg = new EmbeddedPostgres({
    databaseDir: DIR,
    user: 'postgres',
    password: PASSWORD,
    port: PORT,
    persistent: true,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    postgresFlags: ['-c', 'max_connections=200'],
    onLog: () => {},
    onError: () => {},
  });
  if (isNew) await pg.initialise();
  await pg.start();

  if (isNew) {
    await pg.createDatabase('nuvol');
    const client = pg.getPgClient('nuvol');
    await client.connect();
    await client.query(fs.readFileSync(path.join(ROOT, 'db', 'schema.sql'), 'utf8'));
    await client.query(`INSERT INTO orgs (code, name, admin) VALUES ('DEV-ORG', 'หน่วยงานทดสอบ', false), ('DEV-ORG-2', 'หน่วยงานทดสอบ 2', false), ('DEV-ADMIN', 'ศูนย์จิตอาสา (ทดสอบ)', true)`);
    await client.end();
  }

  console.log(`DATABASE_URL=postgres://postgres:${PASSWORD}@localhost:${PORT}/nuvol`);
  console.log('Test organisation codes: DEV-ORG, DEV-ORG-2, DEV-ADMIN (admin)');

  const stop = async () => {
    await pg.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
