/**
 * Turn a bench results file into something a person can read.
 *
 * Two outputs, because there are two questions:
 *
 * - **Did it follow the protocol?** — a scoreboard of mechanical facts (coverage, tool use,
 *   line discipline, blast radius, cost, latency). Markdown, diffable, pasteable into a PR.
 * - **Is the French any good?** — the actual translated text, every model's output for the
 *   same slide next to each other. Only a human can answer that, and only if the text is
 *   laid out so they can compare it in one glance. HTML, because a wide side-by-side table
 *   is unreadable in a terminal.
 *
 * Usage:
 *   node bench/report.ts --in bench/results/<file>.json
 *   node bench/report.ts --in <file>.json --md report.md --html report.html
 */
import fs from 'fs/promises';
import path from 'path';
import { TASKS, type TaskRun } from './tasks.ts';
import type { DraftScore, FollowUpScore, NotesScore } from './scoring.ts';
import type { BenchResults } from './run.ts';

const isDraftScore = (score: unknown): score is DraftScore =>
  !!score && typeof score === 'object' && 'lineStructure' in score;
const isFollowUpScore = (score: unknown): score is FollowUpScore =>
  !!score && typeof score === 'object' && 'blastRadius' in score;
const isNotesScore = (score: unknown): score is NotesScore =>
  !!score && typeof score === 'object' && 'spurious' in score;

const tick = (value: boolean): string => (value ? '✅' : '❌');
const pct = (value: number): string => `${Math.round(value * 100)}%`;
const usd = (value: number | undefined): string => (value == null ? '—' : `$${value.toFixed(4)}`);
const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

/** All runs for one task, grouped by model, keeping repeats in order. */
function groupByModel(runs: TaskRun[]): Map<string, TaskRun[]> {
  const grouped = new Map<string, TaskRun[]>();
  for (const run of runs) {
    grouped.set(run.model, [...(grouped.get(run.model) ?? []), run]);
  }
  return grouped;
}

/** Median, so one slow call on a shared network doesn't define a model's latency. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

// --- Markdown -------------------------------------------------------------------------

function markdownDraftRow(model: string, runs: TaskRun[]): string {
  const ok = runs.filter((run) => run.ok);
  if (ok.length === 0) return `| \`${model}\` | ❌ all runs failed: ${runs[0]?.error ?? 'unknown'} | | | | | | |`;
  const scores = ok.map((run) => run.score).filter(isDraftScore);
  const first = scores[0];
  const coverage = scores.length
    ? scores.reduce((sum, score) => sum + (score.requestedTotal ? score.coveredTotal / score.requestedTotal : 0), 0) /
      scores.length
    : 0;
  const verse = first?.lineStructure.verseTotal
    ? `${first.lineStructure.verseMatched}/${first.lineStructure.verseTotal}`
    : '—';
  const prose = first?.lineStructure.proseTotal
    ? `${first.lineStructure.proseReflowed}/${first.lineStructure.proseTotal}`
    : '—';
  const lookups = first?.lookups.length ? first.lookups.join(', ') : '—';
  return [
    `| \`${model}\``,
    tick(scores.every((score) => score.setTranslationsCalled)),
    pct(coverage),
    verse,
    prose,
    String(first?.literalEscapes ?? 0),
    lookups,
    `${seconds(median(ok.map((run) => run.durationMs)))} · ${usd(ok[0]?.costUsd)}`,
  ].join(' | ') + ' |';
}

function markdownFollowUpRow(model: string, runs: TaskRun[]): string {
  const ok = runs.filter((run) => run.ok);
  if (ok.length === 0) return `| \`${model}\` | ❌ ${runs[0]?.error ?? 'failed'} | | | | |`;
  const scores = ok.map((run) => run.score).filter(isFollowUpScore);
  const first = scores[0];
  if (!first) return `| \`${model}\` | — | | | | |`;
  return [
    `| \`${model}\``,
    tick(first.usedRevise),
    String(first.blastRadius),
    tick(first.appliedRequestedChange),
    tick(!first.leftObjectionableWording),
    `${seconds(median(ok.map((run) => run.durationMs)))} · ${usd(ok[0]?.costUsd)}`,
  ].join(' | ') + ' |';
}

function markdownNotesRow(model: string, runs: TaskRun[]): string {
  const ok = runs.filter((run) => run.ok);
  if (ok.length === 0) return `| \`${model}\` | ❌ ${runs[0]?.error ?? 'failed'} | | | |`;
  const scores = ok.map((run) => run.score).filter(isNotesScore);
  const first = scores[0];
  if (!first) return `| \`${model}\` | — | | | |`;
  return [
    `| \`${model}\``,
    `${first.covered}/${first.requestedIds.length}`,
    String(first.spurious),
    pct(first.maxEchoRatio),
    `${seconds(median(ok.map((run) => run.durationMs)))} · ${usd(ok[0]?.costUsd)}`,
  ].join(' | ') + ' |';
}

/**
 * The caveat that belongs under each scoreboard.
 *
 * Shared by both renderers so a number never appears in one output with its qualification
 * and in the other without — the HTML report is the one people actually read, and an
 * unqualified "50% source-word overlap" reads as an accusation the metric can't support.
 */
