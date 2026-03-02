#!/usr/bin/env npx tsx

/**
 * Diff-aware ingestion for premium version tracking.
 *
 * Compares current article text in the database against freshly fetched
 * EUR-Lex content. If text has changed, inserts a new version row with
 * unified diff and optionally an AI-generated change summary.
 *
 * Usage:
 *   npx tsx scripts/ingest-version-history.ts                 # all regulations
 *   npx tsx scripts/ingest-version-history.ts --regulation NIS2
 *   npx tsx scripts/ingest-version-history.ts --dry-run       # preview only
 *   npx tsx scripts/ingest-version-history.ts --with-summaries # generate AI summaries
 *   npx tsx scripts/ingest-version-history.ts --seed-baseline  # seed initial version rows (no diff)
 *
 * Requires: data/regulations.db with article_versions table
 *   Run: sqlite3 data/regulations.db < scripts/add-article-versions.sql
 *
 * For AI summaries, set ANTHROPIC_API_KEY in environment.
 */

import Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DB_PATH = join(__dirname, '..', 'data', 'regulations.db');

// --- Types ---

interface ArticleRow {
  rowid: number;
  regulation: string;
  article_number: string;
  text: string;
}

interface SourceRow {
  regulation: string;
  celex_id: string;
  eur_lex_version: string | null;
}

interface VersionRow {
  id: number;
  body_text: string;
  effective_date: string | null;
}

interface CliOptions {
  regulation: string | null;
  dryRun: boolean;
  withSummaries: boolean;
  seedBaseline: boolean;
}

// --- CLI ---

function parseOptions(): CliOptions {
  const args = process.argv.slice(2);
  const regulation = getFlag(args, '--regulation');
  const dryRun = args.includes('--dry-run');
  const withSummaries = args.includes('--with-summaries');
  const seedBaseline = args.includes('--seed-baseline');
  return { regulation, dryRun, withSummaries, seedBaseline };
}

function getFlag(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  if (index < 0 || index + 1 >= args.length) return null;
  return args[index + 1];
}

// --- Diff ---

/**
 * Simple unified diff implementation. Compares line-by-line and produces
 * a unified diff string without external dependencies.
 */
function computeUnifiedDiff(oldText: string, newText: string, label: string): string {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');

  const header = [
    `--- a/${label}`,
    `+++ b/${label}`,
  ];

  // Find changed ranges
  const hunks: string[] = [];
  let i = 0;
  let j = 0;

  while (i < oldLines.length || j < newLines.length) {
    // Skip matching lines
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      i++;
      j++;
      continue;
    }

    // Found a difference — collect the hunk
    const startI = Math.max(0, i - 2);
    const startJ = Math.max(0, j - 2);
    const hunkLines: string[] = [];

    // Context before
    for (let c = startI; c < i; c++) {
      hunkLines.push(` ${oldLines[c]}`);
    }

    // Collect differing lines
    while (i < oldLines.length || j < newLines.length) {
      if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
        // Check if we have enough matching context to end the hunk
        let matchCount = 0;
        while (
          i + matchCount < oldLines.length &&
          j + matchCount < newLines.length &&
          oldLines[i + matchCount] === newLines[j + matchCount]
        ) {
          matchCount++;
          if (matchCount >= 3) break;
        }

        if (matchCount >= 3) {
          // End hunk with context
          for (let c = 0; c < Math.min(2, matchCount); c++) {
            hunkLines.push(` ${oldLines[i + c]}`);
          }
          i += matchCount;
          j += matchCount;
          break;
        }

        hunkLines.push(` ${oldLines[i]}`);
        i++;
        j++;
      } else if (i < oldLines.length && (j >= newLines.length || oldLines[i] !== newLines[j])) {
        hunkLines.push(`-${oldLines[i]}`);
        i++;
      } else {
        hunkLines.push(`+${newLines[j]}`);
        j++;
      }
    }

    if (hunkLines.length > 0) {
      const removals = hunkLines.filter(l => l.startsWith('-')).length;
      const additions = hunkLines.filter(l => l.startsWith('+')).length;
      const context = hunkLines.filter(l => l.startsWith(' ')).length;
      hunks.push(`@@ -${startI + 1},${removals + context} +${startJ + 1},${additions + context} @@`);
      hunks.push(...hunkLines);
    }
  }

  if (hunks.length === 0) return '';
  return [...header, ...hunks].join('\n');
}

