import { openDb } from "./src/db.mjs";
const db = openDb();
const recentJobs = db.prepare("SELECT id, title, company, target_company, description, raw, status FROM jobs ORDER BY captured_at DESC LIMIT 5").all();
console.log(JSON.stringify(recentJobs, null, 2));
