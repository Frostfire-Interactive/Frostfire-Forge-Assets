import fs from "fs";
import path from "path";
import { decodePng, encodePng, type RGBAImage } from "./png";

/** Layers that are game data, not art (never drawn). */
const HIDDEN = /collision|nopvp|no-pvp/i;
const GID_MASK = 0x1fffffff;
/** The sea / void behind transparent tiles (a map's own backgroundcolor wins). */
const BACKGROUND: [number, number, number] = [16, 20, 32];

/** Decoded tileset images by file name, shared by every map baked in one pass (read only; null when unreadable). */
export class TilesetImages {
  private images = new Map<string, RGBAImage | null>();
  constructor(private dir: string) {}
  get(name: string): RGBAImage | null {
    if (this.images.has(name)) return this.images.get(name)!;
    let img: RGBAImage | null = null;
    const file = path.join(this.dir, name);
    try { if (fs.existsSync(file)) img = decodePng(fs.readFileSync(file)); } catch { img = null; }
    this.images.set(name, img);
    return img;
  }
}

export function bakeWorldMap(map: any, images: TilesetImages): Buffer {
  const W = Number(map.width) || 0, H = Number(map.height) || 0;
  if (!W || !H) throw new Error("map without a size");
  const bg = typeof map.backgroundcolor === "string" && /^#[0-9a-f]{6}$/i.test(map.backgroundcolor)
    ? [1, 3, 5].map(i => parseInt(map.backgroundcolor.slice(i, i + 2), 16)) as [number, number, number] : BACKGROUND;
  const rgb = new Float32Array(W * H * 3);
  for (let i = 0; i < W * H; i++) { rgb[i * 3] = bg[0]; rgb[i * 3 + 1] = bg[1]; rgb[i * 3 + 2] = bg[2]; }

  const sheets = (map.tilesets ?? []).filter((t: any) => t?.image).sort((a: any, b: any) => b.firstgid - a.firstgid).map((t: any) => {
    const img = images.get(path.basename(String(t.image)));
    const tw = Number(t.tilewidth) || 16, th = Number(t.tileheight) || 16;
    return { first: Number(t.firstgid), img, tw, th, cols: Number(t.columns) || (img ? Math.floor(img.width / tw) : 1) };
  });
  // average colour and coverage of a gid, cached
  const avg = new Map<number, [number, number, number, number]>();
  const colourOf = (gid: number) => {
    let c = avg.get(gid);
    if (c) return c;
    c = [0, 0, 0, 0];
    const s = sheets.find((t: any) => gid >= t.first);
    if (s?.img) {
      const id = gid - s.first, cx = (id % s.cols) * s.tw, cy = Math.floor(id / s.cols) * s.th;
      let r = 0, g = 0, b = 0, a = 0;
      for (let y = 0; y < s.th; y++) for (let x = 0; x < s.tw; x++) {
        const px = cx + x, py = cy + y;
        if (px >= s.img.width || py >= s.img.height) continue;
        const i = (py * s.img.width + px) * 4, al = s.img.data[i + 3]! / 255;
        r += s.img.data[i]! * al; g += s.img.data[i + 1]! * al; b += s.img.data[i + 2]! * al; a += al;
      }
      c = a > 0 ? [r / a, g / a, b / a, a / (s.tw * s.th)] : [0, 0, 0, 0];
    }
    avg.set(gid, c);
    return c;
  };

  for (const layer of map.layers ?? []) {
    if (layer?.type !== "tilelayer" || layer.visible === false || HIDDEN.test(String(layer.name ?? ""))) continue;
    const chunks = Array.isArray(layer.chunks) ? layer.chunks : Array.isArray(layer.data) ? [{ x: 0, y: 0, width: W, height: H, data: layer.data }] : [];
    for (const ch of chunks) {
      const data = ch?.data;
      if (!Array.isArray(data)) continue;
      const cw = Number(ch.width) || W, cx0 = Number(ch.x) || 0, cy0 = Number(ch.y) || 0;
      for (let k = 0; k < data.length; k++) {
        const gid = data[k] & GID_MASK;
        if (!gid) continue;
        const x = cx0 + (k % cw), y = cy0 + Math.floor(k / cw);
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const [r, g, b, a] = colourOf(gid);
        if (a <= 0) continue;
        const i = (y * W + x) * 3;
        rgb[i] = rgb[i]! * (1 - a) + r * a; rgb[i + 1] = rgb[i + 1]! * (1 - a) + g * a; rgb[i + 2] = rgb[i + 2]! * (1 - a) + b * a;
      }
    }
  }
  const px = new Uint8Array(W * H * 3);
  for (let i = 0; i < W * H * 3; i++) px[i] = Math.round(rgb[i]!);
  return encodePng(W, H, px, 3);
}

