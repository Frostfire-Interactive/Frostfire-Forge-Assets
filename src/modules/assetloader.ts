import path from "path";
import fs from "fs";
import log from "./logger";
import assetCache from "../services/assetCache";
import zlib from "zlib";
import crypto from "crypto";
import os from "os";
import { ChunkedMapBake, TilesetImages, bakeWorldMap, bakeChunkedWorldMap, type ChunkedMap } from "./worldmap";
import { loadWorlds, listWorlds, onWorldTilesChanged, readChunkTiles, type World, type WorldTileChange } from "./worldstore";
import { assetsVersion, contentVersion } from "./assetversion";
import mapChanges from "./mapchanges";

// Load assets path from environment variable or use default
function getAssetPath(): string {
  const customAssetPath = process.env.ASSETS_PATH;

  if (customAssetPath) {
    // If custom path is provided, resolve it properly
    let resolvedPath: string;

    if (path.isAbsolute(customAssetPath)) {
      // Absolute path - use as-is
      resolvedPath = customAssetPath;
    } else {
      // Relative path - resolve from current working directory
      // In Docker, cwd is /app, so relative paths work correctly
      // Locally, cwd is project root, so relative paths also work
      resolvedPath = path.resolve(process.cwd(), customAssetPath);
    }

    if (!fs.existsSync(resolvedPath)) {
      log.error(`Assets directory not found at: ${resolvedPath}`);
      process.exit(1);
    }

    log.info(`Using external assets directory: ${resolvedPath}`);
    return resolvedPath;
  }

  // Default to src/assets
  const defaultPath = path.join(import.meta.dir, "..", "assets");
  if (!fs.existsSync(defaultPath)) {
    log.error(`Assets directory not found at default location: ${defaultPath}`);
    process.exit(1);
  }

  log.info(`Using default assets directory: ${defaultPath}`);
  return defaultPath;
}

const assetPath = getAssetPath();

export function getAssetsPath(): string {
  return assetPath;
}

const TILESETS_PATH = "tilesets";
const MAPS_PATH = "maps";
const ANIMATIONS_PATH = "animations";
const SPRITESHEETS_PATH = "spritesheets";
const SPRITES_PATH = "sprites";
const ICONS_PATH = "icons";
const AUDIO_PATH = "audio";

const assetLoadingStartTime = performance.now();

async function loadTilesets() {
  const now = performance.now();
  const tilesets = [] as TilesetData[];
  const tilesetDir = path.join(assetPath, TILESETS_PATH);
  // .json = Tiled tileset definitions; images (.png, ...) are fetched by the
  // browser client via /tileset?name=<image> (gateway map.ts loadTilesets),
  // so they must be cached too now that serving is cache-only.
  const allowedExtensions = [".json", ".png", ".jpg", ".jpeg", ".webp"];

  if (!fs.existsSync(tilesetDir)) {
    throw new Error(`Tilesets directory not found at ${tilesetDir}`);
  }

  const tilesetFiles = fs.readdirSync(tilesetDir).filter(file => allowedExtensions.includes(path.extname(file).toLowerCase()));
  tilesetFiles.forEach((file) => {

    const tilesetData = fs.readFileSync(path.join(tilesetDir, file));

    const compressedData = zlib.gzipSync(tilesetData);

    const originalSize = tilesetData.length;
    const compressedSize = compressedData.length;
    const ratio = (originalSize / compressedSize).toFixed(2);
    const savings = (((originalSize - compressedSize) / originalSize) * 100).toFixed(2);

    log.debug(`Loaded tileset: ${file}`);
    log.debug(`Compressed tileset: ${file}
  - Original: ${originalSize} bytes
  - Compressed: ${compressedSize} bytes
  - Compression Ratio: ${ratio}x
  - Compression Savings: ${savings}%`);

    // version: a content hash of the file, the /tileset ETag (a tileset edited in place under the same name gets a new
    // one, so the browser's revalidation picks the new image up after a restart)
    tilesets.push({ name: file, data: compressedData, version: crypto.createHash("sha256").update(tilesetData).digest("hex").slice(0, 16) });
  });

  await assetCache.add(
    "tilesets",
    tilesets.map(t => ({
      name: t.name,
      data: t.data.toString("base64"),
      version: t.version
    }))
  );

  const imageCount = tilesets.filter(t => path.extname(t.name).toLowerCase() !== ".json").length;
  log.success(`Loaded ${tilesets.length} tileset file(s) (${tilesets.length - imageCount} definitions, ${imageCount} images) in ${(performance.now() - now).toFixed(2)}ms`);
}

