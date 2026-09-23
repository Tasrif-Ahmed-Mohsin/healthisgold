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

## Repository layout

```
packages/core/        Clinical core. No framework, no I/O, no network.
  src/domain/         Triage levels, the clinical snapshot, the safety vocabulary.
  src/safety/         Lexicon, rule set, thresholds, and the kernel itself.
  test/               The kernel's behavioural contract.
docs/                 Architecture, safety rationale, and compliance posture.
```

`packages/core` is deliberately dependency-free. A clinician can review the rule set and the
thresholds without running anything.

## Running it

```bash
npm install
npm test
```

## Status

The clinical core and its safety kernel are implemented and tested. The API, persistence layer,
channel adapters and coordinator console are the next phases — see
[docs/architecture.md](docs/architecture.md) for the intended shape and the order of work.

This build uses **synthetic data only**. See [docs/compliance.md](docs/compliance.md) for what
that means and what would have to change before it touched a real patient.
