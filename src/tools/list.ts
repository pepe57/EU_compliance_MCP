import type { DatabaseAdapter } from '../database/types.js';

export interface ListInput {
  regulation?: string;
  category?: string;
}

export interface Chapter {
  number: string;
  title: string;
  articles: string[];
}

export interface RegulationInfo {
  id: string;
  full_name: string;
  celex_id: string;
  effective_date: string | null;
  article_count: number;
  chapters?: Chapter[];
}

export interface ListResult {
  regulations: RegulationInfo[];
  category_summary?: string;
}

/**
 * Regulation categories for discoverability.
 * Maps category name → array of regulation IDs.
 */
export const REGULATION_CATEGORIES: Record<string, string[]> = {
  cybersecurity: ['NIS2', 'CYBERSECURITY_ACT', 'CYBER_SOLIDARITY', 'EUCC'],
  data_protection: ['GDPR', 'EPRIVACY', 'LED', 'DGA', 'DATA_ACT', 'EHDS'],
  digital_services: ['DSA', 'DMA', 'EIDAS2', 'EECC'],
  financial_services: ['DORA', 'MICA', 'MIFID2', 'MIFIR', 'PSD2', 'AIFMD', 'SFDR', 'EU_TAXONOMY',
    'DORA_RTS_ICT_RISK', 'DORA_RTS_INCIDENT_CLASSIFICATION', 'DORA_RTS_INCIDENT_REPORTING',
    'DORA_ITS_INCIDENT_FORMS', 'DORA_RTS_TLPT', 'DORA_RTS_ICT_SERVICES_POLICY',
    'DORA_RTS_CRITICAL_PROVIDER_DESIGNATION', 'DORA_RTS_OVERSIGHT_HARMONIZATION',
    'DORA_RTS_OVERSIGHT_FEES', 'DORA_ITS_REGISTER_TEMPLATES'],
  ai_and_technology: ['AI_ACT', 'CHIPS_ACT'],
  product_safety: ['CRA', 'GPSR', 'MACHINERY', 'RED', 'PLD'],
  healthcare: ['MDR', 'IVDR', 'EHDS'],
  sustainability: ['CSRD', 'CSDDD', 'EU_TAXONOMY', 'SFDR', 'CBAM', 'EUDR', 'CRMA'],
  critical_infrastructure: ['CER', 'NIS2'],
  automotive: ['UN_R155', 'UN_R156'],
};

export async function listRegulations(
  db: DatabaseAdapter,
  input: ListInput
): Promise<ListResult> {
  const { regulation, category } = input;

  if (regulation) {
    // Get specific regulation with chapters
    const regResult = await db.query(
      `SELECT id, full_name, celex_id, effective_date
       FROM regulations
       WHERE id = $1`,
      [regulation]
    );

    if (regResult.rows.length === 0) {
      return { regulations: [] };
    }

    const regRow = regResult.rows[0] as {
      id: string;
      full_name: string;
      celex_id: string;
      effective_date: string | null;
    };

    // Get articles grouped by chapter
    const articlesResult = await db.query(
      `SELECT article_number, title, chapter
       FROM articles
       WHERE regulation = $1
       ORDER BY article_number::INTEGER`,
      [regulation]
    );

    const articles = articlesResult.rows as Array<{
      article_number: string;
      title: string | null;
      chapter: string | null;
    }>;

    // Group by chapter
    const chapterMap = new Map<string, Chapter>();
    for (const article of articles) {
      const chapterKey = article.chapter || 'General';
      if (!chapterMap.has(chapterKey)) {
        chapterMap.set(chapterKey, {
          number: chapterKey,
          title: `Chapter ${chapterKey}`,
          articles: [],
        });
      }
      chapterMap.get(chapterKey)!.articles.push(article.article_number);
    }

    return {
      regulations: [{
        id: regRow.id,
        full_name: regRow.full_name,
        celex_id: regRow.celex_id,
        effective_date: regRow.effective_date,
        article_count: articles.length,
        chapters: Array.from(chapterMap.values()),
      }],
    };
  }

  // List all regulations with article counts
  const result = await db.query(
    `SELECT
      r.id,
      r.full_name,
      r.celex_id,
      r.effective_date,
      COUNT(a.regulation) as article_count
    FROM regulations r
    LEFT JOIN articles a ON a.regulation = r.id
    GROUP BY r.id, r.full_name, r.celex_id, r.effective_date
    ORDER BY r.id`
  );

  const rows = result.rows as Array<{
    id: string;
    full_name: string;
    celex_id: string;
    effective_date: string | null;
    article_count: number;
  }>;

  const allRegulations = rows.map(row => ({
    id: row.id,
    full_name: row.full_name,
    celex_id: row.celex_id,
    effective_date: row.effective_date,
    article_count: Number(row.article_count),
  }));

  // Filter by category if specified
  if (category) {
    const catKey = category.toLowerCase();
    if (!(catKey in REGULATION_CATEGORIES)) {
      const available = Object.keys(REGULATION_CATEGORIES).sort().join(', ');
      return {
        regulations: [],
        category_summary: `Category '${category}' not found. Available categories: ${available}`,
      };
    }

    const catIds = new Set(REGULATION_CATEGORIES[catKey]);
    const filtered = allRegulations.filter(r => catIds.has(r.id));

    return {
      regulations: filtered,
      category_summary: `${category} (${filtered.length} regulations)`,
    };
  }

  // No category filter: return grouped by category
  const regById = new Map(allRegulations.map(r => [r.id, r]));
  const categorized = new Set<string>();
  const lines: string[] = [];

  lines.push(`${allRegulations.length} regulations in ${Object.keys(REGULATION_CATEGORIES).length} categories\n`);

  for (const [catName, catIds] of Object.entries(REGULATION_CATEGORIES).sort()) {
    const catRegs = catIds
      .filter(id => regById.has(id))
      .map(id => regById.get(id)!);
    if (catRegs.length === 0) continue;

    lines.push(`${catName} (${catRegs.length}):`);
    for (const r of catRegs) {
      lines.push(`  ${r.id}: ${r.full_name} (${r.article_count} articles)`);
      categorized.add(r.id);
    }
    lines.push('');
  }

  // List uncategorized regulations
  const uncategorized = allRegulations.filter(r => !categorized.has(r.id));
  if (uncategorized.length > 0) {
    lines.push(`other (${uncategorized.length}):`);
    for (const r of uncategorized) {
      lines.push(`  ${r.id}: ${r.full_name} (${r.article_count} articles)`);
    }
  }

  return {
    regulations: allRegulations,
    category_summary: lines.join('\n'),
  };
}
