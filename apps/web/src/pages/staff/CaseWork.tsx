/**
 * One case, and what the signed-in person can do about it.
 *
 * The page leads with the reasoning — which rule fired and why, or an explicit statement that
 * no rule did and the level is only the model's suggestion — because a coloured badge with no
 * justification trains people to obey it blindly or ignore it. Actions are shown per role, but
 * the server enforces every one of them; hiding a button is courtesy, not control.
 */

import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { api, type CaseDetail, type CaseEvent, type DeliveryResult, type Doctor, type Me } from '../../api';
import { Badge, Card, ErrorLine, ageLabel, clock, dateTime, humanise, useAction } from '../../ui';

type StaffMe = Extract<Me, { kind: 'staff' }>;

interface FiredRule {
  id: string;
  title: string;
  detail: string;
  rationale?: string;
}

const STATUS_LABEL = {
  open: 'Needs review',
  awaiting_patient: 'Waiting on patient',
  with_doctor: 'With doctor',
  closed: 'Closed',
} as const;

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function deliveryNote(delivery: unknown): string | null {
  if (typeof delivery !== 'object' || delivery === null) return null;
  const d = delivery as Partial<DeliveryResult>;
  if (d.channel === 'whatsapp' && d.delivered === true) return 'Delivered on WhatsApp';
  if (d.channel === 'whatsapp' && d.outsideWindow === true) return 'WhatsApp window closed — patient sees it in the portal';
  if (d.channel === 'whatsapp') return 'WhatsApp failed — patient sees it in the portal';
  return 'Shown in the patient portal';
}

function Entry({ event }: { event: CaseEvent }) {
  const d = event.data;
  const staffName = str(d['staffName']);
  let title: string;
  let who: string;
  let body: string | undefined;
  let extra: string | null = null;
  let tone = '';

  switch (event.type) {
    case 'case.opened':
      title = `Case opened via ${str(d['channel']) ?? 'unknown channel'}`;
      who = 'system';
      break;
    case 'message.received':
      title = `Patient wrote${d['channel'] === 'web' ? ' (portal)' : ''}`;
      who = 'patient';
      body = str(d['text']);
      tone = 'from-patient';
      break;
    case 'extraction.completed': {
      const failure = str(d['failure']);
      const codes = Array.isArray(d['symptoms']) ? (d['symptoms'] as { code?: string }[]).map((s) => s.code).filter(Boolean) : [];
      title = failure !== undefined ? `Extraction failed (${failure}) — rules ran on the raw words` : codes.length > 0 ? `Extracted: ${codes.map((c) => humanise(String(c))).join(', ')}` : 'Nothing extracted from this message';
      who = 'intake-pipeline';
      tone = 'system';
      break;
    }
    case 'safety.evaluated': {
      const suggestion = str(d['aiSuggestion']);
      title = `Safety kernel: ${String(d['level'])}${d['escalatedFromAi'] === true ? ` — rules overruled the model (${suggestion ?? '?'})` : suggestion !== undefined ? ` · model said ${suggestion}` : ''}${d['heldAbove'] === true ? ` · case held at ${String(d['caseLevel'])}` : ''}`;
      who = event.actor.component ?? 'safety-kernel';
      tone = 'system';
      break;
    }
    case 'reply.sent':
      title = `Automatic reply (${str(d['reason']) ?? 'reply'})`;
      who = 'reply-policy';
      body = str(d['text']);
      tone = 'system collapsed';
      break;
    case 'reply.suppressed':
      title = `No automatic reply${d['failed'] === true ? ' — delivery failed' : ''} (${str(d['reason']) ?? ''})`;
      who = 'reply-policy';
      tone = 'system';
      break;
    case 'note.added':
      title = 'Internal note — not visible to the patient';
      who = staffName ?? 'staff';
      body = str(d['text']);
      tone = 'note';
      break;
    case 'question.sent':
      title = 'Asked the patient';
      who = staffName ?? 'staff';
      body = str(d['text']);
      extra = deliveryNote(d);
      tone = 'from-staff';
      break;
    case 'case.routed':
      title = `Sent to ${str(d['doctorName']) ?? 'any doctor'}`;
      who = staffName ?? 'staff';
      body = str(d['reason']);
      tone = 'from-staff';
      break;
    case 'assessment.signed':
      title = `Assessment signed · BMDC ${str(d['bmdcRegNo']) ?? '?'}`;
      who = staffName ?? 'doctor';
      tone = 'signed';
      break;
    case 'case.closed':
      title = 'Case closed';
      who = staffName ?? 'staff';
      body = str(d['reason']);
      break;
    default:
      title = event.type;
      who = event.actor.kind;
  }

  return (
    <li className={`entry ${tone}`}>
      <span className="when">{clock(event.at)}</span>
      <div>
        <div className="entry-title">{title}</div>
        <div className="entry-who">{who}</div>
        {event.type === 'assessment.signed' ? (
          <div className="signed-body">
            <div>
              <span className="label">Assessment</span>
              {str(d['assessment'])}
            </div>
            <div>
              <span className="label">Plan</span>
              {str(d['plan'])}
            </div>
            {str(d['patientAdvice']) !== undefined && (
              <div>
                <span className="label">Advice sent to patient</span>
                {str(d['patientAdvice'])}
                {deliveryNote(d['delivery']) !== null && <span className="dim small"> · {deliveryNote(d['delivery'])}</span>}
              </div>
            )}
          </div>
        ) : (
          body !== undefined && <div className="bubble">{body}</div>
        )}
        {extra !== null && <div className="dim small">{extra}</div>}
      </div>
    </li>
  );
}

