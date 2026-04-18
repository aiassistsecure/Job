import { resolve } from "node:path";

const AIAS_BASE  = process.env.AIAS_API_BASE_URL ?? "https://api.aiassist.net";
const PROVIDER   = process.env.AIAS_PROVIDER ?? "groq";
const MODEL      = process.env.AIAS_MODEL ?? "llama-3.3-70b-versatile";

export async function generateSearchStrategy(facts, verbose = false) {
  if (!process.env.AIAS_API_KEY) {
    if (verbose) console.warn("  [strategy] AIAS_API_KEY missing, using fallback queries");
    return fallbackStrategy(facts);
  }

  process.stdout.write(`  [strategy] consulting LLM to generate intelligent query matrix... `);

  const prompt = `You are a world-class technical recruiter and AI career agent.
Your objective is to review a candidate's resume facts and generate highly optimized, niche search queries to surface the best possible "hidden" jobs across various platforms.

CANDIDATE FACTS:
${JSON.stringify(facts, null, 2)}

OUTPUT REQUIREMENTS:
Output ONLY valid JSON matching this exact structure:
{
  "linkedin_queries": ["role 1", "role 2", "role 3"],
  "upwork_queries": ["highly specific task or skill 1", "task 2"],
  "yc_tags": ["Industry or Tag 1", "Tag 2", "Tag 3"]
}

Rules:
1. 'linkedin_queries' should be standard job titles (e.g. "Head of Developer Relations", "Staff AI Platform Engineer"). Maximum 3.
2. 'upwork_queries' should focus on execution/tasks based on candidate's skills (e.g. "Stripe API integration", "React Native rebuild"). Maximum 3.
3. 'yc_tags' must be single words or short phrases that Y Combinator actually uses as tags natively (e.g. "DevTools", "SaaS", "AI", "Open Source", "API", "B2B", "Fintech"). Maximum 3.
4. Output nothing except the raw JSON object. No Markdown blocks, no explanations.`;

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
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
        response_format: { type: "json_object" }
      }),
    });

    if (!res.ok) throw new Error(`AiAS HTTP ${res.status}`);
    const data = await res.json();
    const content = data.choices[0].message.content.trim();
    
    // strip out backticks if returned despite prompt rules
    const jsonStr = content.replace(/^```json/i, "").replace(/```$/, "").trim();
    const parsed = JSON.parse(jsonStr);
    
    process.stdout.write(`done\n`);
    
    // Safety normalisation
    return {
      linkedin_queries: Array.isArray(parsed.linkedin_queries) ? parsed.linkedin_queries.slice(0, 3) : fallbackStrategy(facts).linkedin_queries,
      upwork_queries: Array.isArray(parsed.upwork_queries) ? parsed.upwork_queries.slice(0, 3) : fallbackStrategy(facts).upwork_queries,
      yc_tags: Array.isArray(parsed.yc_tags) ? parsed.yc_tags.slice(0, 3) : fallbackStrategy(facts).yc_tags,
    };
  } catch (e) {
    if (verbose) console.warn(`\n  [strategy] LLM generation failed: ${e.message}`);
    process.stdout.write(`failed\n`);
    return fallbackStrategy(facts);
  }
}

function fallbackStrategy(facts) {
  const t = facts?.titles?.slice(0, 3) || ["Software Engineer"];
  return {
    linkedin_queries: t,
    upwork_queries: facts?.skills?.slice(0, 3) || ["Web Development"],
    yc_tags: ["AI", "SaaS", "DevTools"]
  };
}
