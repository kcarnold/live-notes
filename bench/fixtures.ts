/**
 * The service content the bench runs against.
 *
 * These are not generic translation prompts — they are the three shapes that actually cause
 * trouble on a Sunday, chosen so that a model's failure is visible as a mechanical fact
 * rather than a matter of taste:
 *
 * - a **hymn**, where line structure is content (meter, singable lines) and must survive;
 * - a **prose congregational reading**, where the source's line breaks are only there to fit
 *   the English on the English slide and must NOT survive (the viewer reflows to its own
 *   screen, so a copied break becomes a hard break in the wrong place);
 * - a **Bible reading**, whose citation lives in the item *title* and never in the slide
 *   text, so grounding it depends entirely on the model noticing the title and calling
 *   `lookup_bible_passage`.
 *
 * All text here is either public domain (pre-1900 hymnody, the doxology) or written for this
 * fixture, so the file can be committed and the bench re-run by anyone.
 */

/**
 * How a slide's line breaks should behave in translation, per the policy the prompt states.
 * Drives the mechanical line-structure score; `either` slides are reported but not scored.
 */
export type LineDiscipline = 'verse' | 'prose' | 'either';

export interface BenchSlide {
  text: string;
  discipline: LineDiscipline;
}

export interface BenchItem {
  id: string;
  /** What the Proclaim item is called. For a reading this is the citation itself. */
  title: string;
  slides: BenchSlide[];
  /** Target languages, as the app names them (see `BIBLE_TRANSLATIONS` in bible.ts). */
  languages: string[];
  /** Bible references we expect a well-behaved model to look up, e.g. `PSA 23`. */
  expectedLookups: string[];
  /** Already-reviewed translations to feed in as style context: language → slide index → text. */
  reviewedContext?: Record<string, Record<number, string>>;
}

/** Convenience: the slide texts alone, in order. */
export const slideTexts = (item: BenchItem): string[] => item.slides.map((slide) => slide.text);

/**
 * A hymn plus the doxology — line structure is the whole point.
 *
 * The last slide repeats the first verse, which is also a duplicate-slide test: the app only
 * asks the model to translate the first occurrence (`translateItem` dedupes on normalized
 * text), so a model that translates it twice anyway is doing work nobody asked for.
 */
export const HYMN_ITEM: BenchItem = {
  id: 'bench-hymn',
  title: 'Amazing Grace',
  languages: ['French', 'Haitian Creole'],
  expectedLookups: [],
  slides: [
    {
      discipline: 'verse',
      text: 'Amazing grace! how sweet the sound,\nThat saved a wretch like me!\nI once was lost, but now am found,\nWas blind, but now I see.',
    },
    {
      discipline: 'verse',
      text: "'Twas grace that taught my heart to fear,\nAnd grace my fears relieved;\nHow precious did that grace appear\nThe hour I first believed!",
    },
    {
      discipline: 'verse',
      text: 'Through many dangers, toils and snares,\nI have already come;\n\'Tis grace hath brought me safe thus far,\nAnd grace will lead me home.',
    },
    {
      discipline: 'verse',
      text: 'Praise God, from whom all blessings flow;\nPraise him, all creatures here below;\nPraise him above, ye heavenly host;\nPraise Father, Son, and Holy Ghost.',
    },
  ],
};

/**
 * A prose call to worship and a prayer, hard-wrapped the way presentation software wraps
 * things. Nothing here carries meaning in its line breaks.
 */
export const PROSE_ITEM: BenchItem = {
  id: 'bench-prose',
  title: 'Call to Worship and Prayer of Confession',
  languages: ['French', 'Haitian Creole', 'Spanish'],
  expectedLookups: [],
  slides: [
    {
      discipline: 'prose',
      text: 'We gather this morning not because we are strong, but because God is\nfaithful. Whatever you carried through the door with you, set it down\nhere for a while, and let us worship together.',
    },
    {
      discipline: 'prose',
      text: 'Merciful God, we confess that we have not loved you with our whole\nheart, and we have not loved our neighbours as ourselves. We have left\nundone the things we ought to have done, and we have done the things we\nought not to have done.',
    },
    {
      discipline: 'prose',
      text: 'Forgive us, renew us, and lead us, so that we may delight in your will\nand walk in your ways, to the glory of your name. Amen.',
    },
    {
      // A one-line response: no structure to preserve or destroy, so it is not scored either
      // way — it is here because real items are full of these and they pad the slide count.
      discipline: 'either',
      text: 'Thanks be to God.',
    },
  ],
  reviewedContext: {
    French: { 3: 'Nous rendons grâce à Dieu.' },
  },
};

