import fs from "fs";
import path from "path";
import zlib from "zlib";
import crypto from "crypto";
import log from "./logger";
import { cleanZones, type MapZone } from "./zones";

const PACK_MAGIC = 0x50574646; // "FFWP"
const PACK_HEADER_BYTES = 64;
const TABLE_ENTRY_BYTES = 32;
const FORMAT_VERSION = 1;
const BLOCK_HEADER_BYTES = 8;
const ENC_FILL = 1;
const ENC_BIT = 2;
const ENC_U16 = 3;
const ENC_U32 = 4;
const CODEC_NONE = 0;
const CODEC_ZLIB = 1;

// The files of a world the game server keeps a copy of (never the packs).
export const WORLD_SYNC_FILES = ["manifest.json", "collision.bits", "nopvp.bits"] as const;
export type WorldSyncFile = typeof WORLD_SYNC_FILES[number];

interface PackEntry {
  offset: number;
  storedLength: number;
  rawLength: number;
  codec: number;
  layerMask: number;
}

interface WorldTileLayer {
  name: string;
  zIndex: number;
  tileIndex: number;
  visible: boolean;
}

export interface World {
  id: string;
  // The name the map is known by everywhere else: "<id>.json"
  name: string;
  dir: string;
  manifest: any;
  // Changes whenever the world is regenerated: part of every chunk cache key
  checksum: string;
  width: number;
  height: number;
  chunkSize: number;
  chunksX: number;
  chunksY: number;
  packChunks: number;
  tileLayerCount: number;
  // Tile layers in the order the map lists them (the order of a chunk's layers)
  layers: WorldTileLayer[];
  fileHashes: Record<WorldSyncFile, string>;
  // The table of each pack read so far, with the file's size and time when it was read
  packTables: Map<string, PackTable>;
  manifestStamp: FileStamp;
}

interface FileStamp {
  size: number;
  mtimeMs: number;
}

interface PackTable extends FileStamp {
  entries: PackEntry[];
}

const stampOf = (stat: fs.Stats): FileStamp => ({ size: stat.size, mtimeMs: stat.mtimeMs });
const sameStamp = (a: FileStamp, b: FileStamp): boolean => a.size === b.size && a.mtimeMs === b.mtimeMs;

const worlds = new Map<string, World>();

