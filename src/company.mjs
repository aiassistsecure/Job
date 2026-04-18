// Company context fetcher — visits the company's website and careers page,
// extracts meaningful text, caches per company to company_cache/{slug}.json.
// The LLM gets a fresh, real snapshot of what the company is actually building
// right now — not stale training data from 2023.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const CACHE_DIR  = resolve(process.cwd(), "company_cache");
const CACHE_TTL  = 24 * 60 * 60 * 1000; // 24 hours

const AIAS_BASE  = process.env.AIAS_API_BASE_URL ?? "https://api.aiassist.net";
const PROVIDER   = process.env.AIAS_PROVIDER ?? "groq";
const MODEL      = process.env.AIAS_MODEL ?? "llama-3.3-70b-versatile";

// ─── Public API ───────────────────────────────────────────────────────────────

export async function loadCompanyContext(company, domain, { force = false, verbose = false } = {}) {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });

  const slug = company.toLowerCase().replace(/[^a-z0-9]/g, "_");
  const cachePath = resolve(CACHE_DIR, `${slug}.json`);

  // Return cache if fresh
  if (!force && existsSync(cachePath)) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, "utf8"));
      const age = Date.now() - (cached.fetched_at ?? 0);
      if (age < CACHE_TTL) {
        if (verbose) console.log(`  [company:${company}] using cached context (${Math.round(age/3600000)}h old)`);
        return cached;
      }
    } catch {}
  }

  process.stdout.write(`  [company:${company}] fetching context from ${domain}...\n`);

  const urls = [
    `https://${domain}`,
    `https://${domain}/blog`,
    `https://${domain}/about`,
    `https://${domain}/careers`,
  ];

  const snippets = [];
  for (const url of urls.slice(0, 2)) { // fetch main + blog, enough for context
    const text = await fetchPageText(url, verbose);
    if (text) snippets.push({ url, text: text.slice(0, 1200) });
  }

  if (!snippets.length) {
    process.stdout.write(`  [company:${company}] could not fetch — skipping context\n`);
    return null;
  }

  // Summarise via AiAS so we get a tight, relevant snapshot not raw HTML noise
  const summary = process.env.AIAS_API_KEY
    ? await summariseContext(company, snippets)
    : snippets.map(s => s.text).join("\n\n").slice(0, 800);

  const ctx = {
    company,
    domain,
    summary,
    snippets: snippets.map(s => ({ url: s.url, chars: s.text.length })),
    fetched_at: Date.now(),
  };

  writeFileSync(cachePath, JSON.stringify(ctx, null, 2));
  process.stdout.write(`  [company:${company}] context cached (${summary.length} chars)\n`);
  return ctx;
}

// ─── Page fetcher ─────────────────────────────────────────────────────────────

async function fetchPageText(url, verbose = false) {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) return null;
    const html = await res.text();
    const text = stripHtml(html);
    if (verbose) console.log(`  [fetch:${url}] ${text.length} chars extracted`);
    return text.length > 100 ? text : null;
  } catch (e) {
    if (verbose) console.warn(`  [fetch:${url}] ${e.message}`);
    return null;
  }
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ").replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .trim()
    .slice(0, 3000);
}

// ─── LLM summariser ──────────────────────────────────────────────────────────

async function summariseContext(company, snippets) {
  const raw = snippets.map(s => `[${s.url}]\n${s.text}`).join("\n\n---\n\n");

  try {
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
          {
            role: "system",
            content: `Extract a tight 200-word company snapshot from the following web content for ${company}. 
Focus on: what they actually build, recent launches or announcements, their technical stack or approach, team culture signals, and anything a job applicant could reference to show genuine familiarity.
Ignore navigation, legal text, cookie notices, and generic marketing.
Return plain text only — no headers, no bullets, just 2-3 dense paragraphs.`,
          },
          { role: "user", content: raw.slice(0, 4000) },
        ],
        temperature: 0.3,
      }),
    });

    if (!res.ok) throw new Error(`AiAS ${res.status}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() ?? raw.slice(0, 800);
  } catch (e) {
    console.warn(`  [company] summarise failed: ${e.message} — using raw text`);
    return snippets.map(s => s.text).join(" ").slice(0, 800);
  }
}