// --- AI Summary (optional) ---

async function generateChangeSummary(
  regulation: string,
  article: string,
  diff: string,
): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 256,
        messages: [
          {
            role: 'user',
            content: `Summarize in 1-2 sentences what changed in ${regulation} Article ${article}. Be specific about what was added, removed, or modified. Output only the summary, no preamble.\n\nDiff:\n${diff.slice(0, 3000)}`,
          },
        ],
      }),
    });

    if (!response.ok) {
      console.warn(`  AI summary failed (${response.status}), skipping`);
      return null;
    }

    const data = (await response.json()) as {
      content: Array<{ type: string; text: string }>;
    };
    return data.content[0]?.text ?? null;
  } catch (error) {
    console.warn(`  AI summary error: ${(error as Error).message}`);
    return null;
  }
}

// --- EUR-Lex fetching ---

async function fetchArticleTexts(
  celexId: string,
): Promise<Map<string, string>> {
  const url = `https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:${celexId}`;
  console.log(`  Fetching: ${url}`);

  const response = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (compatible; EU-Compliance-MCP/1.0; +https://github.com/Ansvar-Systems/EU_compliance_MCP)',
      Accept: 'text/html',
    },
  });

  if (!response.ok) {
    throw new Error(`EUR-Lex fetch failed: ${response.status}`);
  }

  const html = await response.text();
  return parseArticlesFromHtml(html);
}

async function parseArticlesFromHtml(html: string): Promise<Map<string, string>> {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  const articles = new Map<string, string>();
  const allText = doc.body?.textContent || '';
  const lines = allText
    .split('\n')
    .map((l: string) => l.trim())
    .filter((l: string) => l);

  let currentNumber: string | null = null;
  let currentLines: string[] = [];
  let hasTitle = false;

  for (const line of lines) {
    const articleStart = line.match(/^Article\s+(\d+[a-z]?)$/i);
    if (articleStart) {
      if (currentNumber && currentLines.length > 0) {
        articles.set(currentNumber, currentLines.join('\n\n'));
      }
      currentNumber = articleStart[1];
      currentLines = [];
      hasTitle = false;
      continue;
    }

    if (currentNumber) {
      if (
        !hasTitle &&
        currentLines.length === 0 &&
        line.length < 100 &&
        !line.endsWith('.')
      ) {
        hasTitle = true;
      } else if (line.length > 0) {
        currentLines.push(line);
      }
    }
  }

  if (currentNumber && currentLines.length > 0) {
    articles.set(currentNumber, currentLines.join('\n\n'));
  }

  return articles;
}

// --- Main ---

