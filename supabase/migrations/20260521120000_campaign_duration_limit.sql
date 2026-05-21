-- Enforce that ad campaigns can never exceed 15 seconds per play.
-- The product rule is "always 15s" — the client UI already submits 15s, but
-- this constraint guards against direct DB writes, future code regressions,
-- and ad-hoc inserts from other services.

-- 1. Clamp any pre-existing row that would violate the new check, so adding
--    the constraint doesn't fail on legacy data.
UPDATE public.ad_campaigns
SET duration_seconds = 15
WHERE duration_seconds IS NULL OR duration_seconds > 15 OR duration_seconds < 1;

-- 2. Add (or replace) the check constraint.
ALTER TABLE public.ad_campaigns
  DROP CONSTRAINT IF EXISTS ad_campaigns_duration_seconds_check;

ALTER TABLE public.ad_campaigns
  ADD CONSTRAINT ad_campaigns_duration_seconds_check
  CHECK (duration_seconds IS NOT NULL AND duration_seconds BETWEEN 1 AND 15);
