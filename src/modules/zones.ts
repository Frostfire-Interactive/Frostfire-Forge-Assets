// Zones: named areas drawn on a map (map editor, "Zones" layer) or written by the world generator. A player who
// walks into one sees its text and hears its music. A world keeps them in manifest.zones, a plain Tiled map in a
// top-level "zones" key. Every number is in tiles. This is a copy of the game server's rules
// (Frostfire-Forge/src/modules/zones.ts): change both together.

export interface MapZone {
  name: string;
  /** The words shown on entering, when they differ from the name. */
  text?: string;
  /** An audio name as the pickers store it: no extension, lower case. */
  music?: string;
  /** "desert" draws a sandstorm, "snow" a blizzard; the generator also writes words such as "forest". */
  kind?: string;
  /** Worked out from the outline, never taken from the sender. */
  bbox: { x: number; y: number; w: number; h: number };
  /** Rings of [x, y], each one an area of the zone. A ring inside another one is left out (fillHoles), so a zone has no holes. */
  outline: number[][][];
  /** A generated zone's other keys (id, levels, start, hub) are kept as they are. */
  [key: string]: unknown;
}

export const ZONE_LIMITS = { zones: 256, minPoints: 3, maxPoints: 512, name: 64, text: 80, kind: 32, music: 128 };

const KIND = /^[a-z]{1,32}$/;
const MUSIC = /^[a-z0-9 _\-.()']{1,128}$/;

/** Whether a point is inside a ring or on its border. */
function insideOrOn(px: number, py: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i]![0]!, yi = ring[i]![1]!, xj = ring[j]![0]!, yj = ring[j]![1]!;
    const onLine = (xj - xi) * (py - yi) === (yj - yi) * (px - xi);
    if (onLine && px >= Math.min(xi, xj) && px <= Math.max(xi, xj) && py >= Math.min(yi, yj) && py <= Math.max(yi, yj)) return true;
    if ((yi > py) !== (yj > py) && px < xi + ((py - yi) * (xj - xi)) / (yj - yi)) inside = !inside;
  }
  return inside;
}

/** Whether every point of a ring, and the middle of every edge, is inside another ring or on its border. */
function ringWithin(ring: number[][], around: number[][]): boolean {
  return ring.every((p, i) => {
    const next = ring[(i + 1) % ring.length]!;
    return insideOrOn(p[0]!, p[1]!, around) && insideOrOn((p[0]! + next[0]!) / 2, (p[1]! + next[1]!) / 2, around);
  });
}

function ringArea(ring: number[][]): number {
  let twice = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) twice += ring[j]![0]! * ring[i]![1]! - ring[i]![0]! * ring[j]![1]!;
  return Math.abs(twice) / 2;
}

/**
 * A zone's rings with every ring that lies inside another one left out. A ring inside another would be a hole (a
 * point is inside when an odd number of rings surround it), so this fills the holes. Rings that lie apart are kept,
 * in their order.
 */
export function fillHoles(outline: number[][][]): number[][][] {
  const largestFirst = outline.map((_, i) => i).sort((a, b) => ringArea(outline[b]!) - ringArea(outline[a]!));
  const kept: number[] = [];
  for (const i of largestFirst) if (!kept.some((k) => ringWithin(outline[i]!, outline[k]!))) kept.push(i);
  return outline.filter((_, i) => kept.includes(i));
}

