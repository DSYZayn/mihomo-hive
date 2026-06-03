import { deflateSync, inflateSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";

const input = "apps/web/brand-source/source-catgirl-chroma.png";
const sourceDir = "apps/web/brand-source";
const outDir = "apps/web/public/brand";

const source = readPng(input);
const cutout = removeChromaKey(source);
writePng(`${sourceDir}/source-catgirl-alpha.png`, cutout);

const light = composeIcon(cutout, "light", 512);
const dark = composeIcon(cutout, "dark", 512);
writePng(`${outDir}/app-icon-light-512.png`, light);
writePng(`${outDir}/app-icon-dark-512.png`, dark);
writePng(`${outDir}/app-icon-light-192.png`, resize(light, 192, 192));
writePng(`${outDir}/app-icon-dark-192.png`, resize(dark, 192, 192));
writePng(`${outDir}/app-icon-light-64.png`, resize(light, 64, 64));
writePng(`${outDir}/app-icon-dark-64.png`, resize(dark, 64, 64));
writePng(`${outDir}/favicon-32.png`, resize(light, 32, 32));
writePng(`${outDir}/favicon-16.png`, resize(light, 16, 16));

function readPng(path) {
  const bytes = readFileSync(path);
  const signature = bytes.subarray(0, 8);
  if (!signature.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error("Not a PNG file");
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }

  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`Unsupported PNG format: bitDepth=${bitDepth}, colorType=${colorType}`);
  }

  const channels = colorType === 6 ? 4 : 3;
  const inflated = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const raw = new Uint8Array(width * height * channels);

  for (let y = 0; y < height; y += 1) {
    const srcRow = y * (stride + 1);
    const dstRow = y * stride;
    const filter = inflated[srcRow];
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? raw[dstRow + x - channels] : 0;
      const up = y > 0 ? raw[dstRow + x - stride] : 0;
      const upLeft = y > 0 && x >= channels ? raw[dstRow + x - stride - channels] : 0;
      const value = inflated[srcRow + 1 + x];
      raw[dstRow + x] = unfilter(filter, value, left, up, upLeft);
    }
  }

  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, j = 0; i < raw.length; i += channels, j += 4) {
    rgba[j] = raw[i];
    rgba[j + 1] = raw[i + 1];
    rgba[j + 2] = raw[i + 2];
    rgba[j + 3] = channels === 4 ? raw[i + 3] : 255;
  }
  return { width, height, data: rgba };
}

function writePng(path, image) {
  const stride = image.width * 4;
  const raw = Buffer.alloc((stride + 1) * image.height);
  for (let y = 0; y < image.height; y += 1) {
    const row = y * (stride + 1);
    raw[row] = 0;
    Buffer.from(image.data.buffer, image.data.byteOffset + y * stride, stride).copy(raw, row + 1);
  }
  const chunks = [
    chunk("IHDR", ihdr(image.width, image.height)),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ];
  writeFileSync(path, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ...chunks]));
}

function unfilter(type, value, left, up, upLeft) {
  switch (type) {
    case 0:
      return value;
    case 1:
      return (value + left) & 255;
    case 2:
      return (value + up) & 255;
    case 3:
      return (value + Math.floor((left + up) / 2)) & 255;
    case 4:
      return (value + paeth(left, up, upLeft)) & 255;
    default:
      throw new Error(`Unsupported PNG filter: ${type}`);
  }
}

function paeth(left, up, upLeft) {
  const p = left + up - upLeft;
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - up);
  const pc = Math.abs(p - upLeft);
  if (pa <= pb && pa <= pc) return left;
  if (pb <= pc) return up;
  return upLeft;
}

