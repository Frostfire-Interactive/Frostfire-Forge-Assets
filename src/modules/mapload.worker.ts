// A startup worker (modules/mapload.ts): makes a map ready to serve and bakes its world map image, or bakes a
// world's image, off the main thread. Each worker reads the tileset images it needs itself.
import fs from "fs";
import path from "path";
import { TilesetImages, bakeWorldMap, bakeChunkedWorldMap } from "./worldmap";
import { openWorld } from "./worldstore";
import { prepareMap, chunkedMapOf } from "./mapprepare";

declare var self: Worker;

export type MapLoadJob =
  | { id: number; kind: "map"; file: string; mapDir: string; tilesetDir: string }
  | { id: number; kind: "world"; worldId: string; mapDir: string; tilesetDir: string };

export type MapLoadResult =
  | { id: number; kind: "map"; ok: true; data: any; compressed: Uint8Array; checksum: string; size: number; png: Uint8Array | null; bakeError?: string }
  | { id: number; kind: "world"; ok: true; png: Uint8Array }
  | { id: number; ok: false; error: string };

const imagesByDir = new Map<string, TilesetImages>();
const imagesOf = (dir: string) => {
  let images = imagesByDir.get(dir);
  if (!images) imagesByDir.set(dir, images = new TilesetImages(dir));
  return images;
};

self.onmessage = (event: MessageEvent<MapLoadJob>) => {
  const job = event.data;
  let result: MapLoadResult;
  try {
    if (job.kind === "map") {
      const map = prepareMap(fs.readFileSync(path.join(job.mapDir, job.file), "utf-8"));
      if (!map) throw new Error(`Failed to parse ${job.file} as a map`);
      let png: Buffer | null = null, bakeError: string | undefined;
      try { png = bakeWorldMap(map.data, imagesOf(job.tilesetDir)); } catch (e: any) { bakeError = String(e?.message ?? e); }
      result = { id: job.id, kind: "map", ok: true, data: map.data, compressed: map.compressed, checksum: map.checksum, size: map.size, png, bakeError };
    } else {
      const world = openWorld(path.join(job.mapDir, `${job.worldId}.world`), job.worldId);
      const { png } = bakeChunkedWorldMap(chunkedMapOf(world), imagesOf(job.tilesetDir));
      result = { id: job.id, kind: "world", ok: true, png };
    }
  } catch (e: any) {
    result = { id: job.id, ok: false, error: String(e?.message ?? e) };
  }
  self.postMessage(result);
};
