import PDFDocument from "pdfkit";
import { createWriteStream } from "node:fs";
import { resolve } from "node:path";

const BRAND = { primary: "#1a1a2e", accent: "#4f46e5", muted: "#6b7280", light: "#f3f4f6", green: "#16a34a", red: "#dc2626" };

function fmt(score) { return score != null ? `${(score * 100).toFixed(0)}%` : "—"; }
function truncate(str, n) { return str && str.length > n ? str.slice(0, n) + "…" : (str ?? ""); }

export async function generateReport(db, outPath) {
  const resolvedOut = resolve(process.cwd(), outPath);

  // Pull all jobs that are new or drafted, joined with their person + latest draft
  const jobs = db.prepare(`
    SELECT j.*,
           p.name        AS person_name,
           p.email       AS person_email,
           p.linkedin_url AS person_linkedin,
           p.headline    AS person_headline,
           d.subject     AS draft_subject,
           d.body        AS draft_body,
           d.id          AS draft_id
    FROM jobs j
    LEFT JOIN people p ON p.job_id = j.id
    LEFT JOIN drafts d ON d.job_id = j.id
    WHERE j.status IN ('new','drafted')
    ORDER BY j.fit_score DESC, j.captured_at DESC
  `).all();

  return new Promise((resolve_p, reject_p) => {
    if (!jobs.length) {
      console.log("  No jobs in queue to report. Run scan + draft first.");
      resolve_p(null);
      return;
    }

    const doc = new PDFDocument({ margin: 48, size: "A4", info: { Title: "Job — Interchained Job Scout Report" } });
    const stream = createWriteStream(resolvedOut);
    doc.pipe(stream);

    // ── Cover ──────────────────────────────────────────────────────────────
    doc.rect(0, 0, doc.page.width, 120).fill(BRAND.primary);
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(26)
       .text("JOB", 48, 36, { continued: true })
       .font("Helvetica").fontSize(14).fillColor("#a5b4fc")
       .text("  Interchained Job Scout", { baseline: "alphabetic" });
    doc.fillColor("#94a3b8").font("Helvetica").fontSize(10)
       .text(`Generated ${new Date().toLocaleDateString("en-US", { weekday:"long", year:"numeric", month:"long", day:"numeric" })}  ·  ${jobs.length} lead${jobs.length !== 1 ? "s" : ""} queued`, 48, 80);

    doc.moveDown(4);

    // ── One card per job ───────────────────────────────────────────────────
    for (const [i, job] of jobs.entries()) {
      if (i > 0) doc.addPage();

      const topY = doc.y;

      // Fit score badge
      const scoreColor = (job.fit_score ?? 0) >= 0.7 ? BRAND.green : (job.fit_score ?? 0) >= 0.5 ? BRAND.accent : BRAND.muted;
      doc.roundedRect(doc.page.width - 100, topY, 52, 22, 4).fill(scoreColor);
      doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(10)
         .text(`${fmt(job.fit_score)} fit`, doc.page.width - 98, topY + 6, { width: 48, align: "center" });

      // Title + company
      doc.fillColor(BRAND.primary).font("Helvetica-Bold").fontSize(16)
         .text(truncate(job.title, 80), 48, topY, { width: doc.page.width - 160 });
      doc.fillColor(BRAND.accent).font("Helvetica").fontSize(11)
         .text(job.company ?? job.target_company, { continued: true })
         .fillColor(BRAND.muted).text(`  ·  ${job.location ?? "?"}  ·  ${job.remote ? "Remote ✓" : "On-site"}  ·  ${job.source}`);

      if (job.salary_range) {
        doc.fillColor(BRAND.green).font("Helvetica-Bold").fontSize(10).text(`💰 ${job.salary_range}`);
      }
      if (job.employment_type || job.seniority) {
        doc.fillColor(BRAND.muted).font("Helvetica").fontSize(9)
           .text([job.employment_type, job.seniority].filter(Boolean).join("  ·  "));
      }

      doc.moveDown(0.4);
      doc.moveTo(48, doc.y).lineTo(doc.page.width - 48, doc.y).strokeColor(BRAND.light).lineWidth(1).stroke();
      doc.moveDown(0.5);

      // ── Role details ──
      section(doc, "Role");
      doc.fillColor("#374151").font("Helvetica").fontSize(10)
         .text(truncate(job.description ?? "No description captured.", 600), { width: doc.page.width - 96 });
      doc.moveDown(0.3);
      doc.fillColor(BRAND.accent).font("Helvetica").fontSize(9).text(job.url, { link: job.url, underline: true });
      doc.moveDown(0.8);

      // ── Hiring manager ──
      section(doc, "Hiring Contact");
      if (job.person_name) {
        kv(doc, "Name", job.person_name);
        if (job.person_headline) kv(doc, "Role", job.person_headline);
        if (job.person_email)   kv(doc, "Email", job.person_email, { link: `mailto:${job.person_email}` });
        if (job.person_linkedin) kv(doc, "LinkedIn", job.person_linkedin, { link: job.person_linkedin });
      } else {
        doc.fillColor(BRAND.muted).font("Helvetica-Oblique").fontSize(10)
           .text("No contact found yet — run scan to pull hiring manager via Netrows.");
      }
      doc.moveDown(0.8);

      // ── Draft email ──
      section(doc, "Draft Email");
      if (job.draft_subject) {
        doc.fillColor(BRAND.primary).font("Helvetica-Bold").fontSize(10)
           .text(`Subject: ${job.draft_subject}`);
        doc.moveDown(0.3);
        doc.roundedRect(48, doc.y, doc.page.width - 96, 1, 0).fill(BRAND.light);
        doc.moveDown(0.5);
        doc.fillColor("#1f2937").font("Helvetica").fontSize(10)
           .text(job.draft_body ?? "", { width: doc.page.width - 96 });
      } else {
        doc.fillColor(BRAND.muted).font("Helvetica-Oblique").fontSize(10)
           .text("No draft yet — run `node job.mjs draft` to generate.");
      }
      doc.moveDown(0.8);

      // ── HITL action strip ──
      doc.rect(48, doc.y, doc.page.width - 96, 28).fill(BRAND.light);
      const stripY = doc.y + 8;
      doc.fillColor(BRAND.muted).font("Helvetica").fontSize(9)
         .text("ACTIONS:", 60, stripY, { continued: true })
         .fillColor(BRAND.accent).font("Helvetica-Bold")
         .text("  [ ] Send email", { continued: true })
         .fillColor(BRAND.muted).font("Helvetica")
         .text("    [ ] Edit draft", { continued: true })
         .text("    [ ] Archive");
      doc.moveDown(2.5);

      // Job ID footer (small, for CLI reference)
      doc.fillColor(BRAND.muted).font("Helvetica").fontSize(7)
         .text(`job_id: ${job.id}  ·  captured: ${job.captured_at?.slice(0, 10) ?? "?"}  ·  fit_reason: ${job.fit_reason ?? "—"}`,
           48, doc.page.height - 36, { width: doc.page.width - 96 });
    }

    doc.end();
    stream.on("finish", () => resolve_p(resolvedOut));
    stream.on("error", reject_p);
  });
}

function section(doc, label) {
  doc.fillColor(BRAND.primary).font("Helvetica-Bold").fontSize(11).text(label.toUpperCase());
  doc.moveDown(0.3);
}

function kv(doc, label, value, opts = {}) {
  doc.fillColor(BRAND.muted).font("Helvetica-Bold").fontSize(9).text(`${label}:  `, { continued: true });
  doc.fillColor(opts.link ? BRAND.accent : "#1f2937").font("Helvetica").fontSize(9)
     .text(value, { link: opts.link, underline: !!opts.link });
}
