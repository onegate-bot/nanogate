import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, isTransientMountError, withInboundDb } from './connection.js';

describe('isTransientMountError', () => {
  it('matches the hot-journal symptom, which is the common case', () => {
    // A read-only handle opening inbound.db mid-host-write finds a hot
    // rollback journal it is not allowed to replay. 940 of 947 observed
    // failures were this, and it used to be fatal because the old
    // corruption predicate did not match it at all.
    expect(isTransientMountError('attempt to write a readonly database')).toBe(true);
    expect(isTransientMountError('SqliteError: SQLITE_READONLY_ROLLBACK: ...')).toBe(true);
  });

  it('matches the torn-read symptom', () => {
    expect(isTransientMountError('database disk image is malformed')).toBe(true);
    expect(isTransientMountError('SqliteError: SQLITE_CORRUPT_VTAB: ...')).toBe(true);
    expect(isTransientMountError('file is not a database')).toBe(true);
  });

  it('does not claim lock contention or genuine schema errors', () => {
    // busy_timeout already absorbs lock contention; treating it as a mount
    // fault would retry past the point where the real problem should surface.
    expect(isTransientMountError('database is locked')).toBe(false);
    expect(isTransientMountError('no such table: messages_in')).toBe(false);
    expect(isTransientMountError('')).toBe(false);
  });
});

describe('withInboundDb', () => {
  beforeEach(() => {
    initTestSessionDb();
  });
  afterEach(() => {
    closeSessionDb();
  });

  it('returns the read result when nothing goes wrong', () => {
    const rows = withInboundDb((db) => db.prepare('SELECT COUNT(*) AS c FROM messages_in').get());
    expect(rows).toEqual({ c: 0 });
  });

  it('retries a transient mount failure with a fresh connection and recovers', () => {
    let calls = 0;
    const result = withInboundDb(() => {
      calls += 1;
      if (calls < 3) throw new Error('attempt to write a readonly database');
      return 'recovered';
    });
    expect(result).toBe('recovered');
    expect(calls).toBe(3);
  });

  it('does not retry errors that are not mount faults', () => {
    let calls = 0;
    expect(() =>
      withInboundDb(() => {
        calls += 1;
        throw new Error('no such table: messages_in');
      }),
    ).toThrow('no such table');
    // A real schema error must surface immediately, not after 12 sleeps.
    expect(calls).toBe(1);
  });

  it('gives up after a bounded number of attempts and preserves the cause', () => {
    let calls = 0;
    let caught: unknown;
    try {
      withInboundDb(() => {
        calls += 1;
        throw new Error('database disk image is malformed');
      });
    } catch (err) {
      caught = err;
    }
    expect(calls).toBe(12);
    expect((caught as Error).message).toContain('unreadable after 12 attempts');
    expect((caught as Error).cause).toBeInstanceOf(Error);
  });
});
