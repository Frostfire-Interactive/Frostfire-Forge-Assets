const now = performance.now();
import log from "./modules/logger";
import path from "path";
import fs from "fs";
import zlib from "zlib";
import { startHttpsServers, getInternalServerOptions } from "./modules/https_servers";

// Load asset loader
import { initializeAssets, applyChunksWithRebase, getAssetsPath, normalizeInfiniteMap, registerNewMap } from "./modules/assetloader";
import assetCache from "./services/assetCache";
import { revalidated } from "./modules/assetversion";
import mapChanges, { mapEventStream } from "./modules/mapchanges";
import { addWorld, getWorld, listWorlds, readWorldFile, readChunkTiles, buildWorldChunk, saveWorldChunks, saveWorldProperties, WorldSaveError, WORLD_SYNC_FILES, type WorldSyncFile } from "./modules/worldstore";
import { TilesetImages, bakeChunkedWorldMap } from "./modules/worldmap";
import { checkTileSoundChanges, getTileSounds, saveTileSounds, type TileSoundChange } from "./modules/tilesounds";
import { blankTiledMap, checkCreateMap, pngSize, tilesetDefinitions, writeBlankWorld, type CreateMapRequest } from "./modules/mapcreate";


/** The tileset pictures the asset server has (its tilesets cache, the .json definitions left out). */
async function tilesetImageNames(): Promise<string[]> {
  const cached = (await assetCache.get("tilesets") as any[] | null) ?? [];
  return cached.map((t: any) => String(t.name)).filter((n: string) => /\.(png|jpe?g|webp)$/i.test(n)).sort((a: string, b: string) => a.localeCompare(b));
}

const authKey = process.env.ASSET_SERVER_AUTH_KEY || process.env.GATEWAY_AUTH_KEY || "change-this-secret-key";

const CORS_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

const CORS_AUDIO_ALLOW_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Range",
  "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
};

// Extension -> MIME type for audio files served by /audio.
const AUDIO_MIME_TYPES: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".m4a": "audio/mp4",
  ".webm": "audio/webm",
  ".flac": "audio/flac",
  ".opus": "audio/opus",
};
const ALLOWED_AUDIO_EXTENSIONS = Object.keys(AUDIO_MIME_TYPES);

function getAudioMimeType(fileName: string): string {
  return AUDIO_MIME_TYPES[path.extname(fileName).toLowerCase()] || "application/octet-stream";
}

// A world (modules/worldstore.ts) is saved chunk by chunk (/save-map-chunks, /save-map-properties), never replaced
// whole.
const WORLD_READ_ONLY = "A world cannot be replaced whole";

// Full-detail pieces of a world's map image (/worldmap?name&rx&ry), each WORLD_MAP_REGION tiles a side and one
// pixel per tile, baked on request and kept while the world stays as it is. The client asks by the same size
// (worldmap.ts DETAIL_TILES).
const WORLD_MAP_REGION = 1024;
const WORLD_MAP_PIECES_MAX = 64;
const worldMapPieces = new Map<string, Buffer>();
let worldMapImages: TilesetImages | null = null;

function acceptsGzip(req: Request): boolean {
  return (req.headers.get("accept-encoding") || "").includes("gzip");
}

// Cache of precomputed gzip-compressed map chunk payloads. /map-chunk is the
// highest-volume browser endpoint (every client fetches dozens of chunks per
// map load), and each miss costs layer slicing + JSON.stringify + gzipSync.
// Keyed by map name + checksum so map edits invalidate naturally on write.
const chunkCache = new Map<string, Uint8Array>();
const CHUNK_CACHE_MAX_ENTRIES = 10000;

function getChunkCacheKey(mapFile: string, checksum: string, chunkX: number, chunkY: number, chunkSize: number): string {
  return `${mapFile}:${checksum}:${chunkX}:${chunkY}:${chunkSize}`;
}

function rememberChunk(key: string, data: Uint8Array) {
  chunkCache.set(key, data);
  if (chunkCache.size > CHUNK_CACHE_MAX_ENTRIES) {
    const oldestKey = chunkCache.keys().next().value;
    if (oldestKey !== undefined) chunkCache.delete(oldestKey);
  }
}

function clearChunkCacheForMap(mapName: string) {
  const mapFile = mapName.endsWith(".json") ? mapName : `${mapName}.json`;
  const prefix = `${mapFile}:`;
  for (const key of chunkCache.keys()) {
    if (key.startsWith(prefix)) chunkCache.delete(key);
  }
}

// Serialize one map chunk (tile layers sliced from the flat layer.data arrays)
// to a JSON string. Returns null for invalid chunk parameters.
function buildMapChunk(mapData: any, chunkX: number, chunkY: number, chunkSize: number): string | null {
  if (!mapData || !Array.isArray(mapData.layers) || !Number.isInteger(chunkX) || !Number.isInteger(chunkY) || !Number.isInteger(chunkSize) || chunkSize <= 0) {
    return null;
  }

  const startX = chunkX * chunkSize;
  const startY = chunkY * chunkSize;

  const chunk = {
    chunkX,
    chunkY,
    width: chunkSize,
    height: chunkSize,
    layers: [] as any[]
  };

  mapData.layers.forEach((layer: any, index: number) => {
    if (layer.type === "tilelayer" && layer.data) {
      const chunkLayerData: number[] = [];

      for (let y = 0; y < chunkSize; y++) {
        for (let x = 0; x < chunkSize; x++) {
          const mapX = startX + x;
          const mapY = startY + y;
          const mapIndex = mapY * mapData.width + mapX;

          if (mapX >= 0 && mapX < mapData.width && mapY >= 0 && mapY < mapData.height && mapIndex < layer.data.length) {
            chunkLayerData.push(layer.data[mapIndex]);
          } else {
            chunkLayerData.push(0);
          }
        }
      }

      let zIndex = layer.zIndex;
      if (zIndex === undefined) {
        zIndex = index;
      }

      chunk.layers.push({
        name: layer.name,
        zIndex: zIndex,
        data: chunkLayerData,
        width: chunkSize,
        height: chunkSize
      });
    }
  });

  return JSON.stringify(chunk);
}

// Cache keys are flat names (no separators), so anything containing a path
// separator, parent traversal, or null byte is never valid.
function isUnsafeAssetName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed === "" || trimmed.includes("\0") || trimmed.includes("..") || trimmed.includes("/") || trimmed.includes("\\");
}

// Decode a sprite/icon cache entry (stored at load time as gzip of base64 PNG bytes).
function decodeCachedImage(data: string): Buffer {
  const base64 = zlib.gunzipSync(Buffer.from(data, "base64")).toString("utf-8");
  return Buffer.from(base64, "base64");
}

// Decode an audio cache entry (stored at load time as gzip of raw audio bytes).
function decodeCachedAudio(data: string): Buffer {
  return zlib.gunzipSync(Buffer.from(data, "base64"));
}

