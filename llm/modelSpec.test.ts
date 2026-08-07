import { describe, expect, it } from 'vitest';
import { apiKeyEnvNames, apiKeyFor, parseModelSpec, resolveModel } from './modelSpec.ts';

describe('parseModelSpec', () => {
  it('splits a prefixed spec into provider and model', () => {
    expect(parseModelSpec('openrouter:google/gemini-3-pro')).toEqual({
      provider: 'openrouter',
      modelId: 'google/gemini-3-pro',
      spec: 'openrouter:google/gemini-3-pro',
    });
  });

  it('splits only on the first colon, so model variants survive', () => {
    expect(parseModelSpec('openrouter:anthropic/claude-sonnet-4:thinking').modelId).toBe(
      'anthropic/claude-sonnet-4:thinking',
    );
  });

  it('routes a bare model id through OpenRouter', () => {
    expect(parseModelSpec('google/gemini-3-pro')).toMatchObject({
      provider: 'openrouter',
      modelId: 'google/gemini-3-pro',
    });
  });

  it('treats an unknown prefix as part of the model id, not as a provider', () => {
    // `anthropic/...:thinking` has a colon but no provider prefix — splitting on it would
    // silently drop the variant.
    expect(parseModelSpec('anthropic/claude-sonnet-4:thinking')).toMatchObject({
      provider: 'openrouter',
      modelId: 'anthropic/claude-sonnet-4:thinking',
    });
  });

  it('names the direct Google provider', () => {
    expect(parseModelSpec('google:gemini-3.5-flash')).toMatchObject({
      provider: 'google',
      modelId: 'gemini-3.5-flash',
    });
  });

  it('tolerates surrounding whitespace from a comma-separated command line', () => {
    expect(parseModelSpec('  google:gemini-3.5-flash  ').modelId).toBe('gemini-3.5-flash');
  });
});

describe('apiKeyFor', () => {
  it('reads the provider-specific variable', () => {
    expect(apiKeyFor('openrouter', { OPENROUTER_API_KEY: 'sk-or-x' })).toBe('sk-or-x');
  });

  it('prefers GEMINI_API_KEY, which is the one this repo already sets', () => {
    expect(apiKeyFor('google', { GEMINI_API_KEY: 'a', GOOGLE_GENERATIVE_AI_API_KEY: 'b' })).toBe('a');
  });

  it('falls back to the AI SDK\'s own variable name for Google', () => {
    expect(apiKeyFor('google', { GOOGLE_GENERATIVE_AI_API_KEY: 'b' })).toBe('b');
  });

  it('is undefined when nothing is set', () => {
    expect(apiKeyFor('openrouter', {})).toBeUndefined();
  });
});

describe('resolveModel', () => {
  it('builds an OpenRouter model without touching the real environment', () => {
    const model = resolveModel('openrouter:google/gemini-3-pro', { env: { OPENROUTER_API_KEY: 'sk-or-x' } });
    expect(model).toMatchObject({ provider: 'openrouter', modelId: 'google/gemini-3-pro' });
  });

  it('builds a direct Google model', () => {
    const model = resolveModel('google:gemini-3.5-flash', { env: { GEMINI_API_KEY: 'k' } });
    expect(model).toMatchObject({ modelId: 'gemini-3.5-flash' });
  });

  it('fails with the variable names to set, rather than a generic auth error later', () => {
    expect(() => resolveModel('openrouter:whatever', { env: {} })).toThrow(/OPENROUTER_API_KEY/);
    expect(apiKeyEnvNames('google')).toEqual(['GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY']);
  });
});