function sha256(data: Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function isPositiveInt(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

export function openWorld(dir: string, id: string): World {
  const manifestStamp = stampOf(fs.statSync(path.join(dir, "manifest.json")));
  const manifestBytes = fs.readFileSync(path.join(dir, "manifest.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf-8"));

  if (manifest?.format !== "ffworld") throw new Error("manifest.json is not a world manifest");
  if (manifest.formatVersion !== FORMAT_VERSION) throw new Error(`unsupported world format version ${manifest.formatVersion}`);

  const { width, height, chunkSize, packChunks } = manifest;
  if (!isPositiveInt(width) || !isPositiveInt(height) || !isPositiveInt(chunkSize) || !isPositiveInt(packChunks)) {
    throw new Error("manifest.json has no valid size");
  }
  if (chunkSize % 8 !== 0 || width % chunkSize !== 0 || height % chunkSize !== 0) {
    throw new Error("the world size is not a whole number of chunks");
  }
  if (!Array.isArray(manifest.layers) || !Array.isArray(manifest.packs)) throw new Error("manifest.json has no layers or packs");

  const layers: WorldTileLayer[] = [];
  manifest.layers.forEach((layer: any, index: number) => {
    if (layer?.type !== "tilelayer") return;
    if (!Number.isInteger(layer.tileIndex) || layer.tileIndex < 0) throw new Error(`tile layer ${layer.name} has no tileIndex`);
    layers.push({ name: layer.name, zIndex: layer.zIndex === undefined ? index : layer.zIndex, tileIndex: layer.tileIndex, visible: layer.visible !== false });
  });
  const tileLayerCount = layers.length;
  if (tileLayerCount === 0 || tileLayerCount > 16) throw new Error(`a world needs 1 to 16 tile layers, got ${tileLayerCount}`);
  const seen = new Set(layers.map(l => l.tileIndex));
  if (seen.size !== tileLayerCount || Math.max(...seen) !== tileLayerCount - 1) throw new Error("tile layer tileIndex values must be 0..n-1");

  const packsX = Math.ceil(width / chunkSize / packChunks);
  const packsY = Math.ceil(height / chunkSize / packChunks);
  for (let py = 0; py < packsY; py++) {
    for (let px = 0; px < packsX; px++) {
      if (!fs.existsSync(packPath(dir, px, py))) throw new Error(`pack r${px}_${py}.ffp is missing`);
    }
  }

  const fileHashes = {} as Record<WorldSyncFile, string>;
  for (const file of WORLD_SYNC_FILES) {
    fileHashes[file] = file === "manifest.json" ? sha256(manifestBytes) : sha256(fs.readFileSync(path.join(dir, file)));
  }

  return {
    id,
    name: `${id}.json`,
    dir,
    manifest,
    checksum: fileHashes["manifest.json"],
    width,
    height,
    chunkSize,
    chunksX: width / chunkSize,
    chunksY: height / chunkSize,
    packChunks,
    tileLayerCount,
    layers,
    fileHashes,
    packTables: new Map(),
    manifestStamp,
  };
}

/** What changed in a world's tiles: the chunks, or "all" when the world's layers, tilesets or size changed. */
export type WorldTileChange = { chunkX: number; chunkY: number }[] | "all";
type WorldChangeListener = (world: World, change: WorldTileChange) => void;
const changeListeners: WorldChangeListener[] = [];

/** Calls `listener` after a world's tiles changed: an editor save here, or a save by another program on disk. */
export function onWorldTilesChanged(listener: WorldChangeListener): void {
  changeListeners.push(listener);
}

function tilesChanged(world: World, change: WorldTileChange): void {
  if (change !== "all" && change.length === 0) return;
  for (const listener of changeListeners) {
    try {
      listener(world, change);
    } catch (e: any) {
      log.error(`World ${world.name}: ${e?.message ?? e}`);
    }
  }
}

function changedChunks(before: any, after: World): WorldTileChange {
  const same = (key: string) => JSON.stringify(before?.[key]) === JSON.stringify(after.manifest[key]);
  if (!same("layers") || !same("tilesets") || !same("width") || !same("height") || !same("chunkSize") || !same("packChunks")) return "all";
  const old = new Map<string, string>((before.packs ?? []).map((p: any) => [`${p.px}_${p.py}`, p.packHash]));
  const pc = after.packChunks, chunks: { chunkX: number; chunkY: number }[] = [];
  for (const pack of after.manifest.packs) {
    if (old.get(`${pack.px}_${pack.py}`) === pack.packHash) continue;
    for (let ly = 0; ly < pc; ly++) for (let lx = 0; lx < pc; lx++) {
      const chunkX = pack.px * pc + lx, chunkY = pack.py * pc + ly;
      if (chunkX < after.chunksX && chunkY < after.chunksY) chunks.push({ chunkX, chunkY });
    }
  }
  return chunks;
}

function refreshWorld(world: World): void {
  let stamp: FileStamp;
  try {
    stamp = stampOf(fs.statSync(path.join(world.dir, "manifest.json")));
  } catch {
    return;
  }
  if (sameStamp(stamp, world.manifestStamp)) return;
  try {
    const fresh = openWorld(world.dir, world.id);
    const before = world.manifest;
    Object.assign(world, fresh);
    log.info(`World ${world.name} changed on disk: read again (revision ${world.manifest.worldRev ?? 0})`);
    tilesChanged(world, changedChunks(before, world));
  } catch (e: any) {
    world.manifestStamp = stamp;
    log.error(`World ${world.name} changed on disk but cannot be read: ${e?.message ?? e}. Keeping the loaded copy.`);
  }
}

function packPath(dir: string, px: number, py: number): string {
  return path.join(dir, "packs", `r${px}_${py}.ffp`);
}

export function loadWorlds(mapDir: string, tiledMapNames: Set<string>): void {
  const now = performance.now();
  worlds.clear();
  if (!fs.existsSync(mapDir)) return;

  for (const entry of fs.readdirSync(mapDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith(".world")) continue;
    const id = entry.name.slice(0, -".world".length);
    if (!id) continue;
    if (tiledMapNames.has(`${id}.json`)) {
      log.error(`World ${entry.name} skipped: ${id}.json is already a map. Remove one of the two.`);
      continue;
    }
    try {
      const world = openWorld(path.join(mapDir, entry.name), id);
      const mended = mendWorld(world);
      if (mended > 0) log.warn(`World ${entry.name}: a save had been cut short. ${mended} pack(s) were taken as they are and the collision data rebuilt from them.`);
      worlds.set(world.name, world);
      log.debug(`Loaded world: ${entry.name} (${world.width} x ${world.height} tiles)`);
    } catch (e: any) {
      log.error(`World ${entry.name} skipped: ${e?.message ?? e}`);
    }
  }

  if (worlds.size > 0) log.success(`Loaded ${worlds.size} world(s) in ${(performance.now() - now).toFixed(2)}ms`);
}

/** A world just made in the maps folder (modules/mapcreate.ts), taken in like those found at start. */
export function addWorld(mapDir: string, id: string): World {
  const world = openWorld(path.join(mapDir, `${id}.world`), id);
  mendWorld(world);
  worlds.set(world.name, world);
  return world;
}

// mapName with or without ".json". A world changed on disk since it was read is read again first.
export function getWorld(mapName: string): World | undefined {
  const world = worlds.get(mapName.endsWith(".json") ? mapName : `${mapName}.json`);
  if (world) refreshWorld(world);
  return world;
}

export function listWorlds(): World[] {
  const all = [...worlds.values()];
  for (const world of all) refreshWorld(world);
  return all;
}

export function readWorldFile(world: World, file: WorldSyncFile): Buffer {
  return fs.readFileSync(path.join(world.dir, file));
}

function readAt(fd: number, length: number, position: number): Buffer {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const n = fs.readSync(fd, buffer, read, length - read, position + read);
    if (n <= 0) throw new Error("unexpected end of pack file");
    read += n;
  }
  return buffer;
}

function readPackTable(world: World, fd: number, px: number, py: number): PackEntry[] {
  const count = world.packChunks * world.packChunks;
  const head = readAt(fd, PACK_HEADER_BYTES + count * TABLE_ENTRY_BYTES, 0);

  if (head.readUInt32LE(0) !== PACK_MAGIC) throw new Error("not a pack file");
  if (head.readUInt16LE(4) !== FORMAT_VERSION) throw new Error(`unsupported pack format version ${head.readUInt16LE(4)}`);
  if (head.readUInt16LE(6) !== PACK_HEADER_BYTES) throw new Error("unexpected pack header size");
  if (head.readUInt16LE(8) !== px || head.readUInt16LE(10) !== py) throw new Error("the pack belongs to another place of the world");
  if (head.readUInt16LE(12) !== world.chunkSize || head.readUInt16LE(14) !== world.packChunks || head.readUInt16LE(16) !== world.tileLayerCount) {
    throw new Error("the pack does not match the manifest");
  }

  const entries: PackEntry[] = [];
  for (let i = 0; i < count; i++) {
    const e = PACK_HEADER_BYTES + i * TABLE_ENTRY_BYTES;
    entries.push({
      offset: head.readUInt32LE(e),
      storedLength: head.readUInt32LE(e + 4),
      rawLength: head.readUInt32LE(e + 8),
      codec: head.readUInt8(e + 12),
      layerMask: head.readUInt16LE(e + 14),
    });
  }
  return entries;
}

export function readChunkTiles(world: World, chunkX: number, chunkY: number): number[][] {
  const area = world.chunkSize * world.chunkSize;
  const tiles: number[][] = [];
  for (let i = 0; i < world.tileLayerCount; i++) tiles.push(new Array(area).fill(0));

  if (chunkX < 0 || chunkY < 0 || chunkX >= world.chunksX || chunkY >= world.chunksY) return tiles;

  const px = Math.floor(chunkX / world.packChunks);
  const py = Math.floor(chunkY / world.packChunks);
  const key = `${px}_${py}`;
  const index = (chunkY - py * world.packChunks) * world.packChunks + (chunkX - px * world.packChunks);

  let stored: Buffer;
  let entry: PackEntry;
  const fd = fs.openSync(packPath(world.dir, px, py), "r");
  try {
    // A pack rewritten since its table was read (by another program) has its records elsewhere: read the table again
    const stamp = stampOf(fs.fstatSync(fd));
    let table = world.packTables.get(key);
    if (!table || !sameStamp(table, stamp)) {
      table = { ...stamp, entries: readPackTable(world, fd, px, py) };
      world.packTables.set(key, table);
    }
    entry = table.entries[index]!;
    if (entry.offset === 0) return tiles;
    stored = readAt(fd, entry.storedLength, entry.offset);
  } finally {
    fs.closeSync(fd);
  }

  let raw: Buffer;
  if (entry.codec === CODEC_ZLIB) raw = zlib.inflateSync(stored);
  else if (entry.codec === CODEC_NONE) raw = stored;
  else throw new Error(`unknown chunk codec ${entry.codec}`);
  if (raw.length !== entry.rawLength) throw new Error("chunk record has the wrong length");

  let o = 0;
  for (let i = 0; i < world.tileLayerCount; i++) {
    if (!(entry.layerMask & (1 << i))) continue;
    if (o + BLOCK_HEADER_BYTES > raw.length) throw new Error("chunk record is cut short");
    const encoding = raw.readUInt8(o);
    const value = raw.readUInt32LE(o + 4);
    o += BLOCK_HEADER_BYTES;
    const layer = tiles[i]!;

    if (encoding === ENC_FILL) {
      layer.fill(value);
    } else if (encoding === ENC_BIT) {
      if (o + (area >>> 3) > raw.length) throw new Error("chunk record is cut short");
      for (let k = 0; k < area; k++) if ((raw[o + (k >>> 3)]! >>> (k & 7)) & 1) layer[k] = value;
      o += area >>> 3;
    } else if (encoding === ENC_U16) {
      if (o + area * 2 > raw.length) throw new Error("chunk record is cut short");
      for (let k = 0; k < area; k++) layer[k] = raw.readUInt16LE(o + k * 2);
      o += area * 2;
    } else if (encoding === ENC_U32) {
      if (o + area * 4 > raw.length) throw new Error("chunk record is cut short");
      for (let k = 0; k < area; k++) layer[k] = raw.readUInt32LE(o + k * 4);
      o += area * 4;
    } else {
      throw new Error(`unknown tile encoding ${encoding}`);
    }
  }
  if (o !== raw.length) throw new Error("chunk record has bytes left over");

  return tiles;
}

const ZLIB_LEVEL = 6;
const BITS_HEADER_BYTES = 32;

function xxh64(data: Uint8Array): bigint {
  return BigInt.asUintN(64, BigInt(Bun.hash.xxHash64(data)));
}

function hex64(value: bigint): string {
  return value.toString(16).padStart(16, "0");
}

// The record of one chunk: for each tile layer with a tile, a block in the smallest of four forms.
function encodeChunk(layers: number[][], chunkSize: number): { raw: Buffer; layerMask: number } {
  const area = chunkSize * chunkSize;
  const blocks: Buffer[] = [];
  let layerMask = 0;
  layers.forEach((tiles, index) => {
    const first = tiles[0]! >>> 0;
    let other = 0, bitOk = true, allEqual = true, max = 0, any = false;
    for (let i = 0; i < area; i++) {
      const v = tiles[i]! >>> 0;
      if (v !== first) allEqual = false;
      if (v !== 0) {
        any = true;
        if (v > max) max = v;
        if (other === 0) other = v;
        else if (v !== other) bitOk = false;
      }
    }
    if (!any) return;
    layerMask |= 1 << index;
    const encoding = allEqual ? ENC_FILL : bitOk ? ENC_BIT : max <= 0xffff ? ENC_U16 : ENC_U32;
    const dataBytes = encoding === ENC_FILL ? 0 : encoding === ENC_BIT ? area >>> 3 : encoding === ENC_U16 ? area * 2 : area * 4;
    const block = Buffer.alloc(BLOCK_HEADER_BYTES + dataBytes);
    block[0] = encoding;
    block.writeUInt32LE(encoding === ENC_FILL ? first : encoding === ENC_BIT ? other : 0, 4);
    const o = BLOCK_HEADER_BYTES;
    if (encoding === ENC_BIT) {
      for (let k = 0; k < area; k++) if (tiles[k]! !== 0) block[o + (k >>> 3)]! |= 1 << (k & 7);
    } else if (encoding === ENC_U16) {
      for (let k = 0; k < area; k++) block.writeUInt16LE(tiles[k]!, o + k * 2);
    } else if (encoding === ENC_U32) {
      for (let k = 0; k < area; k++) block.writeUInt32LE(tiles[k]! >>> 0, o + k * 4);
    }
    blocks.push(block);
  });
  return { raw: Buffer.concat(blocks), layerMask };
}

// One bitset block of a chunk: a bit for every tile that any of `layers` has a tile on.
function roleBlock(layers: number[][], chunkSize: number): Buffer {
  const area = chunkSize * chunkSize;
  const block = Buffer.alloc(area >>> 3);
  for (const tiles of layers) for (let k = 0; k < area; k++) if (tiles[k]! !== 0) block[k >>> 3]! |= 1 << (k & 7);
  return block;
}

function writeFileAtomic(file: string, data: Uint8Array): void {
  fs.writeFileSync(`${file}.tmp`, data);
  fs.renameSync(`${file}.tmp`, file);
}

export class WorldSaveError extends Error {}

export function saveWorldChunks(world: World, chunks: any[]): { chunkX: number; chunkY: number }[] {
  // the save builds on the world as it is on disk, not as it was when last read
  refreshWorld(world);
  const cs = world.chunkSize, area = cs * cs, pc = world.packChunks;
  const byName = new Map(world.layers.map(layer => [layer.name, layer]));

  // 1. check, and merge each chunk with what is on disk (the last of two edits of one chunk wins)
  const merged = new Map<string, { chunkX: number; chunkY: number; tiles: number[][] }>();
  for (const chunk of chunks) {
    const chunkX = chunk?.chunkX, chunkY = chunk?.chunkY;
    if (!Number.isInteger(chunkX) || !Number.isInteger(chunkY) || chunkX < 0 || chunkY < 0 || chunkX >= world.chunksX || chunkY >= world.chunksY) {
      throw new WorldSaveError(`chunk ${chunkX},${chunkY} is outside the world`);
    }
    if (chunk.width !== cs || chunk.height !== cs) throw new WorldSaveError(`chunk ${chunkX},${chunkY} is not ${cs} x ${cs} tiles`);
    const key = `${chunkX},${chunkY}`;
    const entry = merged.get(key) ?? { chunkX, chunkY, tiles: readChunkTiles(world, chunkX, chunkY) };
    for (const layer of Array.isArray(chunk.layers) ? chunk.layers : []) {
      const known = byName.get(layer?.name);
      if (!known) continue; // a layer the world does not have, as for any map
      const data = layer.data;
      if (!Array.isArray(data) || data.length !== area) throw new WorldSaveError(`layer ${layer.name} of chunk ${chunkX},${chunkY} does not hold ${area} tiles`);
      for (let k = 0; k < area; k++) {
        const v = data[k];
        if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) throw new WorldSaveError(`layer ${layer.name} of chunk ${chunkX},${chunkY} holds a value that is not a tile`);
      }
      entry.tiles[known.tileIndex] = data.slice();
    }
    merged.set(key, entry);
  }

  // 2. the new record of each chunk, by pack; chunks that did not change drop out
  const byPack = new Map<string, { px: number; py: number; records: Map<number, { stored: Buffer; rawLength: number; layerMask: number; hash: bigint; entry: typeof merged extends Map<string, infer V> ? V : never }> }>();
  for (const entry of merged.values()) {
    const { raw, layerMask } = encodeChunk(entry.tiles, cs);
    const px = Math.floor(entry.chunkX / pc), py = Math.floor(entry.chunkY / pc), key = `${px}_${py}`;
    const pack = byPack.get(key) ?? { px, py, records: new Map() };
    pack.records.set((entry.chunkY - py * pc) * pc + (entry.chunkX - px * pc), {
      stored: raw.length ? zlib.deflateSync(raw, { level: ZLIB_LEVEL }) : raw,
      rawLength: raw.length,
      layerMask,
      hash: xxh64(raw),
      entry,
    });
    byPack.set(key, pack);
  }

  const changed: { chunkX: number; chunkY: number; tiles: number[][] }[] = [];
  const rewritten: { key: string; px: number; py: number; bytes: Buffer; packHash: bigint; packRev: number }[] = [];
  for (const [key, pack] of byPack) {
    const old = fs.readFileSync(packPath(world.dir, pack.px, pack.py));
    const count = pc * pc, tableEnd = PACK_HEADER_BYTES + count * TABLE_ENTRY_BYTES;
    if (old.length < tableEnd || old.readUInt32LE(0) !== PACK_MAGIC) throw new WorldSaveError(`pack r${key}.ffp cannot be read`);

    const parts: Buffer[] = [];
    const table = Buffer.from(old.subarray(PACK_HEADER_BYTES, tableEnd));
    const hashes = Buffer.alloc(count * 8);
    let offset = tableEnd, packRev = 0, any = false;
    for (let i = 0; i < count; i++) {
      const e = i * TABLE_ENTRY_BYTES;
      const record = pack.records.get(i);
      const oldHash = table.readBigUInt64LE(e + 16);
      if (record && record.hash !== oldHash) {
        any = true;
        changed.push(record.entry);
        const rev = table.readUInt32LE(e + 24) + 1;
        table.writeUInt32LE(record.stored.length ? offset : 0, e);
        table.writeUInt32LE(record.stored.length, e + 4);
        table.writeUInt32LE(record.rawLength, e + 8);
        table.writeUInt8(record.stored.length ? CODEC_ZLIB : CODEC_NONE, e + 12);
        table.writeUInt16LE(record.layerMask, e + 14);
        table.writeBigUInt64LE(record.hash, e + 16);
        table.writeUInt32LE(rev, e + 24);
        if (record.stored.length) parts.push(record.stored);
        offset += record.stored.length;
      } else {
        // the record as it is, at its new place
        const oldOffset = table.readUInt32LE(e), length = table.readUInt32LE(e + 4);
        if (oldOffset !== 0) {
          if (oldOffset + length > old.length) throw new WorldSaveError(`pack r${key}.ffp is cut short`);
          parts.push(old.subarray(oldOffset, oldOffset + length));
          table.writeUInt32LE(offset, e);
          offset += length;
        }
      }
      hashes.writeBigUInt64LE(table.readBigUInt64LE(e + 16), i * 8);
      packRev = Math.max(packRev, table.readUInt32LE(e + 24));
    }
    if (!any) continue;
    const header = Buffer.from(old.subarray(0, PACK_HEADER_BYTES));
    const packHash = xxh64(hashes);
    header.writeUInt32LE(packRev, 20);
    header.writeBigUInt64LE(packHash, 32);
    rewritten.push({ key, px: pack.px, py: pack.py, bytes: Buffer.concat([header, table, ...parts]), packHash, packRev });
  }
  if (rewritten.length === 0) return [];

  // 3. write: packs first, then the bitsets and the manifest (a stop in between is mended at the next start)
  for (const pack of rewritten) writeFileAtomic(packPath(world.dir, pack.px, pack.py), pack.bytes);
  commitWorld(world, changed, rewritten);
  const result = changed.map(chunk => ({ chunkX: chunk.chunkX, chunkY: chunk.chunkY }));
  tilesChanged(world, result);
  return result;
}

