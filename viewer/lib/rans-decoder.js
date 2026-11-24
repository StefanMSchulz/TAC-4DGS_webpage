// rANS entropy decoder.

const PRECISION = 16;
const SCALE = 1 << PRECISION;
const BYPASS_PRECISION = 4;
const MAX_BYPASS_VAL = (1 << BYPASS_PRECISION) - 1;
const RANS64_L = 1n << 31n;
const PRECISION_MASK = BigInt(SCALE - 1);

function toF32Array(logits) {
  const out = new Float32Array(logits.length);
  for (let i = 0; i < logits.length; i++) out[i] = Math.fround(logits[i]);
  return out;
}

function softmaxF32(logitsF32) {
  let m = -Infinity;
  for (let i = 0; i < logitsF32.length; i++) if (logitsF32[i] > m) m = logitsF32[i];

  const exps = new Float32Array(logitsF32.length);
  let sum = Math.fround(0);
  for (let i = 0; i < logitsF32.length; i++) {
    const e = Math.fround(Math.exp(Math.fround(logitsF32[i] - m)));
    exps[i] = e;
    sum = Math.fround(sum + e);
  }
  const pmf = new Float32Array(logitsF32.length);
  for (let i = 0; i < logitsF32.length; i++) pmf[i] = Math.fround(exps[i] / sum);
  return pmf;
}

function pmfToQuantizedCdf(pmf, precision) {
  const scale = 1 << precision;
  const n = pmf.length;
  const cdf = new Array(n + 1).fill(0);

  for (let i = 0; i < n; i++) {
    cdf[i + 1] = Math.round(Math.fround(pmf[i] * scale));
  }

  let total = 0;
  for (let i = 0; i < cdf.length; i++) total += cdf[i];
  if (total === 0) throw new Error("pmf_to_quantized_cdf: pmf is all-zero");

  for (let i = 0; i < cdf.length; i++) {
    cdf[i] = Math.floor((scale * cdf[i]) / total);
  }

  for (let i = 1; i < cdf.length; i++) cdf[i] += cdf[i - 1];
  cdf[cdf.length - 1] = scale;

  for (let i = 0; i < cdf.length - 1; i++) {
    if (cdf[i] === cdf[i + 1]) {
      let bestFreq = 0xffffffff;
      let bestSteal = -1;
      for (let j = 0; j < cdf.length - 1; j++) {
        const freq = cdf[j + 1] - cdf[j];
        if (freq > 1 && freq < bestFreq) {
          bestFreq = freq;
          bestSteal = j;
        }
      }
      if (bestSteal < 0) throw new Error("pmf_to_quantized_cdf: no donor bin found");
      if (bestSteal < i) {
        for (let j = bestSteal + 1; j <= i; j++) cdf[j] -= 1;
      } else {
        for (let j = i + 1; j <= bestSteal; j++) cdf[j] += 1;
      }
    }
  }

  return cdf;
}

export function buildCdf(logits, precision = PRECISION) {
  const logitsF32 = toF32Array(logits);
  const pmfReal = softmaxF32(logitsF32);
  let sum = 0;
  for (let i = 0; i < pmfReal.length; i++) sum += pmfReal[i];
  const overflow = Math.max(Math.fround(1 - Math.fround(sum)), 0);
  const pmf = new Array(pmfReal.length + 1);
  for (let i = 0; i < pmfReal.length; i++) pmf[i] = pmfReal[i];
  pmf[pmfReal.length] = overflow;

  const cdf = pmfToQuantizedCdf(pmf, precision);
  const maxValue = logitsF32.length;
  return { cdf, maxValue };
}

class RansReader {
  constructor(bytes) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    this.wordPos = 2;
    const w0 = BigInt(this.view.getUint32(0, true));
    const w1 = BigInt(this.view.getUint32(4, true));
    this.x = w0 | (w1 << 32n);
  }

  _readWord() {
    const w = BigInt(this.view.getUint32(this.wordPos * 4, true));
    this.wordPos += 1;
    return w;
  }

  decGet() {
    return Number(this.x & PRECISION_MASK);
  }

  decAdvance(start, freq) {
    let x = this.x;
    x = BigInt(freq) * (x >> BigInt(PRECISION)) + (x & PRECISION_MASK) - BigInt(start);
    if (x < RANS64_L) x = (x << 32n) | this._readWord();
    this.x = x;
  }

  decGetBits(nbits) {
    const mask = (1n << BigInt(nbits)) - 1n;
    const val = this.x & mask;
    let x = this.x >> BigInt(nbits);
    if (x < RANS64_L) x = (x << 32n) | this._readWord();
    this.x = x;
    return Number(val);
  }
}

function findSymbol(cdf, cumFreq, maxValue) {
  let lo = 0, hi = maxValue + 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cdf[mid] <= cumFreq) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

export function decodeSymbols(bytes, cdf, maxValue, count) {
  const reader = new RansReader(bytes);
  const out = new Int32Array(count);

  for (let i = 0; i < count; i++) {
    const cumFreq = reader.decGet();
    const s = findSymbol(cdf, cumFreq, maxValue);
    reader.decAdvance(cdf[s], cdf[s + 1] - cdf[s]);

    let value = s;
    if (value === maxValue) {
      let val = reader.decGetBits(BYPASS_PRECISION);
      let nBypass = val;
      while (val === MAX_BYPASS_VAL) {
        val = reader.decGetBits(BYPASS_PRECISION);
        nBypass += val;
      }
      let rawVal = 0;
      for (let j = 0; j < nBypass; j++) {
        val = reader.decGetBits(BYPASS_PRECISION);
        rawVal |= val << (j * BYPASS_PRECISION);
      }
      value = rawVal >> 1;
      if (rawVal & 1) value = -value - 1;
      else value += maxValue;
    }
    out[i] = value;
  }

  return out;
}
