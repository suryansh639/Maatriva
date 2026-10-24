/**
 * Field database handle lifetime (task 18.8; Req 26.1, 37.7).
 */
import 'fake-indexeddb/auto';

import { afterEach, describe, expect, it } from 'vitest';

import { closeFieldDb, fieldDbName, openFieldDb, retainFieldDb } from './db';

/** A manual `defer` so each test decides when the deferred close runs. */
function manualDefer() {
  const queue: Array<() => void> = [];
  return {
    defer: (fn: () => void) => void queue.push(fn),
    flush: () => queue.splice(0).forEach((fn) => fn()),
  };
}

afterEach(() => closeFieldDb());

describe('openFieldDb', () => {
  it('names the database per user and reuses the handle for the same user', () => {
    const a = openFieldDb('user-a');
    expect(a.name).toBe(fieldDbName('user-a'));
    expect(openFieldDb('user-a')).toBe(a);
    const b = openFieldDb('user-b');
    expect(b).not.toBe(a);
    expect(b.name).toBe('maatriva-field-user-b');
  });
});

describe('retainFieldDb', () => {
  it('closes only after the last release, on the deferred tick', async () => {
    const db = openFieldDb('user-a');
    await db.open();
    const { defer, flush } = manualDefer();
    const release = retainFieldDb(db, defer);
    release();
    expect(db.isOpen()).toBe(true); // live queries may still be unsubscribing
    flush();
    expect(db.isOpen()).toBe(false);
    expect(openFieldDb('user-a')).not.toBe(db); // a later sign-in gets a fresh handle
  });

  it('keeps the handle open when it is retained again before the tick (StrictMode remount)', async () => {
    const db = openFieldDb('user-a');
    await db.open();
    const { defer, flush } = manualDefer();
    retainFieldDb(db, defer)();
    const release = retainFieldDb(db, defer);
    flush();
    expect(db.isOpen()).toBe(true);
    expect(openFieldDb('user-a')).toBe(db);
    release();
    release(); // a second call is a no-op
    flush();
    expect(db.isOpen()).toBe(false);
  });

  it('does not close the handle of another user opened in the meantime', async () => {
    const a = openFieldDb('user-a');
    const { defer, flush } = manualDefer();
    const release = retainFieldDb(a, defer);
    const b = openFieldDb('user-b'); // closes a, b is current
    await b.open();
    release();
    flush();
    expect(b.isOpen()).toBe(true);
    expect(openFieldDb('user-b')).toBe(b);
  });
});