function ihdr(width, height) {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = 8;
  data[9] = 6;
  return data;
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  typeBytes.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return out;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function removeChromaKey(image) {
  const key = sampleBorderKey(image);
  const data = new Uint8ClampedArray(image.data);
  for (let i = 0; i < data.length; i += 4) {
    const dist = Math.hypot(data[i] - key.r, data[i + 1] - key.g, data[i + 2] - key.b);
    const alpha = smoothstep(24, 165, dist) * 255;
    data[i + 3] = Math.min(data[i + 3], Math.round(alpha));
    if (data[i + 3] < 8) {
      data[i] = 0;
      data[i + 1] = 0;
      data[i + 2] = 0;
    } else if (data[i + 3] < 250) {
      const lum = data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722;
      if (lum > 188) {
        data[i] = 245;
        data[i + 1] = 239;
        data[i + 2] = 230;
      } else {
        data[i] = 18;
        data[i + 1] = 24;
        data[i + 2] = 38;
      }
    }
  }
  return { ...image, data };
}

function sampleBorderKey(image) {
  const samples = [];
  for (let x = 0; x < image.width; x += Math.max(1, Math.floor(image.width / 48))) {
    samples.push(pixel(image, x, 0), pixel(image, x, image.height - 1));
  }
  for (let y = 0; y < image.height; y += Math.max(1, Math.floor(image.height / 48))) {
    samples.push(pixel(image, 0, y), pixel(image, image.width - 1, y));
  }
  return {
    r: median(samples.map((p) => p.r)),
    g: median(samples.map((p) => p.g)),
    b: median(samples.map((p) => p.b))
  };
}

function composeIcon(source, theme, size) {
  const canvas = createCanvas(size, size);
  fillBackground(canvas, theme);
  const crop = cropAlpha(source);
  const target = Math.round(size * 0.82);
  const scale = Math.min(target / crop.width, target / crop.height);
  const placed = resize(crop, Math.round(crop.width * scale), Math.round(crop.height * scale));
  if (theme === "dark") recolorForDark(placed);
  const x = Math.round((size - placed.width) / 2);
  const y = Math.round((size - placed.height) / 2 + size * 0.025);
  paste(canvas, placed, x, y);
  return canvas;
}

function fillBackground(image, theme) {
  const top = theme === "dark" ? hex("#121826") : hex("#fff7ef");
  const bottom = theme === "dark" ? hex("#1e222b") : hex("#ffffff");
  const glow = theme === "dark" ? hex("#ea5252") : hex("#ea5252");
  const glow2 = theme === "dark" ? hex("#38c7d9") : hex("#f0b34a");
  const cx1 = image.width * 0.18;
  const cy1 = image.height * 0.12;
  const cx2 = image.width * 0.82;
  const cy2 = image.height * 0.82;
  for (let y = 0; y < image.height; y += 1) {
    const t = y / (image.height - 1);
    for (let x = 0; x < image.width; x += 1) {
      const base = mix(top, bottom, t);
      const g1 = Math.max(0, 1 - Math.hypot(x - cx1, y - cy1) / (image.width * 0.8));
      const g2 = Math.max(0, 1 - Math.hypot(x - cx2, y - cy2) / (image.width * 0.85));
      let c = mix(base, glow, g1 * (theme === "dark" ? 0.16 : 0.08));
      c = mix(c, glow2, g2 * (theme === "dark" ? 0.10 : 0.06));
      setPixel(image, x, y, c.r, c.g, c.b, 255);
    }
  }
}

function recolorForDark(image) {
  const light = hex("#f5efe6");
  const cut = hex("#121826");
  for (let i = 0; i < image.data.length; i += 4) {
    const alpha = image.data[i + 3];
    if (alpha === 0) continue;
    const max = Math.max(image.data[i], image.data[i + 1], image.data[i + 2]);
    const min = Math.min(image.data[i], image.data[i + 1], image.data[i + 2]);
    if (max < 55) {
      image.data[i] = light.r;
      image.data[i + 1] = light.g;
      image.data[i + 2] = light.b;
    } else if (min > 210) {
      image.data[i] = cut.r;
      image.data[i + 1] = cut.g;
      image.data[i + 2] = cut.b;
    }
  }
}

function cropAlpha(image) {
  let minX = image.width;
  let minY = image.height;
  let maxX = 0;
  let maxY = 0;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (image.data[(y * image.width + x) * 4 + 3] > 12) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  const pad = Math.max(6, Math.round(Math.max(maxX - minX, maxY - minY) * 0.035));
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(image.width - 1, maxX + pad);
  maxY = Math.min(image.height - 1, maxY + pad);
  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  const out = createCanvas(width, height, 0);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const src = ((minY + y) * image.width + minX + x) * 4;
      const dst = (y * width + x) * 4;
      out.data[dst] = image.data[src];
      out.data[dst + 1] = image.data[src + 1];
      out.data[dst + 2] = image.data[src + 2];
      out.data[dst + 3] = image.data[src + 3];
    }
  }
  return out;
}

