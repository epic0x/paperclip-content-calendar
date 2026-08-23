-- Media support for scheduled posts.
--
-- The plugin shipped text-only, but every post in the Untrace calendar carries
-- an image, and X requires alt text on every image for accessibility. Without
-- these columns the calendar can schedule a post it cannot actually publish.
--
-- `media_path` is an absolute path on the host that runs the publish script.
-- `alt_text` is required whenever media_path is set — enforced below, because
-- an accessibility rule that is only in a code path gets bypassed eventually.

ALTER TABLE plugin_content_calendar_247abb5408.posts
  ADD COLUMN IF NOT EXISTS media_path TEXT,
  ADD COLUMN IF NOT EXISTS alt_text   TEXT,
  ADD COLUMN IF NOT EXISTS media_id   TEXT,
  ADD COLUMN IF NOT EXISTS source_ref TEXT;

COMMENT ON COLUMN plugin_content_calendar_247abb5408.posts.media_path IS
  'Absolute path to the image on the publishing host. NULL for text-only posts.';
COMMENT ON COLUMN plugin_content_calendar_247abb5408.posts.alt_text IS
  'Accessibility alt text. Required when media_path is set.';
COMMENT ON COLUMN plugin_content_calendar_247abb5408.posts.media_id IS
  'Platform media id returned at upload time. Audit trail for what was sent.';
COMMENT ON COLUMN plugin_content_calendar_247abb5408.posts.source_ref IS
  'Originating Paperclip case identifier, e.g. UNT-C96. Links a scheduled post '
  'back to the case that was approved, so the calendar is never a second '
  'source of truth.';

-- Alt text is not optional when there is an image.
ALTER TABLE plugin_content_calendar_247abb5408.posts
  DROP CONSTRAINT IF EXISTS posts_alt_text_required;
ALTER TABLE plugin_content_calendar_247abb5408.posts
  ADD CONSTRAINT posts_alt_text_required
  CHECK (media_path IS NULL OR (alt_text IS NOT NULL AND length(trim(alt_text)) > 0));

-- One row per case: re-importing an approved case must update, never duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS posts_source_ref_uniq
  ON plugin_content_calendar_247abb5408.posts (source_ref)
  WHERE source_ref IS NOT NULL;
