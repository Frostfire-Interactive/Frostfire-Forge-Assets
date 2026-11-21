import crypto from "crypto";

/** A short content hash of an asset's bytes: its ETag, and its part of the asset version. */
export function contentVersion(data: Buffer | Uint8Array | string): string {
  return crypto.createHash("sha256").update(data).digest("hex").slice(0, 16);
}

export function assetsVersion(lists: { name: string; version: string }[][]): string {
  const parts = lists.map((list, i) =>
    list.map((a) => `${i}:${a.name}:${a.version}`).sort().join("\n"));
  return contentVersion(parts.join("\n\n"));
}

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
