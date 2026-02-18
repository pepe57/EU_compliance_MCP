import type { DatabaseAdapter } from '../database/types.js';

export interface MapControlsInput {
  framework: 'ISO27001' | 'NIST_CSF';
  control?: string;
  regulation?: string;
  limit?: number;
}

export interface ControlMappingEntry {
  regulation: string;
  articles: string[];
  coverage: 'full' | 'partial' | 'related';
  notes: string | null;
}

export interface ControlMapping {
  control_id: string;
  control_name: string;
  mappings: ControlMappingEntry[];
}

export async function mapControls(
  db: DatabaseAdapter,
  input: MapControlsInput
): Promise<ControlMapping[]> {
  const VALID_FRAMEWORKS = ['ISO27001', 'NIST_CSF'];
  const { framework, control, regulation } = input;

  if (!VALID_FRAMEWORKS.includes(framework)) {
    throw new Error(`Invalid framework "${framework}". Must be one of: ${VALID_FRAMEWORKS.join(', ')}`);
  }

  let limit = input.limit ?? 100;
  if (!Number.isFinite(limit) || limit < 0) limit = 100;
  limit = Math.min(Math.floor(limit), 1000);

  let sql = `
    SELECT
      control_id,
      control_name,
      regulation,
      articles,
      coverage,
      notes
    FROM control_mappings
    WHERE framework = $1
  `;

  const params: string[] = [framework];

  if (control) {
    sql += ` AND control_id = $${params.length + 1}`;
    params.push(control);
  }

  if (regulation) {
    sql += ` AND regulation = $${params.length + 1}`;
    params.push(regulation);
  }

  sql += ` ORDER BY control_id, regulation`;
  sql += ` LIMIT $${params.length + 1}`;
  params.push(String(limit));

  const result = await db.query(sql, params);

  const rows = result.rows as Array<{
    control_id: string;
    control_name: string;
    regulation: string;
    articles: string;
    coverage: 'full' | 'partial' | 'related';
    notes: string | null;
  }>;

  // Group by control_id
  const controlMap = new Map<string, ControlMapping>();

  for (const row of rows) {
    if (!controlMap.has(row.control_id)) {
      controlMap.set(row.control_id, {
        control_id: row.control_id,
        control_name: row.control_name,
        mappings: [],
      });
    }

    controlMap.get(row.control_id)!.mappings.push({
      regulation: row.regulation,
      articles: JSON.parse(row.articles),
      coverage: row.coverage,
      notes: row.notes,
    });
  }

  return Array.from(controlMap.values());
}
