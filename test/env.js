// Test values only. Limits are high so ordinary tests never hit them; rate-limit.test.ts lowers them itself.
Object.assign(process.env, {
  DATABASE_URL: 'postgres://postgres:test-only@localhost:54329/nuvol',
  JWT_SECRET: 'test-jwt-secret-test-jwt-secret-test-jwt-secret',
  QR_SECRET: 'test-qr-secret-test-qr-secret-test-qr-secret-00',
  WEB_ORIGIN: 'https://web.example',
  CORS_ORIGINS: 'https://web.example',
  TZ_DISPLAY: 'Asia/Bangkok',
  LOG_LEVEL: 'silent',
  RATE_AUTH_SUP: '100000',
  RATE_AUTH_STUDENT: '100000',
  RATE_CLAIMS: '100000',
  RATE_WRITES: '100000',
  API_DOCS: '1',
});
