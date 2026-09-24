/**
 * One sign-in page with two doors.
 *
 * Patients get the plainer one: a phone number, then a code that arrives on WhatsApp. No
 * password to create, forget, or reuse. Staff use a username and password.
 */

import { useState, type FormEvent } from 'react';

import { api } from '../api';
import { ErrorLine, useAction } from '../ui';

function StaffLogin({ onSignedIn }: { onSignedIn: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const { busy, error, run } = useAction();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (username.trim() === '' || password === '') return;
    if (await run(async () => void (await api.staffLogin(username.trim(), password)))) onSignedIn();
  }

  return (
    <form className="stack" onSubmit={submit}>
      <label>
        Username
        <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus />
      </label>
      <label>
        Password
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
      </label>
      <ErrorLine message={error} />
      <button className="primary" type="submit" disabled={busy || username.trim() === '' || password === ''}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}

function PatientLogin({ onSignedIn }: { onSignedIn: () => void }) {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const { busy, error, run, clear } = useAction();

  async function requestCode(event: FormEvent) {
    event.preventDefault();
    await run(async () => {
      const result = await api.requestCode(phone);
      setSentTo(result.maskedPhone);
    });
  }

  async function verify(event: FormEvent) {
    event.preventDefault();
    if (await run(async () => void (await api.verifyCode(phone, code.trim())))) onSignedIn();
  }

  if (sentTo === null) {
    return (
      <form className="stack" onSubmit={requestCode}>
        <label>
          <span>
            মোবাইল নম্বর <span className="dim">· Mobile number</span>
          </span>
          <input
            inputMode="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="01712 345678"
            autoComplete="tel"
            autoFocus
          />
        </label>
        <p className="hint">
          যে নম্বর থেকে আপনি আমাদের WhatsApp-এ বার্তা পাঠান, সেই নম্বরটি দিন। একটি কোড WhatsApp-এ যাবে।
          <br />
          <span className="dim">Use the number you message us from on WhatsApp. We will send a code there.</span>
        </p>
        <ErrorLine message={error} />
        <button className="primary" type="submit" disabled={busy || phone.trim() === ''}>
          {busy ? 'পাঠানো হচ্ছে…' : 'কোড পাঠান · Send code'}
        </button>
      </form>
    );
  }

  return (
    <form className="stack" onSubmit={verify}>
      <p className="hint">
        আমাদের কাছে এই নম্বরের রেকর্ড থাকলে <strong>{sentTo}</strong>-এ WhatsApp-এ একটি ৬ সংখ্যার কোড পাঠানো হয়েছে।
        <br />
        <span className="dim">If we have a record for {sentTo}, a 6-digit code has been sent on WhatsApp.</span>
      </p>
      <label>
        <span>
          কোড <span className="dim">· Code</span>
        </span>
        <input
          className="code-input"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          autoFocus
        />
      </label>
      <ErrorLine message={error} />
      <button className="primary" type="submit" disabled={busy || code.length !== 6}>
        {busy ? 'যাচাই হচ্ছে…' : 'প্রবেশ করুন · Sign in'}
      </button>
      <button
        type="button"
        className="link"
        onClick={() => {
          setSentTo(null);
          setCode('');
          clear();
        }}
      >
        অন্য নম্বর · Use a different number
      </button>
    </form>
  );
}

export function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [door, setDoor] = useState<'patient' | 'staff'>('patient');

  return (
    <main className="login">
      <div className="brand">
        <div className="mark" aria-hidden="true">
          +
        </div>
        <div>
          <h1>Care Coordination</h1>
          <p className="dim">স্বাস্থ্যসেবা সমন্বয়</p>
        </div>
      </div>

      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={door === 'patient'} className={door === 'patient' ? 'active' : ''} onClick={() => setDoor('patient')}>
          রোগী · Patient
        </button>
        <button role="tab" aria-selected={door === 'staff'} className={door === 'staff' ? 'active' : ''} onClick={() => setDoor('staff')}>
          স্বাস্থ্যকর্মী · Staff
        </button>
      </div>

      <div className="card">{door === 'patient' ? <PatientLogin onSignedIn={onSignedIn} /> : <StaffLogin onSignedIn={onSignedIn} />}</div>

      <p className="footnote">
        Academic project. Not a healthcare service. In an emergency go to your nearest hospital.
        <br />
        জরুরি অবস্থায় নিকটস্থ হাসপাতালে যান।
      </p>
    </main>
  );
}
