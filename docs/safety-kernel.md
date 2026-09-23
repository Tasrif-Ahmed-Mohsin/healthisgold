# The safety kernel

## What it is for

The kernel answers exactly one question: **is there a reason this person cannot safely wait in
a queue?**

It does not diagnose, does not suggest treatment, and does not decide what is wrong. Those are
clinical judgements that belong to a registered clinician. The kernel's entire job is to make
sure that a case which needs a human *now* reaches one, and that nothing in the automated path
can prevent that.

## Why it is not a model

The obvious design is to ask a language model for a triage colour and act on it. We do not,
for three reasons.

**It cannot be reviewed.** A clinician can read
[`rules.ts`](../packages/core/src/safety/rules.ts) and
[`thresholds.ts`](../packages/core/src/safety/thresholds.ts) and tell you exactly what the
system will do with a 1-month-old at 37.8°C. Nobody can do that for a prompt.

**It cannot be regression-tested.** Rules are pure functions over a plain data structure. The
26 tests in [`test/kernel.test.ts`](../packages/core/test/kernel.test.ts) run in 20 ms with no
network. A model-based kernel's behaviour changes when the vendor updates the model, silently.

**Its failure mode is wrong.** A model asked for a colour will confidently return GREEN for a
case it misunderstood. Deterministic rules fail toward caution: an unrecognised presentation
produces no rule match, which leaves the model's own suggestion standing and still routes the
case to a coordinator. Nothing ever reaches a patient unreviewed.

## How a verdict is produced

```
snapshot ──► coded symptoms ─┐
         └─► raw utterances ─┴─► SafetyContext ──► rules ──► rule floor ─┐
                                                                         ├─► max ──► verdict
                                             model suggestion ───────────┘
```

The combination step is a single `max` over severity rank. That is the whole mechanism, and it
is why the escalate-only guarantee is easy to believe.

Three invariants are **asserted**, not assumed — `evaluateSafety` throws rather than return a
verdict that violates them:

1. The verdict is never less urgent than the most urgent rule that fired.
2. The verdict is never less urgent than the model's suggestion.
3. `requiresHumanReview` is the literal `true`, so the type system forbids a verdict without a
   person in the loop.

If invariant 1 or 2 is ever violated the kernel raises instead of returning. A case surfacing
to a coordinator as an error is strictly safer than the same case surfacing as a falsely
reassuring GREEN.

## The two detection channels

Every rule asks `ctx.has(code)`, which is true when **either**:

- the extraction layer coded the symptom, or
- the patient's own words matched the red-flag lexicon.

This exists because of one specific failure: a model that does not extract `chest_pain` from
"বুকে ব্যথা" hands the kernel a snapshot describing a healthy person. The second channel means
that bug costs a coordinator thirty seconds instead of costing a life.

The kernel also reports `extractionGaps` — codes the patient's words contained but extraction
missed. That turns the safety net into a measurement instrument: the extraction layer gets
evaluated against real traffic, continuously, rather than against a benchmark once.

### Matching in three languages

People type in Bangla script, in romanised Banglish, and in English, often within one sentence.
Two different matching strategies are needed:

- **Latin-script terms match whole tokens.** "jor" (জ্বর, fever) must not fire inside "major".
- **Bangla-script terms match substrings.** Bangla takes case suffixes, so "জ্বরে" and "জ্বরের"
  are both the fever we care about and an exact-token match would miss them.

### Negation

A naive matcher fires on "no chest pain". The matcher checks a two-token window either side of
each match for negation markers in all three languages.

One subtlety is load-bearing: **a term containing its own negation marker is exempt.** Bangla
places negation after the verb, so "পানি খেতে পারছে না" ("unable to drink") ends in না.
Suppressing it would silence one of the most important paediatric danger signs in IMCI. The
exemption is tested directly.

The asymmetry is deliberate throughout. A false positive costs reviewer time. A false negative
costs a person who needed a hospital and did not go.

## The rule set

32 rules across consciousness and neurology, cardiac and respiratory, circulation and
metabolic, neonatal and paediatric, obstetric, trauma and toxicology, and mental health.

Every rule names its clinical provenance — mostly WHO IMCI danger signs, WHO ETAT, FAST stroke
recognition, WHO mhGAP, and WHO pregnancy danger signs. A rule without a source does not belong
in the set.

Two rules are worth calling out as examples of why age and context are modelled rather than
flattened:

- **`resp.fast_breathing`** uses the IMCI thresholds, which run 60 / 50 / 40 / 30 breaths per
  minute across age bands. A respiratory rate of 55 is normal in a newborn and an emergency in
  a two-year-old. A single threshold would be wrong in both directions.
- **`paeds.young_infant_fever`** fires at 37.5°C in an infant under two months, where the same
  reading in a three-year-old is unremarkable. Age here matters more than how well the baby
  looks.

### Dispositions are separate from levels

Two cases can share a colour and need completely different logistics. A RED chest pain goes to
a hospital. A RED suicidal-ideation case goes to a named human immediately and is excluded from
every automated path — `allowsAutomatedReply` returns false, including for acknowledgements. A
templated reply is the wrong thing to receive after disclosing suicidal intent.

## Adding or changing a rule

1. Add it to `RED_FLAG_RULES` with an `id`, a `level`, a `rationale` written for the coordinator
   who will read it in the queue, and a `source` naming the guidance.
2. Put any numeric cut-off in `thresholds.ts`, never inline. A partner organisation deviating
   from a threshold should be one reviewed change, not a hunt through conditionals.
3. Add lexicon terms for the symptom codes in all three languages, or the rule only works when
   extraction succeeds.
4. Write the test both ways: the case that should fire, and the near-miss that should not.
5. Bump `KERNEL_VERSION`. Every verdict stores it, so a case decided months ago can be replayed
   against the exact logic that decided it.

## Known limits

Stated plainly, because a system like this is more dangerous when its limits are implied than
when they are written down.

- **The lexicon is a starting set, not a validated instrument.** Its terms come from common
  usage, not from a corpus study of how Bangladeshi patients actually describe symptoms by
  region. Sylheti and Chittagonian usage in particular is under-covered.
- **Sensitivity and specificity are unmeasured.** There is no labelled corpus behind these
  rules yet. The tests prove the logic behaves as specified; they do not prove the specification
  is clinically complete.
- **No rule set catches everything.** The kernel is a floor under the queue, not a guarantee of
  detection. That is exactly why every case still reaches a person.
- **The rules have not been reviewed by a registered clinician.** Before any real patient
  contact, they must be — see [compliance.md](compliance.md).
