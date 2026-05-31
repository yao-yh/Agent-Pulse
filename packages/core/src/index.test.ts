import { describe, expect, it } from 'vitest';
import { eventTypeToTaskStatus, redactSecrets, stableId } from './index';

describe('core helpers', () => {
  it('redacts secret-like keys recursively', () => {
    expect(redactSecrets({ nested: { apiKey: 'sk-test-secret' }, safe: 'hello' })).toEqual({
      nested: { apiKey: '<redacted>' },
      safe: 'hello'
    });
  });

  it('maps important event types to task status', () => {
    expect(eventTypeToTaskStatus('permission.request')).toBe('waiting');
    expect(eventTypeToTaskStatus('error')).toBe('failed');
    expect(eventTypeToTaskStatus('session.end')).toBe('completed');
  });

  it('creates stable ids', () => {
    expect(stableId('x', { a: 1 })).toBe(stableId('x', { a: 1 }));
  });
});

