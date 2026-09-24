# Healthcare coordination layer

A care-coordination system for Bangladesh: channel-agnostic intake, a deterministic safety
kernel, explicit human accountability, and a longitudinal patient record that survives the
consultation.

It is **not** a diagnostic system and not an "AI doctor". A language model may read, structure
and summarise; only a person decides.

## The problem it is aimed at

Bangladesh does not lack telemedicine. There are on the order of a hundred digital-health
companies operating, several with video consultations, medicine delivery and in-app records.
What is missing is the layer *between* them: a patient consults one service, tests at another,
buys medicine from a third, then visits a physical hospital — and none of it connects. The
record lives in a plastic bag of paper prescriptions and lab reports the patient carries from
visit to visit, rewritten by hand each time.

This project targets that gap rather than the consultation itself.

## Design commitments

Four decisions shape everything else. They are listed here because they are the parts worth
arguing with.

**1. The safety kernel contains no model call.** Urgency is decided by deterministic rules in
[`packages/core/src/safety`](packages/core/src/safety). A model may *suggest* a triage level;
the kernel takes whichever of the two is more urgent and records that it did. A model can add
urgency to a case, never remove it. See [docs/safety-kernel.md](docs/safety-kernel.md).

**2. Danger signs are detected twice, independently.** Once from the coded symptoms the
extraction layer produced, and once directly from the patient's own words in Bangla, romanised
Banglish or English. If extraction silently fails, the case still escalates. An extraction bug
degrades to extra reviewer workload instead of to a missed emergency.

**3. A human is structurally unavoidable.** `SafetyVerdict.requiresHumanReview` has the literal
type `true` — there is no way to construct a verdict that dispenses with a person. Under BMDC
rules only a registered doctor makes clinical decisions, so this is a legal constraint as much
as a safety one.

**4. Channels are adapters, not the architecture.** WhatsApp, Messenger, SMS, IVR and the
health-worker console all normalise to the same clinical snapshot. Adding a channel does not
touch the code that decides whether someone is in danger.

## Who uses it

One web app, four interfaces, chosen by who signs in. It installs on a phone from the browser.

| Role | Signs in with | Can | Cannot |
| --- | --- | --- | --- |
| **Patient** | Phone number + a code sent to their WhatsApp | See their own conversations, the doctor's advice, send messages | See triage levels, rules, internal notes, or the clinical assessment |
| **Coordinator** — nurse, SACMO, CHCP, intern | Username + password | Work the queue, ask the patient questions, add notes, send a case to a doctor | Sign an assessment, reassure, prescribe, or close an urgent case no doctor has signed |
| **Doctor** — BMDC-registered | Username + password | Everything a coordinator can, plus sign assessments stamped with their BMDC number | — |
| **Admin** | Username + password | Create, deactivate and reset staff accounts | Open any patient record |

Every rule in that table is enforced by the server, not the interface — see
[`apps/api/test/roles.test.ts`](apps/api/test/roles.test.ts), which attacks each one over HTTP.

## Repository layout

```
packages/core/        Clinical core and the safety kernel. No framework, no I/O.
packages/llm/         Model access with an untrusted-content boundary.
packages/channels/    WhatsApp and simulated adapters. Cannot import the clinical core.
packages/store/       Append-only event log, case/patient projections, accounts, access log.
apps/api/             HTTP server: webhook, sign-in, role-checked case routes.
apps/web/             The web app for patients, coordinators, doctors and admins.
docs/                 Architecture, safety rationale, compliance, WhatsApp setup.
site/                 Public privacy policy and data-deletion pages.
```

## Running it

```bash
npm install
cp .env.example .env              # add DEEPSEEK_API_KEY; WhatsApp values are optional
npm run seed -w @hc/api           # demo staff accounts -> data/demo-accounts.txt
npm run dev -w @hc/api            # API on :3000
npm run dev -w @hc/web            # web app on :5173
```

Open http://localhost:5173. Staff sign in with the accounts in `data/demo-accounts.txt`. A
patient signs in with the WhatsApp number they have messaged from; in development the login
code is also written to the API's log.

```bash
npm test                          # every package
npm run check:llm -w @hc/api      # live extraction + kernel on a Bangla sample
npm run check:whatsapp -w @hc/api # verifies each WhatsApp credential separately
```

## Status

Working end to end: WhatsApp or portal message → extraction → safety kernel → automated reply →
stored case → coordinator works it → doctor signs → patient reads the advice. Not yet built:
voice notes and photographs, and a clinician's review of the rule set.

This build uses **synthetic data only**. See [docs/compliance.md](docs/compliance.md) for what
that means and what would have to change before it touched a real patient.
