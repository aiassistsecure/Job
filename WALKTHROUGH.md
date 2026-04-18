# JOB — Walkthrough

A step-by-step guide to running your first complete cycle: scan → draft → report.

---

## Before you begin

You need:
- **Node.js 18+**
- **NETROWS_API_KEY** — get one at netrows.io (€49/mo, 10k credits)
- **AIAS_API_KEY** — your AiAssist Secure key (for resume extraction + company summarisation + email drafts)
- A copy of your resume as `resume/resume.docx`

```bash
cd interchained_job
npm install
```

---

## Step 1 — Configure your targets

Open `targets.yaml`. Two sections:

**`profile`** — who you are and what you're looking for:

```yaml
profile:
  name: Mark Allen Evans
  title: Developer Relations / AI Platform Engineer
  skills: [AI, MCP, APIs, DevRel, Node.js, Python, platform engineering]
  target_roles: [developer advocate, developer relations, devrel, developer experience]
  remote_ok: true
  deal_breakers: [no sponsorship, on-site only, intern, internship]
```

`deal_breakers` are checked against the full job title + description. Any match drops the fit score by 50 points — the job stays in the DB but won't be shortlisted for drafting.

**`targets`** — your company list:

```yaml
targets:
  - company: Vercel
    domain: vercel.com
    roles: [developer advocate, devrel, developer experience]
```

`roles` are the search queries sent to LinkedIn Jobs via Netrows. The agent runs each query and filters results to the named company client-side, so you don't get cross-company noise.

---

## Step 2 — Load your resume

Drop your resume at `resume/resume.docx`, then run:

```bash
node job.mjs resume
```

This extracts your resume text locally with `mammoth`, sends it to the AiAS LLM to pull structured facts (accomplishments, companies, skills, links), and caches the result to `resume/facts.json`. Every subsequent draft call reuses this cache — no re-extraction, no extra API cost.

The facts JSON looks like:

```json
{
  "name": "Mark Allen Evans",
  "current_title": "Founder / AI Platform Engineer",
  "years_experience": 12,
  "companies": ["Interchained LLC", "..."],
  "skills": ["Node.js", "Python", "AI orchestration", "..."],
  "accomplishments": [
    "Built AiAssist Secure — multi-tenant AI orchestration platform serving 40+ orgs",
    "Shipped @aiassist-secure/intelligence-mcp, an npm MCP package with 22 sources",
    "..."
  ],
  "links": { "github": "...", "linkedin": "..." }
}
```

---

## Step 3 — Scan

```bash
node job.mjs scan
```

For each target company the agent:

1. **Fetches company context** — hits the company's main site and blog, strips HTML, summarises with the LLM, writes to `company_cache/{company}.json`. This snapshot is what makes the draft emails feel current and specific rather than generic. Cached for 24 hours — subsequent scans skip the fetch.

2. **Searches LinkedIn Jobs** via Netrows for each role query, then filters client-side to the exact company. You get only real matches, not keyword-adjacent noise.

3. **Scores each job** (0–1):
   - Base: 0.5
   - +0.05 per skill keyword hit in title/description
   - +0.10 if the title matches a `target_roles` entry
   - +0.10 if remote and `remote_ok: true`
   - +0.15 if posted < 48 h ago, +0.05 if < 1 week
   - −0.50 if any `deal_breaker` found in title/description

4. **Shortlists jobs** with `fit_score >= 0.6` and searches LinkedIn People for a relevant team member at that company.

5. **Finds their email** via Netrows email finder (5 credits per lookup).

To scan a single company:

```bash
node job.mjs scan --only=Vercel
```

To see raw API responses:

```bash
node job.mjs scan --only=Vercel --verbose
```

---

## Step 4 — Review the list

```bash
node job.mjs list
```

Output:

```
  NEW   Developer Advocate                         [fit:75%]
        Vercel · Remote · linkedin_jobs

  NEW   Developer Relations Engineer               [fit:70%]
        Groq · Remote · linkedin_jobs

  NEW   Global Trade Compliance Intern             [fit:0%]
        Cloudflare · Lisbon (Hybrid) · linkedin_jobs
```

Internships with `intern` in the title score 0% and appear at the bottom. Only `fit >= 60%` jobs get people search + email lookup + drafting.

---

## Step 5 — Draft

```bash
node job.mjs draft
```

For each shortlisted job with status `new`, the agent:

1. Loads your resume facts from cache
2. Loads the company context snapshot from `company_cache/`
3. Calls the AiAS LLM (Groq by default) with:
   - The job title, location, and description
   - The company context — what they're currently building
   - Your best-matching accomplishment
   - The recipient's name and role (if found)
4. Gets back `{ subject, body }` — under 120 words, practitioner-to-practitioner tone

The result is stored in SQLite with status `drafted`. Nothing is sent — you control that.

To draft a single job:

```bash
node job.mjs draft --only=<job_id>
```

---

## Step 6 — Export for review (PDF)

```bash
node job.mjs report
```

Generates `reports/job_report_{timestamp}.pdf` with:
- Cover page: your name, scan date, summary stats
- One page per drafted email: job title, company, recipient, subject, body
- Footer with job URL

Review the PDF. When you're happy with an email, copy the body out and send it manually. Mark it sent:

```bash
# (coming soon — node job.mjs send --id=<job_id>)
```

Archive jobs you're not pursuing:

```bash
node job.mjs archive --id=<job_id>
```

---

## Credit costs (Netrows, €49/mo = 10k credits)

| Action | Credits |
|---|---|
| LinkedIn Jobs search (per query) | ~5 |
| LinkedIn People search (per job shortlisted) | ~5 |
| Email finder (per contact) | 5 |
| A full scan of 10 companies, 3 role queries each, 3 shortlisted | ~200 |

A full 10-company scan with people search costs roughly 2% of your monthly credit budget.

---

## Troubleshooting

**"Unexpected token '<'" from any source** — the endpoint returned HTML (bot detection / Cloudflare challenge). That source is blocked from server environments. The LinkedIn Jobs endpoint via Netrows is the reliable path.

**"AiAS chat error 401"** — `AIAS_API_KEY` not set or expired. Company context fetch will fall back to raw text; resume extraction and email drafting will fail.

**"0 results" for all companies** — check `--verbose` output. Netrows may return `data: null` for queries with no results, which is correct (no open roles right now). Try again next week when new roles are posted.

**Resume facts not extracting** — make sure your file is a real `.docx` (not `.doc` or a PDF renamed to `.docx`). Run `node job.mjs resume --verbose` to see the raw extraction output.

---

## Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `NETROWS_API_KEY` | Yes | — | Netrows API key |
| `AIAS_API_KEY` | For drafts | — | AiAssist Secure API key |
| `AIAS_API_BASE_URL` | No | `https://api.aiassist.net` | Override for local dev |
| `AIAS_PROVIDER` | No | `groq` | LLM provider (`groq`, `openai`, `anthropic`) |
| `AIAS_MODEL` | No | `llama-3.3-70b-versatile` | Model override |
