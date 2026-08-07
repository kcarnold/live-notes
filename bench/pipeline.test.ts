/**
 * End-to-end test of the bench itself: real tasks → real scoring → real report, with only
 * the models faked.
 *
 * The point is that the harness is trustworthy before anyone spends money through it. A
 * scoring bug that silently marks a bad model good is worse than no bench at all, and it is
 * exactly the kind of bug that hides when the only way to run the thing is to pay for it.
 *
 * Two fake models are used throughout: a well-behaved one and a badly-behaved one that
 * commits the specific sins the scorers exist to catch. The report must tell them apart.
 */
import { describe, expect, it, vi } from 'vitest';
import { jsonModel, scriptedModel } from '../llm/testing.ts';
import { HYMN_ITEM, FOLLOW_UP, NOTES_TODO, slideTexts } from './fixtures.ts';
import { selectTasks, TASKS, type TaskRun } from './tasks.ts';
import { renderHtml, renderMarkdown } from './report.ts';
import type { BenchResults } from './run.ts';
import type { DraftScore, FollowUpScore, NotesScore } from './scoring.ts';

const hymnSlides = slideTexts(HYMN_ITEM);
const draftTask = TASKS.find((task) => task.id === `draft:${HYMN_ITEM.id}`)!;
const followUpTask = TASKS.find((task) => task.id === 'follow-up')!;
const notesTask = TASKS.find((task) => task.id === 'notes-block')!;

/** `set_translations` input covering every slide of an item in one language. */
const fullDraft = (language: string, texts: string[]) => ({
  name: 'set_translations',
  input: {
    languages: [
      { language, segments: texts.map((translation, segmentId) => ({ segmentId, translation })) },
    ],
  },
});

/** Four-line French stand-ins, so a verse slide's line count is preserved. */
const fourLines = (marker: string) => hymnSlides.map((_, index) => `${marker}${index} un\ndeux\ntrois\nquatre`);

/** Same, flattened to one line — the failure a verse slide must not commit. */
const flattened = (marker: string) => hymnSlides.map((_, index) => `${marker}${index} un deux trois quatre`);

const context = (model: ReturnType<typeof scriptedModel>['model'], spec: string) => ({
  model,
  modelSpec: spec,
  maxSteps: 6,
});

describe('draft task', () => {
  it('scores a well-behaved model as covering every slide with its lines intact', async () => {
    const { model } = scriptedModel([
      {
        toolCalls: [
          fullDraft('French', fourLines('fr')),
          fullDraft('Haitian Creole', fourLines('ht')),
        ],
      },
      { text: 'Drafted both languages.' },
    ]);

    const run = await draftTask.run(context(model, 'fake:good'));
    const score = run.score as DraftScore;

    expect(run.ok).toBe(true);
    expect(score.setTranslationsCalled).toBe(true);
    expect(score.coveredTotal).toBe(score.requestedTotal);
    expect(score.lineStructure.verseMatched).toBe(score.lineStructure.verseTotal);
    expect(score.literalEscapes).toBe(0);
    expect(run.reply).toBe('Drafted both languages.');
  });

  it('catches a model that flattens verse slides and writes literal backslash-n', async () => {
    const { model } = scriptedModel([
      {
        toolCalls: [
          {
            name: 'set_translations',
            input: {
              languages: [
                {
                  language: 'French',
                  segments: flattened('fr').map((translation, segmentId) => ({
                    segmentId,
                    translation: translation.replace(' ', '\\n'),
                  })),
                },
                {
                  language: 'Haitian Creole',
                  segments: flattened('ht').map((translation, segmentId) => ({ segmentId, translation })),
                },
              ],
            },
          },
        ],
      },
      { text: '' },
    ]);

    const run = await draftTask.run(context(model, 'fake:sloppy'));
    const score = run.score as DraftScore;

    expect(score.literalEscapes).toBeGreaterThan(0);
    // The literal escapes are repaired before storage, so those slides gain a line; either
    // way none of them match the source's four lines.
    expect(score.lineStructure.verseMatched).toBe(0);
    expect(score.lineStructure.verseTotal).toBeGreaterThan(0);
  });

  it('catches a model that answers in prose instead of calling the tool', async () => {
    const { model } = scriptedModel([{ text: 'Sure! Here are the translations:\n\nGrâce infinie...' }]);

    const run = await draftTask.run(context(model, 'fake:chatty'));
    const score = run.score as DraftScore;

    expect(run.ok).toBe(true);
    expect(score.setTranslationsCalled).toBe(false);
    expect(score.coveredTotal).toBe(0);
    expect(score.requestedTotal).toBeGreaterThan(0);
  });

  it('records a thrown error as a failed run rather than aborting the sweep', async () => {
    const exploding = {
      specificationVersion: 'v4' as const,
      provider: 'fake',
      modelId: 'explode',
      supportedUrls: {},
      doGenerate: async () => {
        throw new Error('rate limited');
      },
      doStream: async () => {
        throw new Error('rate limited');
      },
    };

    const run = await draftTask.run(context(exploding as never, 'fake:explode'));

    expect(run.ok).toBe(false);
    expect(run.error).toContain('rate limited');
  });

  it('asks each language only for the slides the library has not already covered', async () => {
    const { model, capturedOptions } = scriptedModel([
      { toolCalls: [fullDraft('French', fourLines('fr'))] },
      { text: 'done' },
    ]);
    const proseTask = TASKS.find((task) => task.id === 'draft:bench-prose')!;

    await proseTask.run(context(model, 'fake:good'));

    // The prose fixture has a reviewed French translation for slide 3, so French must be
    // asked for 0,1,2 while the other languages are asked for all four.
    const prompt = JSON.stringify(capturedOptions[0]);
    expect(prompt).toContain('translate slide ids: 0, 1, 2');
    expect(prompt).toContain('translate slide ids: 0, 1, 2, 3');
  });
});

