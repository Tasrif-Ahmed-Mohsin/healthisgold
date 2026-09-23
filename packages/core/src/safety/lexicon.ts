/**
 * The red-flag lexicon: an extraction-independent safety net.
 *
 * Every rule in the kernel can fire from two channels — a coded symptom produced by the
 * extraction layer, or a direct match against the patient's own words. The second channel
 * exists because of a specific failure mode: if a model silently fails to extract
 * `chest_pain` from "বুকে ব্যথা", a kernel that only reads coded symptoms sees a healthy
 * patient. Scanning the raw text as well means an extraction miss degrades to extra
 * reviewer workload rather than to a missed emergency.
 *
 * Coverage is deliberately trilingual: Bangla script, romanised Banglish (how people
 * actually type on a phone), and English. Spelling in Banglish is not standardised, so
 * each concept lists the variants seen in practice rather than one "correct" form.
 */

import type { SymptomCode } from '../domain/snapshot.js';

/** Negation markers. Bangla places these after the phrase; English places them before. */
const NEGATION_MARKERS = [
  'না',
  'নেই',
  'নাই',
  'নয়',
  'na',
  'nai',
  'nei',
  'no',
  'not',
  'never',
  'without',
  'denies',
  'denied',
  'negative',
];

/** How many tokens either side of a match we look at when checking for negation. */
const NEGATION_WINDOW = 2;

const BENGALI_SCRIPT = /\p{Script=Bengali}/u;

/**
 * Terms per concept. Order within a list does not matter; the matcher reports every hit
 * so a reviewer can see exactly which words triggered an escalation.
 */
