import crypto from "crypto";
import fs from "fs";
import path from "path";

export type MapKind = "map" | "world";
export interface CreateMapRequest { name: string; kind: MapKind; width: number; height: number; infinite: boolean; tilesets: string[] }

/** A map's name: lower case letters, digits, - and _, starting with a letter or digit (chat commands lower-case it). */
export const MAP_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;
export const TILE_SIZE = 16;
/** A map's size in tiles. */
export const MAP_MIN = 16, MAP_MAX = 1024;
/** A world's: whole chunks of WORLD_CHUNK tiles (the client's chunk size for 16 px tiles), WORLD_PACK chunks to a pack. */
export const WORLD_CHUNK = 64, WORLD_PACK = 16, WORLD_MIN = 64, WORLD_MAX = 16384;
export const MAX_TILESETS = 16;

/** The tile layers every new map has, top to bottom of the list as the house maps and the worlds have them. */
const TILE_LAYERS: Array<{ name: string; role: "tiles" | "nopvp" | "collision"; visible: boolean; locked?: boolean; properties?: any[] }> = [
  { name: "Ground", role: "tiles", visible: true },
  { name: "Cliffs/Objects", role: "tiles", visible: true },
  { name: "Details (Below Player 1)", role: "tiles", visible: true },
  { name: "Details (Below Player 2)", role: "tiles", visible: true },
  { name: "Details (Above Player 1)", role: "tiles", visible: true, properties: [{ name: "shadows", type: "bool", value: true }] },
  { name: "Details (Above Player 2)", role: "tiles", visible: true, properties: [{ name: "shadows", type: "bool", value: true }] },
  { name: "nopvpzone", role: "nopvp", visible: false, locked: true, properties: [{ name: "nopvp", type: "bool", value: true }] },
  { name: "Collisions", role: "collision", visible: false, properties: [{ name: "collision", type: "bool", value: true }] },
];
const OBJECT_LAYERS: Array<{ name: string; visible: boolean; locked?: boolean }> = [
  { name: "Warps", visible: true, locked: true },
  { name: "Graveyards", visible: true, locked: true },
  { name: "Particles", visible: false },
];

export function checkCreateMap(req: any, taken: (name: string) => boolean, images: Set<string>): string | null {
  if (!req || typeof req.name !== "string" || !MAP_NAME_RE.test(req.name)) return "The name may hold lower case letters, digits, - and _ only, up to 48, starting with a letter or digit.";
  if (req.name.endsWith(".world") || taken(req.name)) return `A map named ${req.name} already exists.`;
  if (req.kind !== "map" && req.kind !== "world") return "Make a map or a world.";
  const { width, height } = req;
  if (req.kind === "map") {
    if (![width, height].every(n => Number.isInteger(n) && n >= MAP_MIN && n <= MAP_MAX)) return `A map is ${MAP_MIN} to ${MAP_MAX} tiles each way.`;
  } else {
    if (![width, height].every(n => Number.isInteger(n) && n >= WORLD_MIN && n <= WORLD_MAX && n % WORLD_CHUNK === 0)) return `A world is ${WORLD_MIN} to ${WORLD_MAX} tiles each way, in steps of ${WORLD_CHUNK}.`;
    if (req.infinite) return "A world has a fixed size: it cannot be infinite.";
  }
  if (typeof req.infinite !== "boolean") return "Say whether the map is infinite.";
  if (!Array.isArray(req.tilesets) || req.tilesets.length === 0 || req.tilesets.length > MAX_TILESETS) return `Pick 1 to ${MAX_TILESETS} tilesets.`;
  if (new Set(req.tilesets).size !== req.tilesets.length) return "A tileset is picked twice.";
  for (const t of req.tilesets) if (typeof t !== "string" || !images.has(t)) return `There is no tileset ${t}.`;
  return null;
}

const stem = (file: string) => path.basename(String(file)).replace(/\.[^.]+$/, "").toLowerCase();