// Fallback icon served when a requested icon/sprite image does not exist.
// Served from the startup cache (the "missing_icon" entry of the icons cache).
// The X-Asset-Fallback header lets clients detect the fallback and opt out
// of rendering it (e.g. spell projectiles).
async function serveMissingIcon(): Promise<Response> {
  try {
    const icons = await assetCache.get("icons") as any[] | null;
    const entry = icons?.find((i: any) => i.name === "missing_icon");
    if (entry?.data) {
      const missingIconData = decodeCachedImage(entry.data);
      return new Response(missingIconData, {
        status: 200,
        headers: {
          "Content-Type": "image/png",
          // Short TTL rather than no-cache: the placeholder is one small static
          // image requested once per missing asset, so no-cache meant every
          // missing sprite re-fetched it on every render. A few minutes still
          // lets a genuinely-added asset show up quickly.
          "Cache-Control": "public, max-age=300",
          "X-Asset-Fallback": "missing_icon",
          "Access-Control-Expose-Headers": "X-Asset-Fallback",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Content-Length": missingIconData.length.toString()
        }
      });
    }
  } catch (error: any) {
    log.error(`Error serving missing icon fallback: ${error.message}`);
  }
  return new Response(JSON.stringify({ error: "Icon not found" }), {
    status: 404,
    headers: CORS_HEADERS
  });
}

function parseRangeHeader(range: string | null, size: number): { start: number; end: number } | null {
  if (!range) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!match) return null;
  const startStr = match[1] ?? "";
  const endStr = match[2] ?? "";
  let start = startStr === "" ? NaN : parseInt(startStr, 10);
  let end = endStr === "" ? NaN : parseInt(endStr, 10);
  if (Number.isNaN(start) && Number.isNaN(end)) return null;
  if (Number.isNaN(start)) {
    // Suffix range: last N bytes
    start = Math.max(0, size - end);
    end = size - 1;
  } else if (Number.isNaN(end)) {
    end = size - 1;
  }
  if (start < 0 || end < start || start >= size) return null;
  end = Math.min(end, size - 1);
  return { start, end };
}

// Serve a raw audio buffer with correct MIME type, ETag/conditional GET,
// and Range (206 Partial Content) support so <audio> elements can seek.
// Revalidated on every use (no-cache + ETag = the file's content hash): a sound
// replaced under the same name is picked up after a restart, an unchanged one
// costs a 304.
function serveAudioBuffer(req: Request, fileName: string, data: Buffer, version: string): Response {
  const mime = getAudioMimeType(fileName);
  const size = data.length;
  const etag = `"${version}"`;
  const baseHeaders: Record<string, string> = {
    "Content-Type": mime,
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-cache",
    "Content-Length": size.toString(),
    "ETag": etag,
    ...CORS_AUDIO_ALLOW_HEADERS,
    "Access-Control-Expose-Headers": `${CORS_AUDIO_ALLOW_HEADERS["Access-Control-Expose-Headers"]}, ETag`,
  };

  if (req.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: baseHeaders });
  }

  if (req.method === "HEAD") {
    return new Response(null, { status: 200, headers: baseHeaders });
  }

  const range = parseRangeHeader(req.headers.get("range"), size);
  if (range) {
    const chunk = data.subarray(range.start, range.end + 1);
    return new Response(chunk, {
      status: 206,
      headers: {
        ...baseHeaders,
        "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
        "Content-Length": chunk.length.toString(),
      },
    });
  }

  return new Response(data, { status: 200, headers: baseHeaders });
}

