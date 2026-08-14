/**
 * Tests for core per-session messages_in schema maintenance.
 *
 * Task-specific DB tests (insertTask, cancel/pause/resume, updateTask,
 * insertRecurrence) live in `src/modules/scheduling/db.test.ts` with the
 * rest of the scheduling module.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { describe, it, expect, afterEach } from 'vitest';

import {
  getInboundSourceSessionId,
  isTransientMountError,
  migrateMessagesInTable,
  withMountRetry,
} from './session-db.js';

const TEST_DIR = '/tmp/nanoclaw-session-db-test';
const DB_PATH = path.join(TEST_DIR, 'inbound.db');

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('migrateMessagesInTable', () => {
  it('backfills series_id = id on legacy rows and is idempotent', () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    // Build a legacy inbound.db WITHOUT series_id to simulate a pre-fix install.
    const db = new Database(DB_PATH);
    db.exec(`
      CREATE TABLE messages_in (
        id             TEXT PRIMARY KEY,
        seq            INTEGER UNIQUE,
        kind           TEXT NOT NULL,
        timestamp      TEXT NOT NULL,
        status         TEXT DEFAULT 'pending',
        process_after  TEXT,
        recurrence     TEXT,
        tries          INTEGER DEFAULT 0,
        platform_id    TEXT,
        channel_type   TEXT,
        thread_id      TEXT,
        content        TEXT NOT NULL
      );
    `);
    db.prepare(
      "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES (?, ?, 'task', datetime('now'), 'pending', '{}')",
    ).run('legacy-1', 2);

    migrateMessagesInTable(db);
    migrateMessagesInTable(db); // idempotent

    const row = db.prepare('SELECT series_id FROM messages_in WHERE id = ?').get('legacy-1') as {
      series_id: string;
    };
    expect(row.series_id).toBe('legacy-1');
    db.close();
  });

  it('adds source_session_id on a legacy DB, leaves existing rows NULL, is idempotent', () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    const db = new Database(DB_PATH);
    db.exec(`
      CREATE TABLE messages_in (
        id             TEXT PRIMARY KEY,
        seq            INTEGER UNIQUE,
        kind           TEXT NOT NULL,
        timestamp      TEXT NOT NULL,
        status         TEXT DEFAULT 'pending',
        process_after  TEXT,
        recurrence     TEXT,
        tries          INTEGER DEFAULT 0,
        platform_id    TEXT,
        channel_type   TEXT,
        thread_id      TEXT,
        content        TEXT NOT NULL
      );
    `);
    db.prepare(
      "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES (?, ?, 'chat', datetime('now'), 'pending', '{}')",
    ).run('legacy-2', 2);

    migrateMessagesInTable(db);
    migrateMessagesInTable(db); // idempotent

    const cols = (db.prepare("PRAGMA table_info('messages_in')").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('source_session_id');

    expect(getInboundSourceSessionId(db, 'legacy-2')).toBeNull();
    expect(getInboundSourceSessionId(db, 'does-not-exist')).toBeNull();
    db.close();
  });
});

describe('isTransientMountError', () => {
  it('matches a read that raced a write on the other side of the mount', () => {
    // The host reads outbound.db read-only while the container writes it.
    // A read landing mid-write hits the container's hot rollback journal;
    // this used to abort the delivery poll and strand the messages.
    expect(isTransientMountError('attempt to write a readonly database')).toBe(true);
    expect(isTransientMountError('SqliteError: SQLITE_READONLY_ROLLBACK')).toBe(true);
    expect(isTransientMountError('database disk image is malformed')).toBe(true);
    expect(isTransientMountError('SQLITE_CORRUPT_VTAB')).toBe(true);
    expect(isTransientMountError('file is not a database')).toBe(true);
  });

  it('does not claim lock contention or real schema errors', () => {
    expect(isTransientMountError('database is locked')).toBe(false);
    expect(isTransientMountError('no such table: messages_out')).toBe(false);
    expect(isTransientMountError('')).toBe(false);
  });
});

describe('withMountRetry', () => {
  it('returns the value when the read succeeds first time', () => {
    expect(withMountRetry(() => 'value')).toBe('value');
  });

  it('retries a transient mount fault until it clears', () => {
    let calls = 0;
    const result = withMountRetry(() => {
      calls += 1;
      if (calls < 4) throw new Error('attempt to write a readonly database');
      return calls;
    });
    expect(result).toBe(4);
  });

  it('surfaces a non-mount error immediately without retrying', () => {
    let calls = 0;
    expect(() =>
      withMountRetry(() => {
        calls += 1;
        throw new Error('no such table: messages_out');
      }),
    ).toThrow('no such table');
    expect(calls).toBe(1);
  });

  it('gives up after a bounded number of attempts and keeps the cause', () => {
    let calls = 0;
    let caught: unknown;
    try {
      withMountRetry(() => {
        calls += 1;
        throw new Error('database disk image is malformed');
      });
    } catch (err) {
      caught = err;
    }
    expect(calls).toBe(12);
    expect((caught as Error).message).toContain('after 12 attempts');
    expect((caught as Error).cause).toBeInstanceOf(Error);
  });
});
