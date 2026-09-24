/**
 * The patient portal.
 *
 * Built for a phone, in Bangla first. It shows the conversation — what the patient said, what
 * came back, and the doctor's advice with the doctor's name and registration number — and
 * nothing of the staff side's working: no triage colours, no rule names, no internal notes.
 * A frightened person reading "RED" on their own record would take it as a diagnosis.
 *
 * It is also the fallback when WhatsApp cannot deliver. Outside Meta's 24-hour window a
 * doctor's reply may not reach the phone; it is always here.
 */

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';

import { api, type PatientCaseSummary, type PatientEntry, type PatientStatus } from '../../api';
import { ErrorLine, dateTime, useAction } from '../../ui';

const STATUS: Record<PatientStatus, { bn: string; en: string }> = {
  reviewing: { bn: 'একজন স্বাস্থ্যকর্মী দেখছেন', en: 'A health worker is reviewing' },
  waiting_for_you: { bn: 'আপনার উত্তরের অপেক্ষায়', en: 'Waiting for your reply' },
  with_doctor: { bn: 'একজন ডাক্তার দেখছেন', en: 'A doctor is reviewing' },
  closed: { bn: 'বন্ধ', en: 'Closed' },
};

const FROM: Record<PatientEntry['from'], { bn: string; en: string }> = {
  you: { bn: 'আপনি', en: 'You' },
  service: { bn: 'স্বয়ংক্রিয় বার্তা', en: 'Automatic message' },
  health_worker: { bn: 'স্বাস্থ্যকর্মী', en: 'Health worker' },
  doctor: { bn: 'ডাক্তার', en: 'Doctor' },
};

function EmergencyNote() {
  return (
    <p className="emergency">
      <strong>জরুরি অবস্থায় ৯৯৯-এ কল করুন বা নিকটস্থ হাসপাতালে যান।</strong>
      <br />
      In an emergency call 999 or go to your nearest hospital.
    </p>
  );
}

function Composer({ onSent, placeholder }: { onSent: (caseId: string) => void; placeholder: string }) {
  const [text, setText] = useState('');
  const { busy, error, run } = useAction();

  async function submit(event: FormEvent) {
    event.preventDefault();
    let caseId = '';
    if (await run(async () => void (caseId = (await api.sendMessage(text)).caseId))) {
      setText('');
      onSent(caseId);
    }
  }

  return (
    <form className="composer" onSubmit={(e) => void submit(e)}>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder={placeholder} />
      <ErrorLine message={error} />
      <button className="primary" disabled={busy || text.trim() === ''}>
        {busy ? 'পাঠানো হচ্ছে…' : 'পাঠান · Send'}
      </button>
    </form>
  );
}

export function PatientHome({ openCase }: { openCase: (id: string) => void }) {
  const [data, setData] = useState<{ name: string | null; cases: PatientCaseSummary[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .myCases()
      .then(setData)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 20_000);
    return () => window.clearInterval(timer);
  }, [load]);

  return (
    <div className="patient">
      <h1 className="greeting">
        আসসালামু আলাইকুম{data?.name ? `, ${data.name}` : ''}
        <span className="dim">Hello{data?.name ? `, ${data.name}` : ''}</span>
      </h1>

      <EmergencyNote />

      <section className="card">
        <h3>কী সমস্যা হচ্ছে? · What’s wrong?</h3>
        <Composer onSent={openCase} placeholder="যেমন: তিন দিন ধরে জ্বর আর মাথা ব্যথা…" />
      </section>

      <ErrorLine message={error} />

      <h2 className="section-title">
        আপনার বার্তা <span className="dim">· Your conversations</span>
      </h2>

      {data?.cases.length === 0 && <p className="empty">এখনো কোনো বার্তা নেই · No conversations yet</p>}

      <div className="list">
        {data?.cases.map((item) => (
          <button key={item.id} className="p-row" onClick={() => openCase(item.id)}>
            <span className={`p-status ${item.status}`}>
              {STATUS[item.status].bn}
              <span className="dim"> · {STATUS[item.status].en}</span>
            </span>
            {item.lastMessage !== null && <span className="p-preview">{item.lastMessage.text}</span>}
            <span className="p-meta">
              {dateTime(item.updatedAt)}
              {item.hasDoctorAdvice && <span className="pill">ডাক্তারের পরামর্শ · Doctor’s advice</span>}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function PatientCase({ id, back, openCase }: { id: string; back: () => void; openCase: (id: string) => void }) {
  const [data, setData] = useState<{ status: PatientStatus; timeline: PatientEntry[]; openedAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    api
      .myCase(id)
      .then(setData)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [id]);

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 10_000);
    return () => window.clearInterval(timer);
  }, [load]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth' });
  }, [data?.timeline.length]);

  if (error !== null) return <ErrorLine message={error} />;
  if (data === null) return <p className="dim">লোড হচ্ছে… · Loading…</p>;

  return (
    <div className="patient">
      <button className="link back" onClick={back}>
        ← সব বার্তা · All conversations
      </button>

      <div className={`p-banner ${data.status}`}>
        {STATUS[data.status].bn}
        <span> · {STATUS[data.status].en}</span>
      </div>

      <div className="chat">
        {data.timeline.map((entry, index) => (
          <div key={`${entry.at}-${index}`} className={`msg ${entry.from === 'you' ? 'mine' : 'theirs'} ${entry.from}`}>
            <div className="msg-from">
              {FROM[entry.from].bn} · {FROM[entry.from].en}
              {entry.name !== undefined && <> · {entry.name}</>}
            </div>
            <div className="msg-text">{entry.text}</div>
            {entry.from === 'doctor' && entry.bmdcRegNo !== undefined && <div className="msg-credential">BMDC {entry.bmdcRegNo}</div>}
            <div className="msg-time">{dateTime(entry.at)}</div>
          </div>
        ))}
        <div ref={bottom} />
      </div>

      {data.status === 'closed' ? (
        <section className="card">
          <p className="dim">এই কথোপকথন বন্ধ। নতুন সমস্যা হলে নতুন বার্তা পাঠান। · This conversation is closed. Send a new message for anything new.</p>
          <Composer onSent={openCase} placeholder="নতুন বার্তা লিখুন… · Write a new message…" />
        </section>
      ) : (
        <section className="card">
          <Composer onSent={() => load()} placeholder="উত্তর লিখুন… · Write a reply…" />
        </section>
      )}

      <EmergencyNote />
    </div>
  );
}
