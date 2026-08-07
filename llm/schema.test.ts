import { describe, expect, it } from 'vitest';
import { Type } from '@google/genai';
import { REVISE_TRANSLATION_TOOL, SET_TRANSLATIONS_TOOL } from '../nlp.ts';
import { geminiSchemaToJsonSchema, geminiToolToNeutral } from './schema.ts';

describe('geminiSchemaToJsonSchema', () => {
  it('lower-cases type names', () => {
    expect(geminiSchemaToJsonSchema({ type: Type.STRING }).type).toBe('string');
    expect(geminiSchemaToJsonSchema({ type: Type.INTEGER }).type).toBe('integer');
  });

  it('converts nested object and array schemas', () => {
    const converted = geminiSchemaToJsonSchema({
      type: Type.OBJECT,
      required: ['items'],
      properties: {
        items: {
          type: Type.ARRAY,
          items: { type: Type.OBJECT, properties: { id: { type: Type.INTEGER } } },
        },
      },
    });

    expect(converted).toEqual({
      type: 'object',
      required: ['items'],
      additionalProperties: false,
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: { id: { type: 'integer' } },
          },
        },
      },
    });
  });

  it('keeps descriptions, which are prompt surface rather than decoration', () => {
    expect(geminiSchemaToJsonSchema({ type: Type.STRING, description: 'the exact substring' }).description).toBe(
      'the exact substring',
    );
  });

  it('omits required when there is nothing required', () => {
    expect(geminiSchemaToJsonSchema({ type: Type.OBJECT, required: [] }).required).toBeUndefined();
  });
});

describe('geminiToolToNeutral', () => {
  it('carries the real tool declarations across without losing their contract', () => {
    const revise = geminiToolToNeutral(REVISE_TRANSLATION_TOOL);

    expect(revise.name).toBe('revise_translation');
    expect(revise.description).toContain('EXACTLY ONCE');
    expect(revise.inputSchema.required).toEqual(['language', 'segmentId', 'find', 'replace']);
    expect(revise.inputSchema.properties?.segmentId.type).toBe('integer');
  });

  it('converts the nested languages/segments structure of set_translations', () => {
    const set = geminiToolToNeutral(SET_TRANSLATIONS_TOOL);
    const segments = set.inputSchema.properties?.languages.items?.properties?.segments;

    expect(set.inputSchema.properties?.languages.type).toBe('array');
    expect(segments?.items?.required).toEqual(['segmentId', 'translation']);
    expect(segments?.items?.properties?.translation.description).toContain('backslash-n');
  });

  it('gives a parameterless declaration an empty object schema', () => {
    expect(geminiToolToNeutral({ name: 'ping', description: 'ping' }).inputSchema).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
  });
});
