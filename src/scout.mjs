import yaml from "js-yaml";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { openDb, startRun, finishRun, upsertJob, upsertPerson, getStats } from "./db.mjs";
import { searchLinkedInJobs, searchIndeedViaNetrows, findHiringManager, findEmail } from "./sources.mjs";
import { loadCompanyContext } from "./company.mjs";

const TARGETS_PATH = resolve(process.cwd(), "targets.yaml");

function loadTargets() {
  return yaml.load(readFileSync(TARGETS_PATH, "utf8"));
}

function scoreJob(job, profile) {
  let score = 0.5;
  const text = `${job.title} ${job.description ?? ""}`.toLowerCase();

  // Role keyword match against title + description
  const roleHits = profile.skills.filter(s => text.includes(s.toLowerCase())).length;
  score += roleHits * 0.05;

  // Title-specific match against target role keywords
  const titleText = job.title.toLowerCase();
  const targetRoleHit = profile.target_roles?.some(r => titleText.includes(r.toLowerCase()));
  if (targetRoleHit) score += 0.1;

  // Remote bonus
  if (profile.remote_ok && job.remote) score += 0.1;

  // Deal-breaker check — covers title too
  const fullText = `${job.title} ${job.description ?? ""} ${job.employment_type ?? ""}`.toLowerCase();
  const dealBreakerHit = (profile.deal_breakers ?? []).some(d => fullText.includes(d.toLowerCase()));
  if (dealBreakerHit) score -= 0.5;

  // Recency bonus
  if (job.date_posted) {
    const age = Date.now() - new Date(job.date_posted).getTime();
    if (age < 48 * 3600 * 1000)    score += 0.15; // < 48h
    else if (age < 7 * 86400 * 1000) score += 0.05; // < 1 week
  }

  return Math.max(0, Math.min(1, score));
}

export async function runScan({ only = null, limit = 10, verbose = false } = {}) {
  const { targets, profile } = loadTargets();
  const db = openDb();
  const hasNetrows = !!process.env.NETROWS_API_KEY;

  if (!hasNetrows) {
    console.log("  ⚠  NETROWS_API_KEY not set — Netrows searches will be skipped");
  }

  const list = only ? targets.filter(t => t.company.toLowerCase() === only.toLowerCase()) : targets;
  if (!list.length) {
    console.log(`  No targets matched "${only}"`);
    return;
  }

  let totalNew = 0;

  for (const target of list) {
    const runId = startRun(db, target.company);
    process.stdout.write(`\n  ── ${target.company} ──\n`);
    let newCount = 0;
    const allJobs = [];

    try {
      // ── Company context — fetch + cache before any drafting ───────────────
      if (target.domain) {
        await loadCompanyContext(target.company, target.domain, { verbose });
      }

      // ── Netrows: LinkedIn Jobs ─────────────────────────────────────────────
      if (hasNetrows) {
        process.stdout.write("    [netrows/linkedin_jobs] ");
        try {
          const jobs = await searchLinkedInJobs({ company: target.company, roles: target.roles, limit, verbose });
          process.stdout.write(`${jobs.length} results\n`);
          allJobs.push(...jobs.map(j => ({ ...j, target_company: target.company })));
        } catch (e) {
          process.stdout.write(`error: ${e.message}\n`);
        }
      }

      // ── Netrows: Indeed Jobs ───────────────────────────────────────────────
      if (hasNetrows) {
        process.stdout.write("    [netrows/indeed_jobs] ");
        try {
          const jobs = await searchIndeedViaNetrows({ company: target.company, roles: target.roles, limit, verbose });
          process.stdout.write(`${jobs.length} results\n`);
          allJobs.push(...jobs.map(j => ({ ...j, target_company: target.company })));
        } catch (e) {
          process.stdout.write(`error: ${e.message}\n`);
        }
      }

      // ── Score + persist jobs ───────────────────────────────────────────────
      for (const job of allJobs) {
        if (!job.title || !job.url) continue;
        job.fit_score  = scoreJob(job, profile);
        job.fit_reason = job.fit_score >= 0.6 ? "keyword + remote match" : "low fit";
        const isNew = upsertJob(db, job);
        if (isNew) newCount++;
      }

      // ── People search + email for shortlisted new jobs ─────────────────────
      if (hasNetrows && newCount > 0) {
        const shortlisted = db.prepare(
          `SELECT * FROM jobs WHERE target_company=? AND status='new' AND fit_score>=0.6 AND id NOT IN (SELECT job_id FROM people)`
        ).all(target.company);

        for (const job of shortlisted.slice(0, 3)) {
          process.stdout.write(`    [people_search] ${job.title} ... `);
          const person = await findHiringManager({ company: target.company, role: job.title, verbose });

          if (!person) { process.stdout.write("no match\n"); continue; }
          process.stdout.write(`found: ${person.name}\n`);

          if (person.linkedin_url) {
            process.stdout.write(`    [email_finder] ${person.name} ... `);
            const emailResult = await findEmail({ linkedinUrl: person.linkedin_url, domain: target.domain, verbose });
            if (emailResult) {
              person.email        = emailResult.email;
              person.email_status = emailResult.status;
              process.stdout.write(`${person.email}\n`);
            } else {
              process.stdout.write("not found\n");
            }
          }

          upsertPerson(db, { ...person, job_id: job.id });
        }
      }

      finishRun(db, runId, { newJobs: newCount });
      process.stdout.write(`    → ${newCount} new jobs\n`);
      totalNew += newCount;

    } catch (err) {
      finishRun(db, runId, { error: err.message });
      console.error(`  ✗ ${target.company}: ${err.message}`);
    }
  }

  console.log(`\n━━ scan complete ━━`);
  console.log(`  ${totalNew} new jobs across ${list.length} target(s)\n`);
  const stats = getStats(db);
  console.log(`  db: ${stats.total} jobs · ${stats.people} contacts · ${stats.emails} emails found`);
}