function layerRoles(world: World): { collision: number[]; nopvp: number[] } {
  const roles = { collision: [] as number[], nopvp: [] as number[] };
  for (const layer of world.manifest.layers) {
    if (layer?.type === "tilelayer" && (layer.role === "collision" || layer.role === "nopvp")) roles[layer.role as "collision" | "nopvp"].push(layer.tileIndex);
  }
  return roles;
}

function commitWorld(world: World, changed: { chunkX: number; chunkY: number; tiles: number[][] }[], packs: { key: string; px: number; py: number; packHash: bigint; packRev: number }[]): void {
  const cs = world.chunkSize, blockBytes = (cs * cs) >>> 3, roles = layerRoles(world);
  const bitsets = (["collision", "nopvp"] as const).map(role => {
    const file = path.join(world.dir, `${role}.bits`);
    const bytes = fs.readFileSync(file);
    if (bytes.length !== BITS_HEADER_BYTES + world.chunksX * world.chunksY * blockBytes) throw new WorldSaveError(`${role}.bits has the wrong length`);
    for (const chunk of changed) {
      roleBlock(roles[role].map(index => chunk.tiles[index]!), cs).copy(bytes, BITS_HEADER_BYTES + (chunk.chunkY * world.chunksX + chunk.chunkX) * blockBytes);
    }
    const hash = xxh64(bytes.subarray(BITS_HEADER_BYTES));
    bytes.writeBigUInt64LE(hash, 16);
    return { role, file, bytes, hash };
  });
  for (const bitset of bitsets) writeFileAtomic(bitset.file, bitset.bytes);

  const manifest = world.manifest;
  for (const pack of packs) {
    const listed = manifest.packs.find((p: any) => p.px === pack.px && p.py === pack.py);
    if (listed) { listed.packHash = hex64(pack.packHash); listed.packRev = pack.packRev; }
    world.packTables.delete(pack.key);
  }
  for (const bitset of bitsets) manifest.bitsets[bitset.role].hash = hex64(bitset.hash);
  manifest.worldRev = (Number(manifest.worldRev) || 0) + 1;
  writeManifest(world, { "collision.bits": sha256(bitsets[0]!.bytes), "nopvp.bits": sha256(bitsets[1]!.bytes) });
}

