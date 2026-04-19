import { openDb } from "./src/db.mjs";
const db = openDb();
const jobs = db.prepare("SELECT id, title, company, description, raw FROM jobs ORDER BY captured_at DESC LIMIT 3").all();
console.log(JSON.stringify(jobs, null, 2));
