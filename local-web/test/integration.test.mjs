import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { openStore } from '../src/store.mjs';
import { createAppServer } from '../src/app.mjs';

const publicDirectory = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

async function fixture(run) {
  const directory = mkdtempSync(join(tmpdir(), 'moonbridge-local-'));
  const db = openStore(join(directory, 'test.sqlite'));
  const server = createAppServer(db, publicDirectory);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path, body, { cookie, token } = {}) {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (cookie) headers.cookie = cookie;
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST', headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  try { await run({ request, base, db }); }
  finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test('desktop pairing, idempotent upload, break, outage and shared-PC handoff', () => fixture(async ({ request, db }) => {
  const avaSession = await request('/api/demo/session', { workerId: 'ava' });
  const carloSession = await request('/api/demo/session', { workerId: 'carlo' });
  assert.equal(avaSession.status, 200);
  assert.equal(carloSession.status, 200);
  const ava = { cookie: avaSession.cookie };
  const carlo = { cookie: carloSession.cookie };
  const shiftA = await request('/api/demo/clock-in', {}, ava);
  const shiftC = await request('/api/demo/clock-in', {}, carlo);
  assert.equal(shiftA.status, 201);
  assert.equal(shiftC.status, 201);
  const deviceId = `PC-${randomUUID()}`;
  const startA = await request('/api/desktop/pair/start', { deviceId });
  assert.equal(startA.status, 201);
  assert.match(startA.body.code, /^\d{6}$/);
  assert.equal((await request('/api/desktop/pair/complete', { code: startA.body.code, deviceId })).status, 409);
  const previewA = await request('/api/demo/pair-preview', { code: startA.body.code }, ava);
  assert.equal(previewA.body.deviceId, deviceId);
  assert.equal((await request('/api/desktop/pair/approve', { code: startA.body.code }, ava)).status, 200);
  const pairedA = await request('/api/desktop/pair/complete', { code: startA.body.code, deviceId });
  assert.equal(pairedA.status, 200);
  assert.equal(pairedA.body.userId, 'ava');
  assert.equal(pairedA.body.shiftId, shiftA.body.shiftId);
  assert.equal((await request('/api/desktop/context', undefined, { token: pairedA.body.token })).body.onBreak, false);

  await new Promise((resolve) => setTimeout(resolve, 100));
  const event = { id: randomUUID(), kind: 'active', startMs: shiftA.body.startedMs + 20, endMs: Date.now() };
  const uploaded = await request('/api/desktop/activity/batch', { events: [event] }, { token: pairedA.body.token });
  assert.equal(uploaded.status, 200);
  assert.equal(uploaded.body.accepted, 1);
  const retry = await request('/api/desktop/activity/batch', { events: [event] }, { token: pairedA.body.token });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.duplicate, 1);

  const earlier = { id: randomUUID(), kind: 'idle', startMs: shiftA.body.startedMs + 1, endMs: shiftA.body.startedMs + 10 };
  const conflict = await request('/api/desktop/activity/batch', { events: [earlier, { ...event, kind: 'idle' }] }, { token: pairedA.body.token });
  assert.equal(conflict.status, 409);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM intervals').get().n, 1);

  assert.equal((await request('/api/demo/break/start', { kind: 'break' }, ava)).status, 200);
  assert.equal((await request('/api/desktop/context', undefined, { token: pairedA.body.token })).body.onBreak, true);
  assert.equal((await request('/api/demo/break/end', {}, ava)).status, 200);
  assert.equal(typeof (await request('/api/desktop/context', undefined, { token: pairedA.body.token })).body.lastBreakEndAt, 'number');

  assert.equal((await request('/api/demo/network', { offline: true }, ava)).status, 200);
  await assert.rejects(request('/api/desktop/context', undefined, { token: pairedA.body.token }));
  await assert.rejects(request('/api/desktop/activity/batch', { events: [event] }, { token: pairedA.body.token }));
  assert.equal((await request('/api/demo/network', { offline: false }, ava)).status, 200);

  const startC = await request('/api/desktop/pair/start', { deviceId });
  assert.equal((await request('/api/desktop/pair/approve', { code: startC.body.code }, carlo)).status, 200);
  const pairedC = await request('/api/desktop/pair/complete', { code: startC.body.code, deviceId });
  assert.equal(pairedC.status, 200);
  assert.equal(pairedC.body.userId, 'carlo');
  assert.equal((await request('/api/desktop/context', undefined, { token: pairedA.body.token })).status, 401);
  assert.equal((await request('/api/desktop/context', undefined, { token: pairedC.body.token })).status, 200);

  const avaReport = await request('/api/demo/report', undefined, ava);
  const carloReport = await request('/api/demo/report', undefined, carlo);
  assert.equal(avaReport.body.report.eventCount, 1);
  assert.equal(carloReport.body.report.eventCount, 0);
  assert.equal((await request('/api/demo/clock-out', {}, carlo)).status, 200);
  assert.equal((await request('/api/desktop/context', undefined, { token: pairedC.body.token })).status, 401);
}));

test('presentation report is clearly marked as sample data and keeps a gap unverified', () => fixture(async ({ request, base }) => {
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /MoonBridge Activity · Local Demo/);
  const session = await request('/api/demo/session', { workerId: 'mina' });
  const auth = { cookie: session.cookie };
  const seeded = await request('/api/demo/sample-report', {}, auth);
  assert.equal(seeded.status, 200);
  const again = await request('/api/demo/sample-report', {}, auth);
  assert.equal(again.body.shiftId, seeded.body.shiftId);
  const report = (await request(`/api/demo/report?shiftId=${seeded.body.shiftId}`, undefined, auth)).body.report;
  assert.equal(report.shift.isSample, true);
  assert.equal(report.summaryMs.active, 23 * 60_000);
  assert.equal(report.summaryMs.idle, 6 * 60_000);
  assert.equal(report.summaryMs.break, 5 * 60_000);
  assert.equal(report.summaryMs.unverified, 4 * 60_000);
  assert.equal(report.recentEvents[0].source, 'sample');
}));

test('desktop signout returns JSON and revokes its bearer token', () => fixture(async ({ request }) => {
  const session = await request('/api/demo/session', { workerId: 'mina' });
  const auth = { cookie: session.cookie };
  await request('/api/demo/clock-in', {}, auth);
  const deviceId = `PC-${randomUUID()}`;
  const started = await request('/api/desktop/pair/start', { deviceId });
  await request('/api/desktop/pair/approve', { code: started.body.code }, auth);
  const pairing = await request('/api/desktop/pair/complete', { code: started.body.code, deviceId });
  const signedOut = await request('/api/desktop/signout', {}, { token: pairing.body.token });
  assert.equal(signedOut.status, 200);
  assert.deepEqual(signedOut.body, { revoked: true });
  assert.equal((await request('/api/desktop/context', undefined, { token: pairing.body.token })).status, 401);
}));
