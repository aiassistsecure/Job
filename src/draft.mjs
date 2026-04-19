// Drafts a personalised cold email via AiAS chat completions.
// Enriched with:
//   - Resume facts extracted from resume.docx (accomplishments, skills, companies)
//   - Company context fetched live from the company's website and cached
//     to company_cache/{slug}.json — the LLM gets a real snapshot of what
//     the company is building right now, not stale training data.

import { loadResumeFacts } from "./resume.mjs";
import { loadCompanyContext } from "./company.mjs";

const AIAS_BASE = process.env.AIAS_API_BASE_URL ?? "https://api.aiassist.net";
const PROVIDER  = process.env.AIAS_PROVIDER ?? "groq";
const MODEL     = process.env.AIAS_MODEL ?? "llama-3.3-70b-versatile";

// Cache resume facts for the session — extract once, reuse for every draft
let _resumeFacts = undefined;

async function getResumeFacts() {
  if (_resumeFacts === undefined) {
    _resumeFacts = await loadResumeFacts();
  }
  return _resumeFacts;
}

export async function draftEmail({ job, person, profile }) {
  const facts = await getResumeFacts();

  // Load company context from cache (populated during scan, or fetch now)
  const companyName = job.company ?? job.target_company;
  const companyCtx = await loadCompanyContext(
    companyName,
    job.domain ?? profile.targets?.find(t => t.company === companyName)?.domain ?? null,
    job.url,
    { verbose: false }
  );

  const candidateContext = buildCandidateContext(profile, facts);

  const systemPrompt = `You are a world-class technical recruiter ghostwriter.
Write a concise, warm cold email from ${profile.name ?? facts?.name ?? "the candidate"} to someone on the team at ${companyName}.

Context: this person is likely a team member or colleague, not the hiring manager. The email should feel like a genuine reach-out through the team — not a formal application, not an apology for the wrong inbox. Natural, human, no awkwardness about it.

Rules — no exceptions:
- Under 120 words total (subject line is separate, not counted)
- Open with something SPECIFIC about what the company is building right now — use the company context below, not generic praise
- Pick ONE accomplishment from the candidate context that directly mirrors what this role needs — name it concretely
- Naturally invite them to pass it along or point to the right person if they're not involved in hiring — phrase this lightly, like it's an afterthought, not a disclaimer
- Tone: practitioner to practitioner — curious and direct, not eager or desperate
- CTA: low-friction — "happy to connect" or "would love 20 mins with whoever owns this" — keep it easy to forward
- Sign off with name only
- Never use: "leverage", "synergy", "passionate about", "excited to apply", "rockstar", "ninja", "I apologize for reaching out"
Output JSON only: { "subject": "...", "body": "..." }`;

  const companySection = companyCtx?.summary
    ? `\nCOMPANY CONTEXT (use this to open with something specific and current):\n${companyCtx.summary.slice(0, 600)}`
    : "";

  const userPrompt = `TARGET ROLE:
Title: ${job.title}
Company: ${companyName}
Location: ${job.location ?? "?"} | Remote: ${job.remote ? "yes" : "unknown"}
${job.salary_range ? `Salary: ${job.salary_range}` : ""}
Description: ${(job.description ?? "").slice(0, 500)}
URL: ${job.url}
${companySection}

EMAIL RECIPIENT (likely a team member, not necessarily the hiring manager):
${person?.name ? `Name: ${person.name}` : "Name: unknown"}
${person?.headline ? `Role: ${person.headline}` : ""}
${person?.email ? `Email: ${person.email}` : ""}

CANDIDATE:
${candidateContext}`;

  const res = await fetch(`${AIAS_BASE}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.AIAS_API_KEY}`,
      "x-AiAssist-provider": PROVIDER,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userPrompt },
      ],
      temperature: 0.7,
      response_format: { type: "json_object" },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`AiAS chat error ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content ?? "{}";
  const rawJson = content.replace(/^```(json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try {
    return JSON.parse(rawJson);
  } catch {
    return {
      subject: `Re: ${job.title} at ${job.company ?? job.target_company}`,
      body: content,
    };
  }
}

// ─── Candidate context builder ────────────────────────────────────────────────

function buildCandidateContext(profile, facts) {
  const lines = [];

  const name = profile.name ?? facts?.name;
  const title = facts?.current_title ?? profile.title;
  if (name)  lines.push(`Name: ${name}`);
  if (title) lines.push(`Current title: ${title}`);
  if (facts?.years_experience) lines.push(`Experience: ${facts.years_experience} years`);

  const companies = facts?.companies?.length ? facts.companies : [];
  if (companies.length) lines.push(`Companies: ${companies.slice(0, 4).join(", ")}`);

  const skills = mergeSkills(profile.skills ?? [], facts?.skills ?? []);
  if (skills.length) lines.push(`Skills: ${skills.slice(0, 12).join(", ")}`);

  const accomplishments = facts?.accomplishments ?? [];
  if (accomplishments.length) {
    lines.push(`\nKey accomplishments (use ONE that fits the role):`);
    accomplishments.slice(0, 6).forEach((a, i) => lines.push(`  ${i + 1}. ${a}`));
  }

  const links = facts?.links ?? {};
  if (links.github)    lines.push(`GitHub: ${links.github}`);
  if (links.linkedin)  lines.push(`LinkedIn: ${links.linkedin}`);
  if (links.portfolio) lines.push(`Portfolio: ${links.portfolio}`);

  if (facts?.education?.length) {
    lines.push(`Education: ${facts.education.slice(0, 2).join("; ")}`);
  }

  return lines.join("\n");
}

function mergeSkills(profileSkills, resumeSkills) {
  const seen = new Set();
  const out = [];
  for (const s of [...profileSkills, ...resumeSkills]) {
    const k = s.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(s); }
  }
  return out;
}