async function main(): Promise<void> {
  const options = parseOptions();

  if (!existsSync(DB_PATH)) {
    console.error('Database not found. Run `npm run build:db` first.');
    process.exit(1);
  }

  const db = new Database(DB_PATH);
  db.pragma('foreign_keys = ON');

  // Ensure article_versions table exists
  const hasTable = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='article_versions'",
    )
    .get();

  if (!hasTable) {
    console.log('Creating article_versions table...');
    const schemaPath = join(__dirname, 'add-article-versions.sql');
    if (!existsSync(schemaPath)) {
      console.error('Schema file not found: scripts/add-article-versions.sql');
      process.exit(1);
    }
    db.exec(readFileSync(schemaPath, 'utf-8'));
    console.log('Table created.\n');
  }

  // Get regulations to process
  let sourceQuery = 'SELECT regulation, celex_id, eur_lex_version FROM source_registry';
  const params: string[] = [];

  if (options.regulation) {
    sourceQuery += ' WHERE regulation = ?';
    params.push(options.regulation);
  }

  const sources = db
    .prepare(sourceQuery)
    .all(...params) as SourceRow[];

  if (sources.length === 0) {
    console.log('No regulations found in source_registry.');
    db.close();
    return;
  }

  console.log(
    `Processing ${sources.length} regulation(s)${options.dryRun ? ' (DRY RUN)' : ''}${options.seedBaseline ? ' (SEED BASELINE)' : ''}\n`,
  );

  const insertVersion = db.prepare(`
    INSERT INTO article_versions (article_id, body_text, effective_date, superseded_date, scraped_at, change_summary, diff_from_previous, source_url)
    VALUES (?, ?, ?, NULL, ?, ?, ?, ?)
  `);

  const updateSuperseded = db.prepare(`
    UPDATE article_versions
    SET superseded_date = ?
    WHERE article_id = ? AND superseded_date IS NULL AND id != ?
  `);

  const getLatestVersion = db.prepare(`
    SELECT id, body_text, effective_date
    FROM article_versions
    WHERE article_id = ?
    ORDER BY scraped_at DESC
    LIMIT 1
  `);

  let totalInserted = 0;
  let totalUnchanged = 0;
  let totalErrors = 0;

  for (const source of sources) {
    console.log(`\n--- ${source.regulation} (${source.celex_id}) ---`);

    const articles = db
      .prepare(
        'SELECT rowid, regulation, article_number, text FROM articles WHERE regulation = ?',
      )
      .all(source.regulation) as ArticleRow[];

    console.log(`  ${articles.length} articles in database`);

    if (options.seedBaseline) {
      const now = new Date().toISOString();
      let seeded = 0;

      for (const article of articles) {
        const existing = getLatestVersion.get(article.rowid) as VersionRow | undefined;
        if (existing) continue;

        if (!options.dryRun) {
          const eurLexUrl = `https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:${source.celex_id}`;
          insertVersion.run(
            article.rowid,
            article.text,
            source.eur_lex_version || now.slice(0, 10),
            now,
            null,
            null,
            eurLexUrl,
          );
        }
        seeded++;
      }

      console.log(
        `  Seeded ${seeded} baseline version(s)${options.dryRun ? ' (dry run)' : ''}`,
      );
      totalInserted += seeded;
      continue;
    }

    // Fetch fresh from EUR-Lex
    let freshTexts: Map<string, string>;
    try {
      freshTexts = await fetchArticleTexts(source.celex_id);
      console.log(`  ${freshTexts.size} articles fetched from EUR-Lex`);
    } catch (error) {
      console.error(
        `  ERROR fetching ${source.celex_id}: ${(error as Error).message}`,
      );
      totalErrors++;
      continue;
    }

    const now = new Date().toISOString();
    let changed = 0;
    let unchanged = 0;

    for (const article of articles) {
      const freshText = freshTexts.get(article.article_number);
      if (!freshText) continue;

      // Normalize for comparison
      const normalizedCurrent = article.text.replace(/\s+/g, ' ').trim();
      const normalizedFresh = freshText.replace(/\s+/g, ' ').trim();

      if (normalizedCurrent === normalizedFresh) {
        unchanged++;
        continue;
      }

      const label = `${source.regulation}_Article_${article.article_number}`;
      const diff = computeUnifiedDiff(article.text, freshText, label);

      let summary: string | null = null;
      if (options.withSummaries) {
        summary = await generateChangeSummary(
          source.regulation,
          article.article_number,
          diff,
        );
        if (summary) {
          console.log(`    Art ${article.article_number}: ${summary}`);
        }
      }

      if (!options.dryRun) {
        const eurLexUrl = `https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:${source.celex_id}`;
        const result = insertVersion.run(
          article.rowid,
          freshText,
          now.slice(0, 10),
          now,
          summary,
          diff,
          eurLexUrl,
        );

        updateSuperseded.run(now.slice(0, 10), article.rowid, result.lastInsertRowid);
      }

      changed++;
      const addedLines = diff.split('\n').filter((l) => l.startsWith('+')).length - 1;
      const removedLines = diff.split('\n').filter((l) => l.startsWith('-')).length - 1;
      console.log(
        `    Art ${article.article_number}: CHANGED (+${addedLines}/-${removedLines} lines)`,
      );
    }

    console.log(
      `  Result: ${changed} changed, ${unchanged} unchanged${options.dryRun ? ' (dry run)' : ''}`,
    );
    totalInserted += changed;
    totalUnchanged += unchanged;
  }

  db.close();

  console.log('\n' + '='.repeat(60));
  console.log('Summary');
  console.log('='.repeat(60));
  console.log(`  New versions inserted: ${totalInserted}`);
  console.log(`  Articles unchanged: ${totalUnchanged}`);
  console.log(`  Errors: ${totalErrors}`);
  if (options.dryRun) console.log('  (DRY RUN - no changes written)');
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