async function loadAudio() {
  const audioCache = [] as AudioData[];
  const now = performance.now();
  const audioDir = path.join(assetPath, AUDIO_PATH);

  const allowedExtensions = [".mp3", ".wav", ".ogg", ".oga", ".m4a", ".webm", ".flac", ".opus"];

  if (!fs.existsSync(audioDir)) {
    log.warn(`Audio directory not found at ${audioDir}, skipping audio loading`);
    await assetCache.add("audio", []);
    return;
  }
  const audioFiles = fs.readdirSync(audioDir).filter(file => allowedExtensions.includes(path.extname(file).toLowerCase()));

  const filteredAudioEntries = audioFiles
    .map(file => ({ file, buffer: fs.readFileSync(path.join(audioDir, file)) }))
    .filter(({ file, buffer }) => buffer !== undefined && allowedExtensions.includes(path.extname(file).toLowerCase()))
    .map(({ file, buffer }) => ({ file, buffer: buffer! }));

  filteredAudioEntries.forEach(({ file, buffer }) => {
    const compressedData = zlib.gzipSync(buffer);
    const originalSize = buffer.length;
    const compressedSize = compressedData.length;
    const ratio = (originalSize / compressedSize).toFixed(2);
    const savings = (((originalSize - compressedSize) / originalSize) * 100).toFixed(2);

    audioCache.push({ name: file, data: compressedData.toString("base64"), version: contentVersion(buffer) });

    log.debug(`Loaded audio: ${file}`);
    log.debug(`Compressed audio: ${file}
  - Original: ${originalSize} bytes
  - Compressed: ${compressedSize} bytes
  - Compression Ratio: ${ratio}x
  - Compression Savings: ${savings}%`);
  });

  await assetCache.add("audio", audioCache);
  log.success(`Loaded ${filteredAudioEntries.length} audio file(s) in ${(performance.now() - now).toFixed(2)}ms`);
}

/** Folder -> slot name. Armor folders are named after the item slot; bodies/heads come from the player folder. */
const SLOT_BY_FOLDER: Record<string, string> = {
  helmet: "helmet",
  shoulderguards: "shoulderguards",
  necklace: "neck",
  neck: "neck",
  gloves: "hands",
  chestplate: "chest",
  boots: "feet",
  pants: "legs",
  weapon: "weapon",
  bodies: "body",
  heads: "head",
  mounts: "mount",
};

function slotFromPath(relativePath: string, templateFile?: string): string {
  const parts = relativePath.split(/[\\/]/).slice(0, -1);
  for (let i = parts.length - 1; i >= 0; i--) {
    const slot = SLOT_BY_FOLDER[(parts[i] ?? "").toLowerCase()];
    if (slot) return slot;
  }
  const name = (templateFile || relativePath).toLowerCase();
  if (name.includes("body")) return "body";
  if (name.includes("head")) return "head";
  return "other";
}

