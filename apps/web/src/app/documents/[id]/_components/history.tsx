'use client';

import { useEffect, useState } from 'react';
import { ClockCounterClockwise } from '@phosphor-icons/react';
import { removedNotice } from '@/lib/sanitized';
import { SpotArt } from '@/components/art';
import { ActionIcon, actionMeta } from '@/components/audit-ui';
import { Badge, Card, EmptyState, LoadError, OUTCOME_TONE, SkeletonRows, cx, relativeTime, staggerClass } from '@/components/ui';
import { api, errorText, formatDate } from '@/lib/api';
import { CAPTURE_METHOD_LABEL, type CaptureMethod } from '@/lib/capture-guard';

interface HistoryEvent { seq: string; occurredAt: string; actorEmail: string | null; action: string; outcome: 'ALLOWED' | 'DENIED' | 'FAILED'; reason: string | null; details?: { sanitized?: { removed?: string[] } } | null }

/** A capture attempt names its method: "Tried to take a screenshot (Print Screen)" (THREATS.md V11). */
function historyLabel(e: HistoryEvent): string {
  if (e.action === 'document.capture_attempt') {
    const how = CAPTURE_METHOD_LABEL[e.reason as CaptureMethod];
    return how ? `Tried to take a screenshot (${how})` : 'Tried to take a screenshot';
  }
  return actionMeta(e.action).label;
}

export function History({ docId }: { docId: string }) {
  const [events, setEvents] = useState<HistoryEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setLoading(true);
    api.get<{ events: HistoryEvent[] }>(`/documents/${docId}/history`)
      .then((r) => { if (live) { setEvents(r.events); setError(null); } })
      // A failure is an error with Retry, never "No activity yet" (P8).
      .catch((err) => { if (live) setError(errorText(err)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [docId, attempt]);
  return (
    <Card title="History" icon={<ClockCounterClockwise size={20} />} description="Everything that happened to this document, including refused attempts." padded={false}>
      {error && !events ? (
        <div className="p-5"><LoadError compact title="Couldn't load the history" error={error} retrying={loading} onRetry={() => setAttempt((a) => a + 1)} /></div>
      ) : !events ? <SkeletonRows rows={5} label="Loading the history…" /> : events.length === 0 ? (
        <EmptyState art={<SpotArt icon={<ClockCounterClockwise size={30} />} />} title="No activity yet" />
      ) : (
        <ol className="max-h-[36rem] animate-fade-in overflow-y-auto px-5 py-4">
          {events.map((e, i) => (
            <li key={e.seq} className={cx('relative flex animate-rise gap-3 pb-5 last:pb-0', staggerClass(i))}>
              {i < events.length - 1 && <span className="absolute left-4 top-9 h-[calc(100%-2rem)] w-px bg-line-strong" />}
              <ActionIcon action={e.action} outcome={e.outcome} />
              <div className="min-w-0 flex-1 pt-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-semibold">{historyLabel(e)}</p>
                  {e.outcome !== 'ALLOWED' && <Badge tone={OUTCOME_TONE[e.outcome]}>{e.outcome === 'DENIED' ? 'Refused' : 'Failed'}</Badge>}
                </div>
                <p className="mt-0.5 break-words text-xs text-fg-subtle">
                  {e.actorEmail ?? 'system'} · <span title={formatDate(e.occurredAt)}>{relativeTime(e.occurredAt)}</span>
                  {e.reason && e.action !== 'document.capture_attempt' && <> · {e.reason.replace(/_/g, ' ')}</>}
                </p>
                {removedNotice(e.details?.sanitized?.removed) && <p className="mt-0.5 text-xs text-fg-subtle">{removedNotice(e.details?.sanitized?.removed)}</p>}
              </div>
              <span className="hidden pt-1 font-mono text-[0.6875rem] text-fg-subtle sm:block">#{e.seq}</span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
