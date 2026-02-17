/**
 * Golden Contract Tests
 *
 * Validates that critical data points in the production database match
 * expected values. These tests catch data corruption, parsing regressions,
 * and accidental data loss during re-ingestion.
 *
 * Golden tests are loaded from fixtures/golden-tests.json.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from '@ansvar/mcp-sqlite';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import { createSqliteAdapter } from '../../src/database/sqlite-adapter.js';
import { searchRegulations } from '../../src/tools/search.js';
import { getArticle } from '../../src/tools/article.js';
import { getRecital } from '../../src/tools/recital.js';
import { listRegulations } from '../../src/tools/list.js';
import { getDefinitions } from '../../src/tools/definitions.js';
import { mapControls } from '../../src/tools/map.js';
import { checkApplicability } from '../../src/tools/applicability.js';
import { getAbout } from '../../src/tools/about.js';
import type { DatabaseAdapter } from '../../src/database/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DB_PATH = join(__dirname, '..', '..', 'data', 'regulations.db');
const GOLDEN_TESTS_PATH = join(__dirname, '..', '..', 'fixtures', 'golden-tests.json');

interface GoldenAssertion {
  path: string;
  equals?: any;
  contains?: string;
  greaterThan?: number;
  oneOf?: any[];
  exists?: boolean;
  notExists?: boolean;
}

interface GoldenTest {
  id: string;
  description: string;
  tool: string;
  input: Record<string, any>;
  assertions: GoldenAssertion[];
}

function getNestedValue(obj: any, path: string): any {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.');
  let current = obj;
  for (const part of parts) {
    if (current === undefined || current === null) return undefined;
    current = current[part];
  }
  return current;
}

describe('Golden Contract Tests', () => {
  let db: DatabaseAdapter;
  let goldenTests: GoldenTest[];

  beforeAll(() => {
    const sqliteDb = new Database(DB_PATH, { readonly: true });
    db = createSqliteAdapter(sqliteDb);

    const content = readFileSync(GOLDEN_TESTS_PATH, 'utf-8');
    goldenTests = JSON.parse(content);
  });

  afterAll(async () => {
    await db.close();
  });

  it('should have at least 10 golden tests defined', () => {
    expect(goldenTests.length).toBeGreaterThanOrEqual(10);
  });

  // Generate a test for each golden test case
  const testContent = readFileSync(GOLDEN_TESTS_PATH, 'utf-8');
  const tests: GoldenTest[] = JSON.parse(testContent);

  for (const test of tests) {
    it(`[${test.id}] ${test.description}`, async () => {
      const sqliteDb = new Database(DB_PATH, { readonly: true });
      const testDb = createSqliteAdapter(sqliteDb);

      let result: any;
      let isError = false;

      try {
        switch (test.tool) {
          case 'get_article':
            result = await getArticle(testDb, test.input as any);
            break;
          case 'get_recital':
            result = await getRecital(testDb, test.input as any);
            break;
          case 'search_regulations':
            result = await searchRegulations(testDb, test.input as any);
            break;
          case 'list_regulations':
            result = await listRegulations(testDb, test.input as any);
            break;
          case 'get_definitions':
            result = await getDefinitions(testDb, test.input as any);
            break;
          case 'map_controls':
            result = await mapControls(testDb, test.input as any);
            break;
          case 'check_applicability':
            result = await checkApplicability(testDb, test.input as any);
            break;
          case 'about':
            result = await getAbout(testDb, {
              version: '1.0.0',
              fingerprint: 'test',
              dbBuilt: '2026-01-01',
            });
            break;
          default:
            throw new Error(`Unknown tool: ${test.tool}`);
        }
      } catch (error) {
        isError = true;
        result = { error: error instanceof Error ? error.message : String(error) };
      }

      // Wrap null results for assertion purposes
      if (result === null || result === undefined) {
        result = { _isNull: true };
      }

      for (const assertion of test.assertions) {
        const value = getNestedValue(result, assertion.path);

        if (assertion.equals !== undefined) {
          expect(value, `${test.id}: ${assertion.path} should equal ${assertion.equals}`).toEqual(assertion.equals);
        }
        if (assertion.contains !== undefined) {
          expect(value, `${test.id}: ${assertion.path} should contain "${assertion.contains}"`).toContain(assertion.contains);
        }
        if (assertion.greaterThan !== undefined) {
          expect(value, `${test.id}: ${assertion.path} should be > ${assertion.greaterThan}`).toBeGreaterThan(assertion.greaterThan);
        }
        if (assertion.oneOf !== undefined) {
          expect(assertion.oneOf, `${test.id}: ${assertion.path} should be one of ${assertion.oneOf}`).toContain(value);
        }
        if (assertion.exists === true) {
          expect(value, `${test.id}: ${assertion.path} should exist`).toBeDefined();
        }
        if (assertion.notExists === true) {
          expect(isError, `${test.id}: should not produce an error`).toBe(false);
        }
      }

      await testDb.close();
    });
  }
});
