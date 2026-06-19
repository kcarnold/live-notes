import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { SlideLibrary } from './slideLibrary.ts';

describe('SlideLibrary', () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'slide-lib-'));
    filePath = path.join(dir, 'library.json');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('treats a missing file as an empty library', async () => {
    const lib = new SlideLibrary(filePath);
    await lib.load();
    expect(lib.list()).toEqual([]);
    expect(lib.lookup('French', 'anything')).toBeUndefined();
  });

  it('upserts a reviewed entry and looks it up by normalized text', async () => {
    const lib = new SlideLibrary(filePath);
    await lib.load();
    await lib.upsert({ language: 'French', sourceText: 'Praise the Lord', text: 'Louez le Seigneur' });

    const entry = lib.lookup('French', '  Praise the Lord  ');
    expect(entry?.text).toBe('Louez le Seigneur');
    expect(entry?.status).toBe('reviewed');
    expect(entry?.provenance).toBe('human');
    expect(entry?.reviewedAt).toBeTypeOf('number');
  });

  it('persists across reloads from a fresh instance', async () => {
    const lib = new SlideLibrary(filePath);
    await lib.load();
    await lib.upsert({
      language: 'French',
      sourceText: 'Psalm 23:1',
      text: 'Le Seigneur est mon berger',
      provenance: 'bible',
    });

    const reloaded = new SlideLibrary(filePath);
    await reloaded.load();
    const entry = reloaded.lookup('French', 'Psalm 23:1');
    expect(entry?.text).toBe('Le Seigneur est mon berger');
    expect(entry?.provenance).toBe('bible');
  });

  it('replaces an existing entry on re-upsert', async () => {
    const lib = new SlideLibrary(filePath);
    await lib.load();
    await lib.upsert({ language: 'French', sourceText: 'Amen', text: 'first' });
    await lib.upsert({ language: 'French', sourceText: 'Amen', text: 'second' });

    expect(lib.lookup('French', 'Amen')?.text).toBe('second');
    expect(lib.list()).toHaveLength(1);
  });

  it('keeps separate entries per language', async () => {
    const lib = new SlideLibrary(filePath);
    await lib.load();
    await lib.upsert({ language: 'French', sourceText: 'Amen', text: 'Amen (fr)' });
    await lib.upsert({ language: 'Spanish', sourceText: 'Amen', text: 'Amén (es)' });

    expect(lib.lookup('French', 'Amen')?.text).toBe('Amen (fr)');
    expect(lib.lookup('Spanish', 'Amen')?.text).toBe('Amén (es)');
    expect(lib.list()).toHaveLength(2);
  });
});