/** The longest edge, in pixels, of the image baked for a world: larger worlds are baked several tiles to a pixel. */
const CHUNKED_MAX_EDGE = 4096;

/** A map held chunk by chunk (a world, modules/worldstore.ts): what the bake needs of it. */
export interface ChunkedMap {
  width: number;
  height: number;
  chunkSize: number;
  tilesets: any[];
  backgroundcolor?: string;
  /** Tile layers in drawing order; `tileIndex` picks the layer's tiles out of a chunk. */
  layers: { name: string; visible: boolean; tileIndex: number }[];
  /** The tiles of one chunk: one array of chunkSize * chunkSize gids per tile layer, by tileIndex. */
  readChunk: (chunkX: number, chunkY: number) => number[][];
}

/** How many tiles one pixel of a world's baked image covers along each axis (a power of two, 1 for a small world). */
export function chunkedMapScale(map: Pick<ChunkedMap, "width" | "height" | "chunkSize">): number {
  let scale = 1;
  while (Math.max(map.width, map.height) / scale > CHUNKED_MAX_EDGE && scale < map.chunkSize) scale *= 2;
  return scale;
}

export function bakeChunkedWorldMap(map: ChunkedMap, images: TilesetImages): { png: Buffer; scale: number } {
  const bake = new ChunkedMapBake(map, images);
  bake.drawAll();
  return { png: bake.png(), scale: bake.scale };
}

export class ChunkedMapBake {
  readonly scale: number;
  readonly width: number;
  readonly height: number;
  /** RGB, three bytes per pixel. */
  readonly pixels: Uint8Array;
  private readonly bg: [number, number, number];
  private readonly drawn: ChunkedMap["layers"];
  private readonly sheets: { first: number; img: RGBAImage | null; tw: number; th: number; cols: number }[];
  // average colour and coverage of a gid, cached
  private readonly avg = new Map<number, [number, number, number, number]>();
  private readonly rgb: Float32Array;

  /** `pixels` (RGB, of the same size) starts the image from an earlier bake; without it the image is empty. */
  constructor(private readonly map: ChunkedMap, images: TilesetImages, pixels?: Uint8Array) {
    const W = map.width, H = map.height, cs = map.chunkSize;
    if (!W || !H || !cs) throw new Error("map without a size");
    this.scale = chunkedMapScale(map);
    this.width = Math.floor(W / this.scale);
    this.height = Math.floor(H / this.scale);
    if (pixels && pixels.length !== this.width * this.height * 3) throw new Error("the earlier image has another size");
    this.pixels = pixels ?? new Uint8Array(this.width * this.height * 3);
    this.bg = typeof map.backgroundcolor === "string" && /^#[0-9a-f]{6}$/i.test(map.backgroundcolor)
      ? [1, 3, 5].map(i => parseInt(map.backgroundcolor!.slice(i, i + 2), 16)) as [number, number, number] : BACKGROUND;
    this.sheets = (map.tilesets ?? []).filter((t: any) => t?.image).sort((a: any, b: any) => b.firstgid - a.firstgid).map((t: any) => {
      const img = images.get(path.basename(String(t.image)));
      const tw = Number(t.tilewidth) || 16, th = Number(t.tileheight) || 16;
      return { first: Number(t.firstgid), img, tw, th, cols: Number(t.columns) || (img ? Math.floor(img.width / tw) : 1) };
    });
    this.drawn = map.layers.filter(l => l.visible !== false && !HIDDEN.test(String(l.name ?? "")));
    this.rgb = new Float32Array(cs * cs * 3);
  }

