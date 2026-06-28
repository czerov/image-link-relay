CREATE TABLE IF NOT EXISTS uploaded_images (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  source_path TEXT,
  file_name TEXT,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_uploaded_images_created_at
ON uploaded_images (created_at DESC);
