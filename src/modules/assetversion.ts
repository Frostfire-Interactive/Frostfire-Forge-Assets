import crypto from "crypto";

/** A short content hash of an asset's bytes: its ETag, and its part of the asset version. */
export function contentVersion(data: Buffer | Uint8Array | string): string {
  return crypto.createHash("sha256").update(data).digest("hex").slice(0, 16);
}

/**
 * One hash over every asset in the lists (sprites, icons, sprite sheets): it changes when an asset changes, is added,
 * removed or renamed. The gateway's service worker reads it from /asset-version and drops the copies it kept from this
 * asset server when it changes.
 */
export function assetsVersion(lists: { name: string; version: string }[][]): string {
  const parts = lists.map((list, i) =>
    list.map((a) => `${i}:${a.name}:${a.version}`).sort().join("\n"));
  return contentVersion(parts.join("\n\n"));
}

/**
 * An asset response the browser revalidates on every use (no-cache + ETag): a 304 when the request already holds this
 * version, the full body otherwise. The body is built only when it is sent.
 */
export function revalidated(req: Request, version: string, headers: Record<string, string>, body: () => Uint8Array | string): Response {
  const etag = `"${version}"`;
  const expose = headers["Access-Control-Expose-Headers"];
  const all: Record<string, string> = {
    ...headers,
    "Cache-Control": "no-cache",
    "ETag": etag,
    "Access-Control-Expose-Headers": expose ? `${expose}, ETag` : "ETag",
  };
  if (req.headers.get("If-None-Match") === etag) {
    delete all["Content-Length"];
    return new Response(null, { status: 304, headers: all });
  }
  const data = body();
  all["Content-Length"] = String(typeof data === "string" ? Buffer.byteLength(data) : data.length);
  return new Response(data, { status: 200, headers: all });
}
