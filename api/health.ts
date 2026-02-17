import type { VercelRequest, VercelResponse } from '@vercel/node';
import Database from '@ansvar/mcp-sqlite';
import { join } from 'path';
import { existsSync, copyFileSync, statSync } from 'fs';

const SOURCE_DB = process.env.EU_COMPLIANCE_DB_PATH
  || join(process.cwd(), 'data', 'regulations.db');
const TMP_DB = '/tmp/regulations.db';

export default function handler(_req: VercelRequest, res: VercelResponse) {
  try {
    // Copy to /tmp if needed (same as mcp.ts)
    if (!existsSync(TMP_DB) && existsSync(SOURCE_DB)) {
      copyFileSync(SOURCE_DB, TMP_DB);
    }

    const dbPath = existsSync(TMP_DB) ? TMP_DB : SOURCE_DB;

    if (!existsSync(dbPath)) {
      res.status(503).json({
        status: 'error',
        error: 'Database not found',
        server: 'eu-regulations-mcp',
      });
      return;
    }

    const db = new Database(dbPath, { readonly: true });

    // Core counts
    const regulations = (db.prepare('SELECT COUNT(*) as c FROM regulations').get() as any).c;
    const articles = (db.prepare('SELECT COUNT(*) as c FROM articles').get() as any).c;
    const recitals = (db.prepare('SELECT COUNT(*) as c FROM recitals').get() as any).c;

    // Freshness from source_registry
    const freshness = db.prepare(
      'SELECT MAX(last_fetched) as last_checked FROM source_registry'
    ).get() as any;

    // Schema version from db_metadata (if available)
    let schemaVersion: string | null = null;
    let dbBuilt: string | null = null;
    try {
      const meta = db.prepare("SELECT value FROM db_metadata WHERE key = 'schema_version'").get() as any;
      if (meta) schemaVersion = meta.value;
      const built = db.prepare("SELECT value FROM db_metadata WHERE key = 'built_at'").get() as any;
      if (built) dbBuilt = built.value;
    } catch {
      // db_metadata may not exist in older databases
    }

    // Database file size
    const dbStat = statSync(dbPath);
    const dbSizeMB = (dbStat.size / (1024 * 1024)).toFixed(1);

    // Staleness check: warn if last_checked > 7 days ago
    const lastChecked = freshness?.last_checked;
    let staleness = 'current';
    if (lastChecked) {
      const daysSince = (Date.now() - new Date(lastChecked).getTime()) / (1000 * 60 * 60 * 24);
      if (daysSince > 30) staleness = 'stale';
      else if (daysSince > 7) staleness = 'aging';
    } else {
      staleness = 'unknown';
    }

    db.close();

    res.status(200).json({
      status: 'ok',
      server: 'eu-regulations-mcp',
      database: {
        schema_version: schemaVersion,
        built: dbBuilt,
        size_mb: Number(dbSizeMB),
        regulations,
        articles,
        recitals,
      },
      freshness: {
        last_checked: lastChecked,
        staleness,
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(503).json({
      status: 'error',
      server: 'eu-regulations-mcp',
      error: message,
    });
  }
}
