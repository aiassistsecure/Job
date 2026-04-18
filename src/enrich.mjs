import { openDb } from "./db.mjs";
import { getJobDetails, getIndeedJobDetails, getUpworkJobDetails } from "./sources.mjs";
import { fetchPageText } from "./company.mjs";

export async function runEnrich({ verbose = false } = {}) {
  const db = openDb();
  
  // Fetch all active jobs. The user specified "enrich everything no limits".
  // We'll skip ones that are already heavily enriched (description > 500 chars).
  const jobs = db.prepare(`SELECT * FROM jobs WHERE status IN ('new', 'drafted')`).all();
  process.stdout.write(`\n  ── Deep Link Enrichment Engine ──\n`);
  
  let enrichedCount = 0;
  
  for (const job of jobs) {
    let rawData = {};
    try { rawData = JSON.parse(job.raw || "{}"); } catch(e) {}
    
    if (rawData._enriched) {
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
        // We already have YC raw data since Free Scan fetched company. 
        // Scrape the job.url natively to extract the actual responsibilities text.
        const text = await fetchPageText(job.url);
        if (text) {
          fullDescription = text.slice(0, 4000);
          enrichedRaw = { scrape: true };
        }
      }
      
      if (fullDescription && fullDescription !== job.description) {
        db.prepare(`UPDATE jobs SET description=? WHERE id=?`).run(fullDescription, job.id);
        
        // Merge the newly enriched data over the raw JSON column
        if (enrichedRaw && job.raw) {
          let oldRaw = {};
          try { oldRaw = JSON.parse(job.raw); } catch (e) {}
          const newRaw = { ...oldRaw, ...enrichedRaw, _enriched: true };
          db.prepare(`UPDATE jobs SET raw=? WHERE id=?`).run(JSON.stringify(newRaw), job.id);
        }
        
        process.stdout.write(`done\n`);
        enrichedCount++;
      } else {
        process.stdout.write(`no extra data\n`);
      }
    } catch (e) {
      process.stdout.write(`failed (${e.message})\n`);
    }
  }
  
  console.log(`\n━━ enrichment complete ━━`);
  console.log(`  ${enrichedCount} jobs enriched with high-fidelity data.\n`);
}
