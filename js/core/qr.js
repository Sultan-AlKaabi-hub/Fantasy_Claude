/**
 * qr.js — a compact QR Code encoder (byte mode, versions 1–10, EC level M).
 *
 * Written in-house so the install dialog can render a QR code for the app's
 * URL without loading third-party script (the CSP allows only 'self') and
 * without any network access. Follows ISO/IEC 18004: data segment → Reed-
 * Solomon error correction → block interleaving → module placement → best-
 * penalty mask → format/version information.
 *
 * Verified against the reference `qrcode` Python library (see tests/qr.test.mjs).
 *
 *   const qr = encodeQR('https://example.com');   // { size, get(x, y) }
 */

const EC_LEVEL = { L: { bits: 1 }, M: { bits: 0 }, Q: { bits: 3 }, H: { bits: 2 } };

/** [ecCodewordsPerBlock, numBlocks] per version for level M. Index 0 unused. */
const EC_M = [null, [10, 1], [16, 1], [26, 1], [18, 2], [24, 2], [16, 4], [18, 4], [22, 4], [22, 5], [26, 5]];

const MAX_VERSION = 10;

function totalCodewords(ver) {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return Math.floor(result / 8);
}

function dataCodewords(ver) {
  const [ec, blocks] = EC_M[ver];
  return totalCodewords(ver) - ec * blocks;
}

/* ---------------- Reed-Solomon over GF(2^8), primitive 0x11D ---------------- */
function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}
function rsDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}
function rsRemainder(data, divisor) {
  const result = new Array(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    divisor.forEach((coef, i) => { result[i] ^= gfMul(coef, factor); });
  }
  return result;
}

/* ---------------- bit buffer ---------------- */
function appendBits(buf, val, len) {
  for (let i = len - 1; i >= 0; i--) buf.push((val >>> i) & 1);
}

