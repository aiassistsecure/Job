// Direct API calls — no MCP layer — so we can inspect raw Netrows responses.
// Pass --verbose to dump the first raw response from each source.

const NETROWS_BASE = "https://api.netrows.com/v1";

function netrowsHeaders() {
  const key = process.env.NETROWS_API_KEY;
  if (!key) throw new Error("NETROWS_API_KEY env var required for Netrows sources");
  return { "x-api-key": key, "Content-Type": "application/json" };
}

async function netrowsGet(endpoint, params = {}, label = "", verbose = false) {
  const url = new URL(`${NETROWS_BASE}${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString(), { headers: netrowsHeaders() });
  const raw = await res.json();
  if (verbose) {
    console.log(`\n[raw:${label}] status=${res.status}`);
    console.log(JSON.stringify(raw, null, 2).slice(0, 2000));
  }
  if (!res.ok) throw new Error(`Netrows ${endpoint} → ${res.status}: ${JSON.stringify(raw).slice(0, 200)}`);
  return raw;
}

// ─── LinkedIn Jobs ──────────────────────────────────────────────────────────

export async function searchLinkedInJobs({ keywords, company = null, limit = 30, verbose = false }) {
  const results = [];
  const seen = new Set();
  
  const query = keywords || company;
  let raw;
  try {
    raw = await netrowsGet("/jobs/search", {
      keywords: query,
      count: Math.min(limit, 50),
    }, `linkedin_jobs:${query}`, verbose);
  } catch (e) {
    console.warn(`  [linkedin_jobs] ${e.message}`);
    return results;
  }

  const jobs = raw.jobs ?? raw.results ?? raw.data ?? [];
  for (const job of jobs) {
    const id = job.id ?? job.job_id ?? String(job.url ?? "");
    if (!id || seen.has(id)) continue;
    // Hard filter ONLY if company is provided
    if (company && company !== "FREE_SCAN") {
      const jobCompany = (typeof job.company === "object" ? job.company?.name : job.company) ?? "";
      if (!companyMatch(jobCompany, company)) {
        if (verbose) console.log(`  [filter] skipped "${job.title}" at "${jobCompany}" — not ${company}`);
        continue;
      }
    }
    seen.add(id);
    results.push(normaliseJob(job, company || "FREE_SCAN", "linkedin_jobs", raw));
    if (results.length >= limit) break;
  }

  return results;
}

// ─── LinkedIn Job Details ────────────────────────────────────────────────────

export async function getJobDetails(jobId, verbose = false) {
  try {
    const raw = await netrowsGet("/jobs/details", { job_id: jobId }, `job_details:${jobId}`, verbose);
    return raw;
  } catch (e) {
    console.warn(`  [job_details] ${e.message}`);
    return null;
  }
}

export async function getIndeedJobDetails(jobKey, verbose = false) {
  try {
    const raw = await netrowsGet("/indeed/job-details", { job_key: jobKey }, `indeed_details:${jobKey}`, verbose);
    return raw;
  } catch (e) {
    console.warn(`  [indeed_details] ${e.message}`);
    return null;
  }
}

export async function getUpworkJobDetails(jobId, verbose = false) {
  try {
    const raw = await netrowsGet("/upwork/jobs/detail", { id: jobId }, `upwork_details:${jobId}`, verbose);
    return raw;
  } catch (e) {
    console.warn(`  [upwork_details] ${e.message}`);
    return null;
  }
}

// ─── LinkedIn People (hiring manager) ───────────────────────────────────────

export async function findHiringManager({ company, role, limit = 5, verbose = false }) {
  const managerTitles = [
    `head of devrel ${company}`,
    `developer relations ${company}`,
    `engineering manager ${company}`,
    `hiring manager ${company}`,
  ];

  for (const query of managerTitles.slice(0, 2)) {
    let raw;
    try {
      raw = await netrowsGet("/people/search", {
        keywords: query,
        count: limit,
      }, `people:${company}`, verbose);
    } catch (e) {
      console.warn(`  [people_search] ${e.message}`);
      continue;
    }

    const profiles = raw.profiles ?? raw.results ?? raw.data ?? [];
    if (profiles.length > 0) {
      return normalisePerson(profiles[0], company, raw);
    }
  }
  return null;
}

// ─── Netrows Email Finder ────────────────────────────────────────────────────
// 5 credits per call. Endpoint verified against Netrows docs.

export async function findEmail({ firstName, lastName, domain, linkedinUrl, verbose = false }) {
  const params = {};
  if (linkedinUrl) params.linkedin_url = linkedinUrl;
  else {
    params.first_name = firstName;
    params.last_name = lastName;
    params.domain = domain;
  }

  let raw;
  try {
    raw = await netrowsGet("/email/finder", params, `email_finder:${domain}`, verbose);
  } catch (e) {
    // Try alternate endpoint name
    try {
      raw = await netrowsGet("/people/email-finder", params, `email_finder_alt:${domain}`, verbose);
    } catch (e2) {
      console.warn(`  [email_finder] ${e2.message}`);
      return null;
    }
  }

  const email = raw.email ?? raw.data?.email ?? raw.result?.email ?? null;
  const status = raw.status ?? raw.email_status ?? raw.data?.status ?? null;
  return email ? { email, status, raw } : null;
}

// ─── Netrows Indeed Jobs ──────────────────────────────────────────────────────
// Indeed data via Netrows — same auth, same credit system.
// Endpoint verified against Netrows endpoint patterns; verbose logs raw response.

export async function searchIndeedViaNetrows({ keywords, company = null, limit = 30, verbose = false }) {
  const results = [];
  const seen = new Set();

  const query = keywords || company;
  let raw;
  try {
    raw = await netrowsGet("/indeed/job-search", {
      query: query,
      limit: Math.min(limit, 50),
    }, `indeed:${query}`, verbose);
  } catch (e) {
    console.warn(`  [netrows/indeed] ${e.message}`);
    return results;
  }

  const jobs = raw.jobs ?? raw.results ?? raw.data ?? [];
  if (Array.isArray(jobs)) {
    for (const job of jobs) {
      const id = job.id ?? job.job_id ?? job.job_key ?? String(job.url ?? job.indeed_url ?? "");
      if (!id || seen.has(id)) continue;
      
      if (company && company !== "FREE_SCAN") {
        const jobCompany = (typeof job.company === "object" ? job.company?.name : job.company) ?? "";
        if (!companyMatch(jobCompany, company)) {
          if (verbose) console.log(`  [filter] skipped "${job.title}" at "${jobCompany}" — not ${company}`);
          continue;
        }
      }
      seen.add(id);
      results.push(normaliseJob(job, company || "FREE_SCAN", "indeed", raw));
      if (results.length >= limit) break;
    }
  }

  return results;
}

// ─── Netrows Upwork Jobs ──────────────────────────────────────────────────────

export async function searchUpworkViaNetrows({ keywords, company = null, limit = 30, verbose = false }) {
  const results = [];
  const seen = new Set();
  const query = keywords || company;
  let raw;
  
  try {
    raw = await netrowsGet("/upwork/jobs/search", {
      q: query,
      per_page: Math.min(limit, 50),
    }, `upwork:${query}`, verbose);
  } catch (e) {
    try {
      raw = await netrowsGet("/upwork/jobs/search", {
        keywords: query,
        count: Math.min(limit, 50),
      }, `upwork_alt:${query}`, verbose);
    } catch (e2) {
      console.warn(`  [netrows/upwork] ${e2.message}`);
      return results;
    }
  }

  const jobs = raw.jobs ?? raw.results ?? raw.data ?? [];
  if (Array.isArray(jobs)) {
    for (const job of jobs) {
      const id = job.ciphertext ?? job.id ?? job.uid ?? String(job.jobUrl ?? job.url ?? "");
      if (!id || seen.has(id)) continue;
      
      if (company && company !== "FREE_SCAN") {
        const jobCompany = (typeof job.company === "object" ? job.company?.name : job.company) ?? "";
        if (jobCompany && !companyMatch(jobCompany, company)) {
          if (verbose) console.log(`  [filter] skipped "${job.title}" at "${jobCompany}" — not ${company}`);
          continue;
        }
      }
      seen.add(id);
      results.push(normaliseJob({
          ...job,
          url: job.jobUrl || job.url
      }, company || "FREE_SCAN", "upwork", raw));
      if (results.length >= limit) break;
    }
  }
  return results;
}

// ─── Netrows Y Combinator Jobs ────────────────────────────────────────────────

export async function searchYCViaNetrows({ keywords, company = null, limit = 20, verbose = false }) {
  const results = [];
  let raw;
  
  try {
    const params = {
      is_hiring: true,
      per_page: company && company !== "FREE_SCAN" ? 3 : 5
    };
    if (company && company !== "FREE_SCAN") params.query = company;
    else if (keywords) params.tag = keywords;

    raw = await netrowsGet("/ycombinator/search", params, `yc_search:${keywords || company}`, verbose);
  } catch (e) {
    console.warn(`  [netrows/yc] search failed: ${e.message}`);
    return results;
  }
  
  const companies = raw.results ?? raw.companies ?? [];
  
  for (const c of companies) {
    if (!c.slug) continue;
    if (company && company !== "FREE_SCAN" && !companyMatch(c.name, company)) continue;
    
    try {
      const cRaw = await netrowsGet("/ycombinator/company", { slug: c.slug }, `yc_company:${c.slug}`, verbose);
      const jobs = cRaw.open_jobs ?? [];
      for (const job of jobs) {
         const id = job.id ?? String(job.url ?? "");
         results.push(normaliseJob({
             ...job, 
             company: cRaw.name,
             url: job.url || cRaw.website
         }, company || "FREE_SCAN", "ycombinator", cRaw));
      }
    } catch (e) {
      console.warn(`  [netrows/yc] company ${c.slug} failed: ${e.message}`);
    }
    if (results.length >= limit) break;
  }
  
  return results;
}

// ─── Normalisers ─────────────────────────────────────────────────────────────

function normaliseJob(raw, targetCompany, source, _fullRaw) {
  const id = raw.id ?? raw.job_id ?? String(raw.url ?? "");
  const company = raw.company ?? raw.company_name ?? {};
  const companyName = typeof company === "object"
    ? (company.name ?? company.title ?? targetCompany)
    : String(company || targetCompany);

  const location = raw.location ?? "";
  const locationStr = typeof location === "object"
    ? (location.name ?? location.full ?? "")
    : String(location);

  return {
    id: `netrows_job:${id}`,
    source,
    target_company: targetCompany,
    title: raw.title ?? raw.job_title ?? "",
    company: companyName,
    location: locationStr,
    remote: /remote/i.test(locationStr) ? 1 : 0,
    employment_type: raw.employment_type ?? raw.workType ?? null,
    seniority: raw.seniority_level ?? raw.experience_level ?? null,
    salary_range: raw.salary ?? raw.salary_range ?? raw.salaryRange ?? null,
    url: raw.url ?? raw.job_url ?? raw.indeed_url ?? "",
    description: (raw.description ?? raw.snippet ?? raw.summary ?? raw.content ?? "").slice(0, 600),
    date_posted: raw.posted_at ?? raw.listed_at ?? raw.postAt ?? (raw.postedTimestamp ? new Date(raw.postedTimestamp).toISOString() : null),
    applicants: typeof raw.applicants === "number" ? raw.applicants : (typeof raw.applicantsCount === "number" ? raw.applicantsCount : null),
    captured_at: new Date().toISOString(),
    raw,
  };
}

function normalisePerson(raw, company, _fullRaw) {
  const id = raw.username ?? raw.id ?? raw.public_id ?? String(raw.linkedin_url ?? raw.profileURL ?? "");
  const url = raw.profileURL ?? raw.url ?? raw.linkedin_url ?? "";
  return {
    id: `netrows_person:${id}`,
    name: raw.fullName ?? raw.name ?? raw.full_name ?? "Unknown",
    headline: raw.headline ?? raw.title ?? null,
    linkedin_url: url.startsWith("http") ? url : `https://linkedin.com/in/${url}`,
    company,
    location: typeof raw.location === "object"
      ? (raw.location?.full ?? raw.location?.name ?? "")
      : (raw.location ?? ""),
    captured_at: new Date().toISOString(),
    raw,
  };
}

// Fuzzy company name match — "Vercel Inc" matches "Vercel", case-insensitive
function companyMatch(jobCompany, targetCompany) {
  if (!jobCompany) return false;
  const a = jobCompany.toLowerCase().replace(/[^a-z0-9]/g, "");
  const b = targetCompany.toLowerCase().replace(/[^a-z0-9]/g, "");
  return a.includes(b) || b.includes(a);
}

function stripTags(str) {
  return str.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();
}
