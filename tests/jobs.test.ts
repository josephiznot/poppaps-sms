import { describe, it, expect } from 'vitest';
import { partitionBySubscribed } from '../src/lib/jobs';

describe('partitionBySubscribed', () => {
  it('splits phones into subscribed and opted-out, preserving order', () => {
    const subscribed = new Set(['+15550000001', '+15550000003']);
    const res = partitionBySubscribed(['+15550000001', '+15550000002', '+15550000003'], subscribed);
    expect(res.subscribed).toEqual(['+15550000001', '+15550000003']);
    expect(res.optedOut).toEqual(['+15550000002']);
  });

  it('treats phones missing from the set as opted out (safe default)', () => {
    const res = partitionBySubscribed(['+15550000009'], new Set());
    expect(res.subscribed).toEqual([]);
    expect(res.optedOut).toEqual(['+15550000009']);
  });

  it('handles an empty input list', () => {
    const res = partitionBySubscribed([], new Set(['+15550000001']));
    expect(res.subscribed).toEqual([]);
    expect(res.optedOut).toEqual([]);
  });
});
