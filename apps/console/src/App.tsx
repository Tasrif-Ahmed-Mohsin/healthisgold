/**
 * The coordinator console.
 *
 * The design goal is not "show the data" — it is **show the reasoning**. A coordinator
 * deciding whether to escalate needs to see which rule fired and why, in plain language,
 * next to the patient's own words. A screen that shows a red badge and no justification
 * teaches people to either obey it blindly or ignore it, and both are worse than no screen.
 */

import { useCallback, useEffect, useState } from 'react';

import { ApiError, api, clearToken, getToken, setToken, type CaseDetail, type CaseEvent, type CaseSummary, type TriageLevel } from './api';

const LEVEL_ORDER: Record<TriageLevel, number> = { BLACK: 3, RED: 2, YELLOW: 1, GREEN: 0 };

function waitedFor(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d`;
}

function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function ageLabel(ageMonths: number | null): string {
  if (ageMonths === null) return 'age unknown';
  if (ageMonths < 24) return `${ageMonths} months`;
  return `${Math.floor(ageMonths / 12)} years`;
}

function TokenGate({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (value.trim() === '') {
      setError('Enter the console token.');
      return;
    }
    setChecking(true);
    setError(null);
    const ok = await api.verifyToken(value.trim()).catch(() => false);
    setChecking(false);
    if (!ok) {
      setError('That token was not accepted.');
      return;
    }
    setToken(value.trim());
    onAuthenticated();
  }

  return (
    <div className="gate">
      <h1>Coordinator console</h1>
      <p>
        This screen shows patient health records. Enter the console token — it is the value of{' '}
        <code>CONSOLE_TOKEN</code> in the server's <code>.env</code>.
      </p>
      <form onSubmit={submit}>
        <input
          type="password"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          placeholder="Console token"
          autoFocus
        />
        {error !== null && <span className="error">{error}</span>}
        <button type="submit" disabled={checking}>
          {checking ? 'Checking…' : 'Open the queue'}
        </button>
      </form>
    </div>
  );
}

function CaseRow({ item, onOpen }: { item: CaseSummary; onOpen: (id: string) => void }) {
  return (
    <button className="card case-row" onClick={() => onOpen(item.id)}>
      <span>
        <span className={`badge ${item.level}`}>{item.level}</span>
      </span>
      <span>
        <span className="meta">
          {item.patient?.displayName ?? 'Unknown patient'} · {ageLabel(item.patient?.ageMonths ?? null)}
        </span>
        {item.symptomCodes.length > 0 ? (
          <ul className="symptoms">
            {item.symptomCodes.map((code) => (
              <li key={code}>{code.replaceAll('_', ' ')}</li>
            ))}
          </ul>
        ) : (
          <div className="meta">no symptoms extracted yet</div>
        )}
      </span>
      <span className="right meta">
        waiting {waitedFor(item.updatedAt)}
        {item.missing.length > 0 && (
          <>
            <br />
            {item.missing.length} question{item.missing.length === 1 ? '' : 's'} open
          </>
        )}
      </span>
    </button>
  );
}

function describeEvent(event: CaseEvent): { what: string; said?: string } {
  const data = event.data;
  switch (event.type) {
    case 'case.opened':
      return { what: 'Case opened' };
    case 'message.received':
      return { what: 'Patient wrote', said: typeof data['text'] === 'string' ? data['text'] : undefined };
    case 'extraction.completed': {
      const symptoms = Array.isArray(data['symptoms'])
        ? (data['symptoms'] as { code?: string }[]).map((s) => s.code).filter(Boolean)
        : [];
      const failure = data['failure'];
      if (typeof failure === 'string') return { what: `Extraction failed (${failure}) — kernel ran on raw text` };
      return { what: symptoms.length > 0 ? `Extracted: ${symptoms.join(', ')}` : 'Extracted nothing from this message' };
    }
    case 'safety.evaluated': {
      const level = String(data['level']);
      const suggested = data['aiSuggestion'];
      const escalated = data['escalatedFromAi'] === true;
      const suffix = escalated
        ? ` — rules overruled the model, which said ${String(suggested)}`
        : suggested === null || suggested === undefined
          ? ''
          : ` (model also said ${String(suggested)})`;
      return { what: `Safety kernel: ${level}${suffix}` };
    }
    case 'reply.sent':
      return { what: `Replied to patient (${String(data['reason'])})`, said: typeof data['text'] === 'string' ? data['text'] : undefined };
    case 'reply.suppressed':
      return { what: `No reply sent (${String(data['reason'])})` };
    default:
      return { what: event.type };
  }
}

function CaseView({ id, onBack }: { id: string; onBack: () => void }) {
  const [detail, setDetail] = useState<CaseDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .detail(id)
      .then((result) => {
        if (!cancelled) setDetail(result);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (error !== null) return <p className="error">{error}</p>;
  if (detail === null) return <p className="meta">Loading…</p>;

  const { case: item, patient, events, history } = detail;
  const firedRules = events
    .filter((event) => event.type === 'safety.evaluated')
    .flatMap((event) => (Array.isArray(event.data['firedRules']) ? (event.data['firedRules'] as { id: string; title: string; detail: string }[]) : []));
  const uniqueRules = [...new Map(firedRules.map((rule) => [rule.id, rule])).values()];

  // When the level came from the model rather than from a rule, say so. A red badge with
  // no justification teaches a coordinator either to obey it blindly or to ignore it, and
  // the two failure modes are equally bad. The distinction is real: a fired rule is a
  // deterministic finding a clinician has reviewed, a model suggestion is neither.
  const latestEvaluation = [...events].reverse().find((event) => event.type === 'safety.evaluated');
  const modelSuggested = latestEvaluation?.data['aiSuggestion'];
  const unexplainedLevel = uniqueRules.length === 0 && item.level !== 'GREEN';

  return (
    <>
      <header className="top">
        <div>
          <button className="link" onClick={onBack}>
            ← Back to queue
          </button>
          <h1>
            <span className={`badge ${item.level}`}>{item.level}</span>{' '}
            {patient?.displayName ?? 'Unknown patient'}
          </h1>
          <span className="muted">
            {ageLabel(patient?.ageMonths ?? null)} · opened {clockTime(item.openedAt)} · {item.disposition.replaceAll('_', ' ').toLowerCase()}
          </span>
        </div>
      </header>

      {unexplainedLevel && (
        <section className="card">
          <h3>Why this level</h3>
          <p className="detail">
            No rule fired. This case is {item.level} because the language model proposed{' '}
            {typeof modelSuggested === 'string' ? modelSuggested : 'that level'}, and the kernel never lowers a
            suggestion — only raises one.
          </p>
          <p className="meta">
            Treat that as a prompt to look, not as a finding. A model suggestion has not been reviewed by
            anyone; a fired rule has.
          </p>
        </section>
      )}

      {uniqueRules.length > 0 && (
        <section className="card">
          <h3>Why this level</h3>
          {uniqueRules.map((rule) => (
            <div className="rule" key={rule.id}>
              <div className="title">{rule.title}</div>
              <div className="detail">{rule.detail}</div>
            </div>
          ))}
        </section>
      )}

      {item.missing.length > 0 && (
        <section className="card">
          <h3>Still to ask</h3>
          <ul className="questions">
            {item.missing.map((question) => (
              <li key={question}>{question}</li>
            ))}
          </ul>
        </section>
      )}

      <h2>What happened</h2>
      <section className="card">
        <ul className="timeline">
          {events.map((event) => {
            const { what, said } = describeEvent(event);
            const who = event.actor.component ?? event.actor.kind;
            return (
              <li key={event.id}>
                <span className="when">{clockTime(event.at)}</span>
                <span>
                  <div className="what">{what}</div>
                  <div className="who">{who}</div>
                  {said !== undefined && <div className="said">{said}</div>}
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      {history.length > 0 && (
        <>
          <h2>Earlier cases</h2>
          <section className="card">
            <ul className="timeline">
              {history.map((past) => (
                <li key={past.id}>
                  <span className="when">{new Date(past.openedAt).toLocaleDateString()}</span>
                  <span>
                    <div className="what">
                      <span className={`badge ${past.level}`}>{past.level}</span>{' '}
                      {past.symptomCodes.join(', ') || 'no symptoms recorded'}
                    </div>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}

      <p className="notice">
        Read-only. Acting on a case — asking a question, routing it, or a doctor signing it off — is the next
        piece of work, and it needs the role split that BMDC registration requires.
      </p>
    </>
  );
}

export default function App() {
  const [authed, setAuthed] = useState(getToken() !== null);
  const [cases, setCases] = useState<CaseSummary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .queue()
      .then((result) => {
        setCases([...result.cases].sort((a, b) => LEVEL_ORDER[b.level] - LEVEL_ORDER[a.level] || a.updatedAt.localeCompare(b.updatedAt)));
        setError(null);
      })
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 401) {
          clearToken();
          setAuthed(false);
          return;
        }
        setError(e instanceof Error ? e.message : String(e));
      });
  }, []);

  useEffect(() => {
    if (!authed || selected !== null) return undefined;
    load();
    // A queue that only updates on reload is a queue someone stops trusting.
    const timer = window.setInterval(load, 10_000);
    return () => window.clearInterval(timer);
  }, [authed, selected, load]);

  if (!authed) {
    return (
      <div className="shell">
        <TokenGate onAuthenticated={() => setAuthed(true)} />
      </div>
    );
  }

  if (selected !== null) {
    return (
      <div className="shell">
        <CaseView id={selected} onBack={() => setSelected(null)} />
      </div>
    );
  }

  return (
    <div className="shell">
      <header className="top">
        <div>
          <h1>Queue</h1>
          <span className="muted">Most urgent first, longest waiting first within a level</span>
        </div>
        <button
          onClick={() => {
            clearToken();
            setAuthed(false);
          }}
        >
          Sign out
        </button>
      </header>

      {error !== null && <p className="error">{error}</p>}
      {cases === null && <p className="meta">Loading…</p>}
      {cases !== null && cases.length === 0 && <p className="empty">No open cases. Send a WhatsApp message to the test number.</p>}
      {cases?.map((item) => (
        <CaseRow key={item.id} item={item} onOpen={setSelected} />
      ))}
    </div>
  );
}
