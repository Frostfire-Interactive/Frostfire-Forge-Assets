import fs from "fs";
import path from "path";
import { getAssetsPath } from "./assetloader";

/** tileset key -> tile id (in that tileset, as text) -> the audio's name without its extension ("" = no sound) */
export type TileSounds = Record<string, Record<string, string>>;
/** A save: these tiles of one tileset take this sound; null gives them back their map's own. */
export interface TileSoundChange { tileset: string; ids: number[]; sound: string | null }

export const TILE_SOUNDS_FILE = "tilesounds.json";
/** At most this many changes in one save, this many tiles in one change, and a tile id below MAX_TILE_ID. */
export const MAX_CHANGES = 64, MAX_IDS = 65536, MAX_TILE_ID = 1_000_000;
/** A tileset key and a sound name: letters, digits, spaces and . _ - only, within these lengths. */
export const MAX_KEY = 64, MAX_SOUND = 128;
const KEY_RE = /^[a-z0-9 ._-]+$/;

let cached: TileSounds | null = null;

const filePath = () => path.join(getAssetsPath(), TILE_SOUNDS_FILE);

/** The list as saved (read from its file once, then kept). A missing or unreadable file is an empty list. */
export function getTileSounds(): TileSounds {
  if (cached) return cached;
  try {
    const raw = JSON.parse(fs.readFileSync(filePath(), "utf8"));
    cached = clean(raw?.tilesets);
  } catch {
    cached = {};
  }
  return cached;
}

/** Only what a save could have written: a broken entry in the file is left out, not trusted. */
function clean(raw: unknown): TileSounds {
  const out: TileSounds = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, tiles] of Object.entries(raw as Record<string, unknown>)) {
    if (!validKey(key) || !tiles || typeof tiles !== "object") continue;
    const row: Record<string, string> = {};
    for (const [id, sound] of Object.entries(tiles as Record<string, unknown>)) {
      const n = Number(id);
      if (Number.isInteger(n) && n >= 0 && n < MAX_TILE_ID && typeof sound === "string" && (sound === "" || validSound(sound))) row[String(n)] = sound;
    }
    if (Object.keys(row).length) out[key] = row;
  }
  return out;
}

const validKey = (key: string) => key.length > 0 && key.length <= MAX_KEY && KEY_RE.test(key);
const validSound = (sound: string) => sound.length > 0 && sound.length <= MAX_SOUND && KEY_RE.test(sound);

/** What is wrong with a save, in words, or null when nothing is. */
export function checkTileSoundChanges(changes: unknown): string | null {
  if (!Array.isArray(changes) || changes.length === 0) return "No changes";
  if (changes.length > MAX_CHANGES) return `At most ${MAX_CHANGES} changes in one save`;
  for (const c of changes as any[]) {
    if (!c || typeof c.tileset !== "string" || !validKey(c.tileset)) return "A change names no valid tileset";
    if (!Array.isArray(c.ids) || c.ids.length === 0 || c.ids.length > MAX_IDS) return `A change holds 1 to ${MAX_IDS} tiles`;
    if (c.ids.some((id: unknown) => !Number.isInteger(id) || (id as number) < 0 || (id as number) >= MAX_TILE_ID)) return "A tile id is not a whole number in range";
    if (c.sound !== null && (typeof c.sound !== "string" || (c.sound !== "" && !validSound(c.sound)))) return "A sound name is not valid";
  }
  return null;
}

/** The list with the changes made, in order (the list given is not changed). */
export function applyTileSoundChanges(base: TileSounds, changes: TileSoundChange[]): TileSounds {
  const out: TileSounds = {};
  for (const [key, tiles] of Object.entries(base)) out[key] = { ...tiles };
  for (const c of changes) {
    const row = out[c.tileset] ?? (out[c.tileset] = {});
    for (const id of c.ids) {
      if (c.sound === null) delete row[String(id)];
      else row[String(id)] = c.sound;
    }
    if (Object.keys(row).length === 0) delete out[c.tileset];
  }
  return out;
}

/** Make the changes and write the list (to a .tmp file renamed over the old one). Returns the list as it is now. */
export function saveTileSounds(changes: TileSoundChange[]): TileSounds {
  const next = applyTileSoundChanges(getTileSounds(), changes);
  const file = filePath();
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ tilesets: next }, null, 1));
  fs.renameSync(`${file}.tmp`, file);
  cached = next;
  return next;
}