export const RED_FLAG_LEXICON: Readonly<Record<SymptomCode, readonly string[]>> = {
  chest_pain: [
    'বুকে ব্যথা', 'বুক ব্যথা', 'বুকে ব্যাথা', 'বুকে চাপ',
    'buke betha', 'buk betha', 'buke batha', 'buke bytha', 'buke chap',
    'chest pain', 'chest tightness', 'pain in chest', 'chest pressure',
  ],
  pain_radiating_arm_jaw: [
    'চোয়ালে ব্যথা', 'হাতে ছড়াচ্ছে', 'বাম হাতে ব্যথা',
    'choyale betha', 'bam hate betha', 'hate chorache',
    'radiating', 'jaw pain', 'pain in left arm', 'pain spreading to arm',
  ],
  sweating: [
    'ঘাম', 'ঘামছে', 'ঘেমে', 'প্রচুর ঘাম',
    'gham', 'ghamche', 'gheme', 'ghemey',
    'sweating', 'cold sweat', 'sweaty', 'diaphoresis',
  ],
  breathlessness: [
    'শ্বাসকষ্ট', 'শ্বাস কষ্ট', 'শ্বাস নিতে কষ্ট', 'দম বন্ধ', 'দম আটকে',
    'shash kosto', 'shashkosto', 'shash nite kosto', 'swash kosto', 'dom bondho', 'dom atke',
    'breathless', 'breathlessness', 'shortness of breath', 'cannot breathe',
    'difficulty breathing', 'trouble breathing', 'gasping',
  ],
  severe_chest_indrawing: [
    'বুক দেবে যাচ্ছে', 'বুক ডেবে',
    'buk debe', 'buk deba',
    'chest indrawing', 'retractions',
  ],
  convulsion: [
    'খিঁচুনি', 'খিচুনি', 'খিঁচে', 'হাত পা খিঁচছে',
    'khichuni', 'khichoni', 'khichani', 'khiche',
    'convulsion', 'convulsions', 'seizure', 'seizures', 'fits', 'fitting',
  ],
  unconscious: [
    'অজ্ঞান', 'সংজ্ঞাহীন', 'জ্ঞান হারিয়েছে', 'সাড়া দিচ্ছে না', 'বেহুঁশ',
    'oggyan', 'ogyan', 'oggan', 'behush', 'gyan hariyeche', 'sara dicche na',
    'unconscious', 'unresponsive', 'not responding', 'passed out', 'fainted', 'collapsed',
  ],
  facial_droop: [
    'মুখ বেঁকে', 'মুখ বাঁকা', 'মুখ একদিকে',
    'mukh beke', 'mukh banka', 'mukh bake',
    'facial droop', 'face drooping', 'mouth drooping', 'face is crooked',
  ],
  arm_weakness: [
    'হাত অবশ', 'এক পাশ অবশ', 'শরীরের একদিক', 'হাত তুলতে পারছে না', 'অবশ',
    'hat obosh', 'ek pash obosh', 'hat tulte parche na', 'obosh',
    'arm weakness', 'one side weak', 'weakness on one side', 'paralysis', 'paralysed',
  ],
  speech_difficulty: [
    'কথা জড়িয়ে', 'কথা বলতে পারছে না', 'কথা আটকে',
    'kotha joriye', 'kotha bolte parche na', 'kotha atke',
    'slurred speech', 'cannot speak', 'speech difficulty', 'unable to speak',
  ],
  neck_stiffness: [
    'ঘাড় শক্ত', 'ঘাড় নাড়াতে পারছে না', 'ঘাড় ব্যথা শক্ত',
    'ghar shokto', 'ghaar shokto', 'ghar narate parche na',
    'neck stiffness', 'stiff neck', 'neck rigidity',
  ],
  severe_bleeding: [
    'রক্তপাত', 'রক্ত পড়ছে', 'প্রচুর রক্ত', 'রক্তক্ষরণ',
    'roktopat', 'rokto porche', 'rokto jhorche', 'prochur rokto',
    'bleeding', 'heavy bleeding', 'haemorrhage', 'hemorrhage', 'blood loss',
  ],
  vaginal_bleeding: [
    'যোনিপথে রক্ত', 'গর্ভাবস্থায় রক্ত', 'মাসিকের বাইরে রক্ত',
    'jonipothe rokto', 'gorbhaboshthay rokto',
    'vaginal bleeding', 'bleeding in pregnancy', 'per vaginal bleeding',
  ],
  reduced_foetal_movement: [
    'বাচ্চা নড়ছে না', 'বাচ্চার নড়াচড়া কম',
    'baccha norche na', 'bacchar noracora kom',
    'baby not moving', 'reduced foetal movement', 'reduced fetal movement',
  ],
  swelling_face_hands: [
    'মুখ ফুলে', 'হাত ফুলে', 'পা ফুলে', 'শরীর ফুলে',
    'mukh fule', 'hat fule', 'pa fule',
    'swelling of face', 'swollen hands', 'facial swelling', 'puffy face',
  ],
  blurred_vision: [
    'চোখে ঝাপসা', 'ঝাপসা দেখছে', 'চোখে দেখতে পারছে না',
    'chokhe jhapsa', 'jhapsa dekhche',
    'blurred vision', 'blurry vision', 'cannot see clearly', 'vision loss',
  ],
  fever: [
    'জ্বর', 'গা গরম', 'শরীর গরম',
    'jor', 'jwor', 'jvor', 'jvar', 'ga gorom', 'gaa gorom',
    'fever', 'febrile', 'high temperature',
  ],
  headache: [
    'মাথা ব্যথা', 'মাথাব্যথা', 'মাথা ধরেছে',
    'matha betha', 'mathabetha', 'matha batha', 'matha bytha',
    'headache', 'head pain',
  ],
  vomiting: [
    'বমি', 'বমি করছে', 'বমি হচ্ছে',
    'bomi', 'bomi korche', 'bomi hocche',
    'vomiting', 'vomited', 'throwing up',
  ],
  diarrhoea: [
    'পাতলা পায়খানা', 'ডায়রিয়া', 'পেট খারাপ',
    'patla paykhana', 'dayria', 'dayeria', 'pet kharap',
    'diarrhoea', 'diarrhea', 'loose motion', 'loose stools', 'watery stools',
  ],
  unable_to_drink: [
    'পানি খেতে পারছে না', 'কিছু খেতে পারছে না', 'পানি খাচ্ছে না',
    'pani khete parche na', 'kichu khete parche na', 'pani khacche na',
    'unable to drink', 'cannot drink', 'not drinking', 'refusing fluids',
  ],
  sunken_eyes: [
    'চোখ বসে গেছে', 'চোখ ডেবে',
    'chokh boshe geche', 'chokh debe',
    'sunken eyes',
  ],
  reduced_urine: [
    'প্রস্রাব কম', 'প্রস্রাব হচ্ছে না', 'প্রস্রাব বন্ধ',
    'prosrab kom', 'prosrab hocche na', 'peshab kom',
    'reduced urine', 'no urine', 'not passing urine', 'anuria', 'oliguria',
  ],
  abdominal_pain: [
    'পেট ব্যথা', 'পেটে ব্যথা', 'পেট ব্যাথা',
    'pet betha', 'pete betha', 'pet batha', 'pet bytha',
    'abdominal pain', 'stomach pain', 'belly pain', 'tummy pain',
  ],
  abdominal_rigidity: [
    'পেট শক্ত', 'পেট টান টান',
    'pet shokto', 'pet tan tan',
    'abdominal rigidity', 'rigid abdomen', 'board like abdomen', 'guarding',
  ],
  not_feeding: [
    'দুধ খাচ্ছে না', 'বুকের দুধ খাচ্ছে না', 'খাওয়াতে পারছি না',
    'dudh khacche na', 'buker dudh khacche na',
    'not feeding', 'refusing feed', 'refusing to feed', 'not breastfeeding',
  ],
  snake_bite: [
    'সাপে কেটেছে', 'সাপে কাটা', 'সাপে কামড়',
    'shape keteche', 'sape kata', 'shap e kamor', 'sap kamor',
    'snake bite', 'snakebite', 'bitten by snake',
  ],
  poisoning: [
    'বিষ খেয়েছে', 'বিষ পান', 'কীটনাশক', 'ইঁদুর মারা ওষুধ',
    'bish kheyeche', 'bish pan', 'keetnashok', 'kitnashok',
    'poisoning', 'poisoned', 'ingested poison', 'pesticide', 'overdose', 'od',
  ],
  suicidal_ideation: [
    'আত্মহত্যা', 'মরে যেতে চাই', 'নিজেকে শেষ', 'বাঁচতে চাই না',
    'attohotta', 'atmohotta', 'more jete chai', 'bachte chai na',
    'suicide', 'suicidal', 'kill myself', 'end my life', 'self harm', 'want to die',
  ],
};

