/**
 * Gemini `Schema` → JSON Schema.
 *
 * Our tool definitions live in [nlp.ts](../nlp.ts) as Gemini `FunctionDeclaration`s, and they
 * are the *specification* of the slide-translation protocol — the descriptions in them are
 * carefully worded prompt surface (the line-break note, the "find must occur exactly once"
 * contract). Duplicating them in a second dialect so the AI SDK path can run the same tools
 * would mean two places to edit and a silent drift between what Gemini is told and what every
 * other provider is told, which is exactly what the comparison is trying to measure.
 *
 * So there is one source of truth and this converts. Gemini's schema dialect *is* OpenAPI /
 * JSON Schema with the type names shouted in upper case (`Type.OBJECT` === `"OBJECT"`), so
 * the conversion is a recursive lower-casing plus a rename of the couple of fields that
 * differ. See `Type` in @google/genai.
 */
import type { FunctionDeclaration, Schema } from '@google/genai';

/** JSON Schema type names, spelled as JSON Schema spells them (Gemini shouts them). */
export type JsonSchemaTypeName = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';

/** The JSON Schema subset we emit — enough for the tool inputs we actually declare. */
export interface JsonSchemaNode {
  type?: JsonSchemaTypeName;
  description?: string;
  enum?: string[];
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  items?: JsonSchemaNode;
  /** Set on every object so providers with strict structured-output modes stay happy. */
  additionalProperties?: boolean;
}

/**
 * Convert one Gemini schema node.
 *
 * `nullable` is deliberately dropped rather than translated to a `["string","null"]` union:
 * none of our tool inputs use it, and a union type is the sort of thing that some providers'
 * strict modes reject outright — a difference in the harness would show up as a model
 * difference in the results.
 */
export function geminiSchemaToJsonSchema(schema: Schema): JsonSchemaNode {
  const node: JsonSchemaNode = {};

  if (schema.type) node.type = String(schema.type).toLowerCase() as JsonSchemaTypeName;
  if (schema.description) node.description = schema.description;
  if (schema.enum) node.enum = [...schema.enum];

  if (schema.properties) {
    node.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [key, geminiSchemaToJsonSchema(value)]),
    );
    // JSON Schema defaults `additionalProperties` to true; strict tool-calling modes want it
    // pinned off. Harmless for providers that ignore it.
    node.additionalProperties = false;
  }
  if (schema.required && schema.required.length > 0) node.required = [...schema.required];
  if (schema.items) node.items = geminiSchemaToJsonSchema(schema.items);

  return node;
}

/** A tool declaration in the provider-neutral shape the AI SDK path consumes. */
export interface NeutralToolDeclaration {
  name: string;
  description: string;
  inputSchema: JsonSchemaNode;
}

/**
 * Convert a Gemini `FunctionDeclaration` into a name + description + JSON Schema triple.
 *
 * A declaration with no `parameters` becomes an empty object schema rather than an absent
 * one, because several providers reject a tool with no input schema at all.
 */
export function geminiToolToNeutral(declaration: FunctionDeclaration): NeutralToolDeclaration {
  return {
    name: declaration.name ?? 'unknown',
    description: declaration.description ?? '',
    inputSchema: declaration.parameters
      ? geminiSchemaToJsonSchema(declaration.parameters)
      : { type: 'object', properties: {}, additionalProperties: false },
  };
}