const routes = {
  "/status": {
    GET: () => new Response(JSON.stringify({ status: "OK" }), { status: 200, headers: CORS_HEADERS })
  },
  // One hash over the sprites, icons and sprite sheets read at startup. The gateway's service worker keeps those
  // cache-first and drops its copies from this server when the hash changes.
  "/asset-version": {
    GET: async () => new Response(JSON.stringify({ version: (await assetCache.get("assetVersion")) ?? "" }), {
      status: 200,
      headers: { ...CORS_HEADERS, "Cache-Control": "no-store" }
    })
  },
  "/tileset": {
    GET: async (req: Request) => {
      const url = new URL(req.url);
      const name = url.searchParams.get("name");

      if (!name) {
        return new Response(JSON.stringify({ error: "Missing tileset name" }), {
          status: 400,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }
        });
      }

      try {
        if (isUnsafeAssetName(name)) {
          return new Response(JSON.stringify({ error: "Invalid tileset name" }), {
            status: 400,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }
          });
        }

        // Serve from the startup cache only - everything is loaded into memory at boot.
        const cachedTilesets = await assetCache.get("tilesets") as any[] | null;
        const cachedTileset = cachedTilesets?.find((t: any) => t.name === name);
        if (cachedTileset?.data) {
          // Revalidated on every load (no-cache + ETag = the file's content hash): a tileset edited in place under the same
          // name is picked up after a restart, an unchanged one costs a 304. The gateway's service worker no longer keeps
          // /tileset (its cache-first copy served the old image on every normal reload).
          const etag = `"${cachedTileset.version ?? ""}"`;
          const headers = {
            "Content-Type": "application/json",
            "Cache-Control": "no-cache",
            ...(cachedTileset.version ? { "ETag": etag } : {}),
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Expose-Headers": "ETag",
          };
          if (cachedTileset.version && req.headers.get("If-None-Match") === etag) return new Response(null, { status: 304, headers });
          return new Response(JSON.stringify({
            name: name,
            data: cachedTileset.data
          }), { status: 200, headers });
        }

        return new Response(JSON.stringify({ error: "Tileset not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }
        });
      } catch (error: any) {
        log.error(`Error serving tileset: ${error.message}`);
        return new Response(JSON.stringify({ error: "Internal server error" }), {
          status: 500,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }
        });
      }
    }
  },
  "/map-chunk": {
    GET: async (req: Request) => {
      const url = new URL(req.url);
      const mapName = url.searchParams.get("map");
      const chunkX = parseInt(url.searchParams.get("x") || "0");
      const chunkY = parseInt(url.searchParams.get("y") || "0");
      const chunkSize = parseInt(url.searchParams.get("size") || "25");

      if (!mapName) {
        return new Response(JSON.stringify({ error: "Missing map name" }), {
          status: 400,
          headers: CORS_HEADERS
        });
      }

      try {
        // Get map from cache. A world (modules/worldstore.ts) answers under the
        // same name with the same chunk JSON, read from its packs on disk.
        const mapFile = mapName.endsWith(".json") ? mapName : `${mapName}.json`;
        const world = getWorld(mapFile);
        const maps = world ? null : await assetCache.get("maps") as any[];
        const map = world ?? maps?.find((m: any) => m.name === mapFile);

        if (!map) {
          return new Response(JSON.stringify({ error: "Map not found" }), {
            status: 404,
            headers: CORS_HEADERS
          });
        }

        const buildChunk = () => world
          ? buildWorldChunk(world, chunkX, chunkY, chunkSize)
          : buildMapChunk(map.data, chunkX, chunkY, chunkSize);

        const wantGzip = acceptsGzip(req);

        // Serve precomputed gzip payload when available (browser fetch
        // transparently decompresses Content-Encoding: gzip).
        if (wantGzip) {
          const cacheKey = getChunkCacheKey(mapFile, map.checksum, chunkX, chunkY, chunkSize);
          const cachedChunk = chunkCache.get(cacheKey);
          if (cachedChunk) {
            return new Response(cachedChunk, {
              status: 200,
              headers: {
                ...CORS_HEADERS,
                "Content-Encoding": "gzip",
                "Vary": "Accept-Encoding"
              }
            });
          }

          // Build the chunk (existing slicing logic), compress, and cache it.
          const chunkPayload = buildChunk();
          if (chunkPayload === null) {
            return new Response(JSON.stringify({ error: "Invalid chunk parameters" }), {
              status: 400,
              headers: CORS_HEADERS
            });
          }
          const gz = zlib.gzipSync(chunkPayload);
          rememberChunk(cacheKey, gz);
          return new Response(gz, {
            status: 200,
            headers: {
              ...CORS_HEADERS,
              "Content-Encoding": "gzip",
              "Vary": "Accept-Encoding"
            }
          });
        }

        // Non-gzip client: build fresh (rare - all modern browsers send gzip)
        const chunkPayload = buildChunk();
        if (chunkPayload === null) {
          return new Response(JSON.stringify({ error: "Invalid chunk parameters" }), {
            status: 400,
            headers: CORS_HEADERS
          });
        }
        return new Response(chunkPayload, {
          status: 200,
          headers: CORS_HEADERS
        });
      } catch (error: any) {
        log.error(`Error serving map chunk: ${error.message}`);
        return new Response(JSON.stringify({ error: "Failed to fetch map chunk" }), {
          status: 500,
          headers: CORS_HEADERS
        });
      }
    }
  },
  "/map-checksums": {
    POST: async (req: Request) => {
      try {
        const body = await req.json() as { checksums: Record<string, string>; serverId: string; authKey: string };
        const { checksums, serverId, authKey: requestAuthKey } = body;
        if (requestAuthKey !== authKey) {
          return new Response(JSON.stringify({ error: "Invalid authentication key" }), { status: 401, headers: CORS_HEADERS });
        }
        // Before start the list's run is not known yet: a place given now would be from no run at all
        if (!mapChanges.ready) {
          return new Response(JSON.stringify({ error: "The maps are still loading" }), { status: 503, headers: CORS_HEADERS });
        }
        // The place in the list of changed maps (/map-events) before comparing: a map saved meanwhile is listed after it
        const changes = mapChanges.place();
        const maps = await assetCache.get("maps") as any[];
        if (!maps || maps.length === 0) {
          return new Response(JSON.stringify({ success: true, outdatedMaps: [], maps: [], changes }), { status: 200, headers: CORS_HEADERS });
        }
        // Every map held here, by name. The game server removes local maps that
        // are not in this list, so its folder stays a copy of this one.
        const mapNames = maps.map((map) => map.name);
        const outdatedMaps: any[] = [];
        for (const map of maps) {
          const mapName = map.name;
          const clientChecksum = checksums[mapName];
          const mapChecksum = map.checksum;
          if (clientChecksum !== mapChecksum) {
            outdatedMaps.push({ name: mapName, checksum: mapChecksum, data: map.data });
          }
        }
        // A game server compares every map at start and after a restart here: only a compare that finds something is worth a line
        if (outdatedMaps.length > 0) log.info(`[AssetServer] Map sync for ${serverId}: ${outdatedMaps.length} outdated maps`);
        else log.debug(`[AssetServer] Map sync for ${serverId}: up to date`);
        // Outdated maps carry full map data - this response can be megabytes.
        // gzip cuts it 80-90%; Bun's fetch on the game server decompresses
        // transparently, so no consumer changes are needed.
        const payload = JSON.stringify({ success: true, outdatedMaps, maps: mapNames, changes });
        if (acceptsGzip(req)) {
          return new Response(zlib.gzipSync(payload), {
            status: 200,
            headers: {
              ...CORS_HEADERS,
              "Content-Encoding": "gzip",
              "Vary": "Accept-Encoding"
            }
          });
        }
        return new Response(payload, { status: 200, headers: CORS_HEADERS });
      } catch (error: any) {
        log.error(`Error in /map-checksums: ${error.message}`);
        return new Response(JSON.stringify({ error: "Invalid request body" }), { status: 400, headers: CORS_HEADERS });
      }
    }
  },
  // The maps saved here since the place the game server was last told (modules/mapchanges.ts), for a game server
  // that polls (an engine older than /map-events): only the maps that changed are sent, never a comparison of every map
  "/map-changes": {
    POST: async (req: Request) => {
      try {
        const { epoch, since, serverId, authKey: requestAuthKey } = await req.json() as { epoch?: unknown; since?: unknown; serverId?: string; authKey: string };
        if (requestAuthKey !== authKey) {
          return new Response(JSON.stringify({ error: "Invalid authentication key" }), { status: 401, headers: CORS_HEADERS });
        }
        if (!mapChanges.ready) {
          return new Response(JSON.stringify({ error: "The maps are still loading" }), { status: 503, headers: CORS_HEADERS });
        }
        const answer = mapChanges.since(epoch, since);
        if (answer.maps.length > 0) log.info(`[AssetServer] Map changes for ${serverId}: ${answer.maps.length} map(s)`);
        const payload = JSON.stringify({ success: true, ...answer });
        if (answer.maps.length > 0 && acceptsGzip(req)) {
          return new Response(zlib.gzipSync(payload), { status: 200, headers: { ...CORS_HEADERS, "Content-Encoding": "gzip", "Vary": "Accept-Encoding" } });
        }
        return new Response(payload, { status: 200, headers: CORS_HEADERS });
      } catch (error: any) {
        log.error(`Error in /map-changes: ${error.message}`);
        return new Response(JSON.stringify({ error: "Invalid request body" }), { status: 400, headers: CORS_HEADERS });
      }
    }
  },
  // The changes a game server follows while it runs (modules/mapchanges.ts mapEventStream): the maps changed since its
  // place, then each map saved here and each world change as it is made, one JSON object per line. The asset server
  // pushes; the game server makes no request until the connection ends (a restart here), then connects again.
  "/map-events": {
    POST: async (req: Request) => {
      try {
        const { epoch, since, serverId, authKey: requestAuthKey } = await req.json() as { epoch?: unknown; since?: unknown; serverId?: string; authKey: string };
        if (requestAuthKey !== authKey) {
          return new Response(JSON.stringify({ error: "Invalid authentication key" }), { status: 401, headers: CORS_HEADERS });
        }
        if (!mapChanges.ready) {
          return new Response(JSON.stringify({ error: "The maps are still loading" }), { status: 503, headers: CORS_HEADERS });
        }
        const first = mapChanges.since(epoch, since);
        if (first.maps.length > 0) log.info(`[AssetServer] Map changes for ${serverId}: ${first.maps.length} map(s)`);
        else if (first.full) log.info(`[AssetServer] ${serverId} compares every map once: its place is from another run`);
        return new Response(mapEventStream(mapChanges, epoch, since), {
          status: 200,
          headers: { ...CORS_HEADERS, "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" },
        });
      } catch (error: any) {
        log.error(`Error in /map-events: ${error.message}`);
        return new Response(JSON.stringify({ error: "Invalid request body" }), { status: 400, headers: CORS_HEADERS });
      }
    }
  },
  // Worlds (modules/worldstore.ts) are too large for /map-checksums, which
  // answers with whole maps. The game server asks for the list, then for each
  // file it has no current copy of: the manifest and the two bitsets, never
  // the tiles.
  "/world-list": {
    POST: async (req: Request) => {
      try {
        const { serverId, authKey: requestAuthKey } = await req.json() as { serverId?: string; authKey: string };
        if (requestAuthKey !== authKey) {
          return new Response(JSON.stringify({ error: "Invalid authentication key" }), { status: 401, headers: CORS_HEADERS });
        }
        const worlds = listWorlds().map(world => ({ id: world.id, name: world.name, files: world.fileHashes }));
        log.debug(`[AssetServer] World sync for ${serverId}: ${worlds.length} world(s)`);
        return new Response(JSON.stringify({ success: true, worlds }), { status: 200, headers: CORS_HEADERS });
      } catch (error: any) {
        log.error(`Error in /world-list: ${error.message}`);
        return new Response(JSON.stringify({ error: "Invalid request body" }), { status: 400, headers: CORS_HEADERS });
      }
    }
  },
  "/world-file": {
    POST: async (req: Request) => {
      try {
        const { id, file, authKey: requestAuthKey } = await req.json() as { id: string; file: string; authKey: string };
        if (requestAuthKey !== authKey) {
          return new Response(JSON.stringify({ error: "Invalid authentication key" }), { status: 401, headers: CORS_HEADERS });
        }
        const world = typeof id === "string" ? getWorld(id) : undefined;
        if (!world) {
          return new Response(JSON.stringify({ error: "World not found" }), { status: 404, headers: CORS_HEADERS });
        }
        if (!WORLD_SYNC_FILES.includes(file as WorldSyncFile)) {
          return new Response(JSON.stringify({ error: "Unknown world file" }), { status: 400, headers: CORS_HEADERS });
        }
        const bytes = readWorldFile(world, file as WorldSyncFile);
        const headers: Record<string, string> = { ...CORS_HEADERS, "Content-Type": "application/octet-stream" };
        // The bitsets are mostly runs of equal bytes: gzip takes megabytes down to kilobytes
        if (acceptsGzip(req)) {
          return new Response(zlib.gzipSync(bytes), { status: 200, headers: { ...headers, "Content-Encoding": "gzip", "Vary": "Accept-Encoding" } });
        }
        return new Response(bytes, { status: 200, headers });
      } catch (error: any) {
        log.error(`Error in /world-file: ${error.message}`);
        return new Response(JSON.stringify({ error: "Failed to read world file" }), { status: 500, headers: CORS_HEADERS });
      }
    }
  },
  "/update-map": {
    POST: async (req: Request) => {
      try {
        const { mapName, mapData, serverId, authKey: requestAuthKey } = await req.json() as { mapName: string; mapData: any; serverId: string; authKey: string };
        if (requestAuthKey !== authKey) {
          return new Response(JSON.stringify({ error: "Invalid authentication key" }), { status: 401, headers: CORS_HEADERS });
        }
        if (!mapName || !mapData) {
          return new Response(JSON.stringify({ error: "Missing mapName or mapData" }), { status: 400, headers: CORS_HEADERS });
        }
        if (getWorld(mapName)) {
          return new Response(JSON.stringify({ error: WORLD_READ_ONLY }), { status: 400, headers: CORS_HEADERS });
        }
        let maps = await assetCache.get("maps") as any[];
        if (!maps) maps = [];
        const crypto = await import("crypto");
        normalizeInfiniteMap(mapData);
        const checksum = crypto.createHash("sha256").update(JSON.stringify(mapData)).digest("hex");
        const existingIndex = maps.findIndex((m: any) => m.name === mapName);
        if (existingIndex >= 0) {
          maps[existingIndex] = { name: mapName, data: mapData, checksum: checksum };
        } else {
          maps.push({ name: mapName, data: mapData, checksum: checksum });
        }
        await assetCache.set("maps", maps);
        mapChanges.record({ name: mapName, checksum, data: mapData });
        clearChunkCacheForMap(mapName);
        log.info(`[AssetServer] Map updated: ${mapName} by server ${serverId}`);
        return new Response(JSON.stringify({ success: true, checksum: checksum, message: "Map updated successfully" }), { status: 200, headers: CORS_HEADERS });
      } catch (error: any) {
        log.error(`Error in /update-map: ${error.message}`);
        return new Response(JSON.stringify({ error: "Failed to update map" }), { status: 500, headers: CORS_HEADERS });
      }
    }
  },
  "/save-map-chunks": {
    POST: async (req: Request) => {
      try {
        const body = await req.json() as { mapName: string; chunks: any[]; bounds?: { minTileX?: number; minTileY?: number; width?: number; height?: number; infinite?: boolean } | null; authKey: string; serverId?: string };
        const { mapName, chunks, bounds, authKey: requestAuthKey, serverId } = body;

        if (requestAuthKey !== authKey) {
          return new Response(JSON.stringify({ error: "Invalid authentication key" }), { status: 401, headers: CORS_HEADERS });
        }

        if (!mapName || !chunks || !Array.isArray(chunks)) {
          return new Response(JSON.stringify({ error: "Invalid request: mapName and chunks are required" }), { status: 400, headers: CORS_HEADERS });
        }

        const pathModule = await import("path");
        const fsModule = await import("fs");
        const crypto = await import("crypto");
        const zlibModule = await import("zlib");

        const maps = (await assetCache.get("maps")) as any[] || [];
        const mapFile = mapName.endsWith(".json") ? mapName : `${mapName}.json`;

        // A world (modules/worldstore.ts) has a fixed size and is saved chunk by
        // chunk into its packs: nothing of it is held or rewritten whole.
        const world = getWorld(mapFile);
        if (world) {
          try {
            const changed = saveWorldChunks(world, chunks);
            clearChunkCacheForMap(mapFile);
            if (changed.length > 0) mapChanges.worldsChanged();
            log.info(`[AssetServer] World ${world.id} saved by ${serverId || "a server"}: ${changed.length} of ${chunks.length} chunk(s) changed`);
            return new Response(JSON.stringify({ success: true, checksum: world.checksum, changed, message: `Saved ${changed.length} chunk(s) for map ${mapName}` }), { status: 200, headers: CORS_HEADERS });
          } catch (worldError: any) {
            if (worldError instanceof WorldSaveError) {
              return new Response(JSON.stringify({ error: worldError.message }), { status: 400, headers: CORS_HEADERS });
            }
            throw worldError;
          }
        }

        const mapIndex = maps.findIndex((m: any) => m.name === mapFile);

        if (mapIndex === -1) {
          return new Response(JSON.stringify({ error: "Map not found" }), { status: 404, headers: CORS_HEADERS });
        }

        // Update chunks in map data, growing / re-basing the origin for
        // infinite-map expansion as needed.
        const mapData = maps[mapIndex].data;
        applyChunksWithRebase(mapData, chunks, bounds);

        // Recalculate checksum with minified JSON
        const jsonString = JSON.stringify(mapData);
        const newChecksum = crypto.createHash("sha256").update(jsonString).digest("hex");

        // Update map in cache
        maps[mapIndex] = {
          name: mapFile,
          data: mapData,
          checksum: newChecksum,
          compressed: zlibModule.gzipSync(jsonString)
        };

        await assetCache.set("maps", maps);
        mapChanges.record({ name: mapFile, checksum: newChecksum, data: mapData });
        clearChunkCacheForMap(mapFile);

        // Persist changes to disk
        try {
          const assetPath = getAssetsPath();
          const mapsPath = pathModule.join(assetPath, "maps");
          const mapFilePath = pathModule.join(mapsPath, mapFile);

          // Write map with minified JSON
          fsModule.writeFileSync(mapFilePath, jsonString, "utf-8");
        } catch (diskError) {
          log.warn(`[AssetServer] Failed to persist map to disk: ${diskError}`);
          // Continue anyway - map is updated in cache
        }

        return new Response(JSON.stringify({ success: true, checksum: newChecksum, message: `Saved ${chunks.length} chunk(s) for map ${mapName}` }), { status: 200, headers: CORS_HEADERS });
      } catch (error: any) {
        log.error(`Error in /save-map-chunks: ${error.message}`);
        return new Response(JSON.stringify({ error: "Failed to save map chunks" }), { status: 500, headers: CORS_HEADERS });
      }
    }
  },
  "/save-map-properties": {
    POST: async (req: Request) => {
      try {
        const body = await req.json() as { mapName: string; graveyards?: any; warps?: any; authKey: string };
        const { mapName, graveyards, warps, authKey: requestAuthKey } = body;

        if (requestAuthKey !== authKey) {
          return new Response(JSON.stringify({ error: "Invalid authentication key" }), { status: 401, headers: CORS_HEADERS });
        }

        if (!mapName) {
          return new Response(JSON.stringify({ error: "Invalid request: mapName is required" }), { status: 400, headers: CORS_HEADERS });
        }

        const pathModule = await import("path");
        const fsModule = await import("fs");
        const crypto = await import("crypto");
        const zlibModule = await import("zlib");

        const maps = (await assetCache.get("maps")) as any[] || [];
        const mapFile = mapName.endsWith(".json") ? mapName : `${mapName}.json`;

        // A world (modules/worldstore.ts) keeps them as objects of its manifest
        const world = getWorld(mapFile);
        if (world) {
          try {
            saveWorldProperties(world, graveyards, warps);
            mapChanges.worldsChanged();
            log.info(`[AssetServer] World ${world.id}: graveyards / warps saved`);
            return new Response(JSON.stringify({ success: true, checksum: world.checksum, message: `Saved properties for map ${mapName}` }), { status: 200, headers: CORS_HEADERS });
          } catch (worldError: any) {
            if (worldError instanceof WorldSaveError) {
              return new Response(JSON.stringify({ error: worldError.message }), { status: 400, headers: CORS_HEADERS });
            }
            throw worldError;
          }
        }

        const mapIndex = maps.findIndex((m: any) => m.name === mapFile);

        if (mapIndex === -1) {
          return new Response(JSON.stringify({ error: "Map not found" }), { status: 404, headers: CORS_HEADERS });
        }

        // Update map data with graveyards and warps
        const mapData = maps[mapIndex].data;

        log.info(`[AssetServer] Before update - mapData has graveyards: ${mapData.graveyards ? 'yes' : 'no'}, warps: ${mapData.warps ? 'yes' : 'no'}`);

        if (graveyards) {
          mapData.graveyards = graveyards;
          log.info(`[AssetServer] Updated graveyards to: ${JSON.stringify(graveyards)}`);

          // Also update the Tiled object layer for graveyards
          let graveyardLayer = mapData.layers.find((l: any) => l.name === "Graveyards" && l.type === "objectgroup");
          if (!graveyardLayer) {
            graveyardLayer = {
              draworder: "topdown",
              id: Math.max(...mapData.layers.map((l: any) => l.id || 0), 0) + 1,
              name: "Graveyards",
              objects: [],
              opacity: 1,
              type: "objectgroup",
              visible: true,
              x: 0,
              y: 0
            };
            mapData.layers.push(graveyardLayer);
            log.info(`[AssetServer] Created Graveyards object layer`);
          }

          graveyardLayer.objects = graveyards.map((g: any, idx: number) => ({
            id: idx + 1,
            name: g.name,
            type: "graveyard",
            x: g.position?.x || 0,
            y: g.position?.y || 0,
            width: 0,
            height: 0,
            rotation: 0,
            visible: true,
            point: true
          }));
          log.info(`[AssetServer] Updated Graveyards object layer with ${graveyards.length} objects`);
        }

        if (warps) {
          mapData.warps = warps;
          log.info(`[AssetServer] Updated warps to: ${JSON.stringify(warps)}`);

          // Also update the Tiled object layer for warps
          let warpLayer = mapData.layers.find((l: any) => l.name === "Warps" && l.type === "objectgroup");
          if (!warpLayer) {
            warpLayer = {
              draworder: "topdown",
              id: Math.max(...mapData.layers.map((l: any) => l.id || 0), 0) + 1,
              name: "Warps",
              objects: [],
              opacity: 1,
              type: "objectgroup",
              visible: true,
              x: 0,
              y: 0
            };
            mapData.layers.push(warpLayer);
            log.info(`[AssetServer] Created Warps object layer`);
          }

          warpLayer.objects = warps.map((w: any, idx: number) => ({
            id: idx + 1,
            name: w.name,
            type: "warp",
            x: w.position?.x || 0,
            y: w.position?.y || 0,
            width: w.size?.width || 32,
            height: w.size?.height || 32,
            rotation: 0,
            visible: true,
            properties: [
              { name: "map", type: "string", value: w.map },
              { name: "x", type: "int", value: w.x },
              { name: "y", type: "int", value: w.y }
            ]
          }));
          log.info(`[AssetServer] Updated Warps object layer with ${warps.length} objects`);
        }

        log.info(`[AssetServer] After update - mapData has graveyards: ${mapData.graveyards ? 'yes' : 'no'}, warps: ${mapData.warps ? 'yes' : 'no'}`);

        // Recalculate checksum with updated data
        const jsonString = JSON.stringify(mapData);
        const newChecksum = crypto.createHash("sha256").update(jsonString).digest("hex");

        // Update map in cache
        maps[mapIndex] = {
          name: mapFile,
          data: mapData,
          checksum: newChecksum,
          compressed: zlibModule.gzipSync(jsonString)
        };

        await assetCache.set("maps", maps);
        mapChanges.record({ name: mapFile, checksum: newChecksum, data: mapData });
        clearChunkCacheForMap(mapFile);
        log.info(`[AssetServer] Updated cache for map: ${mapFile}`);

        // Persist changes to disk
        try {
          const assetPath = getAssetsPath();
          const mapsPath = pathModule.join(assetPath, "maps");
          const mapFilePath = pathModule.join(mapsPath, mapFile);

          log.info(`[AssetServer] Writing map to disk at: ${mapFilePath}`);
          // Write map with formatted JSON
          fsModule.writeFileSync(mapFilePath, JSON.stringify(mapData, null, 2), "utf-8");
          log.info(`[AssetServer] Successfully wrote map to disk`);
        } catch (diskError) {
          log.warn(`[AssetServer] Failed to persist map properties to disk: ${diskError}`);
          // Continue anyway - map is updated in cache
        }

        return new Response(JSON.stringify({ success: true, checksum: newChecksum, message: `Saved map properties for ${mapName}` }), { status: 200, headers: CORS_HEADERS });
      } catch (error: any) {
        log.error(`Error in /save-map-properties: ${error.message}`);
        return new Response(JSON.stringify({ error: "Failed to save map properties" }), { status: 500, headers: CORS_HEADERS });
      }
    }
  },
  "/sprite-sheet-template": {
    GET: async (req: Request) => {
      const url = new URL(req.url);
      const name = url.searchParams.get("name");

      if (!name) {
        return new Response(JSON.stringify({ error: "Missing sprite sheet template name" }), {
          status: 400,
          headers: CORS_HEADERS
        });
      }

      try {
        const templates = await assetCache.get("spriteSheetTemplates") as any[];
        if (!templates || templates.length === 0) {
          return new Response(JSON.stringify({ error: "Sprite sheet templates not found" }), {
            status: 404,
            headers: CORS_HEADERS
          });
        }

        const template = templates.find((t: any) => t.name === name);
        if (!template) {
          return new Response(JSON.stringify({ error: `Sprite sheet template "${name}" not found. Available: ${templates.map((t: any) => t.name).join(", ")}` }), {
            status: 404,
            headers: CORS_HEADERS
          });
        }

        if (!template.template) {
          return new Response(JSON.stringify({ error: `Sprite sheet template "${name}" has no template data` }), {
            status: 404,
            headers: CORS_HEADERS
          });
        }

        // Return the cached template JSON directly
        const templateData = typeof template.template === 'string' ? template.template : JSON.stringify(template.template);
        return revalidated(req, template.templateVersion, { ...CORS_HEADERS, "Content-Type": "application/json" }, () => templateData);
      } catch (error: any) {
        log.error(`Error serving sprite sheet template: ${error.message}`);
        return new Response(JSON.stringify({ error: "Internal server error" }), {
          status: 500,
          headers: CORS_HEADERS
        });
      }
    }
  },
  "/sprite-sheet-image": {
    GET: async (req: Request) => {
      const url = new URL(req.url);
      const name = url.searchParams.get("name");

      if (!name) {
        return new Response(JSON.stringify({ error: "Missing sprite sheet image name" }), {
          status: 400,
          headers: CORS_HEADERS
        });
      }

      try {
        const templates = await assetCache.get("spriteSheetTemplates") as any[];
        if (!templates || templates.length === 0) {
          return new Response(JSON.stringify({ error: "Sprite sheet images not found" }), {
            status: 404,
            headers: CORS_HEADERS
          });
        }

        const template = templates.find((t: any) => t.name === name);
        if (!template) {
          return new Response(JSON.stringify({ error: `Template "${name}" not found. Available: ${templates.map((t: any) => t.name).join(", ")}` }), {
            status: 404,
            headers: CORS_HEADERS
          });
        }

        if (!template.image) {
          return new Response(JSON.stringify({ error: `Template "${name}" has no image data` }), {
            status: 404,
            headers: CORS_HEADERS
          });
        }

        // Convert Buffer to Uint8Array if needed
        const imageData = Buffer.isBuffer(template.image) ? template.image : Buffer.from(template.image);

        // Return the cached image buffer directly as PNG
        return revalidated(req, template.imageVersion, {
          "Content-Type": "image/png",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        }, () => imageData);
      } catch (error: any) {
        log.error(`Error serving sprite sheet image: ${error.message}`);
        return new Response(JSON.stringify({ error: "Internal server error" }), {
          status: 500,
          headers: CORS_HEADERS
        });
      }
    }
  },
  "/sprite": {
    GET: async (req: Request) => {
      const url = new URL(req.url);
      const name = url.searchParams.get("name");

      if (!name) {
        return new Response(JSON.stringify({ error: "Missing sprite name" }), {
          status: 400,
          headers: CORS_HEADERS
        });
      }

      try {
        // Cache keys omit the extension - accept it either way.
        const key = name.trim().replace(/\.png$/i, "");
        if (isUnsafeAssetName(key)) {
          return new Response(JSON.stringify({ error: "Invalid sprite name" }), {
            status: 400,
            headers: CORS_HEADERS
          });
        }

        // Serve from the startup cache only - everything is loaded into memory at boot.
        const sprites = await assetCache.get("sprites") as any[] | null;
        const entry = sprites?.find((s: any) => s.name === key);

        if (!entry?.data) {
          return serveMissingIcon();
        }

        // Revalidated on every use (no-cache + ETag = the PNG's content hash): a sprite replaced under the same name is
        // picked up after a restart. The gateway's service worker keeps it cache-first until /asset-version changes.
        return revalidated(req, entry.version, {
          "Content-Type": "image/png",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type"
        }, () => decodeCachedImage(entry.data));
      } catch (error: any) {
        log.error(`Error serving sprite: ${error.message}`);
        return new Response(JSON.stringify({ error: "Internal server error" }), {
          status: 500,
          headers: CORS_HEADERS
        });
      }
    }
  },
  // The baked full-map image of a map (maps/<map>.worldmap.png): the game's world map view. Revalidated by version.
  "/worldmap": {
    GET: async (req: Request) => {
      const url = new URL(req.url);
      const key = (url.searchParams.get("name") || "").trim().replace(/\.json$/i, "");
      if (!key || isUnsafeAssetName(key)) {
        return new Response(JSON.stringify({ error: "Invalid map name" }), { status: 400, headers: CORS_HEADERS });
      }
      try {
        // A piece of a world at full detail (rx, ry: which region of WORLD_MAP_REGION tiles), for the map view
        // zoomed in: a world's whole image is several tiles to a pixel. Baked when first asked for.
        if (url.searchParams.has("rx") || url.searchParams.has("ry")) {
          const world = getWorld(key);
          const rx = Number(url.searchParams.get("rx")), ry = Number(url.searchParams.get("ry"));
          if (!world || !Number.isInteger(rx) || !Number.isInteger(ry) || rx < 0 || ry < 0 || rx * WORLD_MAP_REGION >= world.width || ry * WORLD_MAP_REGION >= world.height) {
            return new Response(JSON.stringify({ error: "World map not found" }), { status: 404, headers: CORS_HEADERS });
          }
          const pieceKey = `${world.id}:${world.checksum}:${rx}:${ry}`;
          const etag = `"${world.checksum.slice(0, 16)}-${rx}-${ry}"`;
          const headers = {
            "Content-Type": "image/png",
            "Cache-Control": "public, max-age=0, must-revalidate",
            "ETag": etag,
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Expose-Headers": "ETag",
          };
          if (req.headers.get("If-None-Match") === etag) return new Response(null, { status: 304, headers });
          let png = worldMapPieces.get(pieceKey);
          if (!png) {
            const chunks = WORLD_MAP_REGION / world.chunkSize;
            worldMapImages ??= new TilesetImages(path.join(getAssetsPath(), "tilesets"));
            png = bakeChunkedWorldMap({
              width: Math.min(WORLD_MAP_REGION, world.width - rx * WORLD_MAP_REGION),
              height: Math.min(WORLD_MAP_REGION, world.height - ry * WORLD_MAP_REGION),
              chunkSize: world.chunkSize,
              tilesets: world.manifest.tilesets ?? [],
              backgroundcolor: world.manifest.backgroundcolor,
              layers: world.layers,
              readChunk: (chunkX, chunkY) => readChunkTiles(world, rx * chunks + chunkX, ry * chunks + chunkY),
            }, worldMapImages).png;
            worldMapPieces.set(pieceKey, png);
            if (worldMapPieces.size > WORLD_MAP_PIECES_MAX) {
              const oldest = worldMapPieces.keys().next().value;
              if (oldest !== undefined) worldMapPieces.delete(oldest);
            }
          }
          return new Response(png, { status: 200, headers: { ...headers, "Content-Length": png.length.toString() } });
        }

        // A world changed on disk is read again here, which bakes its image again shortly (assetloader.ts rebakeWorld)
        getWorld(key);
        const worldMaps = await assetCache.get("worldmaps") as any[] | null;
        const entry = worldMaps?.find((m: any) => m.name === key);
        if (!entry?.data) {
          return new Response(JSON.stringify({ error: "World map not found" }), { status: 404, headers: CORS_HEADERS });
        }
        const etag = `"${entry.version}"`;
        const headers = {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=0, must-revalidate",
          "ETag": etag,
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Expose-Headers": "ETag",
        };
        if (req.headers.get("If-None-Match") === etag) return new Response(null, { status: 304, headers });
        const png = Buffer.from(entry.data, "base64");
        return new Response(png, { status: 200, headers: { ...headers, "Content-Length": png.length.toString() } });
      } catch (error: any) {
        log.error(`Error serving world map: ${error.message}`);
        return new Response(JSON.stringify({ error: "Internal server error" }), { status: 500, headers: CORS_HEADERS });
      }
    }
  },
  "/icon": {
    GET: async (req: Request) => {
      const url = new URL(req.url);
      const name = url.searchParams.get("name");

      if (!name) {
        return new Response(JSON.stringify({ error: "Missing icon name" }), {
          status: 400,
          headers: CORS_HEADERS
        });
      }

      try {
        // Cache keys omit the extension - accept it either way.
        const key = name.trim().replace(/\.png$/i, "");
        if (isUnsafeAssetName(key)) {
          return new Response(JSON.stringify({ error: "Invalid icon name" }), {
            status: 400,
            headers: CORS_HEADERS
          });
        }

        // Serve from the startup cache only - everything is loaded into memory at boot.
        const icons = await assetCache.get("icons") as any[] | null;
        const entry = icons?.find((i: any) => i.name === key);

        if (!entry?.data) {
          return serveMissingIcon();
        }

        // Revalidated on every use, as /sprite.
        return revalidated(req, entry.version, {
          "Content-Type": "image/png",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type"
        }, () => decodeCachedImage(entry.data));
      } catch (error: any) {
        log.error(`Error serving icon: ${error.message}`);
        return new Response(JSON.stringify({ error: "Internal server error" }), {
          status: 500,
          headers: CORS_HEADERS
        });
      }
    }
  },
  "/audio": {
    GET: async (req: Request) => {
      const url = new URL(req.url);
      const name = url.searchParams.get("name");

      if (!name) {
        return new Response(JSON.stringify({ error: "Missing audio name" }), {
          status: 400,
          headers: CORS_HEADERS
        });
      }

      try {
        const cleaned = name.trim().replace(/^\/+/, "");
        if (isUnsafeAssetName(cleaned)) {
          return new Response(JSON.stringify({ error: "Invalid audio name" }), {
            status: 400,
            headers: CORS_HEADERS
          });
        }

        const reqExt = path.extname(cleaned).toLowerCase();
        if (reqExt && !ALLOWED_AUDIO_EXTENSIONS.includes(reqExt)) {
          return new Response(JSON.stringify({ error: "Invalid audio name" }), {
            status: 400,
            headers: CORS_HEADERS
          });
        }

        // Serve from the startup cache only (stored as base64 gzip).
        // Accepts names with or without extension (e.g. "theme", "theme.mp3").
        const cached = await assetCache.get("audio") as any[] | null;
        const stemOf = (n: string) => n.replace(/\.[^.]*$/, "").toLowerCase();
        const entry = cached?.find((a: any) =>
          a.name === cleaned ||
          a.name.toLowerCase() === cleaned.toLowerCase() ||
          stemOf(a.name) === stemOf(cleaned)
        );
        if (!entry?.data) {
          return new Response(JSON.stringify({ error: "Audio not found" }), {
            status: 404,
            headers: CORS_HEADERS
          });
        }

        const raw = decodeCachedAudio(entry.data);
        return serveAudioBuffer(req, entry.name, raw, entry.version);
      } catch (error: any) {
        log.error(`Error serving audio: ${error.message}`);
        return new Response(JSON.stringify({ error: "Internal server error" }), {
          status: 500,
          headers: CORS_HEADERS
        });
      }
    },
    HEAD: async (req: Request) => {
      // Reuse GET logic - serveAudioBuffer returns headers-only for HEAD.
      return (routes["/audio"] as any).GET(req);
    }
  },
  // The footstep sounds the map editor sets on tiles (modules/tilesounds.ts): read by every game client, written by
  // the game server for an admin
  "/tile-sounds": {
    GET: async () => {
      try {
        return new Response(JSON.stringify({ tilesets: getTileSounds() }), { status: 200, headers: CORS_HEADERS });
      } catch (error: any) {
        log.error(`Error reading tile sounds: ${error.message}`);
        return new Response(JSON.stringify({ error: "Internal server error" }), { status: 500, headers: CORS_HEADERS });
      }
    }
  },
  "/save-tile-sounds": {
    POST: async (req: Request) => {
      try {
        const body = await req.json() as { changes?: TileSoundChange[]; authKey?: string };
        if (body?.authKey !== authKey) {
          return new Response(JSON.stringify({ error: "Invalid authentication key" }), { status: 401, headers: CORS_HEADERS });
        }
        const wrong = checkTileSoundChanges(body.changes);
        if (wrong) return new Response(JSON.stringify({ error: wrong }), { status: 400, headers: CORS_HEADERS });
        const tilesets = saveTileSounds(body.changes!);
        log.info(`[AssetServer] Tile sounds saved: ${body.changes!.reduce((n, c) => n + c.ids.length, 0)} tiles changed`);
        return new Response(JSON.stringify({ success: true, tilesets }), { status: 200, headers: CORS_HEADERS });
      } catch (error: any) {
        log.error(`Error in /save-tile-sounds: ${error.message}`);
        return new Response(JSON.stringify({ error: "Failed to save tile sounds" }), { status: 500, headers: CORS_HEADERS });
      }
    }
  },
  // The tileset pictures there are, for the map editor's New map form
  "/tileset-list": {
    GET: async () => {
      try {
        return new Response(JSON.stringify({ tilesets: await tilesetImageNames() }), { status: 200, headers: CORS_HEADERS });
      } catch (error: any) {
        log.error(`Error listing tilesets: ${error.message}`);
        return new Response(JSON.stringify({ error: "Internal server error" }), { status: 500, headers: CORS_HEADERS });
      }
    }
  },
  // A new, blank map or world from the map editor (modules/mapcreate.ts), asked for by the game server for an admin
  "/create-map": {
    POST: async (req: Request) => {
      try {
        const body = await req.json() as CreateMapRequest & { authKey?: string };
        if (body?.authKey !== authKey) {
          return new Response(JSON.stringify({ error: "Invalid authentication key" }), { status: 401, headers: CORS_HEADERS });
        }
        const mapDir = path.join(getAssetsPath(), "maps");
        const maps = (await assetCache.get("maps") as any[] | null) ?? [];
        const taken = (name: string) => maps.some((m: any) => m.name === `${name}.json`) || !!getWorld(name) || fs.existsSync(path.join(mapDir, `${name}.json`)) || fs.existsSync(path.join(mapDir, `${name}.world`));
        const wrong = checkCreateMap(body, taken, new Set(await tilesetImageNames()));
        if (wrong) return new Response(JSON.stringify({ error: wrong }), { status: 400, headers: CORS_HEADERS });
        const request: CreateMapRequest = { name: body.name, kind: body.kind, width: body.width, height: body.height, infinite: body.infinite, tilesets: body.tilesets };

        const known = [...maps.flatMap((m: any) => m.data?.tilesets ?? []), ...listWorlds().flatMap(w => w.manifest?.tilesets ?? [])];
        const defs = tilesetDefinitions(request.tilesets, known, (file) => {
          try { return pngSize(fs.readFileSync(path.join(getAssetsPath(), "tilesets", path.basename(file)))); } catch { return null; }
        });
        if ("error" in defs) return new Response(JSON.stringify({ error: defs.error }), { status: 400, headers: CORS_HEADERS });

        if (request.kind === "world") {
          writeBlankWorld(path.join(mapDir, `${request.name}.world`), request, defs.tilesets);
          await registerNewMap(request.name, addWorld(mapDir, request.name));
          mapChanges.worldsChanged();
          log.info(`[AssetServer] World ${request.name} created (${request.width} x ${request.height} tiles)`);
          return new Response(JSON.stringify({ success: true, name: request.name, kind: "world" }), { status: 200, headers: CORS_HEADERS });
        }
        const data = blankTiledMap(request, defs.tilesets);
        const file = path.join(mapDir, `${request.name}.json`);
        fs.writeFileSync(`${file}.tmp`, JSON.stringify(data));
        fs.renameSync(`${file}.tmp`, file);
        await registerNewMap(request.name);
        log.info(`[AssetServer] Map ${request.name} created (${request.width} x ${request.height} tiles${request.infinite ? ", infinite" : ""})`);
        return new Response(JSON.stringify({ success: true, name: request.name, kind: "map", data }), { status: 200, headers: CORS_HEADERS });
      } catch (error: any) {
        log.error(`Error in /create-map: ${error.message}`);
        return new Response(JSON.stringify({ error: "Failed to create the map" }), { status: 500, headers: CORS_HEADERS });
      }
    }
  },
  "/audios": {
    GET: async () => {
      try {
        // List from the startup cache only.
        const cached = await assetCache.get("audio") as any[] | null;
        return new Response(JSON.stringify({
          audio: (cached ?? []).map((a: any) => ({ name: a.name, mime: getAudioMimeType(a.name) }))
        }), {
          status: 200,
          headers: CORS_HEADERS
        });
      } catch (error: any) {
        log.error(`Error listing audio: ${error.message}`);
        return new Response(JSON.stringify({ error: "Internal server error" }), {
          status: 500,
          headers: CORS_HEADERS
        });
      }
    }
  },
  "/icons": {
    GET: async () => {
      try {
        // Names only; editors fetch each image from /icon?name=...
        const cached = await assetCache.get("icons") as any[] | null;
        return new Response(JSON.stringify({
          icons: (cached ?? []).map((i: any) => ({ name: i.name }))
        }), {
          status: 200,
          headers: CORS_HEADERS
        });
      } catch (error: any) {
        log.error(`Error listing icons: ${error.message}`);
        return new Response(JSON.stringify({ error: "Internal server error" }), {
          status: 500,
          headers: CORS_HEADERS
        });
      }
    }
  },
  "/sprites": {
    GET: async () => {
      try {
        // Names only; the particle editor's image list fetches each image from /sprite?name=...
        const cached = await assetCache.get("sprites") as any[] | null;
        return new Response(JSON.stringify({
          sprites: (cached ?? []).map((s: any) => ({ name: s.name }))
        }), {
          status: 200,
          headers: CORS_HEADERS
        });
      } catch (error: any) {
        log.error(`Error listing sprites: ${error.message}`);
        return new Response(JSON.stringify({ error: "Internal server error" }), {
          status: 500,
          headers: CORS_HEADERS
        });
      }
    }
  },
  "/sprite-sheets": {
    GET: async (req: Request) => {
      try {
        const templates = await assetCache.get("spriteSheetTemplates") as any[];
        if (!templates || templates.length === 0) {
          return new Response(JSON.stringify({ spriteSheets: [] }), {
            status: 200,
            headers: CORS_HEADERS
          });
        }

        // Equipment sheets are strips of frames; editors show the matching item
        // icon instead when one exists ("wooden staff" -> "wooden_staff").
        const icons = (await assetCache.get("icons") as any[]) || [];
        const iconNames = new Set(icons.map((i: any) => String(i.name).toLowerCase()));
        const iconFor = (name: string): string | null => {
          for (const candidate of [name, name.replace(/ /g, "_"), name.replace(/_/g, " ")]) {
            if (iconNames.has(candidate.toLowerCase())) return candidate;
          }
          return null;
        };

        const spriteSheets = templates.map((t: any) => ({
          name: t.name,
          slot: t.slot || "other",
          icon: iconFor(t.name),
          hasTemplate: t.template !== null,
          hasImage: t.image !== null
        }));

        return new Response(JSON.stringify({ spriteSheets }), {
          status: 200,
          headers: CORS_HEADERS
        });
      } catch (error: any) {
        log.error(`Error listing sprite sheets: ${error.message}`);
        return new Response(JSON.stringify({ error: "Internal server error" }), {
          status: 500,
          headers: CORS_HEADERS
        });
      }
    }
  },
} as Record<string, any>;