/**
 * A Bible reading. The slide text is the passage; the citation exists only in `title`.
 *
 * This is the grounding test: a model that translates these slides from scratch produces
 * something plausible and wrong-sounding to anyone who knows the psalm in that language,
 * while a model that calls `lookup_bible_passage('PSA', 23)` gets the published wording.
 * The verse text below is the KJV, which is public domain.
 */
export const SCRIPTURE_ITEM: BenchItem = {
  id: 'bench-scripture',
  title: 'Psalm 23',
  languages: ['French', 'Haitian Creole'],
  expectedLookups: ['PSA 23'],
  slides: [
    {
      discipline: 'either',
      text: 'The LORD is my shepherd; I shall not want.\nHe maketh me to lie down in green pastures:\nhe leadeth me beside the still waters.',
    },
    {
      discipline: 'either',
      text: 'He restoreth my soul: he leadeth me in the paths of righteousness for his name’s sake.',
    },
    {
      discipline: 'either',
      text: 'Yea, though I walk through the valley of the shadow of death, I will fear no evil:\nfor thou art with me; thy rod and thy staff they comfort me.',
    },
  ],
};

export const BENCH_ITEMS: BenchItem[] = [HYMN_ITEM, PROSE_ITEM, SCRIPTURE_ITEM];

/**
 * A notes-block todo for the incremental path: a few already-translated chunks as context
 * (`C`) followed by new ones to translate (`T`).
 *
 * Mirrors what `translationUtils.ts` builds mid-sermon — the model must return exactly the
 * `T` ids and skip the `C` ids, which is the protocol failure that shows up live as
 * duplicated or missing lines in the viewer.
 */
export const NOTES_TODO = {
  chunks: [
    'Grace is not a reward for the faithful.',
    'It is a gift to the undeserving.',
    'That is the whole of the gospel in one sentence.',
    'Paul says it plainly in his letter to the church at Ephesus.',
    'And if it is a gift, then no one can boast about receiving it.',
    'So the only response left to us is gratitude.',
  ],
  offset: 0,
  // The first three are context (already translated); the last three need translating.
  isTranslationNeeded: [false, false, false, true, true, true],
  translatedContext:
    'La grâce n’est pas une récompense pour les fidèles.\n' +
    'C’est un don pour ceux qui ne le méritent pas.\n' +
    'Voilà tout l’évangile en une seule phrase.',
};

/** Target language for the notes-block task. */
export const NOTES_LANGUAGE = 'French';

/**
 * The follow-up round: a reviewer asks for one word to change in one slide.
 *
 * Every model is handed the *same* already-drafted conversation and the *same* request, so
 * the comparison is of follow-up behaviour alone and not contaminated by how well each model
 * happened to draft. Chaining a model's follow-up onto its own draft would have made the
 * expected outcome different per model and the results incomparable.
 *
 * What is being measured is blast radius. `revise_translation` exists so that a one-word
 * correction does not send four already-approved slides back through the model to be
 * silently reworded.
 */
export const FOLLOW_UP = {
  item: HYMN_ITEM,
  language: 'French',
  /** Index into `HYMN_ITEM.slides` the reviewer is talking about. */
  slideIndex: 0,
  /** Seed translations for the conversation, index-aligned with the item's slides. */
  seedTranslations: [
    'Grâce étonnante ! que le son est doux,\nQui a sauvé un misérable comme moi !\nJ’étais perdu, mais me voici retrouvé,\nJ’étais aveugle, mais maintenant je vois.',
    'C’est la grâce qui a appris à mon cœur à craindre,\nEt la grâce a soulagé mes craintes ;\nCombien cette grâce a paru précieuse\nÀ l’heure où j’ai cru pour la première fois !',
    'À travers bien des dangers, des peines et des pièges,\nJe suis déjà parvenu ;\nC’est la grâce qui m’a mené sain et sauf jusqu’ici,\nEt la grâce me conduira à la maison.',
    'Louez Dieu, de qui découlent tous les bienfaits ;\nLouez-le, toutes les créatures ici-bas ;\nLouez-le là-haut, vous, armée céleste ;\nLouez le Père, le Fils et le Saint-Esprit.',
  ],
  /** The reviewer's message, worded the way a reviewer actually words these. */
  message:
    'On the first slide, "Grâce étonnante" reads oddly to our congregation — please use ' +
    '"Grâce infinie" instead. Everything else is fine as it stands; leave the other slides alone.',
  expectedSubstring: 'Grâce infinie',
  objectionableSubstring: 'Grâce étonnante',
};
