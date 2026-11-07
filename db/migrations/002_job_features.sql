-- Services a job needs beside its worker class: "3d" (image_to_3d), "rig" (rig). Only workers that
-- report all of them in their capabilities take the job. Replaces the gpu3d worker class.
ALTER TABLE jobs ADD COLUMN features text[] NOT NULL DEFAULT '{}';
UPDATE jobs SET worker_class = 'gpu', features = '{3d}' WHERE worker_class = 'gpu3d';
