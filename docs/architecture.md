# Architecture

## The organising principle

**Every case is an append-only event log. Everything else is a projection.**

That one rule is what makes the system extensible at the margin rather than by rewrite:

- Adding a channel (Messenger, IVR, a new console) = a new adapter that emits normalised
  events. The core does not change.
- Adding an AI capability = a new pipeline stage. The core does not change.
- Adding a partner clinic = a new tenant. The core does not change.
- The patient record, the coordinator queue, and the doctor's case summary are all
  projections of the same log, not separate stores that must be kept in sync.

It also gives the audit trail for free, which matters for a system where a regulator may later
ask *why* a case was routed the way it was. Replay the log against the recorded
`kernelVersion` and you get the same verdict.

## The layers

```
Channel adapters      WhatsApp · Messenger · SMS/IVR · CHW console
      │               swappable; none of them know any clinical logic
      ▼
Identity & consent    deterministic; PDPA-shaped; explicit, logged, revocable
      ▼
AI intake pipeline    transcribe → normalise → extract → find gaps
      │               assistive only; output is a proposal, never a decision
      ▼
Safety kernel         deterministic rules; escalate-only; no model call
      ▼
Human layer           coordinator reviews · BMDC-registered doctor decides
      ▼
Patient record        FHIR-shaped, patient-portable
      │
      └──► feeds back into intake: each visit makes the next one cheaper to handle
```

The colour-coding that matters is **accountability**, not sequence. Deterministic code and
humans are load-bearing; the AI layer is the only part that may be wrong without the system
becoming unsafe, and it is positioned so that it can be.

## Why the CHW console comes before the messaging front door

The open question is not "can we receive a message" — that is a solved integration. It is
**"can one coordinator actually run fifteen cases an hour in this console?"** That number
decides whether the economics work at all, because the human layer is the cost centre and no
amount of AI legally removes it.

That question can be answered with a web console and a handful of real users, with no Meta
Business verification, no BSP contract and no registered legal entity. So the console is built
first and the messaging adapter lands after the throughput number exists.

There is a second reason. Under BMDC rules only a registered doctor makes clinical decisions.
A health worker employed by a clinic or NGO already sits inside someone's clinical governance;
a patient messaging a platform directly does not. Building for the worker first means the
accountability question has an answer from day one.

## Module boundaries

### `packages/core` — implemented

Framework-free and I/O-free. No web framework, no database driver, no HTTP client. This is
the part a clinician can review without running anything.

| Module | Responsibility |
| --- | --- |
| `domain/triage` | Triage levels, severity ranking, dispositions. The `max`-only combination. |
| `domain/snapshot` | The clinical snapshot and the safety vocabulary of symptom codes. |
| `safety/lexicon` | Trilingual red-flag terms and the negation-aware matcher. |
| `safety/context` | Unifies coded symptoms and raw text behind one `has()`. |
| `safety/thresholds` | Every numeric cut-off, named, in one auditable place. |
| `safety/rules` | The rule set. Pure predicates, each naming its clinical source. |
| `safety/kernel` | Combination logic and the asserted invariants. |

### `apps/api` — next

Fastify over a `CaseStore` interface. SQLite behind that interface for local development and
demonstration, Postgres behind the same interface for deployment. The interface is the point:
it is the seam that makes a hosting decision reversible, which matters because PDPA cross-border
rules may force one.

**All model calls happen here, server-side.** Never from the browser. This is both a key-safety
requirement and the place where the consent gate and the cross-border transfer boundary live.

### `packages/channels` — next

A `ChannelAdapter` interface plus a web adapter and a simulated WhatsApp adapter. The simulated
adapter exists so the channel seam can be demonstrated and tested without Meta approval, and so
the real adapter is a drop-in when the business entity exists.

### `apps/console` — next

The coordinator's working surface: queue ordered by disposition, case detail with the fired
rules and their evidence, the gaps the patient has not answered yet, and the review action.

A prototype of roughly this already exists at `E:\health` — a six-step wizard covering patient
info, voice intake, OCR document scan, vitals with anomaly flags, triage and a PDF report. It
is frozen and used as a reference. Its OCR extraction, its vitals anomaly logic and its
bilingual label system are worth porting; its architecture is not, because it puts the model in
the decision seat, holds everything in React state with no persistence, and calls model APIs
from the browser.

## The record is the compounding asset

A chat interface is not defensible — several Bangladeshi companies already have one. The
accumulated record is, because it gets better with every case and cannot be copied by writing
code.

Shaped to FHIR resource names — `Patient`, `Condition`, `Observation`, `MedicationStatement`,
`DiagnosticReport` — stored as JSONB rather than implemented as a full FHIR server. The shape
is what matters: it makes eventual interoperability with hospital systems a mechanical
migration instead of a data-modelling project, without paying the cost of full FHIR now.

The deliverable that makes it real to a patient is a printable one-page case summary they can
hand to any doctor, plus a code that pulls the full history. That is the thing that replaces
the plastic bag.

## Order of work

1. **Clinical core and safety kernel.** *Done* — 32 rules, 26 tests, strict TypeScript, no
   dependencies.
2. **Persistence and API.** Event log, case store behind an interface, server-side model calls,
   consent gate.
3. **Intake pipeline.** Transcription, Banglish normalisation, symptom extraction, gap
   detection — each a swappable stage, each logged.
4. **Coordinator console.** Queue and case review. Measure the throughput number.
5. **Channel adapters.** Web first, then simulated WhatsApp, then the real one.
6. **Record portability.** The printable summary and the history link.