async function loadSpriteSheetTemplates() {
  const now = performance.now();
  const templates = [] as SpriteSheetTemplate[];

  const animationsDir = path.join(assetPath, ANIMATIONS_PATH);
  const spriteSheetDir = path.join(assetPath, SPRITESHEETS_PATH);
  const allowedExtensions = [".json"];

  if (!fs.existsSync(animationsDir)) {
    log.warn(`Animations directory not found at ${animationsDir}, skipping animation template loading`);
    await assetCache.add("spriteSheetTemplates", []);
    return;
  }

  if (!fs.existsSync(spriteSheetDir)) {
    log.warn(`Sprite sheets directory not found at ${spriteSheetDir}, skipping sprite sheet image loading`);
    await assetCache.add("spriteSheetTemplates", []);
    return;
  }

  const templateFiles = fs.readdirSync(animationsDir).filter(file => allowedExtensions.includes(path.extname(file).toLowerCase()));

  if (templateFiles.length === 0) {
    log.warn(`No animation templates found in ${animationsDir}`);
    await assetCache.add("spriteSheetTemplates", []);
    return;
  }

  // Load templates with associated images
  templateFiles.forEach(file => {
    const templatePath = path.join(animationsDir, file);
    const templateData = JSON.parse(fs.readFileSync(templatePath, "utf-8"));

    const templateJson = JSON.stringify(templateData);

    let pngFile = templateData.imageSource;
    let pngPath = path.join(spriteSheetDir, pngFile);

    // Check if file needs directory prefix based on template name (same method as PNG loader)
    const dirPath = path.dirname(pngPath);
    if (file.includes("player_body") && !dirPath.includes("player")) {
      pngFile = path.join("player", "bodies", pngFile);
      pngPath = path.join(spriteSheetDir, pngFile);
    } else if (file.includes("player_head") && !dirPath.includes("player")) {
      pngFile = path.join("player", "heads", pngFile);
      pngPath = path.join(spriteSheetDir, pngFile);
    }

    let imageBuffer: Buffer | null = null;

    if (fs.existsSync(pngPath)) {
      imageBuffer = fs.readFileSync(pngPath);
      log.debug(`Loaded animation template: ${file} with image ${pngFile} (${imageBuffer.length} bytes)`);
    } else {
      log.debug(`Loaded animation template: ${file} (no image - template only, imageSource "${pngFile}" not found)`);
    }

    templates.push({
      name: file.replace(".json", ""),
      template: templateJson,
      image: imageBuffer,
      slot: slotFromPath(pngFile, file),
      templateVersion: contentVersion(templateJson),
      imageVersion: imageBuffer ? contentVersion(imageBuffer) : ""
    });
  });

  // Load PNG images that don't have templates
  function getAllPngFilesRecursive(dir: string, baseDir: string = dir): string[] {
    let results: string[] = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results = results.concat(getAllPngFilesRecursive(fullPath, baseDir));
      } else if (entry.name.endsWith(".png")) {
        const relativePath = path.relative(baseDir, fullPath);
        results.push(relativePath);
      }
    }
    return results;
  }

  const allPngFiles = getAllPngFilesRecursive(spriteSheetDir);
  const templatePngFiles = new Set(templateFiles.map(f => {
    const templatePath = path.join(animationsDir, f);
    const templateData = JSON.parse(fs.readFileSync(templatePath, "utf-8"));
    return templateData.imageSource;
  }));

  allPngFiles.forEach(pngFile => {
    if (templatePngFiles.has(pngFile)) {
      return;
    }

    const pngPath = path.join(spriteSheetDir, pngFile);
    const imageBuffer = fs.readFileSync(pngPath);
    let filename = path.basename(pngFile, ".png");

    // Determine which template to use based on the directory
    let templateToUse = null;
    const dirPath = path.dirname(pngPath);

    if (dirPath.includes('armor')) {
      // Helmet uses armor_head_base, shoulderguards use armor_body_base
      if (dirPath.includes('helmet')) {
        const armorHeadTemplate = templates.find((t: any) => t.name === 'armor_head_base');
        templateToUse = armorHeadTemplate?.template || null;
      } else {
        // All other armor (chestplate, gloves, boots, pants, weapon, etc.) use armor_body_base
        const armorBodyTemplate = templates.find((t: any) => t.name === 'armor_body_base');
        templateToUse = armorBodyTemplate?.template || null;
      }
    } else if (dirPath.includes('mounts')) {
      // Mount sprites use player_mount_base template
      const mountTemplate = templates.find((t: any) => t.name === 'player_mount_base');
      templateToUse = mountTemplate?.template || null;
      // Prefix mount images with 'mount_' to match asset server naming
      filename = `mount_${filename}`;
    }

    templates.push({
      name: filename,
      template: templateToUse,
      image: imageBuffer,
      slot: slotFromPath(pngFile),
      templateVersion: templateToUse ? contentVersion(templateToUse) : "",
      imageVersion: contentVersion(imageBuffer)
    });

    let templateName = 'none';
    if (dirPath.includes('armor')) {
      templateName = dirPath.includes('helmet') ? 'armor_head_base' : 'armor_body_base';
    } else if (dirPath.includes('mounts')) {
      templateName = 'player_mount_base';
    }
    log.debug(`Loaded sprite: ${pngFile} (name: ${filename}, ${imageBuffer.length} bytes, using ${templateToUse ? templateName : 'no'} template)`);
  });

  await assetCache.add("spriteSheetTemplates", templates);
  log.success(`Loaded ${templates.length} sprite sheet(s) (${templateFiles.length} with templates, ${templates.length - templateFiles.length} images only) in ${(performance.now() - now).toFixed(2)}ms`);
  if (templates.length > 0) {
    log.debug(`Available sprite templates: ${templates.map((t: any) => t.name).join(", ")}`);
  }
}

async function loadSprites() {
  const now = performance.now();
  const sprites = [] as SpriteData[];

  const spriteDir = path.join(assetPath, SPRITES_PATH);

  if (!fs.existsSync(spriteDir)) {
    log.warn(`Sprites directory not found at ${spriteDir}, skipping sprite loading`);
    await assetCache.add("sprites", []);
    return;
  }

  const spriteFiles = fs.readdirSync(spriteDir).filter(file => file.endsWith(".png"));

  spriteFiles.forEach(file => {
    const name = file.replace(".png", "");
    const rawData = fs.readFileSync(path.join(spriteDir, file));
    const base64Data = rawData.toString("base64");

    log.debug(`Loaded sprite: ${name}`);

    const compressedData = zlib.gzipSync(base64Data);

    sprites.push({ name, data: compressedData.toString("base64"), version: contentVersion(rawData) });

    const originalSize = base64Data.length;
    const compressedSize = compressedData.length;
    const ratio = (originalSize / compressedSize).toFixed(2);
    const savings = (((originalSize - compressedSize) / originalSize) * 100).toFixed(2);

    log.debug(`Compressed sprite: ${name}
  - Original: ${originalSize} bytes
  - Compressed: ${compressedSize} bytes
  - Compression Ratio: ${ratio}x
  - Compression Savings: ${savings}%`);
  });

  await assetCache.add("sprites", sprites);
  log.success(`Loaded ${sprites.length} sprite(s) in ${(performance.now() - now).toFixed(2)}ms`);
}

