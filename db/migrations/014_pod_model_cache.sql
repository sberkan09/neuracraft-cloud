-- Whether a rented pod has the shared model cache (a network volume): without it, its worker first
-- downloads the models, so its start takes longer (the ETA sessions are told; issue #43).
ALTER TABLE gpu_pods ADD COLUMN model_cache boolean;
