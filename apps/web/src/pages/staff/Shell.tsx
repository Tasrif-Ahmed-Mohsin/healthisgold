import type { ReactNode } from 'react';

import type { Me } from '../../api';

type StaffMe = Extract<Me, { kind: 'staff' }>;

const ROLE_LABEL: Record<StaffMe['role'], string> = {
  coordinator: 'Coordinator',
  doctor: 'Doctor',
  admin: 'Admin',
};

export function Shell({
  me,
  onSignOut,
  navigate,
  current,
  children,
}: {
  me: StaffMe;
  onSignOut: () => void;
  navigate: (to: string) => void;
  current: string;
  children: ReactNode;
}) {
  const links =
    me.role === 'admin'
      ? [{ to: '/staff', label: 'Staff accounts' }]
      : me.role === 'doctor'
        ? [
            { to: '/', label: 'With doctor' },
            { to: '/all', label: 'All open cases' },
          ]
        : [{ to: '/', label: 'Queue' }];

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <button className="brand-mini" onClick={() => navigate('/')}>
            <span className="mark small" aria-hidden="true">
              +
            </span>
            Care Coordination
          </button>
          <nav>
            {links.map((link) => (
              <button key={link.to} className={current === link.to ? 'nav active' : 'nav'} onClick={() => navigate(link.to)}>
                {link.label}
              </button>
            ))}
          </nav>
          <div className="who">
            <span className={`role ${me.role}`}>{ROLE_LABEL[me.role]}</span>
            <span className="name">{me.name}</span>
            <button className="ghost" onClick={onSignOut}>
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="page">{children}</main>
    </div>
  );
}
