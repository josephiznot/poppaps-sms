import { describe, it, expect } from 'vitest';
import { playerId, playerIdMap } from '../src/lib/playerId';

describe('playerId', () => {
  it('is deterministic for the same phone', async () => {
    expect(await playerId('+16155551234')).toBe(await playerId('+16155551234'));
  });

  it('is 16 lowercase hex chars (no PII)', async () => {
    expect(await playerId('+16155551234')).toMatch(/^[0-9a-f]{16}$/);
  });

  it('gives distinct phones distinct ids, and the map resolves back to the phone', async () => {
    const phones = ['+16155551234', '+16155555678', '+16155550000'];
    const map = await playerIdMap(phones);
    expect(map.size).toBe(3);
    expect(map.get(await playerId('+16155555678'))).toBe('+16155555678');
    for (const id of map.keys()) expect(phones).not.toContain(id);
  });
});
