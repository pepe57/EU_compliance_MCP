/**
 * Drift Detection Tests
 *
 * Compares SHA-256 hashes of critical data points against known-good values.
 * When a hash changes, it means upstream data (EUR-Lex) has been updated or
 * a parsing regression has occurred. The golden-hashes.json file should be
 * regenerated after verified re-ingestion.
 *
 * Usage:
 *   npm test -- tests/golden/drift-detection.test.ts
 *
 * Regenerate hashes:
 *   npx tsx scripts/generate-golden-hashes.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from '@ansvar/mcp-sqlite';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { createSqliteAdapter } from '../../src/database/sqlite-adapter.js';
import type { DatabaseAdapter } from '../../src/database/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DB_PATH = join(__dirname, '..', '..', 'data', 'regulations.db');
const HASHES_PATH = join(__dirname, '..', '..', 'fixtures', 'golden-hashes.json');

function sha256(text: string): string {
  return createHash('sha256').update(text + '\n').digest('hex');
}

interface GoldenHashes {
  _description: string;
  _generated: string;
  articles: Record<string, string>;
  recitals: Record<string, string>;
  definitions: Record<string, string>;
  counts: Record<string, number>;
}

describe('Drift Detection', () => {
  let db: DatabaseAdapter;
  let hashes: GoldenHashes;

  beforeAll(() => {
    const sqliteDb = new Database(DB_PATH, { readonly: true });
    db = createSqliteAdapter(sqliteDb);

    const content = readFileSync(HASHES_PATH, 'utf-8');
    hashes = JSON.parse(content);
  });

  afterAll(async () => {
    await db.close();
  });

  describe('Article text hashes', () => {
    for (const [key, expectedHash] of Object.entries(
      JSON.parse(readFileSync(HASHES_PATH, 'utf-8')).articles
    )) {
      const [regulation, article] = key.split(':');

      it(`${regulation} Article ${article} text matches golden hash`, async () => {
        const result = await db.query(
          'SELECT text FROM articles WHERE regulation = ? AND article_number = ?',
          [regulation, article]
        );

        expect(result.rows.length, `Article ${key} not found`).toBe(1);

        const actualHash = sha256((result.rows[0] as any).text);
        expect(actualHash, `${key} text has drifted from golden hash`).toBe(expectedHash);
      });
    }
  });

  describe('Recital text hashes', () => {
    for (const [key, expectedHash] of Object.entries(
      JSON.parse(readFileSync(HASHES_PATH, 'utf-8')).recitals
    )) {
      const [regulation, recitalNum] = key.split(':');

      it(`${regulation} Recital ${recitalNum} text matches golden hash`, async () => {
        const result = await db.query(
          'SELECT text FROM recitals WHERE regulation = ? AND recital_number = ?',
          [regulation, Number(recitalNum)]
        );

        expect(result.rows.length, `Recital ${key} not found`).toBe(1);

        const actualHash = sha256((result.rows[0] as any).text);
        expect(actualHash, `${key} recital text has drifted from golden hash`).toBe(expectedHash);
      });
    }
  });

  describe('Definition text hashes', () => {
    for (const [key, expectedHash] of Object.entries(
      JSON.parse(readFileSync(HASHES_PATH, 'utf-8')).definitions
    )) {
      const [regulation, term] = key.split(':');

      it(`${regulation} definition "${term}" matches golden hash`, async () => {
        const result = await db.query(
          'SELECT definition FROM definitions WHERE regulation = ? AND term = ?',
          [regulation, term]
        );

        expect(result.rows.length, `Definition ${key} not found`).toBe(1);

        const actualHash = sha256((result.rows[0] as any).definition);
        expect(actualHash, `${key} definition text has drifted from golden hash`).toBe(expectedHash);
      });
    }
  });

  describe('Row counts', () => {
    it('regulation count matches golden value', async () => {
      const result = await db.query('SELECT COUNT(*) as count FROM regulations');
      expect(Number((result.rows[0] as any).count)).toBe(hashes.counts.regulations);
    });

    it('article count matches golden value', async () => {
      const result = await db.query('SELECT COUNT(*) as count FROM articles');
      expect(Number((result.rows[0] as any).count)).toBe(hashes.counts.articles);
    });
  });
});