describe('follow-up task', () => {
  it('rewards a one-word revise_translation as a blast radius of one', async () => {
    const { model } = scriptedModel([
      {
        toolCalls: [
          {
            name: 'revise_translation',
            input: {
              language: FOLLOW_UP.language,
              segmentId: FOLLOW_UP.slideIndex,
              find: 'Grâce étonnante',
              replace: 'Grâce infinie',
            },
          },
        ],
      },
      { text: 'Changed the first line only.' },
    ]);

    const run = await followUpTask.run(context(model, 'fake:surgical'));
    const score = run.score as FollowUpScore;

    expect(score).toMatchObject({
      usedRevise: true,
      usedSetTranslations: false,
      blastRadius: 1,
      appliedRequestedChange: true,
      leftObjectionableWording: false,
    });
  });

  it('exposes a model that re-sends every slide to change one word', async () => {
    const rewritten = [...FOLLOW_UP.seedTranslations];
    rewritten[0] = rewritten[0].replace('Grâce étonnante', 'Grâce infinie');
    const { model } = scriptedModel([
      { toolCalls: [fullDraft(FOLLOW_UP.language, rewritten)] },
      { text: 'Updated.' },
    ]);

    const run = await followUpTask.run(context(model, 'fake:blunt'));
    const score = run.score as FollowUpScore;

    expect(score.usedRevise).toBe(false);
    expect(score.blastRadius).toBe(FOLLOW_UP.seedTranslations.length);
    expect(score.appliedRequestedChange).toBe(true);
  });
});

describe('notes task', () => {
  it('scores a model that returns exactly the requested segment ids', async () => {
    const requested = NOTES_TODO.chunks
      .map((_, index) => index)
      .filter((index) => NOTES_TODO.isTranslationNeeded[index]);
    const model = jsonModel({
      segments: requested.map((segmentId) => ({ segmentId, translation: `traduction ${segmentId}` })),
    });

    const run = await notesTask.run(context(model, 'fake:tidy'));
    const score = run.score as NotesScore;

    expect(run.ok).toBe(true);
    expect(score.covered).toBe(requested.length);
    expect(score.spurious).toBe(0);
  });

  it('flags a model that also translated the context-only segments', async () => {
    const model = jsonModel({
      segments: NOTES_TODO.chunks.map((_, segmentId) => ({ segmentId, translation: `traduction ${segmentId}` })),
    });

    const run = await notesTask.run(context(model, 'fake:overeager'));
    const score = run.score as NotesScore;

    expect(score.spurious).toBe(3);
  });
});

