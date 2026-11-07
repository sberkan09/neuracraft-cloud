-- Interactive jobs and where their time goes (issue #20).
-- latency: interactive jobs (presets used at the table) are claimed first and never by CPU workers.
ALTER TABLE jobs ADD COLUMN latency text NOT NULL DEFAULT 'batch' CHECK (latency IN ('interactive', 'batch'));
-- A preset's variant for the statistics (sketch_to_scene: the mode).
ALTER TABLE jobs ADD COLUMN preset_variant text;
-- First claim, and the times: {warm, queueSeconds, fetchSeconds, loadSeconds, runSeconds,
-- uploadSeconds, totalSeconds} (the worker reports fetch / load / run / upload).
ALTER TABLE jobs ADD COLUMN claimed_at timestamptz;
ALTER TABLE jobs ADD COLUMN timings jsonb;
CREATE INDEX jobs_preset_finished ON jobs(preset, finished_at) WHERE preset IS NOT NULL;
