import { open } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import type { Services } from "../app.js";
import { requireUser } from "../auth.js";
import { fail } from "../errors.js";
import { blobKey, LocalStorage } from "../storage.js";

const MAX_INPUT = 64 << 20;
const MAX_MODEL = 8 * 1024 ** 3;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// The engine reads PNG and PPM / PGM pictures, safetensors and ONNX models.
const MODEL_EXT = /\.(safetensors|onnx|bvh)$/i;  // (.bvh: motion capture, the engine's "mocap" models)

interface AssetRow {
  id: string;
  kind: string;
  model_kind: string | null;
  name: string;
  content_type: string;
  sha256: string | null;
  bytes: string;
  license: string | null;
  status: string;
  created_at: Date;
  owner_id: string | null;
  slug?: string | null;
}
export const assetJson = (a: AssetRow) => ({
  id: a.id,
  kind: a.kind,
  modelKind: a.model_kind,
  name: a.name,
  contentType: a.content_type,
  bytes: Number(a.bytes),
  license: a.license,
  status: a.status,
  createdAt: a.created_at.toISOString(),
  catalog: a.owner_id === null,
  ...(a.slug ? { slug: a.slug } : {}),
});

async function magic(s: Services, key: string): Promise<Buffer> {
  if (!(s.storage instanceof LocalStorage)) return Buffer.alloc(0);
  const f = await open(s.storage.path(key), "r");
  try {
    const b = Buffer.alloc(8);
    await f.read(b, 0, 8, 0);
    return b;
  } finally {
    await f.close();
  }
}

