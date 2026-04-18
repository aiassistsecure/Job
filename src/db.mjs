import Database from "better-sqlite3";
import { resolve } from "node:path";

const DB_PATH = resolve(process.cwd(), "job.db");

export function openDb() {
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      ended_at   TEXT,
      target     TEXT,
      new_jobs   INTEGER DEFAULT 0,
      error      TEXT
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id              TEXT PRIMARY KEY,
      target_company  TEXT NOT NULL,
      source          TEXT NOT NULL,
      title           TEXT NOT NULL,
      company         TEXT,
      location        TEXT,
      remote          INTEGER DEFAULT 0,
      employment_type TEXT,
      seniority       TEXT,
      salary_range    TEXT,
      url             TEXT NOT NULL,
      description     TEXT,
      date_posted     TEXT,
      applicants      INTEGER,
      fit_score       REAL,
      fit_reason      TEXT,
      captured_at     TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'new',
      raw             TEXT
    );

    CREATE TABLE IF NOT EXISTS people (
      id            TEXT PRIMARY KEY,
      job_id        TEXT NOT NULL,
      name          TEXT NOT NULL,
      headline      TEXT,
      linkedin_url  TEXT,
      email         TEXT,
      email_status  TEXT,
      company       TEXT,
      location      TEXT,
      captured_at   TEXT NOT NULL,
      raw           TEXT,
      FOREIGN KEY (job_id) REFERENCES jobs(id)
    );

    CREATE TABLE IF NOT EXISTS drafts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id      TEXT NOT NULL,
      person_id   TEXT,
      subject     TEXT,
      body        TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      sent_at     TEXT,
      FOREIGN KEY (job_id) REFERENCES jobs(id)
    );
  `);
  return db;
}

export function startRun(db, target) {
  const r = db.prepare(`INSERT INTO runs (started_at, target) VALUES (?, ?)`).run(nowIso(), target ?? null);
  return r.lastInsertRowid;
}

export function finishRun(db, runId, { newJobs = 0, error = null } = {}) {
  db.prepare(`UPDATE runs SET ended_at=?, new_jobs=?, error=? WHERE id=?`).run(nowIso(), newJobs, error, runId);
}

export function upsertJob(db, job) {
  db.prepare(`
    INSERT OR IGNORE INTO jobs
      (id, target_company, source, title, company, location, remote, employment_type,
       seniority, salary_range, url, description, date_posted, applicants,
       fit_score, fit_reason, captured_at, status, raw)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'new',?)
  `).run(
    job.id, job.target_company, job.source, job.title, job.company ?? null,
    job.location ?? null, job.remote ? 1 : 0, job.employment_type ?? null,
    job.seniority ?? null, job.salary_range ?? null, job.url,
    job.description ?? null, job.date_posted ?? null,
    job.applicants ?? null, job.fit_score ?? null, job.fit_reason ?? null,
    job.captured_at, JSON.stringify(job.raw ?? {})
  );
  return db.prepare(`SELECT changes() as c`).get().c > 0;
}

export function upsertPerson(db, person) {
  db.prepare(`
    INSERT OR REPLACE INTO people
      (id, job_id, name, headline, linkedin_url, email, email_status, company, location, captured_at, raw)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    person.id, person.job_id, person.name, person.headline ?? null,
    person.linkedin_url ?? null, person.email ?? null, person.email_status ?? null,
    person.company ?? null, person.location ?? null, person.captured_at,
    JSON.stringify(person.raw ?? {})
  );
}

export function saveDraft(db, { job_id, person_id, subject, body }) {
  db.prepare(`
    INSERT INTO drafts (job_id, person_id, subject, body, created_at)
    VALUES (?,?,?,?,?)
  `).run(job_id, person_id ?? null, subject ?? null, body, nowIso());
  db.prepare(`UPDATE jobs SET status='drafted' WHERE id=? AND status='new'`).run(job_id);
}

export function markSent(db, draftId) {
  db.prepare(`UPDATE drafts SET sent_at=? WHERE id=?`).run(nowIso(), draftId);
  const draft = db.prepare(`SELECT job_id FROM drafts WHERE id=?`).get(draftId);
  if (draft) db.prepare(`UPDATE jobs SET status='sent' WHERE id=?`).run(draft.job_id);
}

export function markArchived(db, jobId) {
  db.prepare(`UPDATE jobs SET status='archived' WHERE id=?`).run(jobId);
}

export function getNewJobs(db, limit = 50) {
  return db.prepare(`SELECT * FROM jobs WHERE status='new' ORDER BY fit_score DESC, captured_at DESC LIMIT ?`).all(limit);
}

export function getUndraftedJobs(db, limit = 20) {
  return db.prepare(`
    SELECT j.*, p.name as person_name, p.email as person_email,
           p.linkedin_url as person_linkedin, p.headline as person_headline
    FROM jobs j
    LEFT JOIN people p ON p.job_id = j.id
    WHERE j.status = 'new' AND p.email IS NOT NULL
    ORDER BY j.fit_score DESC, j.captured_at DESC LIMIT ?
  `).all(limit);
}

export function getAllJobs(db, status = null) {
  if (status) return db.prepare(`SELECT * FROM jobs WHERE status=? ORDER BY captured_at DESC`).all(status);
  return db.prepare(`SELECT * FROM jobs ORDER BY captured_at DESC`).all();
}

export function getStats(db) {
  return {
    total:    db.prepare(`SELECT COUNT(*) as c FROM jobs`).get().c,
    new:      db.prepare(`SELECT COUNT(*) as c FROM jobs WHERE status='new'`).get().c,
    drafted:  db.prepare(`SELECT COUNT(*) as c FROM jobs WHERE status='drafted'`).get().c,
    sent:     db.prepare(`SELECT COUNT(*) as c FROM jobs WHERE status='sent'`).get().c,
    archived: db.prepare(`SELECT COUNT(*) as c FROM jobs WHERE status='archived'`).get().c,
    people:   db.prepare(`SELECT COUNT(*) as c FROM people`).get().c,
    emails:   db.prepare(`SELECT COUNT(*) as c FROM people WHERE email IS NOT NULL`).get().c,
    runs:     db.prepare(`SELECT COUNT(*) as c FROM runs`).get().c,
  };
}

function nowIso() { return new Date().toISOString(); }
