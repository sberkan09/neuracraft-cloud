// Object storage behind signed URLs. "local" keeps files in a folder and signs URLs served by this
// API (development, tests, a single machine); "s3" (R2 / MinIO) is added with the deployment work.
// Keys: uploads/<id> while a file arrives, blobs/<sha256> once it is known (content-addressed).
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";

export interface Storage {
  // A URL the holder may PUT up to maxBytes to, or GET from, until `seconds` pass.
  uploadUrl(key: string, maxBytes: number, seconds: number): string;
  downloadUrl(key: string, seconds: number, filename?: string): string;
  // Moves an uploaded object to blobs/<sha256>; returns its hash and size.
  finalize(uploadKey: string): Promise<{ sha256: string; bytes: number }>;
  remove(key: string): Promise<void>;
}

export const blobKey = (sha256: string) => `blobs/${sha256}`;

interface Grant {
  k: string; // key
  m: "PUT" | "GET";
  e: number; // expiry, unix seconds
  n?: number; // max bytes (PUT)
  f?: string; // download file name
}

export class LocalStorage implements Storage {
  constructor(
    readonly dir: string,
    private readonly key: Buffer,
    private readonly publicUrl: string,
  ) {}

  private sign(g: Grant): string {
    const body = Buffer.from(JSON.stringify(g)).toString("base64url");
    const mac = createHmac("sha256", this.key).update(body).digest("base64url");
    return `${body}.${mac}`;
  }

  // The grant in a token, if its signature holds and it has not expired.
  verify(token: string, method: "PUT" | "GET"): Grant | null {
    const [body, mac] = token.split(".");
    if (!body || !mac) return null;
    const want = createHmac("sha256", this.key).update(body).digest();
    const got = Buffer.from(mac, "base64url");
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    let g: Grant;
    try {
      g = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Grant;
    } catch {
      return null;
    }
    if (g.m !== method || g.e < Date.now() / 1000) return null;
    return g;
  }

  uploadUrl(key: string, maxBytes: number, seconds: number): string {
    return `${this.publicUrl}/v1/storage/${this.sign({ k: key, m: "PUT", e: Math.floor(Date.now() / 1000) + seconds, n: maxBytes })}`;
  }
  downloadUrl(key: string, seconds: number, filename?: string): string {
    return `${this.publicUrl}/v1/storage/${this.sign({ k: key, m: "GET", e: Math.floor(Date.now() / 1000) + seconds, f: filename })}`;
  }

  path(key: string): string {
    const p = path.resolve(this.dir, key);
    if (!p.startsWith(path.resolve(this.dir) + path.sep)) throw new Error("storage key outside the folder");
    return p;
  }

  // Writes a stream (a signed PUT) to the key, refusing more than maxBytes.
  async write(key: string, body: Readable, maxBytes: number): Promise<number> {
    const p = this.path(key);
    await mkdir(path.dirname(p), { recursive: true });
    let n = 0;
    const tmp = `${p}.part`;
    try {
      await pipeline(
        body,
        async function* (src: AsyncIterable<Buffer>) {
          for await (const chunk of src) {
            n += chunk.length;
            if (n > maxBytes) throw new Error("too large");
            yield chunk;
          }
        },
        createWriteStream(tmp),
      );
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
    await rename(tmp, p);
    return n;
  }

  read(key: string): Readable {
    return createReadStream(this.path(key));
  }

  async finalize(uploadKey: string): Promise<{ sha256: string; bytes: number }> {
    const p = this.path(uploadKey);
    const h = createHash("sha256");
    await pipeline(createReadStream(p), h);
    const sha256 = h.digest("hex");
    const bytes = (await stat(p)).size;
    const dest = this.path(blobKey(sha256));
    await mkdir(path.dirname(dest), { recursive: true });
    await rename(p, dest);
    return { sha256, bytes };
  }

  async remove(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
}