/** One zone checked against a map of the given size in tiles, or why it cannot be kept. */
function cleanZone(raw: any, widthTiles: number, heightTiles: number): MapZone | string {
  if (!raw || typeof raw !== "object") return "A zone is not an object";
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name) return "A zone has no name";
  if (name.length > ZONE_LIMITS.name) return `Zone ${name.slice(0, 20)}... has a name longer than ${ZONE_LIMITS.name} characters`;
  const { bbox: _bbox, outline: rawOutline, text: rawText, music: rawMusic, kind: rawKind, name: _name, ...rest } = raw;
  const text = typeof rawText === "string" ? rawText.trim() : "";
  if (text.length > ZONE_LIMITS.text) return `Zone ${name} has text longer than ${ZONE_LIMITS.text} characters`;
  const music = typeof rawMusic === "string" ? rawMusic.trim().toLowerCase() : "";
  if (music && !MUSIC.test(music)) return `Zone ${name} names music that is not an audio name`;
  if (rawKind !== undefined && rawKind !== null && rawKind !== "" && (typeof rawKind !== "string" || !KIND.test(rawKind))) {
    return `Zone ${name} has a kind that is not a lower-case word`;
  }
  if (!Array.isArray(rawOutline) || !rawOutline.length) return `Zone ${name} has no outline`;
  const outline: number[][][] = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const ring of rawOutline) {
    if (!Array.isArray(ring) || ring.length < ZONE_LIMITS.minPoints) return `Zone ${name} has an outline with fewer than ${ZONE_LIMITS.minPoints} points`;
    if (ring.length > ZONE_LIMITS.maxPoints) return `Zone ${name} has an outline with more than ${ZONE_LIMITS.maxPoints} points`;
    const points: number[][] = [];
    for (const p of ring) {
      const x = Array.isArray(p) ? p[0] : undefined, y = Array.isArray(p) ? p[1] : undefined;
      if (!Number.isInteger(x) || !Number.isInteger(y)) return `Zone ${name} has a point that is not a whole tile`;
      if (x < 0 || y < 0 || x > widthTiles || y > heightTiles) return `Zone ${name} has a point outside the map`;
      points.push([x, y]);
      minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
    outline.push(points);
  }
  const zone: MapZone = { ...rest, name, bbox: { x: minX, y: minY, w: maxX - minX, h: maxY - minY }, outline: fillHoles(outline) };
  if (text) zone.text = text;
  if (music) zone.music = music;
  if (typeof rawKind === "string" && rawKind) zone.kind = rawKind;
  return zone;
}

/** A map's whole zone list checked against its size in tiles: the clean list, or why it cannot be saved. */
export function cleanZones(list: unknown, widthTiles: number, heightTiles: number): { zones: MapZone[] } | { error: string } {
  if (!Array.isArray(list)) return { error: "Zones are not a list" };
  if (list.length > ZONE_LIMITS.zones) return { error: `A map holds at most ${ZONE_LIMITS.zones} zones` };
  const zones: MapZone[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const zone = cleanZone(raw, widthTiles, heightTiles);
    if (typeof zone === "string") return { error: zone };
    const key = zone.name.toLowerCase();
    if (seen.has(key)) return { error: `Two zones are named ${zone.name}` };
    seen.add(key);
    zones.push(zone);
  }
  return { zones };
}

/** As cleanZones, for zones read from a file: a bad zone is left out (and named) instead of losing them all. */
export function cleanZonesLenient(list: unknown, widthTiles: number, heightTiles: number): { zones: MapZone[]; dropped: string[] } {
  const zones: MapZone[] = [];
  const dropped: string[] = [];
  if (!Array.isArray(list)) return { zones, dropped };
  const seen = new Set<string>();
  for (const raw of list.slice(0, ZONE_LIMITS.zones)) {
    const zone = cleanZone(raw, widthTiles, heightTiles);
    if (typeof zone === "string") { dropped.push(zone); continue; }
    const key = zone.name.toLowerCase();
    if (seen.has(key)) { dropped.push(`Two zones are named ${zone.name}`); continue; }
    seen.add(key);
    zones.push(zone);
  }
  if (list.length > ZONE_LIMITS.zones) dropped.push(`Only the first ${ZONE_LIMITS.zones} zones are kept`);
  return { zones, dropped };
}

/** The zones of one kind with only their name, bounds and rings (what the sandstorm and blizzard need). */
export function zonesOfKind(zones: unknown, kind: string): Array<{ name: string; bbox: MapZone["bbox"]; outline: number[][][] }> {
  if (!Array.isArray(zones)) return [];
  const finite = (n: unknown) => typeof n === "number" && Number.isFinite(n);
  const found: Array<{ name: string; bbox: MapZone["bbox"]; outline: number[][][] }> = [];
  for (const zone of zones) {
    if (zone?.kind !== kind || !Array.isArray(zone.outline)) continue;
    const outline = zone.outline
      .filter((ring: unknown) => Array.isArray(ring))
      .map((ring: unknown[]) => ring.filter((p: any) => Array.isArray(p) && finite(p[0]) && finite(p[1])).map((p: any) => [p[0], p[1]]))
      .filter((ring: number[][]) => ring.length >= 3);
    const b = zone.bbox;
    if (!outline.length || !b || ![b.x, b.y, b.w, b.h].every(finite)) continue;
    found.push({ name: String(zone.name ?? ""), bbox: { x: b.x, y: b.y, w: b.w, h: b.h }, outline });
  }
  return found;
}
