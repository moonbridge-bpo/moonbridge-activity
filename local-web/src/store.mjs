import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

const WORKERS = [
  { id: 'ava', name: 'Ava Santos', title: 'Support specialist', initials: 'AS' },
  { id: 'carlo', name: 'Carlo Reyes', title: 'Service coordinator', initials: 'CR' },
  { id: 'mina', name: 'Mina Cruz', title: 'Quality analyst', initials: 'MC' },
];

export function openStore(filename) {
  mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS workers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, title TEXT NOT NULL, initials TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, worker_id TEXT NOT NULL REFERENCES workers(id),
      created_ms INTEGER NOT NULL, expires_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS shifts (
      id TEXT PRIMARY KEY, worker_id TEXT NOT NULL REFERENCES workers(id),
      started_ms INTEGER NOT NULL, ended_ms INTEGER,
      is_sample INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_open_shift_per_worker
      ON shifts(worker_id) WHERE ended_ms IS NULL;
    CREATE TABLE IF NOT EXISTS breaks (
      id TEXT PRIMARY KEY, shift_id TEXT NOT NULL REFERENCES shifts(id),
      kind TEXT NOT NULL CHECK(kind IN ('break', 'lunch')),
      started_ms INTEGER NOT NULL, ended_ms INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_open_break_per_shift
      ON breaks(shift_id) WHERE ended_ms IS NULL;
    CREATE TABLE IF NOT EXISTS pair_codes (
      id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, device_id TEXT NOT NULL,
      created_ms INTEGER NOT NULL, expires_ms INTEGER NOT NULL,
      approved_worker_id TEXT REFERENCES workers(id), approved_shift_id TEXT REFERENCES shifts(id),
      approved_ms INTEGER, used_ms INTEGER
    );
    CREATE TABLE IF NOT EXISTS pairings (
      id TEXT PRIMARY KEY, device_id TEXT NOT NULL,
      worker_id TEXT NOT NULL REFERENCES workers(id), shift_id TEXT NOT NULL REFERENCES shifts(id),
      token_hash TEXT NOT NULL UNIQUE, created_ms INTEGER NOT NULL,
      revoked_ms INTEGER, revoke_reason TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_pairing_per_device
      ON pairings(device_id) WHERE revoked_ms IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS one_pairing_per_shift
      ON pairings(shift_id) WHERE revoked_ms IS NULL;
    CREATE TABLE IF NOT EXISTS intervals (
      id TEXT PRIMARY KEY, pairing_id TEXT NOT NULL REFERENCES pairings(id),
      shift_id TEXT NOT NULL REFERENCES shifts(id), kind TEXT NOT NULL CHECK(kind IN ('active', 'idle')),
      start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, received_ms INTEGER NOT NULL,
      source TEXT NOT NULL DEFAULT 'desktop'
    );
    CREATE INDEX IF NOT EXISTS intervals_by_shift ON intervals(shift_id, start_ms);
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at_ms INTEGER NOT NULL,
      action TEXT NOT NULL, worker_id TEXT, shift_id TEXT, device_id TEXT,
      detail TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  const shiftColumns = db.prepare('PRAGMA table_info(shifts)').all().map((column) => column.name);
  if (!shiftColumns.includes('is_sample')) db.exec('ALTER TABLE shifts ADD COLUMN is_sample INTEGER NOT NULL DEFAULT 0');
  const intervalColumns = db.prepare('PRAGMA table_info(intervals)').all().map((column) => column.name);
  if (!intervalColumns.includes('source')) db.exec("ALTER TABLE intervals ADD COLUMN source TEXT NOT NULL DEFAULT 'desktop'");
  const insertWorker = db.prepare('INSERT OR IGNORE INTO workers(id,name,title,initials) VALUES(?,?,?,?)');
  for (const worker of WORKERS) insertWorker.run(worker.id, worker.name, worker.title, worker.initials);
  db.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES('desktop_offline','0')").run();
  return db;
}

export function audit(db, action, { workerId = null, shiftId = null, deviceId = null, detail = '' } = {}) {
  db.prepare('INSERT INTO audit(at_ms,action,worker_id,shift_id,device_id,detail) VALUES(?,?,?,?,?,?)')
    .run(Date.now(), action, workerId, shiftId, deviceId, detail);
}

export function openShift(db, workerId) {
  return db.prepare('SELECT * FROM shifts WHERE worker_id=? AND ended_ms IS NULL').get(workerId) ?? null;
}

export function currentBreak(db, shiftId) {
  return db.prepare('SELECT * FROM breaks WHERE shift_id=? AND ended_ms IS NULL').get(shiftId) ?? null;
}

export function revokePairing(db, pairing, reason, at = Date.now()) {
  db.prepare('UPDATE pairings SET revoked_ms=?, revoke_reason=? WHERE id=? AND revoked_ms IS NULL')
    .run(at, reason, pairing.id);
  audit(db, 'pairing-revoked', {
    workerId: pairing.worker_id, shiftId: pairing.shift_id,
    deviceId: pairing.device_id, detail: reason,
  });
}

export function resetActivity(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const table of ['intervals', 'audit', 'pairings', 'pair_codes', 'breaks', 'shifts']) {
      db.exec(`DELETE FROM ${table}`);
    }
    db.prepare("UPDATE settings SET value='0' WHERE key='desktop_offline'").run();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function createSampleReport(db, workerId) {
  const existing = db.prepare('SELECT id FROM shifts WHERE worker_id=? AND is_sample=1 ORDER BY started_ms DESC LIMIT 1').get(workerId);
  if (existing) return existing.id;
  const end = Date.now() - 2 * 60_000;
  const start = end - 38 * 60_000;
  const shiftId = randomUUID();
  const pairingId = randomUUID();
  const deviceId = 'PC-SAMPLE-MOONBRIDGE';
  const segments = [
    { kind: 'active', from: 0, to: 10 },
    { kind: 'idle', from: 10, to: 16 },
    { kind: 'active', from: 21, to: 29 },
    { kind: 'active', from: 33, to: 38 },
  ];
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT INTO shifts(id,worker_id,started_ms,ended_ms,is_sample) VALUES(?,?,?,?,1)')
      .run(shiftId, workerId, start, end);
    db.prepare('INSERT INTO breaks(id,shift_id,kind,started_ms,ended_ms) VALUES(?,?,?,?,?)')
      .run(randomUUID(), shiftId, 'lunch', start + 16 * 60_000, start + 21 * 60_000);
    db.prepare('INSERT INTO pairings(id,device_id,worker_id,shift_id,token_hash,created_ms,revoked_ms,revoke_reason) VALUES(?,?,?,?,?,?,?,?)')
      .run(pairingId, deviceId, workerId, shiftId, randomBytes(32).toString('hex'), start, end, 'sample report completed');
    const insert = db.prepare('INSERT INTO intervals(id,pairing_id,shift_id,kind,start_ms,end_ms,received_ms,source) VALUES(?,?,?,?,?,?,?,?)');
    for (const segment of segments) {
      for (let minute = segment.from; minute < segment.to; minute++) {
        for (let second = 0; second < 60; second += 10) {
          const from = start + minute * 60_000 + second * 1000;
          const to = from + 10_000;
          insert.run(randomUUID(), pairingId, shiftId, segment.kind, from, to,
            to + (minute >= 33 ? 95_000 : 12_000), 'sample');
        }
      }
    }
    const insertAudit = db.prepare('INSERT INTO audit(at_ms,action,worker_id,shift_id,device_id,detail) VALUES(?,?,?,?,?,?)');
    insertAudit.run(start, 'pairing-completed', workerId, shiftId, deviceId, 'Presentation sample');
    insertAudit.run(start + 16 * 60_000, 'break-started', workerId, shiftId, deviceId, 'lunch');
    insertAudit.run(start + 21 * 60_000, 'break-ended', workerId, shiftId, deviceId, 'lunch');
    insertAudit.run(start + 33 * 60_000, 'connection-restored', workerId, shiftId, deviceId, 'Four-minute gap remains unverified');
    insertAudit.run(end, 'clock-out', workerId, shiftId, deviceId, 'Presentation sample completed');
    db.exec('COMMIT');
    return shiftId;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function toSegment(startMs, endMs, kind) {
  return { id: randomUUID(), startMs, endMs, kind, durationMs: endMs - startMs };
}

export function shiftReport(db, shiftId, now = Date.now()) {
  const shift = db.prepare(`SELECT s.*, w.name AS worker_name, w.initials AS worker_initials
    FROM shifts s JOIN workers w ON w.id=s.worker_id WHERE s.id=?`).get(shiftId);
  if (!shift) return null;
  const endMs = Math.max(shift.started_ms, shift.ended_ms ?? now);
  const events = db.prepare('SELECT * FROM intervals WHERE shift_id=? ORDER BY start_ms, end_ms').all(shiftId);
  const breaks = db.prepare('SELECT * FROM breaks WHERE shift_id=? ORDER BY started_ms').all(shiftId);
  const pairings = db.prepare('SELECT id,device_id,created_ms,revoked_ms,revoke_reason FROM pairings WHERE shift_id=? ORDER BY created_ms').all(shiftId);
  const boundaries = new Set([shift.started_ms, endMs]);
  for (const event of events) {
    boundaries.add(Math.max(shift.started_ms, Math.min(endMs, event.start_ms)));
    boundaries.add(Math.max(shift.started_ms, Math.min(endMs, event.end_ms)));
  }
  for (const item of breaks) {
    boundaries.add(Math.max(shift.started_ms, Math.min(endMs, item.started_ms)));
    boundaries.add(Math.max(shift.started_ms, Math.min(endMs, item.ended_ms ?? endMs)));
  }
  const marks = [...boundaries].sort((a, b) => a - b);
  const summaryMs = { active: 0, idle: 0, break: 0, unverified: 0 };
  const timeline = [];
  let eventIndex = 0;
  let breakIndex = 0;
  for (let i = 0; i < marks.length - 1; i++) {
    const start = marks[i];
    const end = marks[i + 1];
    if (end <= start) continue;
    while (eventIndex < events.length && events[eventIndex].end_ms <= start) eventIndex++;
    while (breakIndex < breaks.length && (breaks[breakIndex].ended_ms ?? endMs) <= start) breakIndex++;
    const activeBreak = breaks[breakIndex];
    const activeEvent = events[eventIndex];
    const kind = activeBreak && activeBreak.started_ms <= start && (activeBreak.ended_ms ?? endMs) >= end
      ? 'break'
      : activeEvent && activeEvent.start_ms <= start && activeEvent.end_ms >= end
        ? activeEvent.kind
        : 'unverified';
    summaryMs[kind] += end - start;
    const last = timeline[timeline.length - 1];
    if (last?.kind === kind && last.endMs === start) {
      last.endMs = end;
      last.durationMs += end - start;
    } else timeline.push(toSegment(start, end, kind));
  }
  const delayMs = events.length ? Math.max(0, events.at(-1).received_ms - events.at(-1).end_ms) : null;
  return {
    shift: { id: shift.id, workerId: shift.worker_id, workerName: shift.worker_name,
      startedMs: shift.started_ms, endedMs: shift.ended_ms, isSample: !!shift.is_sample },
    summaryMs, timeline, eventCount: events.length, pairingCount: pairings.length,
    lastUploadDelayMs: delayMs,
    pairings: pairings.map((p) => ({ id: p.id, deviceId: p.device_id,
      createdMs: p.created_ms, revokedMs: p.revoked_ms, revokeReason: p.revoke_reason })),
    recentEvents: events.slice(-16).reverse().map((e) => ({ id: e.id, kind: e.kind,
      startMs: e.start_ms, endMs: e.end_ms, receivedMs: e.received_ms, source: e.source,
      uploadDelayMs: Math.max(0, e.received_ms - e.end_ms) })),
    audit: db.prepare('SELECT at_ms,action,device_id,detail FROM audit WHERE shift_id=? ORDER BY id DESC LIMIT 15').all(shiftId)
      .map((a) => ({ atMs: a.at_ms, action: a.action, deviceId: a.device_id, detail: a.detail })),
  };
}