function taskFootnote(taskId: string): string[] {
  if (taskId === 'follow-up') {
    return ['Slides touched should be **1**. Anything more means already-approved slides went back through the model.'];
  }
  if (taskId === 'notes-block') {
    return [
      'Source-word overlap is a blunt "did it translate at all" probe — the worst slide\'s share of long ' +
        'source words that survived verbatim. Cognates inflate it (*gratitude* is the same word in French), ' +
        'so only a figure near **100%** means anything: that slide came back in English.',
    ];
  }
  return [];
}

export function renderMarkdown(results: BenchResults): string {
  const lines: string[] = [
    '# Provider comparison',
    '',
    `Run ${results.startedAt} · ${results.models.length} model(s) · ${results.repeat} repeat(s) per task.`,
    '',
    'Every number here is mechanical — protocol compliance, coverage, line discipline, cost.',
    'Whether the translations *read* well is a human call; open the HTML report for the',
    'side-by-side text.',
    '',
  ];

  for (const task of TASKS) {
    const runs = results.runs.filter((run) => run.taskId === task.id);
    if (runs.length === 0) continue;
    const byModel = groupByModel(runs);

    lines.push(`## ${task.title}`, '', `*${task.probe}*`, '');

    if (task.id.startsWith('draft:')) {
      lines.push(
        '| Model | Used tool | Coverage | Verse lines kept | Prose reflowed | Literal `\\n` | Bible lookups | Median time · cost |',
        '| --- | --- | --- | --- | --- | --- | --- | --- |',
        ...[...byModel].map(([model, modelRuns]) => markdownDraftRow(model, modelRuns)),
      );
    } else if (task.id === 'follow-up') {
      lines.push(
        '| Model | Targeted edit | Slides touched | Applied the change | Removed old wording | Median time · cost |',
        '| --- | --- | --- | --- | --- | --- |',
        ...[...byModel].map(([model, modelRuns]) => markdownFollowUpRow(model, modelRuns)),
      );
    } else {
      lines.push(
        '| Model | Segments returned | Spurious ids | Source-word overlap | Median time · cost |',
        '| --- | --- | --- | --- | --- |',
        ...[...byModel].map(([model, modelRuns]) => markdownNotesRow(model, modelRuns)),
      );
    }
    for (const note of taskFootnote(task.id)) lines.push('', note);
    lines.push('');
  }

  const failures = results.runs.filter((run) => !run.ok);
  if (failures.length > 0) {
    lines.push('## Failures', '');
    for (const failure of failures) {
      lines.push(`- \`${failure.model}\` on \`${failure.taskId}\`: ${failure.error}`);
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

// --- HTML -----------------------------------------------------------------------------

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char] ?? char);

/** Slide text with newlines preserved, so a reader can see the line structure at a glance. */
const cell = (text: string): string => `<pre>${escapeHtml(text)}</pre>`;

/**
 * Side-by-side text for one task: every model's translation of the same slide, per language.
 *
 * Sources run down the left so the eye compares across a row. Only the first repeat of each
 * model is shown — comparing model A's third sample against model B's first is noise.
 */
function htmlSideBySide(taskId: string, results: BenchResults): string {
  const runs = results.runs.filter((run) => run.taskId === taskId && run.ok);
  if (runs.length === 0) return '';
  const byModel = new Map<string, TaskRun>();
  for (const run of runs) if (!byModel.has(run.model)) byModel.set(run.model, run);
  const models = [...byModel.keys()];

  const languages = new Set<string>();
  for (const run of byModel.values()) for (const language of Object.keys(run.translations ?? {})) languages.add(language);

  const sections: string[] = [];
  for (const language of languages) {
    // Source slides, in the order the first model returned them, so rows line up.
    const sources: string[] = [];
    for (const run of byModel.values()) {
      for (const block of run.translations?.[language] ?? []) {
        if (!sources.includes(block.sourceText)) sources.push(block.sourceText);
      }
    }
    if (sources.length === 0) continue;

    const rows = sources
      .map((source) => {
        const cells = models.map((model) => {
          const block = (byModel.get(model)?.translations?.[language] ?? []).find(
            (entry) => entry.sourceText === source,
          );
          return `<td>${block ? cell(block.translatedText) : '<span class="missing">— not returned —</span>'}</td>`;
        });
        return `<tr><th scope="row">${cell(source)}</th>${cells.join('')}</tr>`;
      })
      .join('\n');

    sections.push(`
      <h4>${escapeHtml(language)}</h4>
      <div class="scroll">
        <table class="text">
          <thead><tr><th>Source slide</th>${models.map((model) => `<th>${escapeHtml(model)}</th>`).join('')}</tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`);
  }

  const replies = models
    .map((model) => {
      const reply = byModel.get(model)?.reply?.trim();
      return reply ? `<li><code>${escapeHtml(model)}</code>: ${escapeHtml(reply)}</li>` : '';
    })
    .filter(Boolean)
    .join('\n');

  return `${sections.join('\n')}${
    replies ? `<h4>What each model said to the reviewer</h4><ul class="replies">${replies}</ul>` : ''
  }`;
}

export function renderHtml(results: BenchResults): string {
  const sections = TASKS.filter((task) => results.runs.some((run) => run.taskId === task.id))
    .map((task) => {
      const scoreboard = markdownTableToHtml(renderMarkdownTableFor(task.id, results));
      return `
        <section>
          <h2>${escapeHtml(task.title)}</h2>
          <p class="probe">${escapeHtml(task.probe)}</p>
          ${scoreboard}
          ${taskFootnote(task.id)
            .map((note) => `<p class="probe">${inlineMarkdownToHtml(note)}</p>`)
            .join('')}
          ${htmlSideBySide(task.id, results)}
        </section>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Provider comparison — ${escapeHtml(results.startedAt)}</title>
<style>
  :root { color-scheme: light dark; --bg: #fff; --fg: #16181d; --muted: #5b6270; --line: #dfe3ea; --head: #f5f7fa; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #14161a; --fg: #e6e8ec; --muted: #9aa2b1; --line: #2b3038; --head: #1c2027; }
  }
  body { margin: 0 auto; padding: 2rem 1.25rem 4rem; max-width: 1400px; background: var(--bg); color: var(--fg);
         font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  h1 { font-size: 1.7rem; margin-bottom: .25rem; }
  h2 { font-size: 1.25rem; margin-top: 2.5rem; border-top: 1px solid var(--line); padding-top: 1.5rem; }
  h4 { margin: 1.5rem 0 .5rem; font-size: .95rem; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
  .probe, .lede { color: var(--muted); max-width: 70ch; }
  .scroll { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; margin: .5rem 0 1rem; font-size: .9rem; }
  th, td { border: 1px solid var(--line); padding: .45rem .6rem; text-align: left; vertical-align: top; }
  thead th { background: var(--head); position: sticky; top: 0; }
  table.text th[scope="row"] { width: 22%; background: var(--head); }
  table.text td, table.text th { min-width: 16rem; }
  pre { margin: 0; white-space: pre-wrap; font: inherit; }
  .missing { color: var(--muted); font-style: italic; }
  .replies { color: var(--muted); }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .88em; }
</style>
</head>
<body>
<h1>Provider comparison</h1>
<p class="lede">Run ${escapeHtml(results.startedAt)} · ${results.models.length} model(s) · ${results.repeat} repeat(s) per task.
The tables are mechanical protocol checks. The text below each one is for reading: same slide, every model, side by side.</p>
${sections}
</body>
</html>
`;
}

/** Reuse the Markdown table builders, then convert that one table to HTML. */
function renderMarkdownTableFor(taskId: string, results: BenchResults): string {
  const single: BenchResults = { ...results, runs: results.runs.filter((run) => run.taskId === taskId) };
  const markdown = renderMarkdown(single);
  return markdown
    .split('\n')
    .filter((line) => line.startsWith('|'))
    .join('\n');
}

/** Inline Markdown (`code`, **bold**, *italic*) → HTML, on escaped text. */
function inlineMarkdownToHtml(value: string): string {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

/** Minimal Markdown-table → HTML, sufficient for the tables this file emits. */
function markdownTableToHtml(markdown: string): string {
  const rows = markdown.split('\n').filter((line) => line.trim().startsWith('|'));
  if (rows.length === 0) return '';
  const cells = (row: string) =>
    row
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((value) => value.trim());
  const inlineCode = inlineMarkdownToHtml;
  const header = cells(rows[0]);
  const body = rows
    .slice(2)
    .map((row) => `<tr>${cells(row).map((value) => `<td>${inlineCode(value)}</td>`).join('')}</tr>`)
    .join('\n');
  return `<div class="scroll"><table><thead><tr>${header
    .map((value) => `<th>${inlineCode(value)}</th>`)
    .join('')}</tr></thead><tbody>${body}</tbody></table></div>`;
}

// --- CLI ------------------------------------------------------------------------------

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--')) continue;
    const key = argv[index].slice(2);
    const next = argv[index + 1];
    args[key] = next && !next.startsWith('--') ? ((index += 1), next) : 'true';
  }

  const inputPath = args.in;
  if (!inputPath) {
    console.error('Usage: node bench/report.ts --in <results.json> [--md <file>] [--html <file>]');
    process.exitCode = 1;
    return;
  }

  const results = JSON.parse(await fs.readFile(inputPath, 'utf-8')) as BenchResults;
  const base = inputPath.replace(/\.json$/, '');
  const mdPath = args.md ?? `${base}.md`;
  const htmlPath = args.html ?? `${base}.html`;

  await fs.mkdir(path.dirname(mdPath), { recursive: true });
  await fs.writeFile(mdPath, renderMarkdown(results), 'utf-8');
  await fs.writeFile(htmlPath, renderHtml(results), 'utf-8');

  console.log(`Wrote ${mdPath}`);
  console.log(`Wrote ${htmlPath}`);
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  await main();
}