function resize(image, width, height) {
  const out = createCanvas(width, height, 0);
  const sx = image.width / width;
  const sy = image.height / height;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const srcX = Math.min(image.width - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const srcY = Math.min(image.height - 1, Math.max(0, (y + 0.5) * sy - 0.5));
      const c = sample(image, srcX, srcY);
      setPixel(out, x, y, c.r, c.g, c.b, c.a);
    }
  }
  return out;
}

function paste(dst, src, offsetX, offsetY) {
  for (let y = 0; y < src.height; y += 1) {
    for (let x = 0; x < src.width; x += 1) {
      const dx = offsetX + x;
      const dy = offsetY + y;
      if (dx < 0 || dx >= dst.width || dy < 0 || dy >= dst.height) continue;
      const si = (y * src.width + x) * 4;
      const di = (dy * dst.width + dx) * 4;
      const a = src.data[si + 3] / 255;
      dst.data[di] = Math.round(src.data[si] * a + dst.data[di] * (1 - a));
      dst.data[di + 1] = Math.round(src.data[si + 1] * a + dst.data[di + 1] * (1 - a));
      dst.data[di + 2] = Math.round(src.data[si + 2] * a + dst.data[di + 2] * (1 - a));
      dst.data[di + 3] = 255;
    }
  }
}

function createCanvas(width, height, alpha = 255) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 3; i < data.length; i += 4) data[i] = alpha;
  return { width, height, data };
}

function sample(image, x, y) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(image.width - 1, x0 + 1);
  const y1 = Math.min(image.height - 1, y0 + 1);
  const tx = x - x0;
  const ty = y - y0;
  const a = pixel(image, x0, y0);
  const b = pixel(image, x1, y0);
  const c = pixel(image, x0, y1);
  const d = pixel(image, x1, y1);
  return {
    r: bilerp(a.r, b.r, c.r, d.r, tx, ty),
    g: bilerp(a.g, b.g, c.g, d.g, tx, ty),
    b: bilerp(a.b, b.b, c.b, d.b, tx, ty),
    a: bilerp(a.a, b.a, c.a, d.a, tx, ty)
  };
}

function bilerp(a, b, c, d, tx, ty) {
  return Math.round((a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty);
}

function pixel(image, x, y) {
  const i = (y * image.width + x) * 4;
  return { r: image.data[i], g: image.data[i + 1], b: image.data[i + 2], a: image.data[i + 3] };
}

function setPixel(image, x, y, r, g, b, a) {
  const i = (y * image.width + x) * 4;
  image.data[i] = r;
  image.data[i + 1] = g;
  image.data[i + 2] = b;
  image.data[i + 3] = a;
}

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function median(values) {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function hex(value) {
  return {
    r: Number.parseInt(value.slice(1, 3), 16),
    g: Number.parseInt(value.slice(3, 5), 16),
    b: Number.parseInt(value.slice(5, 7), 16)
  };
}

function mix(a, b, t) {
  return {
    r: Math.round(a.r * (1 - t) + b.r * t),
    g: Math.round(a.g * (1 - t) + b.g * t),
    b: Math.round(a.b * (1 - t) + b.b * t)
  };
}
