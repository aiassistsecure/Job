# JOB — Interchained Job Scout

> Company-led · Signal-timed · Warm-path email outreach

A CLI agent that watches your target companies for open roles, scores them against your profile, finds a real team member's email via LinkedIn, and drafts a practitioner-to-practitioner cold email enriched with your resume and a live snapshot of what the company is actually building right now.

Built by **Interchained LLC**. Credits: Ra (Replit AI Agent) + Mark Allen Evans.

---

## What it does

1. **Scans** LinkedIn Jobs (via Netrows) for your target companies
2. **Scores** each role against your profile — remote preference, role keywords, recency, deal-breakers
3. **Fetches company context** — visits the company's website, summarises what they're shipping right now, caches it for 24 h
4. **Finds a contact** — searches LinkedIn People for a relevant team member at the company
5. **Finds their email** — Netrows email finder against the company domain
6. **Drafts the email** — AiAS LLM call combining your resume facts, the job, and the live company context into a sub-120-word warm outreach
7. **Exports a PDF report** — HITL review of all drafted emails before anything leaves your machine

No LinkedIn automation. No scraping. No ban risk. Email-only outreach via Netrows API.

---

## Quick start

```bash
cd job

# 1. Install
npm install

# 2. Drop your resume
cp ~/your-resume.docx resume/resume.docx

# 3. Configure targets
nano targets.yaml   # companies, roles, your profile

# 4. Set secrets
export NETROWS_API_KEY=...
export AIAS_API_KEY=...          # optional — for LLM summarisation
export AIAS_API_BASE_URL=https://api.aiassist.net

# 5. Scan
node job.mjs scan

# 6. Draft emails for shortlisted jobs (fit >= 60%)
node job.mjs draft

# 7. Review as PDF before sending anything
node job.mjs report
```

---

## Commands

| Command | What it does |
|---|---|
| `scan` | Fetch jobs for all targets, score, find contacts + emails |
| `scan --only=Vercel` | Single company |
| `scan --verbose` | Show raw API responses for debugging |
| `draft` | LLM-draft emails for all shortlisted new jobs |
| `draft --only=<job_id>` | Draft one specific job |
| `report` | Export PDF of all drafted emails for HITL review |
| `list` | Show all jobs with status and fit score |
| `stats` | Totals: jobs · contacts · emails · runs |
| `resume` | Re-extract and cache facts from resume.docx |
| `archive --id=<job_id>` | Archive a job (removes from active list) |

---

## Configuration — `targets.yaml`

```yaml
profile:
  name: Your Name
  title: Your Title
  skills: [AI, APIs, DevRel, Node.js, Python]
  target_roles: [developer advocate, developer relations, devrel]
  seniority: [senior, lead, staff]
  remote_ok: true
  deal_breakers: [no sponsorship, on-site only, intern, internship]

targets:
  - company: Vercel
    domain: vercel.com
    roles: [developer advocate, devrel, developer experience]

  - company: Cloudflare
    domain: cloudflare.com
    roles: [developer advocate, AI platform, developer experience]
```

---

## Data sources

| Source | What | Auth |
|---|---|---|
| Netrows LinkedIn Jobs | Job listings | `NETROWS_API_KEY` |
| Netrows LinkedIn People | Team member search | `NETROWS_API_KEY` |
| Netrows Email Finder | Verified work emails | `NETROWS_API_KEY` (5 credits each) |
| Company website | Live product context for drafts | Public fetch + AiAS LLM |
| resume.docx | Accomplishments, skills, companies | Local DOCX extraction (mammoth) |

Netrows pricing: €49/mo = 10k credits. Job/people search ≈ 5 credits. Email finder = 5 credits.

---

## File layout

```
interchained_job/
├── job.mjs              # CLI entry point
├── targets.yaml         # Your companies + profile
├── resume/
│   ├── resume.docx      # Drop your resume here
│   └── facts.json       # Extracted + cached resume facts
├── company_cache/       # Per-company website snapshots (24h TTL)
├── reports/             # Exported PDF reports
├── src/
│   ├── scout.mjs        # Scan orchestration
│   ├── sources.mjs      # Netrows API calls
│   ├── company.mjs      # Company URL fetch + LLM summarise + cache
│   ├── draft.mjs        # LLM email drafter
│   ├── resume.mjs       # DOCX extraction + fact caching
│   ├── report.mjs       # PDF export
│   └── db.mjs           # SQLite lifecycle (new→drafted→sent→archived)
└── job.db               # SQLite database (git-ignored)
```

---

## License

MIT — see [LICENSE](./LICENSE).
