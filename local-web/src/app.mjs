import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { audit, createSampleReport, currentBreak, openShift, resetActivity, revokePairing, shiftReport } from './store.mjs';

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const hash = (value) => createHash('sha256').update(value).digest('hex');
const isUuid = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const isLoopback = (address) => address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';

function json(res, status, body, extra = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', ...extra,
  });
  res.end(JSON.stringify(body));
}

function parseCookie(req, name) {
  const cookies = String(req.headers.cookie || '').split(';');
  for (const raw of cookies) {
    const [key, ...parts] = raw.trim().split('=');
    if (key === name) return parts.join('=');
  }
  return null;
}

function webWorker(db, req) {
  const token = parseCookie(req, 'mb_demo_session');
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  return db.prepare(`SELECT w.* FROM sessions s JOIN workers w ON w.id=s.worker_id
    WHERE s.token_hash=? AND s.expires_ms>?`).get(hash(token), Date.now()) ?? null;
}

function requireWorker(db, req) {
  const worker = webWorker(db, req);
  if (!worker) throw new HttpError(401, 'Choose a synthetic worker to continue');
  return worker;
}

function desktopPairing(db, req) {
  const match = /^Bearer ([0-9a-f]{64})$/i.exec(String(req.headers.authorization || ''));
  if (!match) throw new HttpError(401, 'Desktop pairing token required');
  const pairing = db.prepare('SELECT * FROM pairings WHERE token_hash=? AND revoked_ms IS NULL')
    .get(hash(match[1]));
  if (!pairing) throw new HttpError(401, 'Desktop pairing ended');
  const shift = db.prepare('SELECT * FROM shifts WHERE id=?').get(pairing.shift_id);
  if (!shift || shift.ended_ms !== null) {
    revokePairing(db, pairing, 'shift closed');
    throw new HttpError(401, 'Shift closed');
  }
  return { pairing, shift };
}

async function readJson(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 128 * 1024) throw new HttpError(413, 'Request too large');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required');
    return value;
  }
  catch { throw new HttpError(400, 'Invalid JSON'); }
}

function setOffline(db, offline) {
  db.prepare("UPDATE settings SET value=? WHERE key='desktop_offline'").run(offline ? '1' : '0');
  audit(db, offline ? 'desktop-network-paused' : 'desktop-network-resumed', { detail: 'Local network simulation' });
}

function state(db, req) {
  const worker = webWorker(db, req);
  const workers = db.prepare('SELECT * FROM workers ORDER BY CASE id WHEN \'ava\' THEN 0 WHEN \'carlo\' THEN 1 ELSE 2 END').all()
    .map((item) => {
      const shift = openShift(db, item.id);
      const pairing = shift && db.prepare('SELECT device_id,created_ms FROM pairings WHERE shift_id=? AND revoked_ms IS NULL').get(shift.id);
      return { ...item, clockedIn: !!shift, paired: !!pairing, deviceId: pairing?.device_id ?? null };
    });
  const shift = worker ? openShift(db, worker.id) : null;
  const latestShift = worker && db.prepare('SELECT * FROM shifts WHERE worker_id=? ORDER BY started_ms DESC LIMIT 1').get(worker.id);
  const pairing = shift && db.prepare('SELECT id,device_id,created_ms FROM pairings WHERE shift_id=? AND revoked_ms IS NULL').get(shift.id);
  return {
    worker, workers, shift, latestShift,
    activeBreak: shift ? currentBreak(db, shift.id) : null,
    pairing: pairing ?? null,
    desktopOffline: db.prepare("SELECT value FROM settings WHERE key='desktop_offline'").get()?.value === '1',
    totals: {
      shifts: db.prepare('SELECT COUNT(*) AS n FROM shifts').get().n,
      intervals: db.prepare('SELECT COUNT(*) AS n FROM intervals').get().n,
      pairings: db.prepare('SELECT COUNT(*) AS n FROM pairings').get().n,
    },
    recentAudit: db.prepare('SELECT at_ms,action,worker_id,device_id,detail FROM audit ORDER BY id DESC LIMIT 8').all()
      .map((a) => ({ atMs: a.at_ms, action: a.action, workerId: a.worker_id, deviceId: a.device_id, detail: a.detail })),
  };
}

