/**
 * The queue.
 *
 * Most urgent first, then longest waiting first within a level — a queue that reorders by
 * recency starves whoever has waited longest. It refreshes itself, because a queue that only
 * updates on reload is a queue people stop trusting.
 */

import { useCallback, useEffect, useState } from 'react';

import { api, type CaseStatus, type CaseSummary, type Me } from '../../api';
import { Badge, ErrorLine, ageLabel, humanise, waitedFor } from '../../ui';

type StaffMe = Extract<Me, { kind: 'staff' }>;

const RANK = { BLACK: 3, RED: 2, YELLOW: 1, GREEN: 0 } as const;

const STATUS_LABEL: Record<CaseStatus, string> = {
  open: 'Needs review',
  awaiting_patient: 'Waiting on patient',
  with_doctor: 'With doctor',
  closed: 'Closed',
};

type Filter = 'all' | CaseStatus | 'mine';

export function Queue({ me, openCase, initialFilter }: { me: StaffMe; openCase: (id: string) => void; initialFilter: Filter }) {
  const [filter, setFilter] = useState<Filter>(initialFilter);
  const [cases, setCases] = useState<CaseSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setFilter(initialFilter), [initialFilter]);

  const load = useCallback(() => {
    const request =
      filter === 'mine' ? api.queue('with_doctor', true) : filter === 'all' ? api.queue() : api.queue(filter);
    request
      .then((result) => {
        setCases(
          [...result.cases].sort((a, b) => RANK[b.level] - RANK[a.level] || a.updatedAt.localeCompare(b.updatedAt)),
        );
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [filter]);

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 10_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const filters: { value: Filter; label: string }[] =
    me.role === 'doctor'
      ? [
          { value: 'with_doctor', label: 'Waiting for a doctor' },
          { value: 'mine', label: 'Assigned to me' },
          { value: 'all', label: 'All open' },
        ]
      : [
          { value: 'all', label: 'All open' },
          { value: 'open', label: 'Needs review' },
          { value: 'awaiting_patient', label: 'Waiting on patient' },
          { value: 'with_doctor', label: 'With doctor' },
        ];

  const urgent = cases?.filter((item) => item.level === 'RED' || item.level === 'BLACK').length ?? 0;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{me.role === 'doctor' ? 'Cases for a doctor' : 'Queue'}</h1>
          <p className="dim">Most urgent first · longest waiting first within a level · refreshes every 10 s</p>
        </div>
        {urgent > 0 && (
          <div className="alert-pill" role="status">
            {urgent} urgent
          </div>
        )}
      </div>

      <div className="chips">
        {filters.map((option) => (
          <button key={option.value} className={filter === option.value ? 'chip active' : 'chip'} onClick={() => setFilter(option.value)}>
            {option.label}
          </button>
        ))}
      </div>

      <ErrorLine message={error} />
      {cases === null && <p className="dim">Loading…</p>}
      {cases !== null && cases.length === 0 && <p className="empty">Nothing here. New WhatsApp messages appear automatically.</p>}

      <div className="list">
        {cases?.map((item) => (
          <button key={item.id} className={`row level-${item.level}`} onClick={() => openCase(item.id)}>
            <span className="row-level">
              <Badge level={item.level} />
            </span>
            <span className="row-main">
              <span className="row-title">
                {item.patient?.displayName ?? 'Unknown patient'}
                <span className="dim"> · {ageLabel(item.patient?.ageMonths)}</span>
              </span>
              {item.symptomCodes.length > 0 ? (
                <span className="tags">
                  {item.symptomCodes.map((code) => (
                    <span key={code} className="tag">
                      {humanise(code)}
                    </span>
                  ))}
                </span>
              ) : (
                <span className="dim small">No symptoms extracted yet</span>
              )}
            </span>
            <span className="row-meta">
              <span className={`status ${item.status}`}>{STATUS_LABEL[item.status]}</span>
              <span className="dim small">waiting {waitedFor(item.updatedAt)}</span>
              {item.assignedDoctor !== null && <span className="dim small">{item.assignedDoctor}</span>}
            </span>
          </button>
        ))}
      </div>
    </>
  );
}
