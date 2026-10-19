-- Lease of each job (plan §4.0, plan §3.7): exclusion between runs of the tick that works with any
-- connection of the pool, unlike a session advisory lock. NULL means the job is free; a run that
-- dies leaves a lease that expires on its own.
ALTER TABLE job_run ADD COLUMN locked_until timestamptz;