// The manifest as it is in memory, to disk; the world's file hashes follow.
function writeManifest(world: World, bitsetHashes?: { "collision.bits": string; "nopvp.bits": string }): void {
  const manifestBytes = Buffer.from(`${JSON.stringify(world.manifest, null, 1)}\n`, "utf-8");
  writeFileAtomic(path.join(world.dir, "manifest.json"), manifestBytes);
  // our own write: not a change from outside
  world.manifestStamp = stampOf(fs.statSync(path.join(world.dir, "manifest.json")));
  world.fileHashes = { ...world.fileHashes, ...(bitsetHashes ?? {}), "manifest.json": sha256(manifestBytes) };
  world.checksum = world.fileHashes["manifest.json"];
}

export function saveWorldProperties(world: World, graveyards?: any, warps?: any, zones?: unknown): void {
  // the save builds on the manifest as it is on disk, so objects saved there by another program are kept
  refreshWorld(world);
  const manifest = world.manifest;
  const listOf = (value: any): any[] => Array.isArray(value) ? value : Object.entries(value ?? {}).map(([name, data]: [string, any]) => ({ name, ...data }));
  const number = (value: unknown, what: string): number => {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new WorldSaveError(`${what} is not a number`);
    return n;
  };
  let nextId = Math.max(Number(manifest.nextObjectId) || 1, ...manifest.objects.map((o: any) => (Number(o.id) || 0) + 1));
  const replace = (layerName: string, objects: (old: Map<string, any>) => any[]) => {
    if (!manifest.layers.some((l: any) => l.type === "objectgroup" && l.name === layerName)) {
      manifest.layers.push({ id: Math.max(0, ...manifest.layers.map((l: any) => Number(l.id) || 0)) + 1, name: layerName, type: "objectgroup", visible: true, draworder: "topdown" });
    }
    const old = new Map<string, any>(manifest.objects.filter((o: any) => o.layer === layerName).map((o: any) => [String(o.name), o]));
    const made = objects(old);
    manifest.objects = [...manifest.objects.filter((o: any) => o.layer !== layerName), ...made];
  };

  // everything is built before the manifest is touched: a bad entry refuses the whole save
  const newGraveyards = graveyards === undefined ? null : listOf(graveyards).map((g: any) => ({
    name: String(g?.name ?? ""),
    x: number(g?.position?.x ?? g?.x, `graveyard ${g?.name}: x`),
    y: number(g?.position?.y ?? g?.y, `graveyard ${g?.name}: y`),
  }));
  const newWarps = warps === undefined ? null : listOf(warps).map((w: any) => {
    if (typeof w?.map !== "string" || !w.map) throw new WorldSaveError(`warp ${w?.name} names no map`);
    return {
      name: String(w?.name ?? ""),
      x: number(w?.position?.x, `warp ${w?.name}: position x`),
      y: number(w?.position?.y, `warp ${w?.name}: position y`),
      width: number(w?.size?.width ?? 32, `warp ${w?.name}: width`),
      height: number(w?.size?.height ?? 32, `warp ${w?.name}: height`),
      properties: [
        { name: "map", type: "string", value: w.map },
        { name: "x", type: "int", value: number(w.x, `warp ${w?.name}: x`) },
        { name: "y", type: "int", value: number(w.y, `warp ${w?.name}: y`) },
      ],
    };
  });

  let newZones: MapZone[] | null = null;
  if (zones !== undefined) {
    const cleaned = cleanZones(zones, Number(manifest.width) || world.width, Number(manifest.height) || world.height);
    if ("error" in cleaned) throw new WorldSaveError(cleaned.error);
    newZones = cleaned.zones;
  }

  if (newZones) manifest.zones = newZones;
  if (newGraveyards) {
    replace("Graveyards", old => newGraveyards.map(g => ({ id: old.get(g.name)?.id ?? nextId++, layer: "Graveyards", name: g.name, type: "graveyard", x: g.x, y: g.y, width: 0, height: 0, point: true, properties: [] })));
  }
  if (newWarps) {
    replace("Warps", old => newWarps.map(w => ({ id: old.get(w.name)?.id ?? nextId++, layer: "Warps", name: w.name, type: "warp", x: w.x, y: w.y, width: w.width, height: w.height, properties: w.properties })));
  }
  manifest.nextObjectId = nextId;
  manifest.worldRev = (Number(manifest.worldRev) || 0) + 1;
  writeManifest(world);
}

