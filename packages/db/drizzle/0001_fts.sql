-- Full-text index over the three short text fields only. Descriptions stay out of the database.
CREATE VIRTUAL TABLE `jobs_fts` USING fts5(title, company, location_text, content='jobs', content_rowid='id', tokenize='porter unicode61 remove_diacritics 2');--> statement-breakpoint
CREATE TRIGGER `jobs_fts_ai` AFTER INSERT ON `jobs` BEGIN
  INSERT INTO jobs_fts(rowid, title, company, location_text) VALUES (new.id, new.title, new.company, new.location_text);
END;--> statement-breakpoint
CREATE TRIGGER `jobs_fts_ad` AFTER DELETE ON `jobs` BEGIN
  INSERT INTO jobs_fts(jobs_fts, rowid, title, company, location_text) VALUES ('delete', old.id, old.title, old.company, old.location_text);
END;--> statement-breakpoint
CREATE TRIGGER `jobs_fts_au` AFTER UPDATE OF title, company, location_text ON `jobs` BEGIN
  INSERT INTO jobs_fts(jobs_fts, rowid, title, company, location_text) VALUES ('delete', old.id, old.title, old.company, old.location_text);
  INSERT INTO jobs_fts(rowid, title, company, location_text) VALUES (new.id, new.title, new.company, new.location_text);
END;