/* ---------------- alignment pattern positions ---------------- */
function alignmentPositions(ver) {
  if (ver === 1) return [];
  const numAlign = Math.floor(ver / 7) + 2;
  const size = ver * 4 + 17;
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

export class QRCode {
  constructor(ver, dataCodewordsArr, mask) {
    this.version = ver;
    this.size = ver * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
    this.isFunction = Array.from({ length: this.size }, () => new Array(this.size).fill(false));

    this.drawFunctionPatterns();
    const all = this.addEccAndInterleave(dataCodewordsArr);
    this.drawCodewords(all);

    if (mask === -1) {
      let min = Infinity;
      for (let i = 0; i < 8; i++) {
        this.applyMask(i);
        this.drawFormatBits(i);
        const p = this.penaltyScore();
        if (p < min) { mask = i; min = p; }
        this.applyMask(i);                        // undo (XOR)
      }
    }
    this.mask = mask;
    this.applyMask(mask);
    this.drawFormatBits(mask);
    this.isFunction = null;
  }

  get(x, y) { return x >= 0 && x < this.size && y >= 0 && y < this.size && this.modules[y][x]; }

  setFunction(x, y, dark) { this.modules[y][x] = dark; this.isFunction[y][x] = true; }

  drawFunctionPatterns() {
    for (let i = 0; i < this.size; i++) { this.setFunction(6, i, i % 2 === 0); this.setFunction(i, 6, i % 2 === 0); }
    this.drawFinder(3, 3); this.drawFinder(this.size - 4, 3); this.drawFinder(3, this.size - 4);
    const pos = alignmentPositions(this.version);
    const n = pos.length;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      if (!((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0))) this.drawAlignment(pos[i], pos[j]);
    }
    this.drawFormatBits(0);                       // reserve; overwritten later
    this.drawVersion();
  }

  drawFinder(x, y) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) this.setFunction(xx, yy, dist !== 2 && dist !== 4);
    }
  }
  drawAlignment(x, y) {
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) this.setFunction(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }

  drawFormatBits(mask) {
    const data = (EC_LEVEL.M.bits << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i) => ((bits >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) this.setFunction(8, i, bit(i));
    this.setFunction(8, 7, bit(6)); this.setFunction(8, 8, bit(7)); this.setFunction(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.setFunction(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) this.setFunction(this.size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.setFunction(8, this.size - 15 + i, bit(i));
    this.setFunction(8, this.size - 8, true);
  }

  drawVersion() {
    if (this.version < 7) return;
    let rem = this.version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (this.version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const b = ((bits >>> i) & 1) !== 0;
      const a = this.size - 11 + (i % 3), c = Math.floor(i / 3);
      this.setFunction(a, c, b); this.setFunction(c, a, b);
    }
  }

  addEccAndInterleave(data) {
    const ver = this.version;
    const [blockEcLen, numBlocks] = EC_M[ver];
    const rawCodewords = totalCodewords(ver);
    const numShort = numBlocks - (rawCodewords % numBlocks);
    const shortLen = Math.floor(rawCodewords / numBlocks);
    const blocks = [];
    const div = rsDivisor(blockEcLen);
    for (let i = 0, k = 0; i < numBlocks; i++) {
      const dat = data.slice(k, k + shortLen - blockEcLen + (i < numShort ? 0 : 1));
      k += dat.length;
      const ecc = rsRemainder(dat, div);
      if (i < numShort) dat.push(0);
      blocks.push(dat.concat(ecc));
    }
    const result = [];
    for (let i = 0; i < blocks[0].length; i++) {
      blocks.forEach((block, j) => { if (i !== shortLen - blockEcLen || j >= numShort) result.push(block[i]); });
    }
    return result;
  }

  drawCodewords(data) {
    let i = 0;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < this.size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? this.size - 1 - vert : vert;
          if (!this.isFunction[y][x] && i < data.length * 8) {
            this.modules[y][x] = ((data[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
            i++;
          }
        }
      }
    }
  }

  applyMask(mask) {
    for (let y = 0; y < this.size; y++) for (let x = 0; x < this.size; x++) {
      let invert;
      switch (mask) {
        case 0: invert = (x + y) % 2 === 0; break;
        case 1: invert = y % 2 === 0; break;
        case 2: invert = x % 3 === 0; break;
        case 3: invert = (x + y) % 3 === 0; break;
        case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
        case 5: invert = (x * y) % 2 + (x * y) % 3 === 0; break;
        case 6: invert = ((x * y) % 2 + (x * y) % 3) % 2 === 0; break;
        default: invert = ((x + y) % 2 + (x * y) % 3) % 2 === 0; break;
      }
      if (!this.isFunction[y][x] && invert) this.modules[y][x] = !this.modules[y][x];
    }
  }

  penaltyScore() {
    let result = 0;
    const n = this.size;
    const finderPenalty = (hist) => {
      const core = hist[1] > 0 && hist[2] === hist[1] && hist[3] === hist[1] * 3 && hist[4] === hist[1] && hist[5] === hist[1];
      return (core && hist[0] >= hist[1] * 4 && hist[6] >= hist[1] ? 1 : 0) + (core && hist[6] >= hist[1] * 4 && hist[0] >= hist[1] ? 1 : 0);
    };
    const push = (hist, v) => { hist.shift(); hist.push(v); };
    const terminate = (dark, run, hist) => { if (dark) { push(hist, run); run = 0; } run += n; push(hist, run); return finderPenalty(hist); };
    for (let y = 0; y < n; y++) {
      let dark = false, run = 0; const hist = [0, 0, 0, 0, 0, 0, 0];
      for (let x = 0; x < n; x++) {
        if (this.modules[y][x] === dark) { run++; if (run === 5) result += 3; else if (run > 5) result++; }
        else { push(hist, run); if (!dark) result += finderPenalty(hist) * 40; dark = this.modules[y][x]; run = 1; }
      }
      result += terminate(dark, run, hist) * 40;
    }
    for (let x = 0; x < n; x++) {
      let dark = false, run = 0; const hist = [0, 0, 0, 0, 0, 0, 0];
      for (let y = 0; y < n; y++) {
        if (this.modules[y][x] === dark) { run++; if (run === 5) result += 3; else if (run > 5) result++; }
        else { push(hist, run); if (!dark) result += finderPenalty(hist) * 40; dark = this.modules[y][x]; run = 1; }
      }
      result += terminate(dark, run, hist) * 40;
    }
    for (let y = 0; y < n - 1; y++) for (let x = 0; x < n - 1; x++) {
      const c = this.modules[y][x];
      if (c === this.modules[y][x + 1] && c === this.modules[y + 1][x] && c === this.modules[y + 1][x + 1]) result += 3;
    }
    let darkCount = 0;
    for (const row of this.modules) darkCount += row.filter(Boolean).length;
    const total = n * n;
    const k = Math.ceil(Math.abs(darkCount * 20 - total * 10) / total) - 1;
    result += k * 10;
    return result;
  }
}

/**
 * Encode text (UTF-8, byte mode) at EC level M with the smallest fitting version.
 * @param {string} text
 * @param {{mask?:number, minVersion?:number}} [opt]  mask -1 (default) = automatic
 */
export function encodeQR(text, opt = {}) {
  const bytes = Array.from(new TextEncoder().encode(text));
  let ver = opt.minVersion || 1;
  for (; ; ver++) {
    if (ver > MAX_VERSION) throw new Error('QR: text too long');
    const ccBits = ver <= 9 ? 8 : 16;
    if (4 + ccBits + bytes.length * 8 <= dataCodewords(ver) * 8) break;
  }
  const cap = dataCodewords(ver) * 8;
  const bits = [];
  appendBits(bits, 0b0100, 4);
  appendBits(bits, bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) appendBits(bits, b, 8);
  appendBits(bits, 0, Math.min(4, cap - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);
  for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) appendBits(bits, pad, 8);
  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) codewords.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  return new QRCode(ver, codewords, opt.mask ?? -1);
}

/** Draw a QR into a canvas 2D context. */
export function drawQR(qr, g, x, y, cellPx, quiet = 4, dark = '#0b0912', light = '#ffffff') {
  const px = (qr.size + quiet * 2) * cellPx;
  g.fillStyle = light; g.fillRect(x, y, px, px);
  g.fillStyle = dark;
  for (let yy = 0; yy < qr.size; yy++) for (let xx = 0; xx < qr.size; xx++) {
    if (qr.get(xx, yy)) g.fillRect(x + (xx + quiet) * cellPx, y + (yy + quiet) * cellPx, cellPx, cellPx);
  }
}