/** A PNG's size from its header, or null when it is not a PNG. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || sig.some((b, i) => bytes[i] !== b)) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: dv.getUint32(16), height: dv.getUint32(20) };
}

export function tilesetDefinitions(files: string[], known: any[], sizeOf: (file: string) => { width: number; height: number } | null): { tilesets: any[] } | { error: string } {
  const out: any[] = [];
  let firstgid = 1;
  for (const file of files) {
    const key = stem(file);
    const best = known
      .filter(t => t && stem(t.image ?? t.name ?? "") === key && Number.isInteger(t.tilecount) && t.tilecount > 0)
      .sort((a, b) => (b.tiles?.length ?? 0) - (a.tiles?.length ?? 0))[0];
    let def: any;
    if (best) {
      def = structuredClone(best);
      delete def.firstgid;
      def.image = `../tilesets/${path.basename(file)}`;
    } else {
      const size = sizeOf(file);
      if (!size) return { error: `The picture of ${file} could not be read.` };
      const columns = Math.floor(size.width / TILE_SIZE), rows = Math.floor(size.height / TILE_SIZE);
      if (columns < 1 || rows < 1) return { error: `${file} is smaller than one tile.` };
      def = {
        columns, image: `../tilesets/${path.basename(file)}`, imageheight: size.height, imagewidth: size.width, margin: 0,
        name: key, spacing: 0, tilecount: columns * rows, tileheight: TILE_SIZE, tilewidth: TILE_SIZE,
      };
    }
    out.push({ firstgid, ...def });
    firstgid += def.tilecount;
  }
  return { tilesets: out };
}

/** A blank Tiled map: every tile layer all 0, the object layers empty. */
export function blankTiledMap(req: CreateMapRequest, tilesets: any[]): any {
  const { width, height } = req, area = width * height;
  let id = 0;
  const layers: any[] = TILE_LAYERS.map(l => ({
    data: new Array(area).fill(0), height, id: ++id, name: l.name, opacity: 1, type: "tilelayer", visible: l.visible, width, x: 0, y: 0,
    ...(l.locked ? { locked: true } : {}), ...(l.properties ? { properties: l.properties } : {}),
  }));
  for (const l of OBJECT_LAYERS) layers.push({ draworder: "topdown", id: ++id, name: l.name, objects: [], opacity: 1, type: "objectgroup", visible: l.visible, x: 0, y: 0, ...(l.locked ? { locked: true } : {}) });
  return {
    compressionlevel: -1, height, infinite: req.infinite, layers, nextlayerid: id + 1, nextobjectid: 1, orientation: "orthogonal",
    renderorder: "right-down", tiledversion: "1.12.2", tileheight: TILE_SIZE, tilewidth: TILE_SIZE, tilesets, type: "map", version: "1.10", width,
  };
}

const xxh64 = (data: Uint8Array): bigint => BigInt.asUintN(64, BigInt(Bun.hash.xxHash64(data)));
const hex64 = (v: bigint) => v.toString(16).padStart(16, "0");
const BITS_MAGIC = 0x42574646, PACK_MAGIC = 0x50574646, FORMAT_VERSION = 1, BITS_HEADER = 32, PACK_HEADER = 64, TABLE_ENTRY = 32;

/** An empty bitset file (role 1 collision, 2 no-pvp), its body hash sealed in its header. */
export function blankBitset(chunkSize: number, chunksX: number, chunksY: number, role: number): { bytes: Uint8Array; hash: bigint } {
  const bytes = new Uint8Array(BITS_HEADER + chunksX * chunksY * ((chunkSize * chunkSize) >>> 3));
  const dv = new DataView(bytes.buffer);
  dv.setUint32(0, BITS_MAGIC, true);
  dv.setUint16(4, FORMAT_VERSION, true);
  dv.setUint16(6, BITS_HEADER, true);
  dv.setUint16(8, chunkSize, true);
  dv.setUint16(10, chunksX, true);
  dv.setUint16(12, chunksY, true);
  dv.setUint16(14, role, true);
  const hash = xxh64(bytes.subarray(BITS_HEADER));
  dv.setBigUint64(16, hash, true);
  return { bytes, hash };
}

