-- Publish log — the only thing cases do not already store.
--
-- Everything else about a scheduled post lives in the case: the copy is a case
-- document, the image is an attachment on a child image_assets case, the
-- schedule is fields.publish_at, and approval is the case's own native status.
-- Duplicating any of that here would rebuild the two-sources-of-truth problem
-- this plugin exists to remove.
--
-- So this table records only what happens AFTER a human approves: one row per
-- publish attempt, keyed to the case that was published.

CREATE TABLE IF NOT EXISTS publish_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,

  -- The case this attempt was for, e.g. 'UNT-C96'. Not a FK: the plugin may
  -- not reference public.cases, and the log should survive a case deletion as
  -- an audit record of what went out.
  case_ref      TEXT NOT NULL,

  platform      TEXT NOT NULL DEFAULT 'x',
  scheduled_for TIMESTAMPTZ NOT NULL,
  attempted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- 'posted' | 'failed'
  outcome       TEXT NOT NULL,
  post_url      TEXT,
  media_id      TEXT,
  error_message TEXT,

  CONSTRAINT publish_log_outcome_valid CHECK (outcome IN ('posted', 'failed'))
);

-- The publish interlock, enforced by the database rather than by the job.
--
-- A successful publish may exist at most once per case. The scheduler can run
-- late, twice, or concurrently on two workers; none of that can double-post,
-- because the second INSERT violates this index. This is the guarantee that
-- was previously claimed and not actually enforced anywhere.
CREATE UNIQUE INDEX IF NOT EXISTS publish_log_one_success_per_case
  ON publish_log (case_ref)
  WHERE outcome = 'posted';

CREATE INDEX IF NOT EXISTS publish_log_company_time_idx
  ON publish_log (company_id, scheduled_for DESC);

COMMENT ON TABLE publish_log IS
  'One row per publish attempt. Cases hold the content, approval and schedule; '
  'this holds only the result. The partial unique index on successful rows is '
  'the anti-double-post guarantee.';