function rateLimiter() {
  const hits = new Map();
  return (key, limit, windowMs) => {
    const now = Date.now();
    const recent = (hits.get(key) || []).filter((time) => now - time < windowMs);
    if (recent.length >= limit) throw new HttpError(429, 'Too many attempts; wait a moment');
    recent.push(now);
    hits.set(key, recent);
  };
}

function acceptBatch(db, pairing, shift, events) {
  if (!Array.isArray(events) || events.length < 1 || events.length > 100) {
    throw new HttpError(400, 'Send between 1 and 100 events');
  }
  const now = Date.now();
  const seen = new Set();
  const normalized = events.map((event) => {
    if (!event || !isUuid(event.id) || !['active', 'idle'].includes(event.kind)
      || !Number.isSafeInteger(event.startMs) || !Number.isSafeInteger(event.endMs)
      || event.endMs <= event.startMs || event.endMs - event.startMs > 15 * 60_000
      || event.startMs < shift.started_ms || event.endMs > now + 60_000) {
      throw new HttpError(400, 'Invalid activity interval');
    }
    if (seen.has(event.id)) throw new HttpError(400, 'Duplicate event ID in one batch');
    seen.add(event.id);
    return event;
  });
  const sorted = [...normalized].sort((a, b) => a.startMs - b.startMs);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].startMs < sorted[i - 1].endMs) throw new HttpError(409, 'Overlapping activity intervals');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    let accepted = 0;
    let duplicate = 0;
    const findId = db.prepare('SELECT * FROM intervals WHERE id=?');
    const findOverlap = db.prepare('SELECT id FROM intervals WHERE shift_id=? AND start_ms<? AND end_ms>? LIMIT 1');
    const insert = db.prepare('INSERT INTO intervals(id,pairing_id,shift_id,kind,start_ms,end_ms,received_ms) VALUES(?,?,?,?,?,?,?)');
    for (const event of sorted) {
      const prior = findId.get(event.id);
      if (prior) {
        if (prior.pairing_id !== pairing.id || prior.kind !== event.kind
          || prior.start_ms !== event.startMs || prior.end_ms !== event.endMs) {
          throw new HttpError(409, 'Event ID conflicts with an earlier interval');
        }
        duplicate++;
        continue;
      }
      if (findOverlap.get(shift.id, event.endMs, event.startMs)) {
        throw new HttpError(409, 'Activity intervals overlap');
      }
      insert.run(event.id, pairing.id, shift.id, event.kind, event.startMs, event.endMs, now);
      accepted++;
    }
    if (accepted) audit(db, 'activity-uploaded', {
      workerId: pairing.worker_id, shiftId: shift.id, deviceId: pairing.device_id,
      detail: `${accepted} new, ${duplicate} already received`,
    });
    db.exec('COMMIT');
    return { accepted, duplicate, receivedMs: now };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function createAppServer(db, publicDirectory) {
  const limit = rateLimiter();
  const assets = new Map([
    ['/', ['index.html', 'text/html; charset=utf-8']],
    ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
    ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
    ['/moonbridge-logo.png', ['moonbridge-logo.png', 'image/png']],
    ['/moonbridge-icon.png', ['moonbridge-icon.png', 'image/png']],
  ]);
  return createServer(async (req, res) => {
    try {
      if (!isLoopback(req.socket.remoteAddress)) throw new HttpError(403, 'Local access only');
      const host = String(req.headers.host || '');
      const hostName = host.split(':')[0].toLowerCase();
      if (!['127.0.0.1', 'localhost'].includes(hostName)) throw new HttpError(403, 'Local host required');
      const origin = req.headers.origin;
      if (origin && origin !== `http://${host}`) throw new HttpError(403, 'Cross-origin requests are disabled');
      const url = new URL(req.url || '/', `http://${host}`);
      const path = url.pathname;
      const method = req.method;
      if (method === 'GET' && assets.has(path)) {
        const [file, type] = assets.get(path);
        res.writeHead(200, {
          'content-type': type, 'cache-control': 'no-store',
          'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; object-src 'none'",
          'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
        });
        res.end(readFileSync(join(publicDirectory, file)));
        return;
      }
      if (path === '/api/health' && method === 'GET') return json(res, 200, { ok: true, localOnly: true });
      if (db.prepare("SELECT value FROM settings WHERE key='desktop_offline'").get().value === '1'
        && ((path === '/api/desktop/context' && method === 'GET')
          || (path === '/api/desktop/activity/batch' && method === 'POST'))) {
        req.socket.destroy();
        return;
      }
      if (path === '/api/demo/state' && method === 'GET') return json(res, 200, state(db, req));
      if (path === '/api/demo/report' && method === 'GET') {
        const worker = requireWorker(db, req);
        const shifts = db.prepare('SELECT id,started_ms,ended_ms FROM shifts WHERE worker_id=? ORDER BY started_ms DESC LIMIT 20').all(worker.id);
        const requested = url.searchParams.get('shiftId');
        const selected = requested ? shifts.find((s) => s.id === requested) : shifts[0];
        if (requested && !selected) throw new HttpError(404, 'Shift not found for this worker');
        return json(res, 200, { shifts: shifts.map((s) => ({ id: s.id, startedMs: s.started_ms, endedMs: s.ended_ms, isSample: !!s.is_sample })),
          report: selected ? shiftReport(db, selected.id) : null });
      }
      if (path === '/api/desktop/context' && method === 'GET') {
        const { pairing, shift } = desktopPairing(db, req);
        const activeBreak = currentBreak(db, shift.id);
        const lastBreak = db.prepare('SELECT MAX(ended_ms) AS ended_ms FROM breaks WHERE shift_id=?').get(shift.id);
        return json(res, 200, { pairingId: pairing.id, shiftId: shift.id,
          onBreak: !!activeBreak, lastBreakEndAt: lastBreak?.ended_ms ?? null });
      }
      if (method !== 'POST') throw new HttpError(404, 'Route not found');
      const body = await readJson(req);

      if (path === '/api/demo/pair-preview') {
        const worker = requireWorker(db, req);
        limit(`pair-preview:${worker.id}`, 12, 60_000);
        if (typeof body.code !== 'string' || !/^\d{6}$/.test(body.code)) throw new HttpError(400, 'Enter a six-digit code');
        const record = db.prepare('SELECT * FROM pair_codes WHERE code_hash=?').get(hash(body.code));
        if (!record || record.used_ms !== null || record.expires_ms <= Date.now()) throw new HttpError(410, 'Code expired or unavailable');
        if (record.approved_ms !== null) throw new HttpError(409, 'Code already approved');
        if (!openShift(db, worker.id)) throw new HttpError(409, 'Clock in before approving this computer');
        return json(res, 200, { deviceId: record.device_id, expiresAt: record.expires_ms });
      }

      if (path === '/api/demo/session') {
        const worker = db.prepare('SELECT * FROM workers WHERE id=?').get(body.workerId);
        if (!worker) throw new HttpError(400, 'Choose a listed synthetic worker');
        const token = randomBytes(32).toString('hex');
        const now = Date.now();
        db.prepare('INSERT INTO sessions(token_hash,worker_id,created_ms,expires_ms) VALUES(?,?,?,?)')
          .run(hash(token), worker.id, now, now + 7 * 24 * 60 * 60_000);
        return json(res, 200, { worker }, { 'set-cookie': `mb_demo_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800` });
      }
      if (path === '/api/demo/clock-in') {
        const worker = requireWorker(db, req);
        if (openShift(db, worker.id)) throw new HttpError(409, 'Already clocked in');
        const id = randomUUID();
        const now = Date.now();
        db.prepare('INSERT INTO shifts(id,worker_id,started_ms) VALUES(?,?,?)').run(id, worker.id, now);
        audit(db, 'clock-in', { workerId: worker.id, shiftId: id });
        return json(res, 201, { shiftId: id, startedMs: now });
      }
      if (path === '/api/demo/clock-out') {
        const worker = requireWorker(db, req);
        const shift = openShift(db, worker.id);
        if (!shift) throw new HttpError(409, 'No open shift');
        const now = Date.now();
        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare('UPDATE breaks SET ended_ms=? WHERE shift_id=? AND ended_ms IS NULL').run(now, shift.id);
          db.prepare('UPDATE shifts SET ended_ms=? WHERE id=?').run(now, shift.id);
          for (const pairing of db.prepare('SELECT * FROM pairings WHERE shift_id=? AND revoked_ms IS NULL').all(shift.id)) {
            revokePairing(db, pairing, 'clock-out', now);
          }
          audit(db, 'clock-out', { workerId: worker.id, shiftId: shift.id });
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        return json(res, 200, { shiftId: shift.id, endedMs: now });
      }
      if (path === '/api/demo/break/start') {
        const worker = requireWorker(db, req);
        const shift = openShift(db, worker.id);
        if (!shift) throw new HttpError(409, 'Clock in before starting a break');
        if (currentBreak(db, shift.id)) throw new HttpError(409, 'Break already in progress');
        const kind = body.kind === 'lunch' ? 'lunch' : 'break';
        const id = randomUUID();
        const now = Date.now();
        db.prepare('INSERT INTO breaks(id,shift_id,kind,started_ms) VALUES(?,?,?,?)').run(id, shift.id, kind, now);
        audit(db, 'break-started', { workerId: worker.id, shiftId: shift.id, detail: kind });
        return json(res, 200, { breakId: id, kind, startedMs: now });
      }
      if (path === '/api/demo/break/end') {
        const worker = requireWorker(db, req);
        const shift = openShift(db, worker.id);
        const activeBreak = shift && currentBreak(db, shift.id);
        if (!activeBreak) throw new HttpError(409, 'No break in progress');
        const now = Date.now();
        db.prepare('UPDATE breaks SET ended_ms=? WHERE id=?').run(now, activeBreak.id);
        audit(db, 'break-ended', { workerId: worker.id, shiftId: shift.id, detail: activeBreak.kind });
        return json(res, 200, { breakId: activeBreak.id, endedMs: now });
      }
      if (path === '/api/demo/network') {
        requireWorker(db, req);
        if (typeof body.offline !== 'boolean') throw new HttpError(400, 'offline must be boolean');
        setOffline(db, body.offline);
        return json(res, 200, { offline: body.offline });
      }
      if (path === '/api/demo/reset') {
        requireWorker(db, req);
        resetActivity(db);
        return json(res, 200, { reset: true });
      }
      if (path === '/api/demo/sample-report') {
        const worker = requireWorker(db, req);
        return json(res, 200, { shiftId: createSampleReport(db, worker.id) });
      }

      if (path.startsWith('/api/desktop/') && path !== '/api/desktop/pair/approve') {
        if (db.prepare("SELECT value FROM settings WHERE key='desktop_offline'").get().value === '1') {
          throw new HttpError(503, 'Desktop connection paused for local demonstration');
        }
      }
      if (path === '/api/desktop/pair/start') {
        if (typeof body.deviceId !== 'string' || !/^PC-[0-9a-f-]{36}$/i.test(body.deviceId)) {
          throw new HttpError(400, 'Invalid device ID');
        }
        limit(`pair-start:${body.deviceId}`, 12, 60_000);
        const now = Date.now();
        db.prepare('UPDATE pair_codes SET expires_ms=? WHERE device_id=? AND used_ms IS NULL AND expires_ms>?')
          .run(now, body.deviceId, now);
        let code;
        for (let attempts = 0; attempts < 10; attempts++) {
          const candidate = String(randomInt(0, 1_000_000)).padStart(6, '0');
          if (!db.prepare('SELECT id FROM pair_codes WHERE code_hash=?').get(hash(candidate))) { code = candidate; break; }
        }
        if (!code) throw new HttpError(503, 'Could not create a pairing code');
        db.prepare('INSERT INTO pair_codes(id,code_hash,device_id,created_ms,expires_ms) VALUES(?,?,?,?,?)')
          .run(randomUUID(), hash(code), body.deviceId, now, now + 300_000);
        audit(db, 'pairing-code-created', { deviceId: body.deviceId });
        return json(res, 201, { code, expiresInSeconds: 300 });
      }
      if (path === '/api/desktop/pair/approve') {
        const worker = requireWorker(db, req);
        limit(`pair-approve:${worker.id}`, 10, 60_000);
        if (typeof body.code !== 'string' || !/^\d{6}$/.test(body.code)) throw new HttpError(400, 'Enter a six-digit code');
        const record = db.prepare('SELECT * FROM pair_codes WHERE code_hash=?').get(hash(body.code));
        if (!record || record.used_ms !== null || record.expires_ms <= Date.now()) throw new HttpError(410, 'Code expired or unavailable');
        if (record.approved_ms !== null) throw new HttpError(409, 'Code already approved');
        const shift = openShift(db, worker.id);
        if (!shift) throw new HttpError(409, 'Clock in before approving this computer');
        const now = Date.now();
        db.prepare('UPDATE pair_codes SET approved_worker_id=?,approved_shift_id=?,approved_ms=? WHERE id=?')
          .run(worker.id, shift.id, now, record.id);
        audit(db, 'pairing-approved', { workerId: worker.id, shiftId: shift.id, deviceId: record.device_id });
        return json(res, 200, { approved: true, deviceId: record.device_id, workerName: worker.name, shiftId: shift.id });
      }
      if (path === '/api/desktop/pair/complete') {
        if (typeof body.code !== 'string' || !/^\d{6}$/.test(body.code)
          || typeof body.deviceId !== 'string') throw new HttpError(400, 'Invalid pairing request');
        limit(`pair-complete:${body.deviceId}`, 120, 60_000);
        const record = db.prepare('SELECT * FROM pair_codes WHERE code_hash=? AND device_id=?')
          .get(hash(body.code), body.deviceId);
        if (!record || record.used_ms !== null || record.expires_ms <= Date.now()) throw new HttpError(410, 'Code expired or unavailable');
        if (!record.approved_ms) throw new HttpError(409, 'Waiting for approval');
        const shift = openShift(db, record.approved_worker_id);
        if (!shift || shift.id !== record.approved_shift_id) throw new HttpError(409, 'Approved shift is no longer open');
        const worker = db.prepare('SELECT * FROM workers WHERE id=?').get(record.approved_worker_id);
        const token = randomBytes(32).toString('hex');
        const id = randomUUID();
        const now = Date.now();
        db.exec('BEGIN IMMEDIATE');
        try {
          const prior = db.prepare('SELECT * FROM pairings WHERE revoked_ms IS NULL AND (device_id=? OR shift_id=?)')
            .all(record.device_id, shift.id);
          for (const pairing of prior) revokePairing(db, pairing, 'worker handoff', now);
          db.prepare('INSERT INTO pairings(id,device_id,worker_id,shift_id,token_hash,created_ms) VALUES(?,?,?,?,?,?)')
            .run(id, record.device_id, worker.id, shift.id, hash(token), now);
          db.prepare('UPDATE pair_codes SET used_ms=? WHERE id=?').run(now, record.id);
          audit(db, 'pairing-completed', { workerId: worker.id, shiftId: shift.id, deviceId: record.device_id });
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        return json(res, 200, { token, pairingId: id, userId: worker.id, shiftId: shift.id, workerName: worker.name });
      }
      if (path === '/api/desktop/signout') {
        const { pairing } = desktopPairing(db, req);
        revokePairing(db, pairing, 'desktop signout');
        return json(res, 200, { revoked: true });
      }
      if (path === '/api/desktop/activity/batch') {
        const { pairing, shift } = desktopPairing(db, req);
        return json(res, 200, acceptBatch(db, pairing, shift, body.events));
      }
      throw new HttpError(404, 'Route not found');
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error('[local-web]', error);
      json(res, status, { error: status === 500 ? 'Local server error' : error.message });
    }
  });
}
