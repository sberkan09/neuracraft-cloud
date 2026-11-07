-- Catalog models get a stable name the code can refer to (presets): "dreamshaper-8",
-- "controlnet-scribble", ... One live catalog asset per slug; adding a newer one retires the old.
ALTER TABLE assets ADD COLUMN slug text;
CREATE UNIQUE INDEX assets_catalog_slug ON assets(slug) WHERE owner_id IS NULL AND status = 'ready' AND slug IS NOT NULL;
