/** Minimize all public names, including older free-text name submissions. */
export function publicName(raw: string | null | undefined): string {
  const words = (raw ?? '').trim().split(/\s+/).filter(Boolean);
  const first = words[0];
  if (!first || !/^[\p{L}][\p{L}'’\-]*$/u.test(first)) return 'Player';
  if (words.length === 1) return first.slice(0, 30);
  const initial = words[words.length - 1]?.match(/^[\p{L}]/u)?.[0];
  return initial ? `${first.slice(0, 30)} ${initial.toLocaleUpperCase()}.` : first.slice(0, 30);
}
