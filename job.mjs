#!/usr/bin/env node
// Job — Interchained Job Scout
//
//   node job.mjs scan                  # scan all target companies
//   node job.mjs scan --only=Vercel    # single company
//   node job.mjs scan --verbose        # dump raw API responses
//   node job.mjs draft                 # draft emails for shortlisted leads
//   node job.mjs list                  # show all jobs in queue
//   node job.mjs list --status=drafted
//   node job.mjs stats                 # db summary
//   node job.mjs archive <job_id>      # remove from queue

import yaml from "js-yaml";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { openDb, getAllJobs, getStats, getUndraftedJobs, saveDraft, markArchived } from "./src/db.mjs";
import { runScan } from "./src/scout.mjs";
import { draftEmail } from "./src/draft.mjs";
import { generateReport } from "./src/report.mjs";
import { loadResumeFacts, clearResumeCache } from "./src/resume.mjs";

const BANNER = `
\x1b[36m════════════════════════════════════════════════════════════
     ██╗ ██████╗ ██████╗
     ██║██╔═══██╗██╔══██╗
     ██║██║   ██║██████╔╝
██   ██║██║   ██║██╔══██╗
╚█████╔╝╚██████╔╝██████╔╝
 ╚════╝  ╚═════╝ ╚═════╝
\x1b[33m  ─────────────────────────────────────────────────────────
  Job Scout · Interchained LLC · aiassist.net
  Company-led · Signal-timed · Warm-path email outreach
\x1b[36m════════════════════════════════════════════════════════════\x1b[0m
`;

function parseArgs(argv) {
  const args = { command: null, flags: {} };
  for (const arg of argv.slice(2)) {
    if (!args.command && !arg.startsWith("--")) { args.command = arg; continue; }
    const m = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) args.flags[m[1]] = m[2] ?? true;
  }
  return args;
}

function loadProfile() {
  const path = resolve(process.cwd(), "targets.yaml");
  return yaml.load(readFileSync(path, "utf8"))?.profile ?? {};
}

function fmtStatus(s) {
  return {
    new:      "\x1b[32m   NEW\x1b[0m",
    drafted:  "\x1b[33mDRAFTED\x1b[0m",
    sent:     "\x1b[34m  SENT\x1b[0m",
    archived: "\x1b[90mARCHIV\x1b[0m",
  }[s] ?? s;
}

const { command, flags } = parseArgs(process.argv);

console.log(BANNER);

if (!command || command === "help") {
  console.log(`Commands:
  scan   [--only=Company] [--limit=N] [--verbose]   scan target companies
  draft  [--limit=N]                                 draft emails (auto-loads resume facts)
  report [--out=./report.pdf]                        generate HITL PDF report
  resume                                             preview extracted resume facts
  resume --refresh                                   force re-extract from resume.docx
  list   [--status=new|drafted|sent|archived]        show jobs
  stats                                              db summary
  archive <job_id>                                   archive a job
`);
  process.exit(0);
}

// ── scan ──────────────────────────────────────────────────────────────────────
if (command === "scan") {
  await runScan({
    only:    flags.only ?? null,
    limit:   flags.limit ? Number(flags.limit) : 10,
    verbose: !!flags.verbose,
  });
}

// ── draft ─────────────────────────────────────────────────────────────────────
else if (command === "draft") {
  if (!process.env.AIAS_API_KEY) {
    console.error("AIAS_API_KEY env var required for draft command");
    process.exit(1);
  }
  const db = openDb();
  const profile = loadProfile();
  const limit = flags.limit ? Number(flags.limit) : 10;
  const jobs = getUndraftedJobs(db, limit);

  if (!jobs.length) {
    console.log("  No shortlisted jobs with emails found. Run scan first.\n");
    process.exit(0);
  }

  console.log(`  Drafting emails for ${jobs.length} lead(s)...\n`);

  for (const job of jobs) {
    process.stdout.write(`  ── ${job.title} @ ${job.company ?? job.target_company}\n`);
    process.stdout.write(`     To: ${job.person_name ?? "Hiring Manager"} <${job.person_email ?? "?"}>\n`);
    try {
      const draft = await draftEmail({
        job,
        person: {
          name:     job.person_name,
          email:    job.person_email,
          headline: job.person_headline,
          linkedin_url: job.person_linkedin,
        },
        profile,
      });
      saveDraft(db, {
        job_id:    job.id,
        person_id: null,
        subject:   draft.subject,
        body:      draft.body,
      });
      console.log(`     Subject: ${draft.subject}`);
      console.log(`     ─────────────────────`);
      console.log(`     ${draft.body.replace(/\n/g, "\n     ")}\n`);
    } catch (e) {
      console.error(`     ✗ draft failed: ${e.message}\n`);
    }
  }
}

