-- Premium tier schema extension: article version tracking
-- Run against regulations.db to add version history support.
--
-- Usage:
--   sqlite3 data/regulations.db < scripts/add-article-versions.sql

CREATE TABLE IF NOT EXISTS article_versions (
  id INTEGER PRIMARY KEY,
  article_id INTEGER NOT NULL,
  body_text TEXT NOT NULL,
  effective_date TEXT,
  superseded_date TEXT,
  scraped_at TEXT NOT NULL,
  change_summary TEXT,
  diff_from_previous TEXT,
  source_url TEXT,
  FOREIGN KEY (article_id) REFERENCES articles(rowid)
);

CREATE INDEX IF NOT EXISTS idx_av_article ON article_versions(article_id);
CREATE INDEX IF NOT EXISTS idx_av_effective ON article_versions(effective_date);
