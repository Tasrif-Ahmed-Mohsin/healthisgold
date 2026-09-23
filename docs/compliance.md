# Compliance posture

This build handles **synthetic data only**. Nothing here has touched a real patient, and the
system must not be pointed at one until the gaps at the bottom of this document are closed.

The point of writing this down now is that the constraints are architectural. Retrofitting
consent, an audit trail or a hosting boundary into a system that was not built with the seams
is a rewrite; leaving the seams in place from the start costs almost nothing.

## What applies

### Personal Data Protection Act, 2026

Bangladesh passed the Personal Data Protection Act, 2026 (Law 63 of 2026) in April 2026,
repealing and replacing the 2025 Ordinance. Enforcement mechanisms phase in over roughly 18
months from gazette, so the regime becomes fully operational around mid-2027.

What it means for this system:

- **Explicit consent** for collection and processing. Health information is sensitive personal
  data on any reading of the Act. Consent must be specific, recorded, and revocable — which is
  why it is a distinct architectural layer sitting between the channel adapters and anything
  clinical, rather than a checkbox somewhere in a form.
- **A supervisory authority.** The Act establishes the National Data Governance Authority.
- **Cross-border transfer is restricted** without approval, with an adequacy-style requirement
  on the receiving country.
- **Localisation** was broad when the Ordinance was gazetted in November 2025 — a real-time
  synchronised in-country copy of any Bangladeshi personal data held on foreign cloud
  infrastructure. The February 2026 amendment narrowed that to restricted and
  critical-information-infrastructure data. Health data's status under that narrower test is
  not something to assume; it needs a legal opinion before any real deployment.

**Design consequence:** every model call goes server-side, behind the consent gate, and is
logged. The `CaseStore` interface exists so that the hosting decision stays reversible — if
health data turns out to require in-country storage, that is a driver swap, not a migration
project.

This is also why the reference prototype's approach is not carried forward. Calling a model
API directly from the patient's browser means sensitive health data crosses a border from an
uncontrolled client, with no consent record and no audit trail. It also puts the API key in
the shipped bundle.

### BMDC registration

Only a doctor registered with the Bangladesh Medical and Dental Council may diagnose or
prescribe. This is the constraint that shapes the whole product, not a footnote.

It means an intern, a physician assistant or a community health worker issuing "basic guidance"
for "routine cases" is practising medicine without registration — a genuinely common failure
mode in care-coordination designs, because the care-ladder diagram makes it look reasonable.

**Design consequence:** the human layer has two distinct roles with different powers. A
coordinator reviews, asks follow-up questions, and routes. Only a registered doctor makes a
clinical decision, and only a registered doctor signs one. `requiresHumanReview` being
structurally `true` is where this starts, but the role distinction has to be enforced in the
API's authorisation layer when that is built.

### Cyber Security Act, 2023

Relevant to breach handling and to how patient data is secured at rest and in transit. Not
architecturally shaping in the way the two above are, but it belongs on the list.

## What this build deliberately does not do

Honest scoping, because claiming compliance you have not implemented is worse than admitting
the gap.

- **No production consent flow.** The layer exists in the architecture; the implementation is
  in the next phase.
- **No authentication or authorisation.** Therefore no enforcement of the coordinator/doctor
  role split yet.
- **No encryption at rest, no key management, no breach procedure.**
- **No data retention or deletion policy**, which the Act requires.
- **No Chief Data Officer or DPO appointment**, which the Act requires of covered
  organisations.
- **No legal entity**, and therefore no ability to obtain WhatsApp Business Platform access,
  which requires a verified business.

## What must be true before real patient contact

1. **A registered clinician reviews and signs off the rule set and thresholds.** The rules cite
   WHO guidance but have not been reviewed by a practising clinician. This is the single
   largest gap.
2. **A named doctor holds clinical accountability** for cases routed through the system, in
   writing.
3. **A legal opinion on health-data localisation** under the amended Act.
4. **Consent, authentication and audit logging implemented** — not designed, implemented.
5. **An escalation path that exists in the physical world.** A RED verdict is worthless if
   there is no agreed facility, no transport, and nobody expecting the referral. This is an
   operational commitment from a partner organisation, not code.
6. **A defined position on the 24-hour messaging window.** On WhatsApp, replies inside 24 hours
   of the patient's last message are free; anything initiated outside it is a paid template. At
   roughly $0.07 per message on the Bangladesh rate card from October 2026, follow-up economics
   need deciding before they are designed around — and an emergency escalation must never
   depend on a paid template being deliverable.

## Sources

- Personal Data Protection Act, 2026 (Law 63 of 2026), and the Personal Data Protection
  (Amendment) Ordinance, 2026 (Ordinance No. 23 of 2026).
- Bangladesh Medical and Dental Council registration requirements.
- Cyber Security Act, 2023.
- Meta WhatsApp Business Platform per-message pricing, Bangladesh rate card effective
  1 October 2026.
