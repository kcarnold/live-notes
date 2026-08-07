/**
 * Tests for the telemetry call options.
 *
 * These assert the *shape we send*, which is all this side of the wire controls. Whether
 * PostHog turns these attributes back into a conversation trace and a person is a server-side
 * question no unit test can answer — see the procedure in docs/llm-providers.md.
 */
import { describe, expect, it } from 'vitest';
import { TRACE_ATTRIBUTE_KEYS, telemetryFor } from './telemetry.ts';

describe('telemetryFor', () => {
  it('sends the conversation id under both the PostHog and OpenTelemetry names', () => {
    const options = telemetryFor('slide-translation-agent', { traceId: 'item-42' });

    expect(options.runtimeContext[TRACE_ATTRIBUTE_KEYS.posthogTraceId]).toBe('item-42');
    expect(options.runtimeContext[TRACE_ATTRIBUTE_KEYS.otelSessionId]).toBe('item-42');
  });

  it('sends the person id under both names', () => {
    const options = telemetryFor('slide-translation-agent', { distinctId: 'doc-2026-07-31' });

    expect(options.runtimeContext[TRACE_ATTRIBUTE_KEYS.posthogDistinctId]).toBe('doc-2026-07-31');
    expect(options.runtimeContext[TRACE_ATTRIBUTE_KEYS.otelUserId]).toBe('doc-2026-07-31');
  });

  it('opts every key into telemetry, since the AI SDK excludes runtime context by default', () => {
    const options = telemetryFor('agent', { traceId: 't', distinctId: 'd', properties: { source: 'followUp' } });

    expect(Object.keys(options.telemetry.includeRuntimeContext).sort()).toEqual(
      Object.keys(options.runtimeContext).sort(),
    );
    expect(Object.values(options.telemetry.includeRuntimeContext).every(Boolean)).toBe(true);
  });

  it('carries the functionId through, which is how calls group by workload', () => {
    expect(telemetryFor('notes-block-translation', {}).telemetry.functionId).toBe('notes-block-translation');
  });

  it('stringifies extra properties, because span attributes are not arbitrary JSON', () => {
    const options = telemetryFor('agent', { properties: { itemTitle: 'Psalm 23', slideCount: 4 } });

    expect(options.runtimeContext.itemTitle).toBe('Psalm 23');
    expect(options.runtimeContext.slideCount).toBe('4');
  });

  it('drops null and undefined properties rather than sending "null"', () => {
    const options = telemetryFor('agent', { properties: { itemTitle: undefined, note: null } });

    expect(options.runtimeContext).toEqual({});
    expect(options.telemetry.includeRuntimeContext).toEqual({});
  });

  it('produces an empty context when there is nothing to tag, not undefined keys', () => {
    const options = telemetryFor('agent', {});

    expect(options.runtimeContext).toEqual({});
    expect(options.telemetry.functionId).toBe('agent');
  });
});