/** A pack with no records: every chunk empty (offset 0, the hash of no bytes). */
export function blankPack(px: number, py: number, chunkSize: number, packChunks: number, tileLayerCount: number, generationId: bigint): { bytes: Uint8Array; hash: bigint } {
  const count = packChunks * packChunks, bytes = new Uint8Array(PACK_HEADER + count * TABLE_ENTRY), dv = new DataView(bytes.buffer);
  const empty = xxh64(new Uint8Array(0)), hashes = new Uint8Array(count * 8), hv = new DataView(hashes.buffer);
  for (let i = 0; i < count; i++) {
    dv.setBigUint64(PACK_HEADER + i * TABLE_ENTRY + 16, empty, true);
    hv.setBigUint64(i * 8, empty, true);
  }
  const hash = xxh64(hashes);
  dv.setUint32(0, PACK_MAGIC, true);
  dv.setUint16(4, FORMAT_VERSION, true);
  dv.setUint16(6, PACK_HEADER, true);
  dv.setUint16(8, px, true);
  dv.setUint16(10, py, true);
  dv.setUint16(12, chunkSize, true);
  dv.setUint16(14, packChunks, true);
  dv.setUint16(16, tileLayerCount, true);
  dv.setUint32(20, 0, true);
  dv.setBigUint64(24, generationId, true);
  dv.setBigUint64(32, hash, true);
  return { bytes, hash };
}

/** Write a blank world into `dir` (made here; it must not exist). Its spawn is its middle. */
export function writeBlankWorld(dir: string, req: CreateMapRequest, tilesets: any[]): void {
  const cs = WORLD_CHUNK, pc = WORLD_PACK, chunksX = req.width / cs, chunksY = req.height / cs;
  const packsX = Math.ceil(chunksX / pc), packsY = Math.ceil(chunksY / pc);
  const genHex = crypto.randomBytes(8).toString("hex"), generationId = BigInt(`0x${genHex}`);
  let id = 0;
  const layers: any[] = TILE_LAYERS.map((l, tileIndex) => ({
    id: ++id, name: l.name, type: "tilelayer", tileIndex, zIndex: tileIndex, role: l.role, visible: l.visible,
    ...(l.locked ? { locked: true } : {}), ...(l.properties ? { properties: l.properties } : {}),
  }));
  for (const l of OBJECT_LAYERS) layers.push({ id: ++id, name: l.name, type: "objectgroup", visible: l.visible, ...(l.locked ? { locked: true } : {}), draworder: "topdown" });

  // written to a directory beside it, renamed into place once whole: a world is never seen half made
  const tmp = `${dir}.tmp-${genHex}`;
  fs.mkdirSync(path.join(tmp, "packs"), { recursive: true });
  try {
    const packs: any[] = [];
    for (let py = 0; py < packsY; py++) for (let px = 0; px < packsX; px++) {
      const pack = blankPack(px, py, cs, pc, TILE_LAYERS.length, generationId);
      const file = `packs/r${px}_${py}.ffp`;
      fs.writeFileSync(path.join(tmp, file), pack.bytes);
      packs.push({ px, py, file, packHash: hex64(pack.hash), packRev: 0 });
    }
    const collision = blankBitset(cs, chunksX, chunksY, 1), nopvp = blankBitset(cs, chunksX, chunksY, 2);
    fs.writeFileSync(path.join(tmp, "collision.bits"), collision.bytes);
    fs.writeFileSync(path.join(tmp, "nopvp.bits"), nopvp.bytes);
    const manifest = {
      format: "ffworld", formatVersion: FORMAT_VERSION, id: req.name, generationId: genHex, worldRev: 0,
      width: req.width, height: req.height, tilewidth: TILE_SIZE, tileheight: TILE_SIZE, chunkSize: cs, packChunks: pc,
      chunksX, chunksY, packsX, packsY, orientation: "orthogonal", renderorder: "right-down", layers, tilesets,
      bitsets: { collision: { file: "collision.bits", hash: hex64(collision.hash) }, nopvp: { file: "nopvp.bits", hash: hex64(nopvp.hash) } },
      packs, spawn: { x: (req.width * TILE_SIZE) / 2, y: (req.height * TILE_SIZE) / 2 }, nextObjectId: 1, objects: [],
      warps: null, graveyards: null, source: { generator: "map-editor", mode: "blank" },
    };
    fs.writeFileSync(path.join(tmp, "manifest.json"), `${JSON.stringify(manifest, null, 1)}\n`);
    fs.renameSync(tmp, dir);
  } catch (error) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw error;
  }
}
