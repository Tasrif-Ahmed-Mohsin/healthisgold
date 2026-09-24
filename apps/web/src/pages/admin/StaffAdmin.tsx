/**
 * Staff accounts. The admin's whole world — by design an admin cannot open a case.
 */

import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { api, type StaffMember, type StaffRole } from '../../api';
import { Card, ErrorLine, useAction } from '../../ui';

export function StaffAdmin({ meId }: { meId: string }) {
  const [staff, setStaff] = useState<StaffMember[] | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [role, setRole] = useState<StaffRole>('coordinator');
  const [bmdc, setBmdc] = useState('');
  const [password, setPassword] = useState('');
  const [created, setCreated] = useState<string | null>(null);
  const create = useAction();
  const toggle = useAction();

  const load = useCallback(() => {
    api
      .listStaff()
      .then((result) => setStaff(result.staff))
      .catch(() => setStaff([]));
  }, []);

  useEffect(load, [load]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setCreated(null);
    const ok = await create.run(async () => {
      await api.createStaff({
        username: username.trim(),
        displayName: displayName.trim(),
        role,
        password,
        ...(role === 'doctor' ? { bmdcRegNo: bmdc.trim() } : {}),
      });
    });
    if (ok) {
      setCreated(`${displayName.trim()} can now sign in as “${username.trim()}”.`);
      setDisplayName('');
      setUsername('');
      setBmdc('');
      setPassword('');
      load();
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Staff accounts</h1>
          <p className="dim">Admins manage accounts and cannot open patient records.</p>
        </div>
      </div>

      <div className="workspace">
        <div className="main-col">
          <Card>
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Username</th>
                  <th>Role</th>
                  <th>BMDC</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {staff?.map((member) => (
                  <tr key={member.id} className={member.active ? '' : 'inactive'}>
                    <td>{member.displayName}</td>
                    <td className="mono">{member.username}</td>
                    <td>
                      <span className={`role ${member.role}`}>{member.role}</span>
                    </td>
                    <td className="mono">{member.bmdcRegNo ?? '—'}</td>
                    <td className="right">
                      {member.id !== meId && (
                        <button
                          className="ghost small"
                          disabled={toggle.busy}
                          onClick={() => void toggle.run(async () => void (await api.setStaffActive(member.id, !member.active))).then(load)}
                        >
                          {member.active ? 'Deactivate' : 'Reactivate'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ErrorLine message={toggle.error} />
            <p className="dim small">Deactivating signs the person out everywhere, immediately.</p>
          </Card>
        </div>

        <aside className="side-col">
          <Card title="Add a staff member">
            <form className="stack" onSubmit={(e) => void submit(e)}>
              <label>
                Full name
                <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
              </label>
              <label>
                Username
                <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
              </label>
              <label>
                Role
                <select value={role} onChange={(e) => setRole(e.target.value as StaffRole)}>
                  <option value="coordinator">Coordinator (nurse, SACMO, CHCP, intern)</option>
                  <option value="doctor">Doctor (BMDC-registered)</option>
                  <option value="admin">Admin</option>
                </select>
              </label>
              {role === 'doctor' && (
                <label>
                  BMDC registration number
                  <input value={bmdc} onChange={(e) => setBmdc(e.target.value)} placeholder="A-12345" />
                </label>
              )}
              <label>
                Initial password <span className="dim small">· at least 10 characters</span>
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
              </label>
              <ErrorLine message={create.error} />
              {created !== null && <p className="ok">✓ {created}</p>}
              <button className="primary" disabled={create.busy}>
                Create account
              </button>
            </form>
          </Card>
        </aside>
      </div>
    </>
  );
}