async function loadIcons() {
  const now = performance.now();
  const icons = [] as IconData[];

  const iconDir = path.join(assetPath, ICONS_PATH);

  if (!fs.existsSync(iconDir)) {
    log.warn(`Icons directory not found at ${iconDir}, skipping icon loading`);
    await assetCache.add("icons", []);
    return;
  }

  const iconFiles = fs.readdirSync(iconDir).filter(file => file.endsWith(".png"));

  iconFiles.forEach(file => {
    const name = file.replace(".png", "");
    const rawData = fs.readFileSync(path.join(iconDir, file));
    const base64Data = rawData.toString("base64");

    log.debug(`Loaded icon: ${name}`);

    const compressedData = zlib.gzipSync(base64Data);

    icons.push({ name, data: compressedData.toString("base64"), version: contentVersion(rawData) });

    const originalSize = base64Data.length;
    const compressedSize = compressedData.length;
    const ratio = (originalSize / compressedSize).toFixed(2);
    const savings = (((originalSize - compressedSize) / originalSize) * 100).toFixed(2);

    log.debug(`Compressed icon: ${name}
  - Original: ${originalSize} bytes
  - Compressed: ${compressedSize} bytes
  - Compression Ratio: ${ratio}x
  - Compression Savings: ${savings}%`);
  });

  await assetCache.add("icons", icons);
  log.success(`Loaded ${icons.length} icon(s) in ${(performance.now() - now).toFixed(2)}ms`);
}

/**
 * Baked full-map images (maps/<map>.worldmap.png, one pixel per tile; the map generator writes them beside the map):
 * the game's world map view. Cached as raw PNG bytes (base64) with a version (file mtime) for revalidation.
 */
// The world map images (the game's full-map view, M): baked in memory at startup for every loaded map
// (modules/worldmap.ts), so they always match the maps and tilesets on disk. A hand-baked <map>.worldmap.png in
// the maps folder is only used for a map whose bake failed. Nothing is written to disk.
// A world's bake takes seconds (the 10240 x 10240 continent: about 10), so the image is kept between starts in the
// system's temp folder, under a name made of everything it depends on: the world's manifest (which names every
// pack's content), its tileset images and this bake's version. Nothing is written to the assets folder.
const WORLD_BAKE_VERSION = 1;
const worldBakeDir = () => path.join(os.tmpdir(), "frostfire-forge-assets", "worldmaps");

// The kept copy of a world's image: named after everything the image depends on
function worldBakeFile(world: World): string {
  const key = crypto.createHash("sha256").update(`${WORLD_BAKE_VERSION}:${world.checksum}`);
  for (const tileset of world.manifest.tilesets ?? []) {
    const name = path.basename(String(tileset?.image ?? ""));
    const file = path.join(assetPath, TILESETS_PATH, name);
    const stat = name && fs.existsSync(file) ? fs.statSync(file) : null;
    key.update(`:${name}:${stat ? `${stat.size}:${Math.floor(stat.mtimeMs)}` : "missing"}`);
  }
  return path.join(worldBakeDir(), `${world.id}-${key.digest("hex").slice(0, 24)}.png`);
}

// Keeps a world's image for the next start, in place of the copy of an earlier build. The kept copy is only a
// shortcut: a failure to write it changes nothing.
function keepWorldBake(world: World, png: Buffer): void {
  const prefix = `${world.id}-`, file = worldBakeFile(world);
  try {
    fs.mkdirSync(worldBakeDir(), { recursive: true });
    for (const old of fs.readdirSync(worldBakeDir())) {
      // an earlier build of this world (the rest of the name is the 24-character key)
      if (old.startsWith(prefix) && old.length === prefix.length + 28) fs.unlinkSync(path.join(worldBakeDir(), old));
    }
    fs.writeFileSync(`${file}.tmp`, png);
    fs.renameSync(`${file}.tmp`, file);
  } catch { /* no kept copy */ }
}

