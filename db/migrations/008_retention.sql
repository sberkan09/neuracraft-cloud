-- Retention and regions (issue #19, docs/PRIVACY.md).

-- When the cleanup deletes the asset (its row, and its bytes once nothing else refers to them).
-- Preset jobs set it: inline inputs after a day, outputs after a week. Null: kept until deleted.
ALTER TABLE assets ADD COLUMN expires_at timestamptz;
CREATE INDEX assets_expiry ON assets(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX assets_sha ON assets(sha256);
CREATE INDEX asset_files_sha ON asset_files(sha256);

-- A preset job's narrative and prompts were removed (the row keeps timing, cost, the preset and the
-- prompt instructions' version).
ALTER TABLE jobs ADD COLUMN scrubbed_at timestamptz;

-- Where the job may run: worker regions (WORKER_REGION); empty = anywhere.
ALTER TABLE jobs ADD COLUMN regions text[] NOT NULL DEFAULT '{}';

-- A report outlives the asset once it is resolved (the asset is cleaned up, the record stays).
ALTER TABLE reports ALTER COLUMN asset_id DROP NOT NULL;
ALTER TABLE reports DROP CONSTRAINT reports_asset_id_fkey;
ALTER TABLE reports ADD CONSTRAINT reports_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE SET NULL;