export function mendWorld(world: World): number {
  const pc = world.packChunks, stale: { key: string; px: number; py: number; packHash: bigint; packRev: number }[] = [];
  for (const listed of world.manifest.packs) {
    const fd = fs.openSync(packPath(world.dir, listed.px, listed.py), "r");
    let head: Buffer;
    try { head = readAt(fd, PACK_HEADER_BYTES, 0); } finally { fs.closeSync(fd); }
    const packHash = head.readBigUInt64LE(32), packRev = head.readUInt32LE(20);
    if (hex64(packHash) !== listed.packHash || packRev !== listed.packRev) stale.push({ key: `${listed.px}_${listed.py}`, px: listed.px, py: listed.py, packHash, packRev });
  }
  const bitsStale = (["collision", "nopvp"] as const).some(role => {
    const fd = fs.openSync(path.join(world.dir, `${role}.bits`), "r");
    try { return hex64(readAt(fd, BITS_HEADER_BYTES, 0).readBigUInt64LE(16)) !== world.manifest.bitsets?.[role]?.hash; } finally { fs.closeSync(fd); }
  });
  if (stale.length === 0 && !bitsStale) return 0;
  const packs = stale.length ? stale : world.manifest.packs.map((p: any) => ({ key: `${p.px}_${p.py}`, px: p.px, py: p.py, packHash: BigInt(`0x${p.packHash}`), packRev: p.packRev }));
  const chunks: { chunkX: number; chunkY: number; tiles: number[][] }[] = [];
  for (const pack of packs) {
    for (let ly = 0; ly < pc; ly++) for (let lx = 0; lx < pc; lx++) {
      const chunkX = pack.px * pc + lx, chunkY = pack.py * pc + ly;
      if (chunkX < world.chunksX && chunkY < world.chunksY) chunks.push({ chunkX, chunkY, tiles: readChunkTiles(world, chunkX, chunkY) });
    }
  }
  commitWorld(world, chunks, packs);
  return packs.length;
}

export function buildWorldChunk(world: World, chunkX: number, chunkY: number, chunkSize: number): string | null {
  if (!Number.isInteger(chunkX) || !Number.isInteger(chunkY) || chunkSize !== world.chunkSize) return null;

  const tiles = readChunkTiles(world, chunkX, chunkY);

  return JSON.stringify({
    chunkX,
    chunkY,
    width: chunkSize,
    height: chunkSize,
    layers: world.layers.map(layer => ({
      name: layer.name,
      zIndex: layer.zIndex,
      data: tiles[layer.tileIndex],
      width: chunkSize,
      height: chunkSize,
    })),
  });
}
