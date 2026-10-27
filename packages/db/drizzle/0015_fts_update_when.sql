-- SQLite fires an AFTER UPDATE OF trigger whenever a listed column is in the SET list, even when its value
-- is unchanged. Guard the index rewrite on real changes so a re-applied identical posting writes no FTS rows.
DROP TRIGGER `jobs_fts_au`;--> statement-breakpoint
CREATE TRIGGER `jobs_fts_au` AFTER UPDATE OF title, company, location_text ON `jobs`
WHEN old.title IS NOT new.title OR old.company IS NOT new.company OR old.location_text IS NOT new.location_text
BEGIN
  INSERT INTO jobs_fts(jobs_fts, rowid, title, company, location_text) VALUES ('delete', old.id, old.title, old.company, old.location_text);
  INSERT INTO jobs_fts(rowid, title, company, location_text) VALUES (new.id, new.title, new.company, new.location_text);
END;
