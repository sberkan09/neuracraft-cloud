// Abuse reports (issue #18): the owner of a generated picture reports it from inside the app (Google
// Play's AI-generated content policy asks for this). Once per asset and reporter; anyone else gets
// 404, so the asset's existence is not given away. From then on the picture is hidden from its owner
// too (no download, not in listings or the job's outputs) until a review dismisses the report.
import type { FastifyInstance } from "fastify";
import type { Services } from "../app.js";
import { requireUser } from "../auth.js";
import { tx } from "../db.js";
import { fail } from "../errors.js";
import { jobSnapshot, REPORT_REASONS, type ReportReason } from "../moderation.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function reportRoutes(app: FastifyInstance, s: Services) {
  // assets:read is enough: whoever may see a picture may report it.
  app.post<{ Params: { id: string }; Body: { reason?: unknown; note?: unknown } }>("/v1/assets/:id/report", async (req, reply) => {
    const u = await requireUser(s.db, req, "assets:read");
    if (!UUID.test(req.params.id)) fail(404, "not_found");
    const a = await s.db.query<{ id: string; owner_id: string }>(
      "SELECT id, owner_id FROM assets WHERE id = $1 AND owner_id = $2 AND end_user IS NOT DISTINCT FROM $3 AND kind = 'output' AND status IN ('ready', 'held')",
      [req.params.id, u.id, u.endUser],
    );
    const asset = a.rows[0] ?? fail(404, "not_found");
    const body = req.body ?? {};
    if (typeof body.reason !== "string" || !REPORT_REASONS.includes(body.reason as ReportReason))
      fail(400, "report.invalid", { field: "reason", reason: `one of ${REPORT_REASONS.join(", ")}` });
    if (body.note !== undefined && body.note !== null && (typeof body.note !== "string" || body.note.length > 500))
      fail(400, "report.invalid", { field: "note", reason: "text of at most 500 characters" });
    const note = typeof body.note === "string" && body.note.trim() ? body.note.trim() : null;

    const row = await tx(s.db, async (c) => {
      const old = await c.query<{ id: string; reason: string; created_at: Date }>(
        "SELECT id, reason, created_at FROM reports WHERE asset_id = $1 AND reporter_id = $2",
        [asset.id, u.id],
      );
      if (old.rows[0]) return old.rows[0];
      const job = await c.query<{ job_id: string }>("SELECT job_id FROM job_outputs WHERE asset_id = $1", [asset.id]);
      const jobId = job.rows[0]?.job_id ?? null;
      const ins = await c.query<{ id: string; reason: string; created_at: Date }>(
        `INSERT INTO reports (asset_id, job_id, owner_id, reporter_id, source, reason, note, snapshot)
         VALUES ($1, $2, $3, $4, 'user', $5, $6, $7)
         ON CONFLICT (asset_id, reporter_id) WHERE reporter_id IS NOT NULL DO NOTHING
         RETURNING id, reason, created_at`,
        [asset.id, jobId, asset.owner_id, u.id, body.reason, note, JSON.stringify(await jobSnapshot(c, jobId))],
      );
      await c.query("UPDATE assets SET reported_at = coalesce(reported_at, now()) WHERE id = $1", [asset.id]);
      // Two identical requests at once: the second insert does nothing; return the first one's row.
      return (
        ins.rows[0] ??
        (await c.query<{ id: string; reason: string; created_at: Date }>("SELECT id, reason, created_at FROM reports WHERE asset_id = $1 AND reporter_id = $2", [asset.id, u.id])).rows[0]!
      );
    });
    return reply.status(202).send({ report: { id: row.id, assetId: asset.id, reason: row.reason, createdAt: row.created_at.toISOString() } });
  });
}
