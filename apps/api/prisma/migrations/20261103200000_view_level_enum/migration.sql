-- VIEW: a grant level below READ. See the pages, never the original file.
-- On its own migration: a new enum value cannot be used in the transaction
-- that adds it, and 20261103200100 uses it.
ALTER TYPE "GrantLevel" ADD VALUE IF NOT EXISTS 'VIEW' BEFORE 'READ';
