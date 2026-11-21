import zlib from "zlib";
import crypto from "crypto";
import { readChunkTiles, type World } from "./worldstore";
import type { ChunkedMap } from "./worldmap";

export function normalizeInfiniteMap(mapData: any): void {
  if (!mapData || mapData.infinite !== true || !Array.isArray(mapData.layers)) return;

  let mapWidth = 0;
  let mapHeight = 0;
  for (const layer of mapData.layers) {
    if (layer.type !== "tilelayer" || !Array.isArray(layer.chunks)) continue;
    for (const chunk of layer.chunks) {
      const data = chunk?.data;
      if (!Array.isArray(data)) continue;
      const cw = chunk.width || 0;
      const ch = chunk.height || 0;
      const cx = chunk.x || 0;
      const cy = chunk.y || 0;
      for (let row = 0; row < ch; row++) {
        for (let col = 0; col < cw; col++) {
          if (!data[row * cw + col]) continue;
          const gx = cx + col + 1;
          const gy = cy + row + 1;
          if (gx > mapWidth) mapWidth = gx;
          if (gy > mapHeight) mapHeight = gy;
        }
      }
    }
  }
  if (!mapWidth || !mapHeight) return;

  for (const layer of mapData.layers) {
    if (layer.type !== "tilelayer") continue;

    const flat = new Array(mapWidth * mapHeight).fill(0);

    if (Array.isArray(layer.chunks)) {
      for (const chunk of layer.chunks) {
        const data = chunk?.data;
        if (!Array.isArray(data)) continue;
        const cw = chunk.width;
        const ch = chunk.height;
        const cx = chunk.x;
        const cy = chunk.y;
        for (let row = 0; row < ch; row++) {
          const gy = cy + row;
          if (gy < 0 || gy >= mapHeight) continue;
          for (let col = 0; col < cw; col++) {
            const gx = cx + col;
            if (gx < 0 || gx >= mapWidth) continue;
            const val = data[row * cw + col];
            if (val) flat[gy * mapWidth + gx] = val;
          }
        }
      }
    }

    layer.data = flat;
    layer.width = mapWidth;
    layer.height = mapHeight;
    layer.startx = 0;
    layer.starty = 0;
    delete layer.chunks;
  }

  mapData.width = mapWidth;
  mapData.height = mapHeight;
}

/** A map file's text made ready to serve: parsed and flattened, then its gzip and its checksum (over the flattened JSON). */
export function prepareMap(text: string): { data: any; compressed: Buffer; checksum: string; size: number } | null {
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!parsed) return null;
  normalizeInfiniteMap(parsed);
  // Serialized and hashed after normalizeInfiniteMap so sync comparisons match
  const jsonString = JSON.stringify(parsed);
  return {
    data: parsed,
    compressed: zlib.gzipSync(jsonString),
    checksum: crypto.createHash("sha256").update(jsonString).digest("hex"),
    size: jsonString.length,
  };
}

export function chunkedMapOf(world: World): ChunkedMap {
  return {
    width: world.width,
    height: world.height,
    chunkSize: world.chunkSize,
    tilesets: world.manifest.tilesets ?? [],
    backgroundcolor: world.manifest.backgroundcolor,
    layers: world.layers,
    readChunk: (chunkX, chunkY) => readChunkTiles(world, chunkX, chunkY),
  };
}
