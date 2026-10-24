/**
 * Closed-loop patient timeline (Req 22.6, 22.7). English only (Req 32.6).
 *
 * Renders `buildTimelineFromDetail` entries as an ordered list, oldest first.
 * A done task linked to an alert shows a "Loop closed" badge: an icon plus the
 * text, so it never relies on colour alone (the E2E script checks the text).
 */
import { formatIstHHMM, istDate } from '../shared/time';
import type { MotherDetailOut } from '../shared/types';
import { buildTimelineFromDetail, LOOP_CLOSED_LABEL } from './timeline';
import type { TimelineEntry, TimelineKind } from './timeline';

/** Kinds placed at 00:00 IST of a calendar date; shown without a time. */
const DATE_ONLY_KINDS: ReadonlySet<TimelineKind> = new Set<TimelineKind>(['visit', 'task_overdue', 'birth_outcome']);

const KIND_ICONS: Readonly<Record<TimelineKind, string>> = {
  visit: '●',
  alert_created: '▲',
  alert_acknowledged: '✔',
  task_issued: '➜',
  task_done: '✓',
  task_overdue: '⏰',
  alert_closed: '■',
  birth_outcome: '★',
};

/** "YYYY-MM-DD" (date-only kinds) or "YYYY-MM-DD HH:MM IST"; "Unknown time" when unparseable. */
export function formatTimelineTime(entry: Pick<TimelineEntry, 'at' | 'kind'>): string {
  if (!Number.isFinite(entry.at)) return 'Unknown time';
  const date = istDate(entry.at);
  return DATE_ONLY_KINDS.has(entry.kind) ? date : `${date} ${formatIstHHMM(entry.at)} IST`;
}

export interface TimelineProps {
  entries: readonly TimelineEntry[];
  /** Heading id, so the list can be labelled by it. */
  headingId?: string;
}

export function Timeline({ entries, headingId = 'patient-timeline-heading' }: TimelineProps) {
  return (
    <section className="pd-section timeline" aria-labelledby={headingId}>
      <h2 id={headingId}>Timeline</h2>
      {entries.length === 0 ? (
        <p className="pd-empty">No events yet.</p>
      ) : (
        <ol className="timeline__list">
          {entries.map((e) => (
            <li
              key={e.id}
              className={`timeline__item timeline__item--${e.kind}${e.loopClosed ? ' timeline__item--loop-closed' : ''}`}
              data-kind={e.kind}
            >
              <span className="timeline__icon" aria-hidden="true">
                {KIND_ICONS[e.kind]}
              </span>
              <div className="timeline__body">
                <time
                  className="timeline__time"
                  dateTime={Number.isFinite(e.at) ? new Date(e.at).toISOString() : undefined}
                >
                  {formatTimelineTime(e)}
                </time>
                <span className="timeline__label">{e.label}</span>
                {e.loopClosed ? (
                  <span className="loop-closed-badge" data-testid="loop-closed">
                    <span aria-hidden="true">✓ </span>
                    {LOOP_CLOSED_LABEL}
                  </span>
                ) : null}
                {e.detail ? <p className="timeline__detail">{e.detail}</p> : null}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** Builds and renders the timeline of a patient-detail response. */
export function PatientTimeline({ detail, today }: { detail: MotherDetailOut; today: string }) {
  return <Timeline entries={buildTimelineFromDetail(detail, today)} />;
}

export default Timeline;