export async function assetRoutes(app: FastifyInstance, s: Services) {
  // Starts an upload: the asset (status uploading) and a signed URL to PUT the bytes to.
  app.post<{ Body: { name?: string; kind?: string; bytes?: number; contentType?: string; modelKind?: string; license?: string } }>(
    "/v1/assets",
    async (req, reply) => {
      const u = await requireUser(s.db, req, "assets:write");
      const b = req.body ?? {};
      const kind = b.kind === "model" ? "model" : b.kind === "input" ? "input" : fail(400, "request.invalid", { field: "kind" });
      const bytes = Number(b.bytes);
      const name = String(b.name ?? "").slice(0, 200);
      if (!name || !Number.isInteger(bytes) || bytes <= 0) fail(400, "request.invalid");
      if (bytes > (kind === "model" ? MAX_MODEL : MAX_INPUT)) fail(413, "request.too_large", { max: kind === "model" ? MAX_MODEL : MAX_INPUT });
      if (kind === "model") {
        if (!MODEL_EXT.test(name)) fail(400, "model.unsupported");
        if (!b.license) fail(400, "request.invalid", { field: "license" });
      }
      const r = await s.db.query<AssetRow>(
        `INSERT INTO assets (owner_id, kind, model_kind, name, content_type, bytes, license, status, end_user)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'uploading', $8) RETURNING *`,
        [u.id, kind, kind === "model" ? (/\.bvh$/i.test(name) ? "mocap" : (b.modelKind ?? null)) : null, name, String(b.contentType ?? "application/octet-stream").slice(0, 100), bytes, b.license ?? null, u.endUser],
      );
      const asset = r.rows[0]!;
      return reply.status(201).send({ asset: assetJson(asset), uploadUrl: s.storage.uploadUrl(`uploads/${asset.id}`, bytes, 3600) });
    },
  );

  // The bytes are in: hash them, store them content-addressed, mark the asset ready.
  app.post<{ Params: { id: string } }>("/v1/assets/:id/complete", async (req) => {
    const u = await requireUser(s.db, req, "assets:write");
    if (!UUID.test(req.params.id)) fail(404, "not_found");
    const r = await s.db.query<AssetRow>("SELECT * FROM assets WHERE id = $1 AND owner_id = $2 AND end_user IS NOT DISTINCT FROM $3 AND status = 'uploading'", [req.params.id, u.id, u.endUser]);
    const a = r.rows[0] ?? fail(404, "not_found");
    const key = `uploads/${a.id}`;
    const head = await magic(s, key).catch(() => fail(400, "request.invalid", { reason: "nothing uploaded" }));
    // Inputs are pictures (PNG, PPM) or 3D models (.glb); motion captures (.bvh) are text. The name's
    // extension is what the engine goes by, so it has to match the bytes.
    if (head.length) {
      const glbName = /\.glb$/i.test(a.name), bvhName = /\.bvh$/i.test(a.name);
      const png = head[0] === 0x89 && head.toString("latin1", 1, 4) === "PNG";
      const ppm = head[0] === 0x50 && (head[1] === 0x35 || head[1] === 0x36);
      const glb = head.toString("latin1", 0, 4) === "glTF";
      const bvh = head.toString("latin1", 0, 8) === "HIERARCH";
      const why =
        a.kind === "input" && glbName && !glb ? "not a glTF binary" :
        a.kind === "input" && !glbName && !png && !ppm ? "not a PNG or PPM picture" :
        a.kind === "model" && bvhName && !bvh ? "not a BVH motion capture" : "";
      if (why) {
        await s.storage.remove(key);
        fail(400, "request.invalid", { reason: why });
      }
    }
    const { sha256, bytes } = await s.storage.finalize(key);
    await s.db.query("INSERT INTO blobs (sha256, bytes) VALUES ($1, $2) ON CONFLICT DO NOTHING", [sha256, bytes]);
    const done = await s.db.query<AssetRow>("UPDATE assets SET sha256 = $2, bytes = $3, status = 'ready' WHERE id = $1 RETURNING *", [a.id, sha256, bytes]);
    return { asset: assetJson(done.rows[0]!) };
  });

  app.get<{ Querystring: { kind?: string } }>("/v1/assets", async (req) => {
    const u = await requireUser(s.db, req, "assets:read");
    const r = await s.db.query<AssetRow>(
      // A reported picture is hidden from its owner too until the report is reviewed (moderation.ts).
      "SELECT * FROM assets WHERE owner_id = $1 AND end_user IS NOT DISTINCT FROM $3 AND status IN ('ready', 'held') AND reported_at IS NULL AND ($2::text IS NULL OR kind = $2) ORDER BY created_at DESC LIMIT 200",
      [u.id, req.query.kind ?? null, u.endUser],
    );
    return { assets: r.rows.map(assetJson) };
  });

  // Models the service offers to everyone (each with its license).
  app.get("/v1/catalog", async () => {
    const r = await s.db.query<AssetRow>("SELECT * FROM assets WHERE owner_id IS NULL AND kind = 'model' AND status = 'ready' ORDER BY name");
    return { models: r.rows.map(assetJson) };
  });

  // A short-lived link to the bytes of the user's own picture or result (models are not handed out).
  app.get<{ Params: { id: string } }>("/v1/assets/:id/content", async (req, reply) => {
    const u = await requireUser(s.db, req, "assets:read");
    if (!UUID.test(req.params.id)) fail(404, "not_found");
    const r = await s.db.query<AssetRow>("SELECT * FROM assets WHERE id = $1 AND owner_id = $2 AND end_user IS NOT DISTINCT FROM $3 AND status = 'ready' AND kind <> 'model' AND reported_at IS NULL", [req.params.id, u.id, u.endUser]);
    const a = r.rows[0] ?? fail(404, "not_found");
    return reply.redirect(s.storage.downloadUrl(blobKey(a.sha256!), 600, a.name), 302);
  });

  app.delete<{ Params: { id: string } }>("/v1/assets/:id", async (req) => {
    const u = await requireUser(s.db, req, "assets:write");
    if (!UUID.test(req.params.id)) fail(404, "not_found");
    const r = await s.db.query("UPDATE assets SET status = 'removed' WHERE id = $1 AND owner_id = $2 AND end_user IS NOT DISTINCT FROM $3 AND status <> 'removed'", [req.params.id, u.id, u.endUser]);
    if (!r.rowCount) fail(404, "not_found");
    return { ok: true };
  });
}
