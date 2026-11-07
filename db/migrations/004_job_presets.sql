-- Jobs submitted through a preset (issue #15) record which one and its version.
ALTER TABLE jobs ADD COLUMN preset text;
ALTER TABLE jobs ADD COLUMN preset_version int;
