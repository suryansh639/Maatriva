import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';

import { FieldDb, type LocalTask } from '../db';
import { completeTask, listOutbox } from '../outbox';
import { groupTasks, isTaskOverdue } from './TasksInbox';

function task(over: Partial<LocalTask> & Pick<LocalTask, 'id'>): LocalTask {
  return {
    mother_id: '00000000-0000-4000-8000-000000000001',
    alert_id: null,
    action_type: 'HOME_VISIT_48H',
    instructions: null,
    due_date: '2025-01-10',
    status: 'open',
    is_overdue: false,
    issued_by_id: 'doc',
    issued_by_name: 'Dr Demo',
    asha_id: 'asha',
    created_at: '2025-01-01T00:00:00Z',
    done_at: null,
    done_note: null,
    ...over,
  };
}

describe('isTaskOverdue', () => {
  it('is true only for open tasks due before today', () => {
    expect(isTaskOverdue(task({ id: 'a', due_date: '2025-01-09' }), '2025-01-10')).toBe(true);
    expect(isTaskOverdue(task({ id: 'a', due_date: '2025-01-10' }), '2025-01-10')).toBe(false);
    expect(isTaskOverdue(task({ id: 'a', due_date: '2025-01-09', status: 'done' }), '2025-01-10')).toBe(false);
    expect(isTaskOverdue(task({ id: 'a', due_date: '2025-01-09', status: 'cancelled' }), '2025-01-10')).toBe(false);
  });

  it('trusts the server is_overdue flag for open tasks', () => {
    expect(isTaskOverdue(task({ id: 'a', due_date: '2099-01-01', is_overdue: true }), '2025-01-10')).toBe(true);
  });
});

describe('groupTasks', () => {
  it('puts open tasks first by due date and closed tasks newest first', () => {
    const tasks = [
      task({ id: 'd1', status: 'done', done_at: '2025-01-03T00:00:00Z' }),
      task({ id: 'o2', due_date: '2025-01-12' }),
      task({ id: 'c1', status: 'cancelled', created_at: '2025-01-02T00:00:00Z' }),
      task({ id: 'o1', due_date: '2025-01-05' }),
      task({ id: 'd2', status: 'done', done_at: '2025-01-04T00:00:00Z' }),
    ];
    const { open, closed } = groupTasks(tasks);
    expect(open.map((t) => t.id)).toEqual(['o1', 'o2']);
    expect(closed.map((t) => t.id)).toEqual(['d2', 'd1', 'c1']);
  });

  it('handles an empty list', () => {
    expect(groupTasks([])).toEqual({ open: [], closed: [] });
  });
});

describe('marking a task done moves it to the closed group', () => {
  let db: FieldDb | null = null;
  afterEach(async () => {
    await db?.delete();
    db = null;
  });

  it('completes through the outbox with the note', async () => {
    db = new FieldDb(`tasks-inbox-${Math.random()}`);
    const id = '11111111-1111-4111-8111-111111111111';
    await db.tasks.put(task({ id }));

    await completeTask(db, id, '  visited, referred  ');

    const { open, closed } = groupTasks(await db.tasks.toArray());
    expect(open).toHaveLength(0);
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({ id, status: 'done', done_note: 'visited, referred', pending: true });
    const outbox = await listOutbox(db);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ entity: 'task', op: 'complete', entity_id: id });
  });
});
