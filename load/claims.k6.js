// Spec section 12: 300 students check in to one activity within 60 seconds.
//   k6 run -e BASE_URL=http://localhost:3000 -e ORG_CODE=<code> load/claims.k6.js
// Options: STUDENTS (300), DURATION_S (60). A shorter duration is a harsher test of the same queue.
// Uses a static QR so one token lasts the whole run; every other step is the same as a dynamic QR.
import { check, fail } from 'k6';
import exec from 'k6/execution';
import http from 'k6/http';
import { Trend } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://localhost:3000';
const ORG_CODE = __ENV.ORG_CODE;
const STUDENTS = Number(__ENV.STUDENTS || 300);
const DURATION_S = Number(__ENV.DURATION_S || 60);
const LAT = 16.7466;
const LNG = 100.1948;

const claimTime = new Trend('claim_ms', true);

export const options = {
  setupTimeout: '180s',
  scenarios: {
    scan: {
      executor: 'constant-arrival-rate',
      rate: STUDENTS,
      timeUnit: `${DURATION_S}s`,
      duration: `${DURATION_S}s`,
      preAllocatedVUs: 200,
      maxVUs: 400,
    },
  },
  thresholds: {
    'claim_ms': ['p(95)<500'],
    'http_req_failed{name:claim}': ['rate==0'],
    checks: ['rate==1'],
  },
};

const json = (token) => ({ headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) } });

export function setup() {
  if (!ORG_CODE) fail('Set ORG_CODE');
  const sup = http.post(`${BASE}/auth/sup`, JSON.stringify({ supName: 'k6', orgCode: ORG_CODE }), json());
  if (sup.status !== 200) fail(`sup sign-in: ${sup.status} ${sup.body}`);
  const supToken = sup.json('token');

  const now = Date.now();
  // A poster at the size limit, because a slow lock would show up with one: rule queries must not read it.
  const poster = `data:image/jpeg;base64,${'A'.repeat(400000)}`;
  const created = http.post(
    `${BASE}/activities`,
    JSON.stringify({
      title: `load ${now}`, categoryKey: 'blood', poster, description: 'load test', place: 'k6', lat: LAT, lng: LNG, start: now - 3600000, end: now + 3600000,
      hours: 6, capLimit: false, capacity: 0, walkIn: true, qrMode: 'static', locMode: 'on', radius: 150, qrInterval: 10,
      supervisor: { name: 'k6', phone: '0' }, chatEnabled: false,
    }),
    json(supToken),
  );
  if (created.status !== 201) fail(`create: ${created.status} ${created.body}`);
  const activityId = created.json('id');
  const qr = http.post(`${BASE}/activities/${activityId}/qr`, JSON.stringify({ la: LAT, lo: LNG, ac: 10 }), json(supToken)).json('token');

  // Sign in first, in batches. The run measures check-ins, and a hall's phones hold tokens already.
  const prefix = 60000000 + (now % 3000000);
  const tokens = [];
  for (let start = 0; start < STUDENTS; start += 20) {
    const batch = [];
    for (let i = start; i < Math.min(start + 20, STUDENTS); i++) batch.push(['POST', `${BASE}/auth/student`, JSON.stringify({ studentId: String(prefix + i), name: `นิสิต ${i}` }), json()]);
    for (const res of http.batch(batch)) {
      if (res.status !== 200) fail(`student sign-in: ${res.status} ${res.body}`);
      tokens.push(res.json('token'));
    }
  }
  return { supToken, activityId, qr, tokens };
}

export default function (data) {
  const i = exec.scenario.iterationInTest;
  if (i >= data.tokens.length) return;
  const res = http.post(
    `${BASE}/claims`,
    JSON.stringify({ token: data.qr, lat: LAT + Math.random() / 1000, lng: LNG, accuracy: 15, deviceId: `device-${i}` }),
    { ...json(data.tokens[i]), tags: { name: 'claim' } },
  );
  claimTime.add(res.timings.duration);
  check(res, { 'claim ok': (r) => r.status === 200 && r.json('ok') === true });
}

export function teardown(data) {
  const activity = http.get(`${BASE}/activities/${data.activityId}`, json(data.supToken)).json();
  const credits = http.get(`${BASE}/activities/${data.activityId}/credits`, json(data.supToken)).json();
  console.log(`RESULT credits=${credits.length} creditCount=${activity.creditCount} regCount=${activity.regCount} expected=${data.tokens.length}`);
  check(null, {
    'credits = students': () => credits.length === data.tokens.length,
    'credit_count = students': () => activity.creditCount === data.tokens.length,
    'reg_count = students': () => activity.regCount === data.tokens.length,
  });
}