describe('selectTasks', () => {
  it('returns everything when nothing is selected', () => {
    expect(selectTasks([])).toHaveLength(TASKS.length);
  });

  it('selects a whole family by prefix', () => {
    const drafts = selectTasks(['draft']);
    expect(drafts.length).toBeGreaterThan(1);
    expect(drafts.every((task) => task.id.startsWith('draft:'))).toBe(true);
  });

  it('selects one task by exact id', () => {
    expect(selectTasks(['notes-block']).map((task) => task.id)).toEqual(['notes-block']);
  });
});

describe('report rendering', () => {
  /** Two contrasting runs of the same task, as a results file would hold them. */
  const results = (runs: TaskRun[]): BenchResults => ({
    startedAt: '2026-07-31T10:00:00.000Z',
    models: [...new Set(runs.map((run) => run.model))],
    taskIds: [...new Set(runs.map((run) => run.taskId))],
    repeat: 1,
    runs,
  });

  const buildRuns = async (): Promise<TaskRun[]> => {
    const good = scriptedModel([
      { toolCalls: [fullDraft('French', fourLines('fr')), fullDraft('Haitian Creole', fourLines('ht'))] },
      { text: 'Drafted both languages.' },
    ]);
    const bad = scriptedModel([{ text: 'Here you go, in prose.' }]);
    return [
      await draftTask.run(context(good.model, 'fake:good')),
      await draftTask.run(context(bad.model, 'fake:chatty')),
    ];
  };

  it('puts both models in the scoreboard with their differing verdicts', async () => {
    const markdown = renderMarkdown(results(await buildRuns()));

    expect(markdown).toContain('fake:good');
    expect(markdown).toContain('fake:chatty');
    expect(markdown).toContain(draftTask.title);
    // The well-behaved model covered everything; the chatty one covered nothing.
    expect(markdown).toContain('100%');
    expect(markdown).toContain('0%');
  });

  it('lays the translations out side by side, one column per model', async () => {
    const html = renderHtml(results(await buildRuns()));

    expect(html).toContain('<th>fake:good</th>');
    expect(html).toContain('<th>fake:chatty</th>');
    // Source slides are the row headers, so a reader compares across a row.
    expect(html).toContain('Amazing grace');
    expect(html).toContain('— not returned —');
  });

  it('escapes model output rather than injecting it into the page', async () => {
    const injected: TaskRun = {
      taskId: draftTask.id,
      model: 'fake:inject',
      ok: true,
      durationMs: 10,
      steps: 1,
      translations: { French: [{ sourceText: hymnSlides[0], translatedText: '<script>alert(1)</script>' }] },
    };

    const html = renderHtml(results([injected]));

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('lists runs that failed instead of quietly dropping them', () => {
    const markdown = renderMarkdown(
      results([
        { taskId: draftTask.id, model: 'fake:explode', ok: false, error: 'rate limited', durationMs: 5, steps: 0 },
      ]),
    );

    expect(markdown).toContain('## Failures');
    expect(markdown).toContain('rate limited');
  });
});

describe('bible grounding', () => {
  it('reports which references the model looked up', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          chapter: { number: 23, content: [{ type: 'verse', number: 1, content: ['Le Seigneur est mon berger'] }] },
        }),
        { status: 200 },
      ),
    );
    const scriptureTask = TASKS.find((task) => task.id === 'draft:bench-scripture')!;
    const { model } = scriptedModel([
      { toolCalls: [{ name: 'lookup_bible_passage', input: { book: 'PSA', chapter: 23 } }] },
      { toolCalls: [fullDraft('French', ['a', 'b', 'c']), fullDraft('Haitian Creole', ['a', 'b', 'c'])] },
      { text: 'Based on the published text.' },
    ]);

    const run = await scriptureTask.run(context(model, 'fake:grounded'));
    const score = run.score as DraftScore;

    expect(score.lookups).toEqual(['PSA 23']);
    expect(score.expectedLookupsCovered).toBe(true);
    fetchSpy.mockRestore();
  });

  it('marks a model that never looked the passage up', async () => {
    const scriptureTask = TASKS.find((task) => task.id === 'draft:bench-scripture')!;
    const { model } = scriptedModel([
      { toolCalls: [fullDraft('French', ['a', 'b', 'c']), fullDraft('Haitian Creole', ['a', 'b', 'c'])] },
      { text: 'Translated directly.' },
    ]);

    const run = await scriptureTask.run(context(model, 'fake:ungrounded'));
    const score = run.score as DraftScore;

    expect(score.lookups).toEqual([]);
    expect(score.expectedLookupsCovered).toBe(false);
  });
});
