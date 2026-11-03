-- 004_free_access_grants.sql — free-access comps on the account record.
--
-- WHY (owner request, 2026-11-02): "How can I give someone free use of the site?
-- I need to get feedback from a human new to match betting." A named person can
-- be granted a plan without paying, and the grant lives on their account.
--
-- The columns mirror src/server/entitlement.ts CompState:
--   comp_plan        which plan the grant unlocks (NULL = no grant)
--   comp_ends_at     when the free access stops
--   comp_permanent   the EXPLICIT "no end date" decision — a grant with no
--                    end date and this false grants nothing (fail closed)
--   comp_note        why this person has it, in the owner's words
--   comp_granted_by  which owner account granted it
--   comp_granted_at  when it was granted

ALTER TABLE users ADD COLUMN IF NOT EXISTS comp_plan       TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS comp_ends_at    TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS comp_permanent  BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS comp_note       TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS comp_granted_by TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS comp_granted_at TIMESTAMPTZ;
