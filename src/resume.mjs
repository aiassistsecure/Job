// Resume extractor — DOCX primary, plain text fallback.
// Scans resume/ dir, extracts raw text with mammoth, sends to AiAS once
// to pull structured facts, caches to resume/facts.json so subsequent
// draft runs are instant (no re-parse, no re-LLM call).
//
// Facts shape:
//   { name, current_title, years_experience, companies[], titles[],
//     skills[], accomplishments[], education[], links{} }

import mammoth from "mammoth";
import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { resolve, extname } from "node:path";

const RESUME_DIR  = resolve(process.cwd(), "resume");
const FACTS_CACHE = resolve(RESUME_DIR, "facts.json");
const AIAS_BASE   = process.env.AIAS_API_BASE_URL ?? "https://api.aiassist.net";
const PROVIDER    = process.env.AIAS_PROVIDER ?? "groq";
const MODEL       = process.env.AIAS_MODEL ?? "llama-3.3-70b-versatile";

// ─── Public API ───────────────────────────────────────────────────────────────

export async function loadResumeFacts({ force = false } = {}) {
  // Return cached facts unless forced
  if (!force && existsSync(FACTS_CACHE)) {
    try {
      const cached = JSON.parse(readFileSync(FACTS_CACHE, "utf8"));
      if (cached?.skills?.length || cached?.name) {
        process.stdout.write("  [resume] cached facts loaded\n");
        return cached;
      }
    } catch {}
  }

  const text = await extractText();
  if (!text) return null;

  process.stdout.write(`  [resume] ${text.length} chars extracted — running fact extraction...\n`);
  const facts = process.env.AIAS_API_KEY
    ? await extractFactsViaLLM(text)
    : fallbackParse(text);

  writeFileSync(FACTS_CACHE, JSON.stringify(facts, null, 2));
  process.stdout.write(`  [resume] facts cached → resume/facts.json\n`);
  return facts;
}

export function clearResumeCache() {
  if (existsSync(FACTS_CACHE)) {
    unlinkSync(FACTS_CACHE);
    console.log("  [resume] cache cleared — next draft run will re-extract");
  } else {
    console.log("  [resume] no cache to clear");
  }
}

// ─── Text extraction ──────────────────────────────────────────────────────────

async function extractText() {
  if (!existsSync(RESUME_DIR)) {
    console.warn("  [resume] resume/ directory not found — skipping");
    return null;
  }

  const files = readdirSync(RESUME_DIR).filter(f => !f.startsWith(".") && !/^readme/i.test(f));

  // DOCX primary
  const docxFile = files.find(f => extname(f).toLowerCase() === ".docx");
  if (docxFile) {
    try {
      const buf = readFileSync(resolve(RESUME_DIR, docxFile));
      const result = await mammoth.extractRawText({ buffer: buf });
      const text = result.value?.trim() ?? "";
      if (text) {
        process.stdout.write(`  [resume] extracted from ${docxFile} (${text.length} chars)\n`);
        return text;
      }
      console.warn(`  [resume] mammoth returned empty text from ${docxFile}`);
    } catch (e) {
      console.warn(`  [resume] mammoth error on ${docxFile}: ${e.message}`);
    }
  }

  // Plain text / markdown fallback
  const txtFile = files.find(f => [".txt", ".md"].includes(extname(f).toLowerCase()));
  if (txtFile) {
    const text = readFileSync(resolve(RESUME_DIR, txtFile), "utf8").trim();
    process.stdout.write(`  [resume] reading ${txtFile} (${text.length} chars)\n`);
    return text;
  }

  console.warn("  [resume] no .docx / .txt / .md found in resume/ — skipping resume enrichment");
  return null;
}

// ─── LLM fact extraction ──────────────────────────────────────────────────────

async function extractFactsViaLLM(rawText) {
  const systemPrompt = `You are a precise resume parser. Extract structured professional facts.
Return valid JSON — null or [] for missing fields, never hallucinate:
{
  "name": "Full Name",
  "current_title": "Most recent job title",
  "years_experience": 7,
  "companies": ["Most Recent Co", "Previous Co"],
  "titles": ["Senior Engineer", "Lead DevRel"],
  "skills": ["Node.js", "Python", "APIs", "DevRel"],
  "accomplishments": [
    "Built X that did Y — resulted in Z (numbers preferred)",
    "Launched open-source tool with N GitHub stars"
  ],
  "education": ["BS Computer Science, MIT 2017"],
  "links": {
    "github": "https://github.com/...",
    "linkedin": "https://linkedin.com/in/...",
    "portfolio": "https://..."
  }
}
Keep accomplishments concrete: name the thing, what it did, the outcome. Max 6.`;

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
          { role: "system", content: systemPrompt },
          { role: "user",   content: `RESUME:\n\n${rawText.slice(0, 6000)}` },
        ],
        temperature: 0.1,
        response_format: { type: "json_object" },
      }),
    });

    if (!res.ok) throw new Error(`AiAS ${res.status}`);
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content ?? "{}";
    return JSON.parse(content);
  } catch (e) {
    console.warn(`  [resume] LLM extraction failed (${e.message}) — using heuristic fallback`);
    return fallbackParse(rawText);
  }
}

// ─── Heuristic fallback ───────────────────────────────────────────────────────

function fallbackParse(text) {
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  return {
    name: lines[0] ?? null,
    current_title: lines[1] ?? null,
    years_experience: null,
    companies: [],
    titles: [],
    skills: extractSkillsHeuristic(text),
    accomplishments: lines
      .filter(l => /\b(built|launched|led|created|grew|increased|reduced|shipped|authored|designed|founded)\b/i.test(l))
      .slice(0, 6),
    education: [],
    links: extractLinksHeuristic(text),
  };
}

function extractSkillsHeuristic(text) {
  const known = ["JavaScript","TypeScript","Python","Node.js","React","FastAPI","Redis","PostgreSQL",
    "Docker","AWS","GCP","REST","GraphQL","MCP","AI","LLM","DevRel","APIs","Git","Linux","Kubernetes"];
  return known.filter(s => new RegExp(`\\b${s}\\b`, "i").test(text));
}

function extractLinksHeuristic(text) {
  const links = {};
  const gh = text.match(/https?:\/\/github\.com\/[\w-]+/);
  const li = text.match(/https?:\/\/(?:www\.)?linkedin\.com\/in\/[\w-]+/);
  if (gh) links.github = gh[0];
  if (li) links.linkedin = li[0];
  return links;
}