// ── report ────────────────────────────────────────────────────────────────────
else if (command === "report") {
  const db = openDb();
  const outPath = flags.out ?? `./job-report-${new Date().toISOString().slice(0, 10)}.pdf`;
  console.log(`  Generating HITL report → ${outPath}\n`);
  const written = await generateReport(db, outPath);
  if (written) {
    console.log(`  ✓ Report written: ${written}`);
    console.log(`  Open it, review each lead, and check the action boxes.\n`);
    // Mark all drafted jobs as exported so they won't appear in the next report
    db.prepare(`UPDATE jobs SET status='sent' WHERE status='drafted'`).run();
    console.log(`  Drafted jobs marked as sent — they won't re-appear in future reports.`);
  }
  console.log();
}

// ── resume ────────────────────────────────────────────────────────────────────
else if (command === "resume") {
  if (flags.refresh) {
    clearResumeCache();
    console.log("  Cache cleared. Re-extracting from resume.docx...\n");
  }
  const facts = await loadResumeFacts({ force: !!flags.refresh });
  if (!facts) {
    console.log("  No resume found. Drop your resume.docx into the resume/ directory.\n");
  } else {
    console.log("\n  ── Resume Facts ─────────────────────────────────────────");
    if (facts.name)              console.log(`  Name:         ${facts.name}`);
    if (facts.current_title)     console.log(`  Title:        ${facts.current_title}`);
    if (facts.years_experience)  console.log(`  Experience:   ${facts.years_experience} years`);
    if (facts.companies?.length) console.log(`  Companies:    ${facts.companies.join(", ")}`);
    if (facts.skills?.length)    console.log(`  Skills:       ${facts.skills.join(", ")}`);
    if (facts.accomplishments?.length) {
      console.log(`  Accomplishments:`);
      facts.accomplishments.forEach((a, i) => console.log(`    ${i+1}. ${a}`));
    }
    if (facts.links?.github)     console.log(`  GitHub:       ${facts.links.github}`);
    if (facts.links?.linkedin)   console.log(`  LinkedIn:     ${facts.links.linkedin}`);
    if (facts.education?.length) console.log(`  Education:    ${facts.education.join("; ")}`);
    console.log();
  }
}

// ── list ──────────────────────────────────────────────────────────────────────
else if (command === "list") {
  const db = openDb();
  const status = flags.status ?? null;
  const jobs = getAllJobs(db, status);
  if (!jobs.length) { console.log("  No jobs found.\n"); process.exit(0); }
  for (const j of jobs) {
    const score = j.fit_score != null ? ` [fit:${(j.fit_score * 100).toFixed(0)}%]` : "";
    console.log(`  ${fmtStatus(j.status)}  ${j.title}`);
    console.log(`           ${j.company ?? j.target_company} · ${j.location ?? "?"} · ${j.source}${score}`);
    console.log(`           ${j.url}\n`);
  }
}

// ── stats ─────────────────────────────────────────────────────────────────────
else if (command === "stats") {
  const db = openDb();
  const s = getStats(db);
  console.log(`  Jobs:     ${s.total} total  (${s.new} new · ${s.drafted} drafted · ${s.sent} sent · ${s.archived} archived)`);
  console.log(`  Contacts: ${s.people} found · ${s.emails} with email`);
  console.log(`  Runs:     ${s.runs}`);
  console.log();
}

// ── archive ───────────────────────────────────────────────────────────────────
else if (command === "archive") {
  const jobId = process.argv[3];
  if (!jobId) { console.error("Usage: node job.mjs archive <job_id>"); process.exit(1); }
  const db = openDb();
  markArchived(db, jobId);
  console.log(`  Archived: ${jobId}\n`);
}

else {
  console.error(`  Unknown command: ${command}`);
  process.exit(1);
}
