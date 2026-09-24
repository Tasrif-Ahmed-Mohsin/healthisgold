/**
 * The API client.
 *
 * The session is an httpOnly cookie the browser attaches on its own, so this file never sees
 * or stores a credential — there is nothing here for injected script to steal. Every request
 * is same-origin (Vite proxies to the API in development), which is what lets the cookie be
 * SameSite=Strict.
 */

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new ApiError(response.status, payload.error ?? `Request failed (${response.status}).`);
  return payload as T;
}

export type TriageLevel = 'GREEN' | 'YELLOW' | 'RED' | 'BLACK';
export type StaffRole = 'coordinator' | 'doctor' | 'admin';
export type CaseStatus = 'open' | 'awaiting_patient' | 'with_doctor' | 'closed';

export type Me =
  | { kind: 'staff'; id: string; role: StaffRole; name: string; username: string; bmdcRegNo: string | null }
  | { kind: 'patient'; id: string; name: string | null };

export interface Patient {
  id: string;
  displayName: string | null;
  ageMonths: number | null;
}

export interface CaseSummary {
  id: string;
  patientId: string;
  status: CaseStatus;
  level: TriageLevel;
  disposition: string;
  openedAt: string;
  updatedAt: string;
  symptomCodes: string[];
  missing: string[];
  firedRuleIds: string[];
  assignedDoctorId: string | null;
  patient: Patient | null;
  assignedDoctor: string | null;
}

export interface CaseEvent {
  id: string;
  seq: number;
  type: string;
  at: string;
  actor: { kind: 'patient' | 'system' | 'staff'; component?: string; patientId?: string; staffId?: string; role?: StaffRole };
  data: Record<string, unknown>;
}

export interface CaseDetail {
  case: Omit<CaseSummary, 'patient' | 'assignedDoctor'>;
  patient: Patient | null;
  events: CaseEvent[];
  history: Omit<CaseSummary, 'patient' | 'assignedDoctor'>[];
  assignedDoctor: string | null;
  viewedBy: string[];
}

export interface Doctor {
  id: string;
  name: string;
  bmdcRegNo: string | null;
}

export interface StaffMember {
  id: string;
  username: string;
  displayName: string;
  role: StaffRole;
  bmdcRegNo: string | null;
  active: boolean;
  createdAt: string;
}

export type PatientStatus = 'reviewing' | 'waiting_for_you' | 'with_doctor' | 'closed';

export interface PatientCaseSummary {
  id: string;
  openedAt: string;
  updatedAt: string;
  status: PatientStatus;
  lastMessage: { from: string; text: string } | null;
  hasDoctorAdvice: boolean;
}

export interface PatientEntry {
  at: string;
  from: 'you' | 'service' | 'health_worker' | 'doctor';
  text: string;
  name?: string;
  bmdcRegNo?: string;
}

export interface DeliveryResult {
  channel: 'whatsapp' | 'web';
  delivered: boolean;
  outsideWindow: boolean;
}

export const api = {
  me: () => call<Me>('GET', '/auth/me'),
  staffLogin: (username: string, password: string) => call<unknown>('POST', '/auth/staff/login', { username, password }),
  requestCode: (phone: string) => call<{ sent: boolean; maskedPhone: string }>('POST', '/auth/patient/request-code', { phone }),
  verifyCode: (phone: string, code: string) => call<unknown>('POST', '/auth/patient/verify', { phone, code }),
  logout: () => call<unknown>('POST', '/auth/logout', {}),

  queue: (status?: CaseStatus, mine = false) => {
    const params = new URLSearchParams();
    if (status !== undefined) params.set('status', status);
    if (mine) params.set('mine', '1');
    const query = params.toString();
    return call<{ cases: CaseSummary[] }>('GET', `/cases${query === '' ? '' : `?${query}`}`);
  },
  caseDetail: (id: string) => call<CaseDetail>('GET', `/cases/${id}`),
  doctors: () => call<{ doctors: Doctor[] }>('GET', '/doctors'),
  addNote: (id: string, text: string) => call<unknown>('POST', `/cases/${id}/notes`, { text }),
  askPatient: (id: string, text: string) => call<{ delivery: DeliveryResult }>('POST', `/cases/${id}/questions`, { text }),
  routeToDoctor: (id: string, reason: string, doctorId: string | null) =>
    call<unknown>('POST', `/cases/${id}/route`, { reason, ...(doctorId === null ? {} : { doctorId }) }),
  signAssessment: (id: string, assessment: string, plan: string, patientAdvice: string) =>
    call<{ delivery: DeliveryResult | null }>('POST', `/cases/${id}/assessment`, {
      assessment,
      plan,
      ...(patientAdvice.trim() === '' ? {} : { patientAdvice }),
    }),
  closeCase: (id: string, reason: string) => call<unknown>('POST', `/cases/${id}/close`, { reason }),

  listStaff: () => call<{ staff: StaffMember[] }>('GET', '/staff'),
  createStaff: (input: { username: string; displayName: string; role: StaffRole; password: string; bmdcRegNo?: string }) =>
    call<unknown>('POST', '/staff', input),
  setStaffActive: (id: string, active: boolean) => call<unknown>('POST', `/staff/${id}/active`, { active }),

  myCases: () => call<{ name: string | null; cases: PatientCaseSummary[] }>('GET', '/me/cases'),
  myCase: (id: string) => call<{ id: string; openedAt: string; status: PatientStatus; timeline: PatientEntry[] }>('GET', `/me/cases/${id}`),
  sendMessage: (text: string) => call<{ caseId: string }>('POST', '/me/messages', { text }),
};
