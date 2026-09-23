/**
 * Talking to the API.
 *
 * The console token lives in `localStorage` and is sent as a bearer on every request. That
 * is a stopgap standing in for real per-user accounts — see the note in the API's case
 * routes. It is recorded here too because a reader of this file should not have to go
 * looking to discover that the person on the other side of this screen is anonymous to the
 * system, which is the opposite of what a clinical audit trail needs.
 */

const TOKEN_KEY = 'hc.console.token';

export function getToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  try {
    window.localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Private browsing, or storage disabled. The token still works for this session.
  }
}

export function clearToken(): void {
  try {
    window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* nothing useful to do */
  }
}

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request<T>(path: string): Promise<T> {
  const token = getToken();
  const response = await fetch(path, {
    headers: token === null ? {} : { Authorization: `Bearer ${token}` },
  });

  if (response.status === 401) throw new ApiError(401, 'That token was not accepted.');
  if (response.status === 503) throw new ApiError(503, 'Console endpoints are disabled on the server.');
  if (!response.ok) throw new ApiError(response.status, `Request failed (${response.status}).`);

  return (await response.json()) as T;
}

export type TriageLevel = 'GREEN' | 'YELLOW' | 'RED' | 'BLACK';

export interface Patient {
  id: string;
  createdAt: string;
  displayName: string | null;
  ageMonths: number | null;
}

export interface CaseSummary {
  id: string;
  patientId: string;
  status: string;
  level: TriageLevel;
  disposition: string;
  openedAt: string;
  updatedAt: string;
  symptomCodes: string[];
  missing: string[];
  firedRuleIds: string[];
  patient: Patient | null;
}

export interface FiredRuleSummary {
  id: string;
  title: string;
  detail: string;
}

export interface CaseEvent {
  id: string;
  seq: number;
  type: string;
  at: string;
  actor: { kind: string; component?: string; patientId?: string; staffId?: string; role?: string };
  data: Record<string, unknown>;
}

export interface CaseDetail {
  case: Omit<CaseSummary, 'patient'>;
  patient: Patient | null;
  events: CaseEvent[];
  history: Omit<CaseSummary, 'patient'>[];
}

export const api = {
  queue: () => request<{ cases: CaseSummary[] }>('/cases'),
  detail: (id: string) => request<CaseDetail>(`/cases/${id}`),
  verifyToken: async (token: string): Promise<boolean> => {
    const response = await fetch('/cases', { headers: { Authorization: `Bearer ${token}` } });
    return response.ok;
  },
};
