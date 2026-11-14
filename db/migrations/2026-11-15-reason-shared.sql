-- Lets a supervisor choose whether the student reads the reason for cut hours.
-- Run on production before deploying the server that uses it. Safe to run twice; the old server ignores the column.
ALTER TABLE credits ADD COLUMN IF NOT EXISTS reason_shared boolean NOT NULL DEFAULT false;
