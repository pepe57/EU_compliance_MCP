/**
 * Shared FTS5 query escaping for SQLite full-text search.
 */

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at',
  'to', 'for', 'of', 'with', 'by',
]);

/**
 * Escape special FTS5 query characters and build optimal search query for SQLite.
 */
export function escapeFts5Query(query: string): string {
  const words = query
    .replace(/[*+^():.§/|;=~!@#$%&\\{}[\],<>]/g, '')
    .replace(/['"]/g, '')
    .replace(/-/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOPWORDS.has(word.toLowerCase()));

  if (words.length === 0) return '';
  if (words.length <= 3) return words.join(' ');
  return words.map((word) => `${word}*`).join(' OR ');
}
