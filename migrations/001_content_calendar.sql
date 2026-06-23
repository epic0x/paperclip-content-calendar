CREATE TABLE plugin_content_calendar_247abb5408.posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  issue_id UUID REFERENCES public.issues(id) ON DELETE SET NULL,
  platform TEXT NOT NULL DEFAULT 'x',
  content TEXT NOT NULL,
  scheduled_date DATE NOT NULL,
  scheduled_time TIME,
  status TEXT NOT NULL DEFAULT 'draft',
  posted_at TIMESTAMPTZ,
  post_url TEXT,
  error_message TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX posts_company_date_idx ON plugin_content_calendar_247abb5408.posts (company_id, scheduled_date);

CREATE INDEX posts_status_idx ON plugin_content_calendar_247abb5408.posts (status, scheduled_date);

CREATE TABLE plugin_content_calendar_247abb5408.batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  days_count INTEGER NOT NULL DEFAULT 10,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'pending',
  metadata JSONB DEFAULT '{}'::jsonb
);