const serverPort = parseInt(process.env.WEBSRV_INTERNAL_PORT || "") || 8082;

Bun.serve({
    hostname: "127.0.0.1",
    port: serverPort,
    development: false,
    reusePort: true,
    ...getInternalServerOptions(process.env.TLS_CERT_PATH!, process.env.TLS_KEY_PATH!, process.env.TLS_CA_PATH),
  async fetch(req: Request, server: any) {
    const url = tryParseURL(req.url);
    if (!url) {
      return new Response(JSON.stringify({ message: "Invalid request" }), { status: 400 });
    }
    const address = server.requestIP(req);
    if (!address) {
      return new Response(JSON.stringify({ message: "Invalid request" }), { status: 400 });
    }

    const route = routes[url.pathname as keyof typeof routes];
    // Handle CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, Range",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    // Block potentially dangerous HTTP methods
    if (req.method === "CONNECT" || req.method === "TRACE" || req.method === "TRACK") {
      return new Response("Forbidden", { status: 403 });
    }

    // Restrict direct ip access to the webserver (only in production)
    if (process.env.DOMAIN && process.env.DOMAIN !== "http://localhost" && process.env.DOMAIN?.replace(/https?:\/\//, "") !== url.host) {
      log.debug(`Domain mismatch: expected "${process.env.DOMAIN?.replace(/https?:\/\//, "")}", got "${url.host}"`);
      return new Response(JSON.stringify({ message: "Invalid request" }), { status: 403 });
    }

    // If route exists, handle it
    if (route) {
      const handler = route[req.method as keyof typeof route] ?? (req.method === "HEAD" ? route["GET"] : undefined);
      if (handler) return handler(req);
    }

    // API routes should NOT fall back to static file serving
    const apiRoutes = ["/worldmap", "/icon", "/sprite", "/sprite-sheet-template", "/sprite-sheet-image", "/tileset", "/map-chunk", "/audio", "/audios", "/sprites", "/tile-sounds", "/tileset-list"];
    if (apiRoutes.includes(url.pathname)) {
      return new Response(JSON.stringify({ error: "Route not found" }), {
        status: 404,
        headers: CORS_HEADERS
      });
    }

    // All assets are served from the startup cache via the routes above -
    // there is intentionally no static file fallback to disk.
    // Unknown routes redirect to homepage
    return Response.redirect("/", 301);
  },
});

startHttpsServers({
  name: "Asset Server",
  sslEnabled: process.env.HTTP_USE_SSL === "true",
  httpPort: parseInt(process.env.WEBSRV_PORT || "") || 80,
  httpsPort: parseInt(process.env.WEBSRV_PORTSSL || "") || 443,
  internalPort: serverPort,
  certPath: process.env.TLS_CERT_PATH,
  keyPath: process.env.TLS_KEY_PATH,
  caPath: process.env.TLS_CA_PATH,
  log,
});

function tryParseURL(url: string) : URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

// Initialize assets (tilesets and maps)
await initializeAssets();

const readyTimeMs = performance.now() - now;
log.success(`Asset Server ready in ${(readyTimeMs / 1000).toFixed(3)}s (${readyTimeMs.toFixed(0)}ms)`);