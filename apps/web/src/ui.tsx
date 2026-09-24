/**
 * Small shared pieces: a hash router, formatting, and the level badge.
 *
 * Hash routing (`#/case/123`) keeps the app a set of static files with no server rewrites,
 * which is what lets it be installed on a phone and hosted anywhere.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';

import type { TriageLevel } from './api';

export function useRoute(): [string, (to: string) => void] {
  const read = () => window.location.hash.replace(/^#/, '') || '/';
  const [route, setRoute] = useState(read);

  useEffect(() => {
    const onChange = () => setRoute(read());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  const navigate = useCallback((to: string) => {
    window.location.hash = to;
  }, []);

  return [route, navigate];
}

export function waitedFor(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d`;
}

export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function dateTime(iso: string): string {
  return new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function ageLabel(ageMonths: number | null | undefined): string {
  if (ageMonths === null || ageMonths === undefined) return 'age unknown';
  if (ageMonths < 24) return `${ageMonths} months`;
  return `${Math.floor(ageMonths / 12)} years`;
}

export function humanise(code: string): string {
  return code.replaceAll('_', ' ').toLowerCase();
}

export function Badge({ level }: { level: TriageLevel }) {
  return <span className={`badge ${level}`}>{level}</span>;
}

export function ErrorLine({ message }: { message: string | null }) {
  return message === null ? null : (
    <p className="error" role="alert">
      {message}
    </p>
  );
}

export function Card({ title, children, tone }: { title?: string; children: ReactNode; tone?: 'warn' | 'calm' }) {
  return (
    <section className={`card${tone === undefined ? '' : ` ${tone}`}`}>
      {title !== undefined && <h3>{title}</h3>}
      {children}
    </section>
  );
}

/** Runs an async action with a busy flag and an error message, which every form here needs. */
export function useAction(): {
  busy: boolean;
  error: string | null;
  run: (action: () => Promise<void>) => Promise<boolean>;
  clear: () => void;
} {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  return { busy, error, run, clear: () => setError(null) };
}