type Tab = 'ask' | 'note' | 'route' | 'assess' | 'close';

export function CaseWork({ me, id, back }: { me: StaffMe; id: string; back: () => void }) {
  const [detail, setDetail] = useState<CaseDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [tab, setTab] = useState<Tab>(me.role === 'doctor' ? 'assess' : 'ask');
  const [flash, setFlash] = useState<string | null>(null);

  const [question, setQuestion] = useState('');
  const [note, setNote] = useState('');
  const [routeReason, setRouteReason] = useState('');
  const [routeDoctor, setRouteDoctor] = useState('');
  const [assessment, setAssessment] = useState('');
  const [plan, setPlan] = useState('');
  const [advice, setAdvice] = useState('');
  const [closeReason, setCloseReason] = useState('');

  const action = useAction();

  const load = useCallback(() => {
    api
      .caseDetail(id)
      .then((result) => {
        setDetail(result);
        setLoadError(null);
      })
      .catch((e: unknown) => setLoadError(e instanceof Error ? e.message : String(e)));
  }, [id]);

  useEffect(() => {
    load();
    api
      .doctors()
      .then((result) => setDoctors(result.doctors))
      .catch(() => setDoctors([]));
    const timer = window.setInterval(load, 15_000);
    return () => window.clearInterval(timer);
  }, [load]);

  if (loadError !== null) return <ErrorLine message={loadError} />;
  if (detail === null) return <p className="dim">Loading…</p>;

  const { case: item, patient, events, history } = detail;
  const closed = item.status === 'closed';
  // The level reflects the whole case — a case never drops through automation — so the
  // explanation has to as well: every rule that has fired on it, and the most urgent thing a
  // model ever proposed for it. Reading only the latest message would explain the wrong level.
  const evaluations = events.filter((event) => event.type === 'safety.evaluated');
  const rules = [
    ...new Map(
      evaluations.flatMap((event) => (Array.isArray(event.data['firedRules']) ? (event.data['firedRules'] as FiredRule[]) : [])).map((rule) => [rule.id, rule]),
    ).values(),
  ];
  const RANK: Record<string, number> = { GREEN: 0, YELLOW: 1, RED: 2, BLACK: 3 };
  const modelSuggestion = evaluations
    .map((event) => str(event.data['aiSuggestion']))
    .filter((level): level is string => level !== undefined)
    .sort((a, b) => (RANK[b] ?? 0) - (RANK[a] ?? 0))[0];
  const signed = events.some((event) => event.type === 'assessment.signed');
  const coordinatorBlockedFromClosing = me.role === 'coordinator' && item.level !== 'GREEN' && !signed;

  async function submit(event: FormEvent, work: () => Promise<string>, reset: () => void) {
    event.preventDefault();
    setFlash(null);
    let message = '';
    const ok = await action.run(async () => {
      message = await work();
    });
    if (ok) {
      reset();
      setFlash(message);
      load();
    }
  }

  const tabs: { key: Tab; label: string }[] =
    me.role === 'doctor'
      ? [
          { key: 'assess', label: 'Assess & sign' },
          { key: 'ask', label: 'Ask patient' },
          { key: 'note', label: 'Note' },
          { key: 'close', label: 'Close' },
        ]
      : [
          { key: 'ask', label: 'Ask patient' },
          { key: 'route', label: 'Send to doctor' },
          { key: 'note', label: 'Note' },
          { key: 'close', label: 'Close' },
        ];

  return (
    <>
      <button className="link back" onClick={back}>
        ← Back to queue
      </button>

      <div className="case-head">
        <Badge level={item.level} />
        <div>
          <h1>{patient?.displayName ?? 'Unknown patient'}</h1>
          <p className="dim">
            {ageLabel(patient?.ageMonths)} · opened {dateTime(item.openedAt)} · <span className={`status ${item.status}`}>{STATUS_LABEL[item.status]}</span>
            {detail.assignedDoctor !== null && <> · {detail.assignedDoctor}</>}
          </p>
        </div>
      </div>

      <div className="workspace">
        <div className="main-col">
          {rules.length > 0 ? (
            <Card title="Why this level" tone="warn">
              {rules.map((rule) => (
                <div className="rule" key={rule.id}>
                  <div className="rule-title">{rule.title}</div>
                  <div>{rule.detail}</div>
                  {rule.rationale !== undefined && <div className="dim small">{rule.rationale}</div>}
                </div>
              ))}
            </Card>
          ) : item.level !== 'GREEN' ? (
            <Card title="Why this level" tone="warn">
              <p>
                <strong>No rule fired.</strong> This case is {item.level} because the language model proposed {modelSuggestion ?? 'it'} on one of its messages.
                Automated checks never lower a case’s level — only a person can.
              </p>
              <p className="dim small">Treat it as a prompt to look, not a finding. A model suggestion has not been reviewed by anyone; a fired rule has.</p>
            </Card>
          ) : (
            <Card title="Why this level" tone="calm">
              <p className="dim">No danger sign matched any rule. A person should still read the case.</p>
            </Card>
          )}

          <Card title="Reported">
            {item.symptomCodes.length > 0 ? (
              <div className="tags">
                {item.symptomCodes.map((code) => (
                  <span key={code} className="tag">
                    {humanise(code)}
                  </span>
                ))}
              </div>
            ) : (
              <p className="dim">No symptoms extracted yet.</p>
            )}
            {item.missing.length > 0 && (
              <>
                <h4>Still to ask</h4>
                <ul className="plain">
                  {item.missing.map((q) => (
                    <li key={q}>{q}</li>
                  ))}
                </ul>
              </>
            )}
          </Card>

          <Card title="Conversation and activity">
            <ul className="timeline">
              {events.map((event) => (
                <Entry key={event.id} event={event} />
              ))}
            </ul>
          </Card>

          {history.length > 0 && (
            <Card title="Earlier cases">
              <ul className="plain">
                {history.map((past) => (
                  <li key={past.id}>
                    <Badge level={past.level} /> {new Date(past.openedAt).toLocaleDateString()} · {past.symptomCodes.map(humanise).join(', ') || 'no symptoms recorded'}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>

        <aside className="side-col">
          {closed ? (
            <Card title="Closed">
              <p className="dim">This case is closed. A new message from the patient opens a new case.</p>
            </Card>
          ) : (
            <section className="card actions">
              <div className="action-tabs" role="tablist">
                {tabs.map((t) => (
                  <button
                    key={t.key}
                    role="tab"
                    aria-selected={tab === t.key}
                    className={tab === t.key ? 'active' : ''}
                    onClick={() => {
                      setTab(t.key);
                      action.clear();
                      setFlash(null);
                    }}
                  >
                    {t.label}
                  </button>
                ))}
              </div>

              {tab === 'ask' && (
                <form
                  className="stack"
                  onSubmit={(e) =>
                    void submit(
                      e,
                      async () => deliveryNote((await api.askPatient(id, question)).delivery) ?? 'Sent',
                      () => setQuestion(''),
                    )
                  }
                >
                  {item.missing.length > 0 && (
                    <div className="chips small">
                      {item.missing.map((q) => (
                        <button type="button" key={q} className="chip" onClick={() => setQuestion(q)}>
                          {q}
                        </button>
                      ))}
                    </div>
                  )}
                  <textarea value={question} onChange={(e) => setQuestion(e.target.value)} rows={4} placeholder="Ask the patient something…" />
                  {me.role === 'coordinator' && (
                    <p className="hint">Questions only. Reassurance and dosing are blocked — they are a doctor’s call.</p>
                  )}
                  <button className="primary" disabled={action.busy || question.trim() === ''}>
                    Send to patient
                  </button>
                </form>
              )}

              {tab === 'note' && (
                <form className="stack" onSubmit={(e) => void submit(e, async () => (await api.addNote(id, note), 'Note added'), () => setNote(''))}>
                  <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={4} placeholder="Visible to staff only." />
                  <button className="primary" disabled={action.busy || note.trim() === ''}>
                    Add note
                  </button>
                </form>
              )}

              {tab === 'route' && (
                <form
                  className="stack"
                  onSubmit={(e) =>
                    void submit(
                      e,
                      async () => (await api.routeToDoctor(id, routeReason, routeDoctor === '' ? null : routeDoctor), 'Sent to doctor'),
                      () => setRouteReason(''),
                    )
                  }
                >
                  <label>
                    Doctor
                    <select value={routeDoctor} onChange={(e) => setRouteDoctor(e.target.value)}>
                      <option value="">Any available doctor</option>
                      {doctors.map((doctor) => (
                        <option key={doctor.id} value={doctor.id}>
                          {doctor.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <textarea value={routeReason} onChange={(e) => setRouteReason(e.target.value)} rows={3} placeholder="Why this needs a doctor…" />
                  <button className="primary" disabled={action.busy || routeReason.trim() === ''}>
                    Send to doctor
                  </button>
                </form>
              )}

              {tab === 'assess' && (
                <form
                  className="stack"
                  onSubmit={(e) =>
                    void submit(
                      e,
                      async () => {
                        const result = await api.signAssessment(id, assessment, plan, advice);
                        return result.delivery === null ? 'Assessment signed' : `Signed · ${deliveryNote(result.delivery) ?? ''}`;
                      },
                      () => {
                        setAssessment('');
                        setPlan('');
                        setAdvice('');
                      },
                    )
                  }
                >
                  <label>
                    Assessment <span className="dim small">· clinicians only</span>
                    <textarea value={assessment} onChange={(e) => setAssessment(e.target.value)} rows={3} />
                  </label>
                  <label>
                    Plan <span className="dim small">· clinicians only</span>
                    <textarea value={plan} onChange={(e) => setPlan(e.target.value)} rows={3} />
                  </label>
                  <label>
                    Advice to the patient <span className="dim small">· sent to them, plain words</span>
                    <textarea value={advice} onChange={(e) => setAdvice(e.target.value)} rows={3} />
                  </label>
                  <p className="hint">Signing as {me.name} · BMDC {me.bmdcRegNo ?? '—'}</p>
                  <button className="primary" disabled={action.busy || assessment.trim() === '' || plan.trim() === ''}>
                    Sign assessment
                  </button>
                </form>
              )}

              {tab === 'close' && (
                <form className="stack" onSubmit={(e) => void submit(e, async () => (await api.closeCase(id, closeReason), 'Case closed'), () => setCloseReason(''))}>
                  {coordinatorBlockedFromClosing ? (
                    <p className="hint warn">
                      This case is {item.level} and no doctor has signed it off. A coordinator can’t close it — send it to a doctor instead.
                    </p>
                  ) : (
                    <textarea value={closeReason} onChange={(e) => setCloseReason(e.target.value)} rows={3} placeholder="Reason for closing…" />
                  )}
                  <button className="danger" disabled={action.busy || coordinatorBlockedFromClosing || closeReason.trim() === ''}>
                    Close case
                  </button>
                </form>
              )}

              <ErrorLine message={action.error} />
              {flash !== null && (
                <p className="ok" role="status">
                  ✓ {flash}
                </p>
              )}
            </section>
          )}

          {detail.viewedBy.length > 0 && (
            <Card title="Opened by">
              <ul className="plain small">
                {detail.viewedBy.map((line) => {
                  const [name, at] = line.split(' · ');
                  return (
                    <li key={line}>
                      {name} <span className="dim">· {at === undefined ? '' : dateTime(at)}</span>
                    </li>
                  );
                })}
              </ul>
              <p className="dim small">Every opening of this record is logged.</p>
            </Card>
          )}
        </aside>
      </div>
    </>
  );
}