export interface LexiconHit {
  readonly code: SymptomCode;
  readonly term: string;
  /** True when a negation marker sat next to the match, e.g. "no chest pain". */
  readonly negated: boolean;
  /** The surrounding words, so a reviewer can judge the match without opening the case. */
  readonly context: string;
}

/**
 * Normalises text for matching: lower-cases and replaces every non-letter, non-digit
 * character with a space. Unicode-aware, so Bangla survives and punctuation does not.
 */
export function normaliseForMatching(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function isBengaliTerm(term: string): boolean {
  return BENGALI_SCRIPT.test(term);
}

/**
 * A term is negation-immune when the term itself contains a negation marker. Without this,
 * "পানি খেতে পারছে না" (unable to drink) would be suppressed by its own trailing না —
 * turning one of the most important paediatric danger signs into silence.
 */
function containsNegation(term: string): boolean {
  const tokens = normaliseForMatching(term).split(' ');
  return tokens.some((token) => NEGATION_MARKERS.includes(token));
}

function nearbyNegation(tokens: readonly string[], start: number, length: number): boolean {
  const from = Math.max(0, start - NEGATION_WINDOW);
  const to = Math.min(tokens.length, start + length + NEGATION_WINDOW);
  for (let i = from; i < to; i += 1) {
    if (i >= start && i < start + length) continue;
    const token = tokens[i];
    if (token !== undefined && NEGATION_MARKERS.includes(token)) return true;
  }
  return false;
}

function contextAround(tokens: readonly string[], start: number, length: number): string {
  const from = Math.max(0, start - 4);
  const to = Math.min(tokens.length, start + length + 4);
  return tokens.slice(from, to).join(' ');
}

/**
 * Finds every lexicon term present in the given text.
 *
 * Latin-script terms match on whole-token boundaries, because short romanisations like
 * "jor" (fever) would otherwise fire inside unrelated words such as "major". Bangla-script
 * terms match on substrings instead, because Bangla takes case suffixes — "জ্বরে" and
 * "জ্বরের" are both the fever we care about, and demanding an exact token would miss them.
 */
export function findLexiconHits(text: string): LexiconHit[] {
  const normalised = normaliseForMatching(text);
  if (normalised === '') return [];
  const tokens = normalised.split(' ');
  const hits: LexiconHit[] = [];

  for (const [code, terms] of Object.entries(RED_FLAG_LEXICON) as [SymptomCode, readonly string[]][]) {
    for (const term of terms) {
      const normalisedTerm = normaliseForMatching(term);
      if (normalisedTerm === '') continue;
      const termTokens = normalisedTerm.split(' ');
      const immune = containsNegation(term);

      for (let i = 0; i + termTokens.length <= tokens.length; i += 1) {
        const matched = termTokens.every((termToken, offset) => {
          const token = tokens[i + offset];
          if (token === undefined) return false;
          if (isBengaliTerm(termToken)) return token.includes(termToken);
          return token === termToken;
        });
        if (!matched) continue;

        hits.push({
          code,
          term,
          negated: !immune && nearbyNegation(tokens, i, termTokens.length),
          context: contextAround(tokens, i, termTokens.length),
        });
        break;
      }
    }
  }

  return hits;
}
