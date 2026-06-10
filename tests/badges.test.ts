import { describe, it, expect } from 'vitest';
import { computeBadges, badgesForAll, type PlayedGame } from '../src/lib/badges';

const g = (id: string, scored: boolean): PlayedGame => ({ gameId: id, scored });

describe('computeBadges', () => {
  it('🔥 Hot: top-5 in last two played games', () => {
    expect(computeBadges([g('a', false), g('b', true), g('c', true)], [])).toContain('🔥 Hot');
  });

  it('⚡ Comeback: first top-5 after 4+ played games without', () => {
    const played = [g('1', false), g('2', false), g('3', false), g('4', false), g('5', true)];
    const badges = computeBadges(played, []);
    expect(badges).toContain('⚡ Comeback');
    expect(badges).not.toContain('🔥 Hot');
  });

  it('no Comeback with fewer than 4 dry games before the score', () => {
    expect(computeBadges([g('1', false), g('2', false), g('3', true)], [])).toEqual([]);
  });

  it('🃏 Regular: attended all of the last 3 recorded games', () => {
    const played = [g('x', false), g('y', false), g('z', false)];
    expect(computeBadges(played, ['x', 'y', 'z'])).toContain('🃏 Regular');
    expect(computeBadges(played, ['x', 'y', 'w'])).not.toContain('🃏 Regular');
  });

  it('no badges for a quiet history', () => {
    expect(computeBadges([g('a', true), g('b', false)], ['a', 'b', 'c'])).toEqual([]);
  });
});

describe('badgesForAll', () => {
  it('groups history per player and uses the venue-wide last 3 games', () => {
    // Games in chronological order: g1, g2, g3. Alice plays+scores all; Bob plays all, never scores.
    const history = [
      { member_phone: 'A', game_id: 'g1', starts_at: '1', points: 5 },
      { member_phone: 'B', game_id: 'g1', starts_at: '1', points: 0 },
      { member_phone: 'A', game_id: 'g2', starts_at: '2', points: 5 },
      { member_phone: 'B', game_id: 'g2', starts_at: '2', points: 0 },
      { member_phone: 'A', game_id: 'g3', starts_at: '3', points: 4 },
      { member_phone: 'B', game_id: 'g3', starts_at: '3', points: 0 },
    ];
    const all = badgesForAll(history);
    expect(all['A']).toEqual(['🔥 Hot', '🃏 Regular']);
    expect(all['B']).toEqual(['🃏 Regular']); // never shamed, still celebrated for showing up
  });
});
