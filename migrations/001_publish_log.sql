-- Content calendar plugin, initial schema.
--
-- Namespace: plugin_content_calendar_cc002f61cd
-- Derived by the host as plugin_<slug>_<sha256(pluginId)[0:10]> from
-- pluginId "untrace.plugin-content-calendar" plus namespaceSlug
-- "content_calendar". Do not hand-edit the hash. If it disagrees with what
-- derivePluginDatabaseNamespace() computes, every statement here is rejected
-- as out-of-namespace. scripts/verify-namespace.mjs checks this in CI.
--
-- WARNING, NO APOSTROPHES IN COMMENTS IN THIS FILE.
-- The host validator calls stripSqlForKeywordScan(), which replaces quoted
-- string literals BEFORE it strips comments. A single apostrophe in a comment
-- therefore opens a phantom string that runs to the next apostrophe in real
-- SQL (for example the empty-jsonb default further down) and eats the
-- CREATE TABLE keyword with it. The statement then normalises to a fragment,
-- fails the "DDL or namespace-scoped backfill only" check, and the install
-- dies with a message that points nowhere near the comment that caused it.
-- scripts/verify-namespace.mjs fails the build if an apostrophe reappears.
--
-- DESIGN NOTE, why there is no posts table here.
--
-- Paperclip cases are the source of truth for content: caption, channel,
-- publish_at, media and approval status all live on the case. Copying them
-- into a plugin table recreates the two-sources-of-truth split this plugin
-- exists to remove. The June scaffold did exactly that. It is not carried
-- over.
--
-- What lives here is only what a case cannot express: what this plugin
-- actually did when it tried to publish. That is genuinely plugin-owned, and
-- it is append-only so a failed publish is never silently lost.
--
-- Note also that cases is NOT in the host coreReadTables whitelist, so this
-- plugin cannot SELECT or foreign-key it from SQL at all. Case reads go over
-- the authenticated HTTP API. Only company_id is referenced below.

-- One row per publish attempt. Never updated in place, never deleted.
CREATE TABLE plugin_content_calendar_cc002f61cd.publish_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,

  -- The case this attempt was for. Kept as both uuid and human identifier
  -- because the HTTP API addresses cases by either. Deliberately not a foreign
  -- key: the plugin may not reference public.cases, and the log should outlive
  -- a deleted case as an audit record of what went out.
  case_id UUID NOT NULL,
  case_identifier TEXT NOT NULL,
  case_key TEXT,

  channel TEXT NOT NULL,

  -- The publish_at the case carried at the moment of the attempt, so a later
  -- reschedule cannot rewrite history.
  scheduled_for TIMESTAMPTZ NOT NULL,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- dry_run: gate passed, deliberately not sent because autoPost is off
  -- sent:    handed to the channel adapter and accepted
  -- failed:  adapter rejected or threw
  -- skipped: gate not satisfied, for example not approved or not due
  outcome TEXT NOT NULL,

  -- Why, in one line. Populated for skipped and failed.
  reason TEXT,

  -- Set only when outcome is sent.
  post_url TEXT,

  -- Hash of the caption at attempt time, so we can prove what text went out
  -- even if the case is edited afterwards.
  content_sha256 TEXT,

  -- Full adapter response, for debugging a failure without re-running it.
  adapter_response JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT publish_attempts_outcome_valid
    CHECK (outcome IN ('sent', 'dry_run', 'failed', 'skipped'))
);

CREATE INDEX publish_attempts_case_idx
  ON plugin_content_calendar_cc002f61cd.publish_attempts (case_id, attempted_at DESC);

CREATE INDEX publish_attempts_outcome_idx
  ON plugin_content_calendar_cc002f61cd.publish_attempts (company_id, outcome, attempted_at DESC);

-- THE DOUBLE-POST INTERLOCK, enforced by the database rather than by the job.
-- A case may accumulate many skipped or failed attempts but at most one sent.
-- The scheduler can run late, twice, or concurrently on two workers and still
-- cannot double-post, because the second insert violates this index.
CREATE UNIQUE INDEX publish_attempts_one_send_per_case
  ON plugin_content_calendar_cc002f61cd.publish_attempts (case_id)
  WHERE outcome = 'sent';

-- Operator schedule changes made from the calendar UI. Recorded here first,
-- then written back to the publish_at field on the case, so a failed
-- write-back is visible rather than lost.
CREATE TABLE plugin_content_calendar_cc002f61cd.schedule_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  case_id UUID NOT NULL,
  case_identifier TEXT NOT NULL,
  previous_publish_at TIMESTAMPTZ,
  requested_publish_at TIMESTAMPTZ NOT NULL,
  applied_to_case BOOLEAN NOT NULL DEFAULT FALSE,
  apply_error TEXT,
  requested_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX schedule_overrides_case_idx
  ON plugin_content_calendar_cc002f61cd.schedule_overrides (case_id, created_at DESC);
