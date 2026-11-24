// Minimal DEFLATE decoder (raw inflate) for reading .npz archives.

class BitReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.bytePos = 0;
    this.bitBuf = 0;
    this.bitCount = 0;
  }

  bits(n) {
    while (this.bitCount < n) {
      this.bitBuf |= this.bytes[this.bytePos++] << this.bitCount;
      this.bitCount += 8;
    }
    const val = this.bitBuf & ((1 << n) - 1);
    this.bitBuf >>>= n;
    this.bitCount -= n;
    return val;
  }

  alignToByte() {
    this.bitBuf = 0;
    this.bitCount = 0;
  }
}

function buildHuffman(lengths) {
  const MAXBITS = 15;
  const counts = new Array(MAXBITS + 1).fill(0);
  for (const len of lengths) counts[len]++;
  counts[0] = 0;

  const offsets = new Array(MAXBITS + 2).fill(0);
  for (let len = 1; len <= MAXBITS; len++) offsets[len + 1] = offsets[len] + counts[len];

  const symbols = new Array(lengths.length).fill(0);
  for (let sym = 0; sym < lengths.length; sym++) {
    const len = lengths[sym];
    if (len !== 0) symbols[offsets[len]++] = sym;
  }

  return { counts, symbols };
}

function decodeSymbol(reader, table) {
  let code = 0;
  let first = 0;
  let index = 0;
  for (let len = 1; len <= 15; len++) {
    code |= reader.bits(1);
    const count = table.counts[len];
    if (code - first < count) return table.symbols[index + (code - first)];
    index += count;
    first += count;
    first <<= 1;
    code <<= 1;
  }
  throw new Error("inflate: invalid Huffman code");
}

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function fixedTables() {
  const litLengths = new Array(288);
  for (let i = 0; i <= 143; i++) litLengths[i] = 8;
  for (let i = 144; i <= 255; i++) litLengths[i] = 9;
  for (let i = 256; i <= 279; i++) litLengths[i] = 7;
  for (let i = 280; i <= 287; i++) litLengths[i] = 8;
  const distLengths = new Array(30).fill(5);
  return { lit: buildHuffman(litLengths), dist: buildHuffman(distLengths) };
}

function dynamicTables(reader) {
  const hlit = reader.bits(5) + 257;
  const hdist = reader.bits(5) + 1;
  const hclen = reader.bits(4) + 4;

  const clLengths = new Array(19).fill(0);
  for (let i = 0; i < hclen; i++) clLengths[CLEN_ORDER[i]] = reader.bits(3);
  const clTable = buildHuffman(clLengths);

  const lengths = new Array(hlit + hdist).fill(0);
  let i = 0;
  while (i < lengths.length) {
    const sym = decodeSymbol(reader, clTable);
    if (sym < 16) {
      lengths[i++] = sym;
    } else if (sym === 16) {
      const rep = reader.bits(2) + 3;
      const prev = lengths[i - 1];
      for (let r = 0; r < rep; r++) lengths[i++] = prev;
    } else if (sym === 17) {
      const rep = reader.bits(3) + 3;
      for (let r = 0; r < rep; r++) lengths[i++] = 0;
    } else {
      const rep = reader.bits(7) + 11;
      for (let r = 0; r < rep; r++) lengths[i++] = 0;
    }
  }

  return {
    lit: buildHuffman(lengths.slice(0, hlit)),
    dist: buildHuffman(lengths.slice(hlit)),
  };
}

export function inflateRaw(input, expectedSize) {
  const reader = new BitReader(input);
  const out = new Uint8Array(expectedSize);
  let outPos = 0;

  for (;;) {
    const final = reader.bits(1);
    const type = reader.bits(2);

    if (type === 0) {
      reader.alignToByte();
      const len = input[reader.bytePos] | (input[reader.bytePos + 1] << 8);
      reader.bytePos += 4;
      out.set(input.subarray(reader.bytePos, reader.bytePos + len), outPos);
      reader.bytePos += len;
      outPos += len;
    } else if (type === 1 || type === 2) {
      const { lit, dist } = type === 1 ? fixedTables() : dynamicTables(reader);
      for (;;) {
        const sym = decodeSymbol(reader, lit);
        if (sym === 256) break;
        if (sym < 256) {
          out[outPos++] = sym;
          continue;
        }
        const lenIdx = sym - 257;
        const length = LENGTH_BASE[lenIdx] + reader.bits(LENGTH_EXTRA[lenIdx]);
        const distSym = decodeSymbol(reader, dist);
        const distance = DIST_BASE[distSym] + reader.bits(DIST_EXTRA[distSym]);
        let src = outPos - distance;
        for (let k = 0; k < length; k++) out[outPos++] = out[src++];
      }
    } else {
      throw new Error(`inflate: unsupported block type ${type}`);
    }

    if (final) break;
  }

  if (outPos !== expectedSize) {
    throw new Error(`inflate: size mismatch, got ${outPos} expected ${expectedSize}`);
  }
  return out;
}
