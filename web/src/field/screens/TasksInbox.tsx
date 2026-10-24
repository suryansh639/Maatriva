/**
 * Tasks inbox (Req 31.1–31.3, 32.1).
 *
 * A live list of the doctor's tasks from the local database (`useLiveQuery`):
 * - open tasks first, by due date. Each card shows the translated action label,
 *   the doctor's instructions, the mother (a link to her detail screen), who issued
 *   it and the due date. Overdue tasks carry an icon plus the word "Overdue", so the
 *   state never relies on colour alone.
 * - "Mark done" opens an optional note (at most 300 characters, `validateDoneNote`)
 *   and "Save as done" calls `completeTask`, which writes the task row and its outbox
 *   entry in one transaction. This works offline and online alike.
 * - done and cancelled tasks sit in a collapsed `<details>` section,
 *   "Done tasks ({n})", newest first. A completion not yet confirmed by a pull shows
 *   the "Not synced yet" marker.
 *
 * Stable hooks for the E2E script: every card is `data-testid="task-card"` with
 * `data-task-id`, `data-action-type` and `data-status`; the buttons have the exact
 * accessible names "Mark done" and "Save as done" (English).
 */
import { useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';

import { useI18n } from '../../shared/I18nProvider';
import { todayIST } from '../../shared/time';
import type { LocalTask } from '../db';
import { shortCode } from '../mothersList';
import { completeTask } from '../outbox';
import { motherPath } from '../paths';
import { useSync } from '../sync/SyncProvider';
import { DONE_NOTE_MAX, codePointLength, validateDoneNote } from '../validation';
import './tasks.css';

// ------------------------------------------------------------------ pure helpers

/** True for an open task whose due date is before `today` (IST "YYYY-MM-DD"). */
export function isTaskOverdue(task: Pick<LocalTask, 'status' | 'due_date' | 'is_overdue'>, today: string): boolean {
  return task.status === 'open' && (task.is_overdue || task.due_date < today);
}

export interface GroupedTasks<T> {
  /** Open tasks, earliest due date first (then oldest issued). */
  open: T[];
  /** Done and cancelled tasks, most recent first. */
  closed: T[];
}

/** Split tasks into the open list and the collapsed done/cancelled list. */
export function groupTasks<T extends Pick<LocalTask, 'id' | 'status' | 'due_date' | 'created_at' | 'done_at'>>(
  tasks: readonly T[],
): GroupedTasks<T> {
  const byId = (a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const open = tasks
    .filter((t) => t.status === 'open')
    .sort((a, b) => a.due_date.localeCompare(b.due_date) || a.created_at.localeCompare(b.created_at) || byId(a, b));
  const closed = tasks
    .filter((t) => t.status !== 'open')
    .sort((a, b) => {
      const ka = a.done_at ?? a.created_at;
      const kb = b.done_at ?? b.created_at;
      return kb.localeCompare(ka) || byId(a, b);
    });
  return { open, closed };
}

// ------------------------------------------------------------------ screen

interface InboxData {
  tasks: LocalTask[];
  motherNames: Map<string, string>;
}

export function TasksInbox() {
  const { t } = useI18n();
  const { db } = useSync();
  const [announcement, setAnnouncement] = useState('');

  const data = useLiveQuery<InboxData>(
    async () => {
      const [tasks, mothers] = await Promise.all([db.tasks.toArray(), db.mothers.toArray()]);
      return { tasks, motherNames: new Map(mothers.map((m) => [m.id, m.full_name])) };
    },
    [db],
  );

  if (!data) {
    return (
      <section className="field-screen tasks-inbox" aria-labelledby="tasks-title">
        <h1 id="tasks-title">{t('field.tasks.title')}</h1>
        <p>{t('field.common.loading')}</p>
      </section>
    );
  }

  const today = todayIST();
  const { open, closed } = groupTasks(data.tasks);
  const motherName = (id: string) => data.motherNames.get(id) ?? shortCode(id);

  return (
    <section className="field-screen tasks-inbox" aria-labelledby="tasks-title" data-testid="tasks-inbox">
      <h1 id="tasks-title">{t('field.tasks.title')}</h1>

      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>

      {data.tasks.length === 0 ? (
        <p className="tasks-inbox__empty">{t('field.tasks.empty')}</p>
      ) : (
        <>
          <h2 className="tasks-inbox__heading">{t('field.tasks.open')}</h2>
          {open.length === 0 ? (
            <p className="tasks-inbox__empty">{t('field.tasks.empty')}</p>
          ) : (
            <ul className="tasks-inbox__list" data-testid="open-tasks">
              {open.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  motherName={motherName(task.mother_id)}
                  overdue={isTaskOverdue(task, today)}
                  onDone={setAnnouncement}
                />
              ))}
            </ul>
          )}

          {closed.length > 0 ? (
            <details className="tasks-inbox__done" data-testid="done-tasks">
              <summary>{t('field.tasks.done', { n: closed.length })}</summary>
              <ul className="tasks-inbox__list">
                {closed.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    motherName={motherName(task.mother_id)}
                    overdue={false}
                    onDone={setAnnouncement}
                  />
                ))}
              </ul>
            </details>
          ) : null}
        </>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ one task

interface TaskCardProps {
  task: LocalTask;
  motherName: string;
  overdue: boolean;
  /** Receives the text to announce after a successful completion. */
  onDone: (message: string) => void;
}

function TaskCard({ task, motherName, overdue, onDone }: TaskCardProps) {
  const { t, actionLabel } = useI18n();
  const { db } = useSync();
  const uid = useId();
  const titleId = `${uid}-title`;
  const noteId = `${uid}-note`;
  const noteErrorId = `${uid}-note-error`;
  const saveErrorId = `${uid}-save-error`;

  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const markDoneRef = useRef<HTMLButtonElement>(null);

  const noteError = validateDoneNote(note);
  const label = actionLabel(task.action_type);
  const isOpen = task.status === 'open';

  const startEditing = () => {
    setEditing(true);
    setSaveError(false);
  };

  const cancel = () => {
    setEditing(false);
    setNote('');
    setSaveError(false);
    // Return focus to the button that opened the note.
    requestAnimationFrame(() => markDoneRef.current?.focus());
  };

  const save = async () => {
    if (noteError || saving) return;
    setSaving(true);
    setSaveError(false);
    try {
      const updated = await completeTask(db, task.id, note);
      onDone(`${label}: ${t('field.tasks.doneOn', { date: (updated.done_at ?? '').slice(0, 10) })}`);
      // The card re-renders in the done section through the live query.
    } catch (err) {
      console.warn('could not complete task', err);
      setSaveError(true);
      setSaving(false);
    }
  };

  const classes = ['task-card', `task-card--${task.status}`];
  if (overdue) classes.push('task-card--overdue');

  return (
    <li
      className={classes.join(' ')}
      data-testid="task-card"
      data-task-id={task.id}
      data-action-type={task.action_type}
      data-status={task.status}
      aria-labelledby={titleId}
    >
      <h3 className="task-card__title" id={titleId}>
        {label}
      </h3>

      <div className="task-card__tags">
        {overdue ? (
          <span className="task-tag task-tag--overdue" data-testid="task-overdue">
            <span aria-hidden="true">⚠ </span>
            {t('field.tasks.overdue')}
          </span>
        ) : null}
        {task.status === 'cancelled' ? (
          <span className="task-tag task-tag--cancelled" data-testid="task-cancelled">
            <span aria-hidden="true">✕ </span>
            {t('field.tasks.cancelled')}
          </span>
        ) : null}
        {task.status === 'done' ? (
          <span className="task-tag task-tag--done">
            <span aria-hidden="true">✓ </span>
            {t('field.tasks.doneOn', { date: (task.done_at ?? '').slice(0, 10) })}
          </span>
        ) : null}
        {task.pending ? (
          <span className="task-tag task-tag--pending" data-testid="task-pending">
            <span aria-hidden="true">⟳ </span>
            {t('field.common.pendingMarker')}
          </span>
        ) : null}
      </div>

      {task.instructions ? (
        <p className="task-card__instructions" lang="en">
          {task.instructions}
        </p>
      ) : null}

      <p className="task-card__meta">
        <Link to={motherPath(task.mother_id)} className="task-card__mother">
          {t('field.tasks.forMother', { name: motherName })}
        </Link>
      </p>
      {task.issued_by_name ? (
        <p className="task-card__meta">{t('field.tasks.issuedBy', { name: task.issued_by_name })}</p>
      ) : null}
      <p className="task-card__meta">
        <time dateTime={task.due_date}>{t('field.tasks.due', { date: task.due_date })}</time>
      </p>
      {task.status === 'done' && task.done_note ? <p className="task-card__note">{task.done_note}</p> : null}

      {isOpen && !editing ? (
        <button
          ref={markDoneRef}
          type="button"
          className="btn btn--primary task-card__action"
          data-testid="task-mark-done"
          aria-describedby={titleId}
          onClick={startEditing}
        >
          <span aria-hidden="true">✓ </span>
          {t('field.tasks.markDone')}
        </button>
      ) : null}

      {isOpen && editing ? (
        <div className="task-card__form">
          <label htmlFor={noteId}>{t('field.tasks.note')}</label>
          <textarea
            id={noteId}
            className="task-card__textarea"
            value={note}
            rows={3}
            autoFocus
            data-testid="task-done-note"
            aria-invalid={noteError ? true : undefined}
            aria-describedby={noteError ? noteErrorId : undefined}
            onChange={(e) => setNote(e.target.value)}
          />
          <p className="task-card__counter" aria-hidden="true">
            {codePointLength(note)}/{DONE_NOTE_MAX}
          </p>
          {noteError ? (
            <p className="task-card__error" id={noteErrorId}>
              {t(noteError)}
            </p>
          ) : null}
          {saveError ? (
            <p className="task-card__error" id={saveErrorId} role="alert">
              {t('field.error.saveFailed')}
            </p>
          ) : null}
          <div className="task-card__buttons">
            <button
              type="button"
              className="btn btn--primary"
              data-testid="task-save-done"
              disabled={Boolean(noteError) || saving}
              aria-describedby={saveError ? `${titleId} ${saveErrorId}` : titleId}
              onClick={() => void save()}
            >
              {t('field.tasks.confirmDone')}
            </button>
            <button type="button" className="btn" onClick={cancel} disabled={saving}>
              {t('field.common.cancel')}
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

export default TasksInbox;
