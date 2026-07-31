/**
 * Run the bench: every selected task against every selected model, into a results file.
 *
 * Deliberately offline-first. Running costs money and takes minutes, so the run and the
 * report are separate programs: `run.ts` spends the tokens once and writes raw results,
 * `report.ts` turns those results into something readable as many times as you like. Results
 * files are worth keeping — they are the evidence behind whichever provider we settle on, and
 * they can be re-read months later when someone asks why.
 *
 * Usage:
 *   node bench/run.ts --models openrouter:google/gemini-3-pro,openrouter:anthropic/claude-sonnet-4.5
 *   node bench/run.ts --models google:gemini-3.5-flash --tasks notes-block --out bench/results/notes.json
 *
 * Options:
 *   --models   comma-separated model specs (see llm/modelSpec.ts). Required.
 *   --tasks    comma-separated task ids or prefixes; default all. `draft` selects every draft task.
 *   --out      results file; default bench/results/<timestamp>.json
 *   --repeat   run each task/model pair N times (models are non-deterministic); default 1
 *   --max-steps  cap on agent rounds per run; default 12 (the production MAX_AGENT_ROUNDS)
 *   --concurrency  how many runs in flight at once; default 2
 */
import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import pLimit from 'p-limit';
import { MAX_AGENT_ROUNDS } from '../nlp.ts';
import { apiKeyFor, parseModelSpec, resolveModel } from '../llm/modelSpec.ts';
import { selectTasks, type TaskRun } from './tasks.ts';

export interface BenchResults {
  /** When the run happened, so a stale results file is obvious. */
  startedAt: string;
  models: string[];
  taskIds: string[];
  repeat: number;
  runs: TaskRun[];
}

/** Minimal `--flag value` parsing; no dependency, and the flag set is small and stable. */
function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      index += 1;
    } else {
      args[key] = 'true';
    }
  }
  return args;
}

const list = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const models = list(args.models);
  if (models.length === 0) {
    console.error('Usage: node bench/run.ts --models <spec,spec> [--tasks <id,...>] [--out <file>]');
    console.error('Model specs look like "openrouter:google/gemini-3-pro" or "google:gemini-3.5-flash".');
    process.exitCode = 1;
    return;
  }

  const tasks = selectTasks(list(args.tasks));
  if (tasks.length === 0) {
    console.error(`No tasks matched "${args.tasks}".`);
    process.exitCode = 1;
    return;
  }

  // Fail before spending anything on the models that *are* configured — a sweep that dies
  // half way through with a missing key has already burned the earlier calls.
  const missing = models
    .map(parseModelSpec)
    .filter((spec) => !apiKeyFor(spec.provider))
    .map((spec) => spec.spec);
  if (missing.length > 0) {
    console.error(`Missing API key for: ${missing.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const repeat = Number(args.repeat ?? '1');
  const maxSteps = Number(args['max-steps'] ?? String(MAX_AGENT_ROUNDS));
  const limit = pLimit(Number(args.concurrency ?? '2'));
  const startedAt = new Date();
  const outPath =
    args.out ?? path.join('bench', 'results', `${startedAt.toISOString().replace(/[:.]/g, '-')}.json`);

  console.log(`Bench: ${models.length} model(s) × ${tasks.length} task(s) × ${repeat} → ${outPath}`);

  const jobs: Array<Promise<TaskRun>> = [];
  for (const modelSpec of models) {
    const model = resolveModel(modelSpec);
    for (const task of tasks) {
      for (let attempt = 0; attempt < repeat; attempt += 1) {
        jobs.push(
          limit(async () => {
            const label = `${modelSpec} · ${task.id}${repeat > 1 ? ` #${attempt + 1}` : ''}`;
            console.log(`→ ${label}`);
            const run = await task.run({ model, modelSpec, maxSteps });
            const status = run.ok ? `${run.durationMs}ms, ${run.steps} step(s)` : `FAILED: ${run.error}`;
            console.log(`← ${label} — ${status}`);
            return run;
          }),
        );
      }
    }
  }

  const runs = await Promise.all(jobs);
  const results: BenchResults = {
    startedAt: startedAt.toISOString(),
    models,
    taskIds: tasks.map((task) => task.id),
    repeat,
    runs,
  };

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${JSON.stringify(results, null, 2)}\n`, 'utf-8');

  const failed = runs.filter((run) => !run.ok).length;
  console.log(`\nWrote ${runs.length} run(s) to ${outPath}${failed > 0 ? ` (${failed} failed)` : ''}`);
  console.log(`Report with:  node bench/report.ts --in ${outPath}`);
}

// Only run when invoked directly, so the module stays importable from tests.
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  await main();
}