function chunkedMapOf(world: World): ChunkedMap {
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

function bakeWorldCached(world: World, images: TilesetImages): Buffer {
  const file = worldBakeFile(world);
  try {
    if (fs.existsSync(file)) return fs.readFileSync(file);
  } catch { /* unreadable: bake it */ }
  const { png } = bakeChunkedWorldMap(chunkedMapOf(world), images);
  keepWorldBake(world, png);
  return png;
}

// After a world's tiles changed (an editor save, or a save by another program such as the Tiled extension), its
// image is baked again: only the changed chunks are drawn, over the image as it was, so a save of a few chunks takes
// moments even on the 10240 x 10240 continent. Changes that come close together are baked once.
const worldBakes = new Map<string, ChunkedMapBake>();
const pendingBakes = new Map<string, { change: WorldTileChange; timer: ReturnType<typeof setTimeout> }>();
const WORLD_REBAKE_DELAY_MS = 500;

onWorldTilesChanged((world, change) => {
  const pending = pendingBakes.get(world.id);
  if (pending) clearTimeout(pending.timer);
  const merged: WorldTileChange = change === "all" || pending?.change === "all" ? "all" : [...(pending?.change ?? []), ...change];
  const timer = setTimeout(() => {
    pendingBakes.delete(world.id);
    rebakeWorld(world, merged).catch((e: any) => log.warn(`Could not bake the world map of ${world.name} again: ${e?.message ?? e}`));
  }, WORLD_REBAKE_DELAY_MS);
  pendingBakes.set(world.id, { change: merged, timer });
});

export async function rebakeWorld(world: World, change: WorldTileChange): Promise<void> {
  const now = performance.now();
  // read the tileset images again: a changed one is picked up here as at start
  const images = new TilesetImages(path.join(assetPath, TILESETS_PATH));
  const map = chunkedMapOf(world);

  // Start from the image as it was: kept from the last bake here, or the one being served
  let bake: ChunkedMapBake | null = null;
  if (change !== "all") {
    const kept = worldBakes.get(world.id);
    try {
      if (kept) bake = new ChunkedMapBake(map, images, kept.pixels);
    } catch { bake = null; }
    if (!bake) {
      const entry = ((await assetCache.get("worldmaps") as any[] | null) ?? []).find((m: any) => m.name === world.id);
      if (entry?.data) bake = ChunkedMapBake.fromPng(map, images, Buffer.from(entry.data, "base64"));
    }
  }
  if (!bake) {
    bake = new ChunkedMapBake(map, images);
    change = "all";
  }
  let drawn = 0;
  if (change === "all") bake.drawAll();
  else {
    const seen = new Set<string>();
    for (const c of change) {
      const key = `${c.chunkX},${c.chunkY}`;
      if (seen.has(key)) continue;
      seen.add(key);
      bake.drawChunk(c.chunkX, c.chunkY);
      drawn++;
    }
  }
  worldBakes.set(world.id, bake);

  const png = bake.png();
  const updated = { name: world.id, data: png.toString("base64"), version: crypto.createHash("sha256").update(png).digest("hex").slice(0, 16) };
  const worldMaps = (await assetCache.get("worldmaps") as any[] | null) ?? [];
  const index = worldMaps.findIndex((m: any) => m.name === world.id);
  if (index >= 0) worldMaps[index] = updated;
  else worldMaps.push(updated);
  await assetCache.add("worldmaps", worldMaps);
  keepWorldBake(world, png);
  log.info(`Baked the world map of ${world.id} again (${change === "all" ? "the whole world" : `${drawn} chunk(s)`}) in ${(performance.now() - now).toFixed(0)}ms`);
}

async function loadWorldMaps() {
  const now = performance.now();
  const mapDir = path.join(assetPath, MAPS_PATH);
  const worldMaps: { name: string; data: string; version: string }[] = [];
  const maps = (await assetCache.get("maps") as MapData[] | null) ?? [];
  const images = new TilesetImages(path.join(assetPath, TILESETS_PATH));
  let baked = 0;
  for (const map of maps) {
    const name = map.name.replace(/\.json$/i, "");
    try {
      const png = bakeWorldMap(map.data, images);
      worldMaps.push({ name, data: png.toString("base64"), version: crypto.createHash("sha256").update(png).digest("hex").slice(0, 16) });
      baked++;
    } catch (e: any) {
      log.warn(`Could not bake the world map of ${map.name}: ${e?.message ?? e}`);
    }
  }
  // Worlds (modules/worldstore.ts): baked from their packs, a large one several tiles to a pixel
  for (const world of listWorlds()) {
    try {
      const png = bakeWorldCached(world, images);
      worldMaps.push({ name: world.id, data: png.toString("base64"), version: crypto.createHash("sha256").update(png).digest("hex").slice(0, 16) });
      baked++;
    } catch (e: any) {
      log.warn(`Could not bake the world map of ${world.name}: ${e?.message ?? e}`);
    }
  }
  let fromFiles = 0;
  if (fs.existsSync(mapDir)) {
    for (const file of fs.readdirSync(mapDir).filter(f => f.toLowerCase().endsWith(".worldmap.png"))) {
      const name = file.slice(0, -".worldmap.png".length);
      if (worldMaps.some(m => m.name === name)) continue;
      const full = path.join(mapDir, file);
      worldMaps.push({ name, data: fs.readFileSync(full).toString("base64"), version: String(Math.floor(fs.statSync(full).mtimeMs)) });
      fromFiles++;
    }
  }
  await assetCache.add("worldmaps", worldMaps);
  log.success(`Baked ${baked} world map image(s)${fromFiles ? ` (+${fromFiles} from file)` : ""} in ${(performance.now() - now).toFixed(2)}ms`);
}

/**
 * A map just written to the maps folder (modules/mapcreate.ts): a Tiled map "<name>.json", or a world taken in by
 * worldstore's addWorld first. It joins the maps cache and gets its world map image, as the maps found at start do.
 */
export async function registerNewMap(name: string, world?: World): Promise<void> {
  const images = new TilesetImages(path.join(assetPath, TILESETS_PATH));
  let png: Buffer | null = null;
  if (world) {
    try { png = bakeWorldCached(world, images); } catch (e: any) { log.warn(`Could not bake the world map of ${world.name}: ${e?.message ?? e}`); }
  } else {
    const map = processMapFile(`${name}.json`);
    if (!map) throw new Error(`${name}.json could not be read back`);
    const maps = (await assetCache.get("maps") as MapData[] | null) ?? [];
    maps.push(map);
    await assetCache.add("maps", maps);
    mapChanges.record(map);
    try { png = bakeWorldMap(map.data, images); } catch (e: any) { log.warn(`Could not bake the world map of ${map.name}: ${e?.message ?? e}`); }
  }
  if (png) {
    const worldMaps = (await assetCache.get("worldmaps") as any[] | null) ?? [];
    worldMaps.push({ name, data: png.toString("base64"), version: crypto.createHash("sha256").update(png).digest("hex").slice(0, 16) });
    await assetCache.add("worldmaps", worldMaps);
  }
}

function loadAllMaps() {
  const now = performance.now();
  const mapDir = path.join(assetPath, MAPS_PATH);
  const maps: MapData[] = [];

  if (!fs.existsSync(mapDir)) throw new Error(`Maps directory not found at ${mapDir}`);

  const mapFiles = fs.readdirSync(mapDir).filter(f => f.endsWith(".json"));
  if (mapFiles.length === 0) throw new Error("No maps found in the maps directory");

  for (const file of mapFiles) {
    const map = processMapFile(file);
    if (map) {
      maps.push(map);
    }
  }

  assetCache.add("maps", maps);
  log.success(`Loaded ${maps.length} map(s) in ${(performance.now() - now).toFixed(2)}ms`);

  // Worlds: maps too large for one file, kept as <id>.world directories
  loadWorlds(mapDir, new Set(mapFiles));
}

// Tiled stores "infinite" maps as per-layer `chunks` arrays instead of a flat
// `data` array. The /map-chunk endpoint slices from a flat `layer.data` sized
// width*height, so flatten infinite maps in place. Tiles outside the declared
// map bounds are clipped. This must run AFTER the raw-JSON checksum is computed
// so map-sync between engine and asset server stays stable.
// Apply edited chunks to a finite map: grow the flat storage to fit the edits,
// then (for infinite maps) trim the result back to the tight content bounds so
// empty expansion isn't persisted. Existing tiles and object-group objects are
// shifted by the actual amount the content moved. `bounds` is the editor's claimed
// extent (minTileX/minTileY <= 0, width/height exclusive max). Returns the net
// world shift (in tiles) and the final map dimensions.
export function applyChunksWithRebase(
  mapData: any,
  chunks: any[],
  bounds?: { minTileX?: number; minTileY?: number; width?: number; height?: number; infinite?: boolean } | null
): { shiftX: number; shiftY: number; width: number; height: number } {
  if (!mapData || !Array.isArray(mapData.layers)) {
    return { shiftX: 0, shiftY: 0, width: mapData?.width || 0, height: mapData?.height || 0 };
  }

  const refLayer = mapData.layers.find((l: any) => l.type === "tilelayer" && Array.isArray(l.data));
  const oldWidth = refLayer?.width || mapData.width || 0;
  const oldHeight = refLayer?.height || mapData.height || 0;

  const minTileX = Math.min(0, bounds?.minTileX ?? 0);
  const minTileY = Math.min(0, bounds?.minTileY ?? 0);
  const reqWidth = bounds?.width ?? oldWidth;
  const reqHeight = bounds?.height ?? oldHeight;

  // Provisional grow + shift to make room for the claimed expansion.
  const provShiftX = -minTileX;
  const provShiftY = -minTileY;
  const provWidth = Math.max(reqWidth, oldWidth) + provShiftX;
  const provHeight = Math.max(reqHeight, oldHeight) + provShiftY;

  if (provWidth !== oldWidth || provHeight !== oldHeight || provShiftX > 0 || provShiftY > 0) {
    for (const layer of mapData.layers) {
      if (layer.type !== "tilelayer" || !Array.isArray(layer.data)) continue;
      const ow = layer.width || oldWidth;
      const oh = layer.height || oldHeight;
      const newData = new Array(provWidth * provHeight).fill(0);
      for (let oy = 0; oy < oh; oy++) {
        for (let ox = 0; ox < ow; ox++) {
          const v = layer.data[oy * ow + ox];
          if (!v) continue;
          const nx = ox + provShiftX;
          const ny = oy + provShiftY;
          if (nx >= 0 && nx < provWidth && ny >= 0 && ny < provHeight) {
            newData[ny * provWidth + nx] = v;
          }
        }
      }
      layer.data = newData;
      layer.width = provWidth;
      layer.height = provHeight;
    }
    mapData.width = provWidth;
    mapData.height = provHeight;
  }

  for (const chunk of chunks || []) {
    const cw = chunk.width;
    const ch = chunk.height;
    const startX = chunk.chunkX * cw + provShiftX;
    const startY = chunk.chunkY * ch + provShiftY;
    for (const chunkLayer of chunk.layers || []) {
      const mapLayer = mapData.layers.find((l: any) => l.name === chunkLayer.name);
      if (!mapLayer || !Array.isArray(mapLayer.data)) continue;
      for (let y = 0; y < ch; y++) {
        for (let x = 0; x < cw; x++) {
          const mapX = startX + x;
          const mapY = startY + y;
          if (mapX < 0 || mapX >= provWidth || mapY < 0 || mapY >= provHeight) continue;
          const ci = y * cw + x;
          if (ci < chunkLayer.data.length) {
            mapLayer.data[mapY * provWidth + mapX] = chunkLayer.data[ci];
          }
        }
      }
    }
  }

  let netShiftX = provShiftX;
  let netShiftY = provShiftY;
  let finalWidth = provWidth;
  let finalHeight = provHeight;

  // Trim empty expansion (infinite maps only): shrink back to the tight content
  // bounds. Left/up is only trimmed up to the expansion amount, so intentional
  // empty borders at the original origin are preserved. Use the client's infinite
  // flag when provided (the in-memory map's flag can be stale).
  if ((bounds?.infinite ?? mapData.infinite) === true) {
    let tMinX = Infinity, tMinY = Infinity, tMaxX = -1, tMaxY = -1;
    for (const layer of mapData.layers) {
      if (layer.type !== "tilelayer" || !Array.isArray(layer.data)) continue;
      const w = layer.width;
      const data = layer.data;
      for (let i = 0; i < data.length; i++) {
        if (!data[i]) continue;
        const x = i % w;
        const y = (i - x) / w;
        if (x < tMinX) tMinX = x;
        if (x > tMaxX) tMaxX = x;
        if (y < tMinY) tMinY = y;
        if (y > tMaxY) tMaxY = y;
      }
    }

    if (tMaxX >= 0) {
      const leftTrim = Math.min(tMinX, provShiftX);
      const topTrim = Math.min(tMinY, provShiftY);
      const tightW = (tMaxX + 1) - leftTrim;
      const tightH = (tMaxY + 1) - topTrim;

      if (leftTrim > 0 || topTrim > 0 || tightW < provWidth || tightH < provHeight) {
        for (const layer of mapData.layers) {
          if (layer.type !== "tilelayer" || !Array.isArray(layer.data)) continue;
          const ow = layer.width;
          const old = layer.data;
          const nd = new Array(tightW * tightH).fill(0);
          for (let y = 0; y < tightH; y++) {
            for (let x = 0; x < tightW; x++) {
              const v = old[(y + topTrim) * ow + (x + leftTrim)];
              if (v) nd[y * tightW + x] = v;
            }
          }
          layer.data = nd;
          layer.width = tightW;
          layer.height = tightH;
        }
        mapData.width = tightW;
        mapData.height = tightH;
      }

      finalWidth = tightW;
      finalHeight = tightH;
      netShiftX = provShiftX - leftTrim;
      netShiftY = provShiftY - topTrim;
    }
  }

  if (netShiftX !== 0 || netShiftY !== 0) {
    const dpx = netShiftX * (mapData.tilewidth || 32);
    const dpy = netShiftY * (mapData.tileheight || 32);
    for (const layer of mapData.layers) {
      if (layer.type !== "objectgroup" || !Array.isArray(layer.objects)) continue;
      for (const obj of layer.objects) {
        if (typeof obj.x === "number") obj.x += dpx;
        if (typeof obj.y === "number") obj.y += dpy;
      }
    }
  }

  return { shiftX: netShiftX, shiftY: netShiftY, width: finalWidth, height: finalHeight };
}

export function normalizeInfiniteMap(mapData: any): void {
  if (!mapData || mapData.infinite !== true || !Array.isArray(mapData.layers)) return;

  // The map's declared width/height go stale the moment "infinite" is enabled in
  // Tiled. Derive the true size from the actual painted tiles across all layers
  // (not the 16-aligned chunk bounds) so we don't report empty padding that would
  // render as a black border and let the camera pan into nothing. Origin stays at
  // tile 0,0; any negative-coordinate tiles are clipped.
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
  // Keep mapData.infinite = true so the flag reaches the client/editor. Re-running
  // this is safe: once chunks are flattened away the bounds loop finds none and
  // returns early before touching layer data.
}

function processMapFile(file: string): MapData | null {
  const mapDir = path.join(assetPath, MAPS_PATH);
  const fullPath = path.join(mapDir, file);
  const parsed = tryParse(fs.readFileSync(fullPath, "utf-8"));

  if (!parsed) {
    log.error(`Failed to parse ${file} as a map`);
    return null;
  }

  normalizeInfiniteMap(parsed);

  // Compute serialized form and checksum after normalizeInfiniteMap so sync comparisons match
  const jsonString = JSON.stringify(parsed);
  const compressedData = zlib.gzipSync(jsonString);
  const checksum = crypto.createHash("sha256").update(jsonString).digest("hex");

  log.debug(`Loaded map: ${file}`);
  log.debug(`Compressed map: ${file}
  - Original: ${jsonString.length} bytes
  - Compressed: ${compressedData.length} bytes
  - Compression Ratio: ${(jsonString.length / compressedData.length).toFixed(2)}x
  - Compression Savings: ${(((jsonString.length - compressedData.length) / jsonString.length) * 100).toFixed(2)}%`);

  normalizeInfiniteMap(parsed);

  return {
    name: file,
    data: parsed,
    compressed: compressedData,
    checksum: checksum,
  };
}

function tryParse(data: string): any {
  try {
    return JSON.parse(data);
  } catch (e: any) {
    log.error(e);
    return null;
  }
}

export async function initializeAssets() {
  await loadTilesets();
  await loadSpriteSheetTemplates();
  await loadSprites();
  await loadIcons();
  await loadAudio();
  await loadAssetVersion();
  loadAllMaps();
  await loadWorldMaps();

  const assetLoadingEndTime = performance.now();
  const totalAssetLoadingTime = (assetLoadingEndTime - assetLoadingStartTime).toFixed(2);
  log.success(`✔ All assets loaded successfully in ${totalAssetLoadingTime}ms`);
}

/**
 * The asset version served at /asset-version: one hash over the sprites, icons and sprite sheets (template and image)
 * read at startup. The gateway's service worker keeps those cache-first and drops its copies when this changes.
 */
async function loadAssetVersion() {
  const sprites = (await assetCache.get("sprites") as SpriteData[] | null) ?? [];
  const icons = (await assetCache.get("icons") as IconData[] | null) ?? [];
  const sheets = (await assetCache.get("spriteSheetTemplates") as SpriteSheetTemplate[] | null) ?? [];
  const version = assetsVersion([
    sprites,
    icons,
    sheets.map((s) => ({ name: s.name, version: `${s.templateVersion}.${s.imageVersion}` })),
  ]);
  await assetCache.add("assetVersion", version);
  log.debug(`Asset version: ${version}`);
}

interface TilesetData {
  name: string;
  data: Buffer;
  version: string;
}

interface SpriteSheetTemplate {
  name: string;
  template: string | null;
  image: Buffer | null;
  /** Equipment slot / kind, from the folder the image lives in. Lets editors browse by slot. */
  slot: string;
  /** Content hashes of the template JSON and the image ("" when there is none): the ETags of their endpoints. */
  templateVersion: string;
  imageVersion: string;
}

interface SpriteData {
  name: string;
  data: string;
  /** Content hash of the PNG: the /sprite ETag. */
  version: string;
}

interface IconData {
  name: string;
  data: string;
  /** Content hash of the PNG: the /icon ETag. */
  version: string;
}

interface MapData {
  name: string;
  data: any;
  compressed: Buffer;
  checksum: string;
}

interface AudioData {
  name: string;
  data: string;
  /** Content hash of the file: the /audio ETag. */
  version: string;
}
