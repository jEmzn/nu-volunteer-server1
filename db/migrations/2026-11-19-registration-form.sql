-- Registration form (replaces the Google Form): the contact details and consent a student gives when registering, and the
-- questions a supervisor adds to an activity. Template questions live inside templates.settings, so that table is unchanged.
-- Run on production before deploying the server that uses it. Safe to run twice; the old server ignores the columns.
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS faculty text;
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS consent_at timestamptz;
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS answers jsonb NOT NULL DEFAULT '{}';
ALTER TABLE activities ADD COLUMN IF NOT EXISTS questions jsonb NOT NULL DEFAULT '[]';
