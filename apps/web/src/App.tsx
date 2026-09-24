/**
 * One app, three interfaces, chosen by who signs in.
 *
 * A coordinator lands on the queue, a doctor on the cases waiting for a doctor, an admin on
 * staff accounts, and a patient on their own conversations. The routing here only decides
 * which screen to draw — the server decides what each person may actually see and do.
 */

import { useCallback, useEffect, useState } from 'react';

import { api, type Me } from './api';
import { StaffAdmin } from './pages/admin/StaffAdmin';
import { Login } from './pages/Login';
import { PatientCase, PatientHome } from './pages/patient/Patient';
import { CaseWork } from './pages/staff/CaseWork';
import { Queue } from './pages/staff/Queue';
import { Shell } from './pages/staff/Shell';
import { useRoute } from './ui';

export default function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [route, navigate] = useRoute();

  const refresh = useCallback(() => {
    api
      .me()
      .then(setMe)
      .catch(() => setMe(null));
  }, []);

  useEffect(refresh, [refresh]);

  async function signOut() {
    await api.logout().catch(() => undefined);
    setMe(null);
    navigate('/');
  }

  if (me === undefined) return <p className="dim center">Loading…</p>;

  if (me === null) {
    return (
      <Login
        onSignedIn={() => {
          navigate('/');
          refresh();
        }}
      />
    );
  }

  if (me.kind === 'patient') {
    const caseMatch = /^\/c\/([\w-]+)$/.exec(route);
    return (
      <div className="app patient-app">
        <header className="topbar">
          <div className="topbar-inner">
            <button className="brand-mini" onClick={() => navigate('/')}>
              <span className="mark small" aria-hidden="true">
                +
              </span>
              স্বাস্থ্যসেবা
            </button>
            <div className="who">
              <button className="ghost" onClick={() => void signOut()}>
                বের হন · Sign out
              </button>
            </div>
          </div>
        </header>
        <main className="page narrow">
          {caseMatch !== null ? (
            <PatientCase id={caseMatch[1]!} back={() => navigate('/')} openCase={(id) => navigate(`/c/${id}`)} />
          ) : (
            <PatientHome openCase={(id) => navigate(`/c/${id}`)} />
          )}
        </main>
      </div>
    );
  }

  if (me.role === 'admin') {
    return (
      <Shell me={me} onSignOut={() => void signOut()} navigate={navigate} current="/staff">
        <StaffAdmin meId={me.id} />
      </Shell>
    );
  }

  const caseMatch = /^\/case\/([\w-]+)$/.exec(route);
  const current = route === '/all' ? '/all' : '/';

  return (
    <Shell me={me} onSignOut={() => void signOut()} navigate={navigate} current={caseMatch === null ? current : ''}>
      {caseMatch !== null ? (
        <CaseWork me={me} id={caseMatch[1]!} back={() => navigate(me.role === 'doctor' ? '/' : '/')} />
      ) : (
        <Queue
          me={me}
          openCase={(id) => navigate(`/case/${id}`)}
          initialFilter={me.role === 'doctor' ? (route === '/all' ? 'all' : 'with_doctor') : 'all'}
        />
      )}
    </Shell>
  );
}
