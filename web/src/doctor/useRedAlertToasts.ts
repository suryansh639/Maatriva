/**
 * RED alert toasts (Req 19.8; design §17 table).
 *
 * Subscribes to the live stream and shows a "RED alert" toast with an
 * "Open patient" button for every RED `alert.created`, and a "RED alert updated"
 * toast for an `alert.updated` with new codes (see `toastForEvent`).
 *
 * `DoctorLayout` calls this once for the shared stream, so a doctor gets the toast
 * on every doctor page (dashboard, patient detail, digest) and never twice. Pages
 * must not call it again for the same stream.
 */
import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useToasts } from '../shared/Toasts';
import { toastForEvent } from './dashboardLive';
import type { LiveEventsState } from './live/useLiveEvents';
import { patientPath } from './TriageQueue';

export function useRedAlertToasts(subscribe: LiveEventsState['subscribe']): void {
  const { push } = useToasts();
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  useEffect(
    () =>
      subscribe((ev) => {
        const toast = toastForEvent(ev);
        if (!toast) return;
        push({
          title: toast.title,
          message: toast.message,
          tone: 'danger',
          actionLabel: 'Open patient',
          onAction: () => navigateRef.current(patientPath(toast.motherId)),
        });
      }),
    [subscribe, push],
  );
}
