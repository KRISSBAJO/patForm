-- Changes to a database that already exists.
--
-- `schema.sql` describes a database created from nothing, and until this file
-- the only way to give a running database a new column was to drop it and
-- re-seed, which signs every member out and empties the workspace. Each
-- statement here is safe to run on every start: it does nothing the second
-- time. Anything added to schema.sql for an existing table belongs here too.

-- Majority vote: how many people may vote, counted when the vote is asked.
alter table approval_request add column if not exists electorate int;
