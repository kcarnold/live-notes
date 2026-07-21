import { describe, it, expect } from 'vitest';
import { fitFontSize } from './useFitText';

describe('fitFontSize', () => {
  // Model: text height grows linearly with font size (one line), width fixed.
  // heightAt(px) = px * lineCount * lineHeight
  const model = (lineCount: number, lineHeight = 1.2) =>
    (px: number) => ({ width: 100, height: px * lineCount * lineHeight });

  it('returns the largest font size that fits the available height', () => {
    // avail height 120, single line, lineHeight 1.2 => fits up to 100px.
    const best = fitFontSize(1000, 120, model(1), { min: 10, max: 200, steps: 20 });
    expect(best).toBeGreaterThan(99);
    expect(best).toBeLessThanOrEqual(100);
  });

  it('shrinks more when there are more lines', () => {
    const one = fitFontSize(1000, 120, model(1), { min: 10, max: 200, steps: 20 });
    const four = fitFontSize(1000, 120, model(4), { min: 10, max: 200, steps: 20 });
    expect(four).toBeLessThan(one);
    // four lines at 120px / (4 * 1.2) => ~25px
    expect(four).toBeGreaterThan(24);
    expect(four).toBeLessThanOrEqual(25);
  });

  it('is constrained by width when text is too wide', () => {
    // Width grows with font; only <= 50px keeps width under 500.
    const measure = (px: number) => ({ width: px * 10, height: px });
    const best = fitFontSize(500, 100000, measure, { min: 10, max: 200, steps: 20 });
    expect(best).toBeLessThanOrEqual(50);
    expect(best).toBeGreaterThan(49);
  });

  it('never exceeds max even when everything fits', () => {
    const best = fitFontSize(100000, 100000, model(1), { min: 10, max: 64, steps: 20 });
    expect(best).toBe(64);
  });

  it('falls back to min when nothing fits', () => {
    // Even the smallest size overflows.
    const measure = () => ({ width: 0, height: 10_000 });
    const best = fitFontSize(1000, 100, measure, { min: 12, max: 160, steps: 20 });
    expect(best).toBe(12);
  });
});
