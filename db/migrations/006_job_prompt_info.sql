-- How a preset job's prompt came about (issue #17): the narrative, the prompt written from it, who wrote
-- it (llm, template, client) and the instruction version. For debugging, abuse handling and quality
-- work; removed with the job's inputs by the retention cleanup.
ALTER TABLE jobs ADD COLUMN prompt_info jsonb;
