import zlib from "zlib";

export interface RGBAImage { width: number; height: number; data: Uint8Array }

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const paeth = (a: number, b: number, c: number) => {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

export function decodePng(file: Uint8Array): RGBAImage {
  const buf = Buffer.from(file.buffer, file.byteOffset, file.byteLength);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG");
  let width = 0, height = 0, depth = 0, colour = 0, interlace = 0;
  let palette: Uint8Array | null = null, trns: Uint8Array | null = null;
  const idat: Buffer[] = [];
  for (let p = 8; p + 8 <= buf.length;) {
    const len = buf.readUInt32BE(p), type = buf.toString("latin1", p + 4, p + 8), body = buf.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") { width = body.readUInt32BE(0); height = body.readUInt32BE(4); depth = body[8]!; colour = body[9]!; interlace = body[12]!; }
    else if (type === "PLTE") palette = body;
    else if (type === "tRNS") trns = body;
    else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    p += 12 + len;
  }
  if (!width || !height) throw new Error("PNG without IHDR");
  if (interlace) throw new Error("interlaced PNG not supported");
  const channels = colour === 0 ? 1 : colour === 2 ? 3 : colour === 3 ? 1 : colour === 4 ? 2 : colour === 6 ? 4 : 0;
  if (!channels) throw new Error(`PNG colour type ${colour} not supported`);
  const bitsPerPixel = channels * depth, bpp = Math.max(1, bitsPerPixel >> 3), stride = Math.ceil((width * bitsPerPixel) / 8);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  // undo the row filters
  const px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]!, src = y * (stride + 1) + 1, row = y * stride, up = row - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[row + x - bpp]! : 0, b = y ? px[up + x]! : 0, c = x >= bpp && y ? px[up + x - bpp]! : 0, v = raw[src + x]!;
      px[row + x] = (f === 0 ? v : f === 1 ? v + a : f === 2 ? v + b : f === 3 ? v + ((a + b) >> 1) : v + paeth(a, b, c)) & 0xff;
    }
  }
  // samples -> 8-bit RGBA
  const out = new Uint8Array(width * height * 4);
  const sample = (row: number, i: number): number => {
    if (depth === 8) return px[row + i]!;
    if (depth === 16) return px[row + i * 2]!; // high byte
    const bit = i * depth, byte = px[row + (bit >> 3)]!, shift = 8 - depth - (bit & 7);
    return (byte >> shift) & ((1 << depth) - 1);
  };
  const scale = (v: number) => (depth >= 8 ? v : Math.round((v * 255) / ((1 << depth) - 1)));
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (colour === 3) {
        const k = sample(row, x);
        out[o] = palette?.[k * 3] ?? 0; out[o + 1] = palette?.[k * 3 + 1] ?? 0; out[o + 2] = palette?.[k * 3 + 2] ?? 0;
        out[o + 3] = trns && k < trns.length ? trns[k]! : 255;
      } else {
        const s = (c: number) => scale(sample(row, x * channels + c));
        if (colour === 0 || colour === 4) { const g = s(0); out[o] = g; out[o + 1] = g; out[o + 2] = g; out[o + 3] = colour === 4 ? s(1) : 255; }
        else { out[o] = s(0); out[o + 1] = s(1); out[o + 2] = s(2); out[o + 3] = colour === 6 ? s(3) : 255; }
      }
    }
  }
  return { width, height, data: out };
}

function chunk(type: string, body: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

/** Encodes 8-bit pixels (`channels` 3 = RGB, 4 = RGBA, row-major) as a PNG. */
export function encodePng(width: number, height: number, pixels: Uint8Array, channels: 3 | 4 = 4): Buffer {
  const stride = width * channels, raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    // filter 1 (Sub): small for flat colour runs
    const o = y * (stride + 1), row = y * stride;
    raw[o] = 1;
    for (let x = 0; x < stride; x++) raw[o + 1 + x] = (pixels[row + x]! - (x >= channels ? pixels[row + x - channels]! : 0)) & 0xff;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = channels === 4 ? 6 : 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", new Uint8Array(0))]);
}
