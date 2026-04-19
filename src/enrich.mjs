import { openDb } from "./db.mjs";
import { getJobDetails, getIndeedJobDetails, getUpworkJobDetails } from "./sources.mjs";
import { fetchPageText } from "./company.mjs";

export async function runEnrich({ verbose = false } = {}) {
  const db = openDb();
  
  // Fetch all active jobs. The user specified "enrich everything no limits".
  const jobs = db.prepare(`SELECT * FROM jobs WHERE status IN ('new', 'drafted')`).all();
  process.stdout.write(`\n  ── Deep Link Enrichment Engine ──\n`);
  
  let enrichedCount = 0;
  
  for (const job of jobs) {
    let rawData = {};
    try { rawData = JSON.parse(job.raw || "{}"); } catch(e) {}
    
    // Skip only if strictly marked as enriched AND we have basic metadata
    if (rawData._enriched && job.title !== "Unknown Title" && job.company !== "Unknown Company") {
      if (verbose) console.log(`    [enrich] skipped ${job.id} (already enriched)`);
      continue;
    }
    
    process.stdout.write(`    [enrich] ${job.source} | ${job.id} ... `);
    
    let fullDescription = job.description;
    let enrichedRaw = null;
    const rawId = job.id.replace(/^netrows_job:/, "");
    
    try {
      if (job.source === "linkedin" || job.source === "linkedin_jobs") {
        const details = await getJobDetails(rawId, verbose);
        if (details) {
          fullDescription = details.data?.description ?? details.data?.job_description ?? details.description ?? details.job_description ?? fullDescription;
          enrichedRaw = details.data || details;
        }
      } else if (job.source === "indeed") {
        const details = await getIndeedJobDetails(rawId, verbose);
        if (details) {
          fullDescription = details.data?.description ?? details.data?.job_description ?? details.description ?? details.job_description ?? fullDescription;
          enrichedRaw = details.data || details;
        }
      } else if (job.source === "upwork") {
        const details = await getUpworkJobDetails(rawId, verbose);
        if (details) {
          fullDescription = details.description ?? fullDescription;
          enrichedRaw = details;
        }
      } else if (job.source === "ycombinator") {
        // Scrape the job.url natively to extract the actual responsibilities text.
        const text = await fetchPageText(job.url);
        if (text) {
          fullDescription = text;
          enrichedRaw = { scrape: true };
        }
      }
      
      // 1. Update Description and persist enriched state
      if (fullDescription && (fullDescription !== job.description || !rawData._enriched)) {
        db.prepare(`UPDATE jobs SET description=? WHERE id=?`).run(fullDescription, job.id);
        
        let oldRaw = {};
        if (job.raw) { try { oldRaw = JSON.parse(job.raw); } catch(e) {} }
        const newRaw = { ...oldRaw, ...(enrichedRaw || {}), _enriched: true };
        db.prepare(`UPDATE jobs SET raw=? WHERE id=?`).run(JSON.stringify(newRaw), job.id);
        
        enrichedCount++;
      }

      // 2. Metadata Healing: If title/company are Unknown, fix them now that we have the full text
      if (fullDescription && (job.title === "Unknown Title" || job.company === "Unknown Company")) {
          const fixed = await extractMetadataFromText(fullDescription);
          if (fixed) {
              db.prepare(`UPDATE jobs SET title=?, company=?, target_company=? WHERE id=?`)
                .run(fixed.title, fixed.company, fixed.company, job.id);
              process.stdout.write(`healed metadata (${fixed.title} @ ${fixed.company}) ... `);
          }
      }
      
      process.stdout.write(`done\n`);
    } catch (e) {
      process.stdout.write(`failed (${e.message})\n`);
    }
  }
  
  console.log(`\n━━ enrichment complete ━━`);
  console.log(`  ${enrichedCount} jobs upgraded with high-fidelity data.\n`);
}

async function extractMetadataFromText(text) {
    const AIAS_BASE = process.env.AIAS_API_BASE_URL ?? "https://api.aiassist.net";
    const PROVIDER  = process.env.AIAS_PROVIDER ?? "groq";
    const MODEL     = process.env.AIAS_MODEL ?? "llama-3.3-70b-versatile";

    if (!text || text.length < 100) return null;
    
    const prompt = `Extract exactly the Job Title and Company Name from this job posting. Return ONLY JSON: {"title": "...", "company": "..."}\n\nText:\n${text.slice(0, 4000)}`;
    try {
        const res = await fetch(`${AIAS_BASE}/v1/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.AIAS_API_KEY}`, "x-AiAssist-provider": PROVIDER },
            body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: prompt }], temperature: 0.1, response_format: { type: "json_object" } }),
        });
        if (res.ok) {
            const data = await res.json();
            const content = data.choices[0].message.content.replace(/^```(json)?\s*/i, "").replace(/```\s*$/, "").trim();
            return JSON.parse(content);
        }
    } catch (e) {
        return null;
    }
}
