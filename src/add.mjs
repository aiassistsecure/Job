import { openDb } from "./db.mjs";
import { fetchPageText } from "./company.mjs";

const AIAS_BASE = process.env.AIAS_API_BASE_URL ?? "https://api.aiassist.net";
const PROVIDER  = process.env.AIAS_PROVIDER ?? "groq";
const MODEL     = process.env.AIAS_MODEL ?? "llama-3.3-70b-versatile";

export async function addJobLink(url, verbose = false) {
  let source = "unknown";
  let extractedId = `manual_${Date.now()}`;

  // 1. Map target URL to pipeline native IDs 
  if (url.includes("workatastartup.com")) {
    source = "ycombinator";
    const m = url.match(/\/jobs\/(\d+)/);
    if (m) extractedId = m[1];
  } else if (url.includes("upwork.com")) {
    source = "upwork";
    const m = url.match(/_(~[a-zA-Z0-9]+)/);
    if (m) extractedId = m[1];
  } else if (url.includes("indeed.com")) {
    source = "indeed";
    const m = url.match(/jk=([a-zA-Z0-9]+)/);
    if (m) extractedId = m[1];
  } else if (url.includes("linkedin.com")) {
    source = "linkedin";
    const m = url.match(/\/view\/(\d+)/) || url.match(/currentJobId=(\d+)/);
    if (m) extractedId = m[1];
  }

  process.stdout.write(`\n  ── Manual Lead Injection ──\n`);
  process.stdout.write(`  [add] Detected source: ${source} (ID: ${extractedId})\n`);
  process.stdout.write(`  [add] Scraping page for initial metadata... `);

  // 2. Fetch the HTML text directly for quick title/company mapping
  const rawHtmlText = await fetchPageText(url, verbose);
  let title = "Unknown Title";
  let company = "Unknown Company";

  if (rawHtmlText) {
    process.stdout.write(`done\n  [add] Extracting Title & Company via LLM... `);
    const prompt = `You are a high precision recruiter AI. Extract the exact Job Title and Company Name from this raw job posting text.
If you cannot confidently find them, guess to your best ability based on context clues.
Return ONLY valid JSON: {"title": "...", "company": "..."}

Raw HTML Text snippet:
${rawHtmlText.slice(0, 5000)}`;

    try {
      const res = await fetch(`${AIAS_BASE}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.AIAS_API_KEY}`, "x-AiAssist-provider": PROVIDER },
        body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: prompt }], temperature: 0.1, response_format: { type: "json_object" } }),
      });
      if (res.ok) {
        const data = await res.json();
        const content = data.choices[0].message.content.replace(/^```(json)?\s*/i, "").replace(/```\s*$/, "").trim();
        const parsed = JSON.parse(content);
        if (parsed.title) title = parsed.title;
        if (parsed.company) company = parsed.company;
      }
    } catch (e) {}
    process.stdout.write(`done\n`);
  } else {
    process.stdout.write(`failed (Proceeding with unknown metadata)\n`);
  }

  // 3. Inject the clean payload directly into SQLite
  const db = openDb();
  const dbId = `netrows_job:${extractedId}`;

  console.log(`  [add] Injecting: ${title} @ ${company}\n`);
  
  try {
    db.prepare(`
      INSERT INTO jobs (id, target_company, source, url, title, company, status, fit_score, captured_at)
      VALUES (?, ?, ?, ?, ?, ?, 'new', 1.0, ?)
    `).run(dbId, company, source, url, title, company, new Date().toISOString());
    console.log(`  ✓ Successfully added to pipeline. Run 'node job.mjs enrich' next!`);
  } catch (e) {
    if (e.message.includes("UNIQUE constraint failed")) {
      console.log(`  ! Job already exists in the pipeline (ID: ${dbId})`);
    } else {
      console.error(`  ! Failed to inject: ${e.message}`);
    }
  }
}
