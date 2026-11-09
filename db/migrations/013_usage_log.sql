-- The usage log (docs/USAGE_LOG.md): enough to compare, weeks later, what the GPUs cost us with what
-- a hosted service (fal.ai, Replicate, ...) would have charged for the same jobs at the same times.
--
-- It holds no narratives, prompts, pictures, accounts or end-user ids, so it outlives the data it
-- describes: deleting a user or an end user, and the retention scrub, leave it alone.

-- One row per finished job (written by a trigger when a job reaches succeeded, failed or cancelled).
CREATE TABLE usage_jobs (
    job_id         uuid PRIMARY KEY,        -- no foreign key: the job row may be deleted later
    session_id     uuid,                    -- the app session it belonged to (a random id)
    preset         text,
    preset_variant text,                    -- sketch_to_scene: map / atmosphere
    latency        text NOT NULL,           -- interactive / batch
    worker_class   text NOT NULL,
    state          text NOT NULL,           -- succeeded / failed / cancelled
    error_code     text,                    -- content.flagged, job.timeout, ...
    attempts       int NOT NULL,
    -- What the job asked of the GPU (from its generation step).
    op             text,                    -- txt2img / img2img
    width          int,
    height         int,
    steps          int,
    sampler        text,
    controlnet     boolean,
    lora           int,                     -- LoRAs applied
    models         int,                     -- model files it needed
    prompt_source  text,                    -- written from a narrative: llm (an LLM call) / template; null: given
    -- Where and when it ran.
    worker_id      uuid,
    pod_id         uuid,                    -- the rented GPU pod, if any
    gpu_type       text,
    price_per_hour numeric(10, 4),
    created_at     timestamptz NOT NULL,
    claimed_at     timestamptz,
    started_at     timestamptz,
    finished_at    timestamptz NOT NULL,
    worker_seconds double precision,
    timings        jsonb                    -- warm, queue, fetch, load, run, upload, total
);
CREATE INDEX usage_jobs_created ON usage_jobs(created_at);

CREATE FUNCTION usage_log_job() RETURNS trigger AS $$
DECLARE
    gen jsonb := jsonb_path_query_first(NEW.workflow, '$.steps[*] ? (@.op == "txt2img" || @.op == "img2img")');
    pod record;
BEGIN
    SELECT id, gpu_type, price_per_hour INTO pod FROM gpu_pods WHERE worker_id = NEW.worker_id ORDER BY requested_at DESC LIMIT 1;
    INSERT INTO usage_jobs (job_id, session_id, preset, preset_variant, latency, worker_class, state, error_code, attempts,
                            op, width, height, steps, sampler, controlnet, lora, models, prompt_source,
                            worker_id, pod_id, gpu_type, price_per_hour,
                            created_at, claimed_at, started_at, finished_at, worker_seconds, timings)
    VALUES (NEW.id, NEW.session_id, NEW.preset, NEW.preset_variant, NEW.latency, NEW.worker_class, NEW.state, NEW.error->>'code', NEW.attempts,
            gen->>'op', (gen->>'width')::int, (gen->>'height')::int, (gen->>'steps')::int, gen->>'sampler',
            gen ? 'controlnet', coalesce(jsonb_array_length(CASE WHEN jsonb_typeof(gen->'lora') = 'array' THEN gen->'lora' END), 0),
            coalesce(array_length(NEW.models, 1), 0), NEW.prompt_info->>'source',
            NEW.worker_id, pod.id, pod.gpu_type, pod.price_per_hour,
            NEW.created_at, NEW.claimed_at, NEW.started_at, coalesce(NEW.finished_at, now()), NEW.worker_seconds, NEW.timings)
    ON CONFLICT (job_id) DO UPDATE SET state = EXCLUDED.state, error_code = EXCLUDED.error_code, finished_at = EXCLUDED.finished_at,
        worker_seconds = EXCLUDED.worker_seconds, timings = coalesce(EXCLUDED.timings, usage_jobs.timings),
        started_at = EXCLUDED.started_at, claimed_at = EXCLUDED.claimed_at;
    RETURN NEW;
END $$ LANGUAGE plpgsql;

-- (Also on the columns written in the same transaction after the state: the timings, the seconds.)
CREATE TRIGGER usage_log_job AFTER UPDATE OF state, timings, worker_seconds, finished_at ON jobs
    FOR EACH ROW WHEN (NEW.state IN ('succeeded', 'failed', 'cancelled'))
    EXECUTE FUNCTION usage_log_job();

-- One row per app session, written when it closes.
CREATE TABLE usage_sessions (
    session_id     uuid PRIMARY KEY,
    started_at     timestamptz NOT NULL,
    closed_at      timestamptz NOT NULL,
    close_reason   text,
    last_job_at    timestamptz
);

CREATE FUNCTION usage_log_session() RETURNS trigger AS $$
BEGIN
    INSERT INTO usage_sessions (session_id, started_at, closed_at, close_reason, last_job_at)
    VALUES (NEW.id, NEW.started_at, NEW.closed_at, NEW.close_reason, NEW.last_job_at)
    ON CONFLICT (session_id) DO NOTHING;
    RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER usage_log_session AFTER UPDATE OF closed_at ON app_sessions
    FOR EACH ROW WHEN (NEW.closed_at IS NOT NULL AND OLD.closed_at IS NULL)
    EXECUTE FUNCTION usage_log_session();

-- What the capacity manager did and why (capacity.ts): pods rented, ready, warmed up, drained and
-- stopped with their cost, rentals the provider could not serve, budgets reached, demand changes.
CREATE TABLE capacity_events (
    id      bigserial PRIMARY KEY,
    at      timestamptz NOT NULL DEFAULT now(),
    kind    text NOT NULL,
    pod_id  uuid,
    detail  jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX capacity_events_at ON capacity_events(at);

-- When a warming worker claimed for the first time (its warm-up ended).
ALTER TABLE workers ADD COLUMN warmed_at timestamptz;
