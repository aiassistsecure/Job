import { openDb } from "./src/db.mjs";
const db = openDb();
console.log(db.prepare("SELECT * FROM jobs WHERE id='netrows_job:85602'").get());