  /** Start from an earlier bake's PNG; null when it cannot be read or has another size. */
  static fromPng(map: ChunkedMap, images: TilesetImages, png: Uint8Array): ChunkedMapBake | null {
    try {
      const img = decodePng(png);
      const rgb = new Uint8Array(img.width * img.height * 3);
      for (let i = 0, o = 0; i < img.width * img.height; i++, o += 3) {
        rgb[o] = img.data[i * 4]!; rgb[o + 1] = img.data[i * 4 + 1]!; rgb[o + 2] = img.data[i * 4 + 2]!;
      }
      return new ChunkedMapBake(map, images, rgb);
    } catch {
      return null;
    }
  }

  private colourOf(gid: number): [number, number, number, number] {
    let c = this.avg.get(gid);
    if (c) return c;
    c = [0, 0, 0, 0];
    const s = this.sheets.find(t => gid >= t.first);
    if (s?.img) {
      const id = gid - s.first, cx = (id % s.cols) * s.tw, cy = Math.floor(id / s.cols) * s.th;
      let r = 0, g = 0, b = 0, a = 0;
      for (let y = 0; y < s.th; y++) for (let x = 0; x < s.tw; x++) {
        const px = cx + x, py = cy + y;
        if (px >= s.img.width || py >= s.img.height) continue;
        const i = (py * s.img.width + px) * 4, al = s.img.data[i + 3]! / 255;
        r += s.img.data[i]! * al; g += s.img.data[i + 1]! * al; b += s.img.data[i + 2]! * al; a += al;
      }
      c = a > 0 ? [r / a, g / a, b / a, a / (s.tw * s.th)] : [0, 0, 0, 0];
    }
    this.avg.set(gid, c);
    return c;
  }

  /** Draw one chunk (its pixels are replaced). */
  drawChunk(cx: number, cy: number): void {
    const cs = this.map.chunkSize, scale = this.scale, per = cs / scale, n = scale * scale, rgb = this.rgb, bg = this.bg;
    if (cx < 0 || cy < 0 || cx * cs >= this.map.width || cy * cs >= this.map.height) return;
    const tiles = this.map.readChunk(cx, cy);
    for (let i = 0; i < cs * cs; i++) { rgb[i * 3] = bg[0]; rgb[i * 3 + 1] = bg[1]; rgb[i * 3 + 2] = bg[2]; }
    for (const layer of this.drawn) {
      const data = tiles[layer.tileIndex];
      if (!data) continue;
      for (let k = 0; k < cs * cs; k++) {
        const gid = data[k]! & GID_MASK;
        if (!gid) continue;
        const [r, g, b, a] = this.colourOf(gid);
        if (a <= 0) continue;
        const i = k * 3;
        rgb[i] = rgb[i]! * (1 - a) + r * a; rgb[i + 1] = rgb[i + 1]! * (1 - a) + g * a; rgb[i + 2] = rgb[i + 2]! * (1 - a) + b * a;
      }
    }
    for (let py = 0; py < per; py++) for (let qx = 0; qx < per; qx++) {
      const ox = cx * per + qx, oy = cy * per + py;
      if (ox >= this.width || oy >= this.height) continue;
      let r = 0, g = 0, b = 0;
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
        const i = ((py * scale + dy) * cs + qx * scale + dx) * 3;
        r += rgb[i]!; g += rgb[i + 1]!; b += rgb[i + 2]!;
      }
      const o = (oy * this.width + ox) * 3;
      this.pixels[o] = Math.round(r / n); this.pixels[o + 1] = Math.round(g / n); this.pixels[o + 2] = Math.round(b / n);
    }
  }

  drawAll(): void {
    const cs = this.map.chunkSize;
    for (let cy = 0; cy * cs < this.map.height; cy++) for (let cx = 0; cx * cs < this.map.width; cx++) this.drawChunk(cx, cy);
  }

  png(): Buffer {
    return encodePng(this.width, this.height, this.pixels, 3);
  }
}
