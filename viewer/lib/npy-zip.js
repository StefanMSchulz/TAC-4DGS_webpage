// Reads .npy arrays from .npz (zip) archives.

import { inflateRaw } from "./inflate.js";

const textDecoder = new TextDecoder("ascii");

export function readZip(buf) {
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  const entries = {};
  let pos = 0;

  while (pos < buf.byteLength) {
    const sig = view.getUint32(pos, true);
    if (sig === 0x02014b50 /* central directory */ || sig === 0x06054b50 /* EOCD */) break;
    if (sig !== 0x04034b50 /* local file header */) {
      throw new Error(`npy-zip: unexpected signature 0x${sig.toString(16)} at byte ${pos}`);
    }

    const method = view.getUint16(pos + 8, true);
    const compSize = view.getUint32(pos + 18, true);
    const uncompSize = view.getUint32(pos + 22, true);
    const nameLen = view.getUint16(pos + 26, true);
    const extraLen = view.getUint16(pos + 28, true);
    const nameStart = pos + 30;
    const name = textDecoder.decode(bytes.subarray(nameStart, nameStart + nameLen));
    const dataStart = nameStart + nameLen + extraLen;
    const compData = bytes.subarray(dataStart, dataStart + compSize);

    let raw;
    if (method === 0) {
      raw = compData;
    } else if (method === 8) {
      raw = inflateRaw(compData, uncompSize);
    } else {
      throw new Error(`npy-zip: unsupported compression method ${method} for ${name}`);
    }
    entries[name] = raw;

    pos = dataStart + compSize;
  }

  return entries;
}

const DTYPE_CTORS = {
  "<f4": Float32Array,
  "<f8": Float64Array,
  "<i4": Int32Array,
  "<i8": BigInt64Array,
  "<u4": Uint32Array,
  "<u8": BigUint64Array,
  "<i2": Int16Array,
  "<u2": Uint16Array,
  "|u1": Uint8Array,
  "|i1": Int8Array,
  "|b1": Uint8Array,
};

function float16ToFloat32(h) {
  const sign = (h & 0x8000) >> 15;
  const exp = (h & 0x7c00) >> 10;
  const frac = h & 0x03ff;
  let f;
  if (exp === 0) {
    f = frac === 0 ? 0 : (frac / 1024) * Math.pow(2, -14);
  } else if (exp === 0x1f) {
    f = frac === 0 ? Infinity : NaN;
  } else {
    f = (1 + frac / 1024) * Math.pow(2, exp - 15);
  }
  return sign ? -f : f;
}

function decodeFloat16Array(bytes) {
  const u16 = new Uint16Array(bytes.length / 2);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  for (let i = 0; i < u16.length; i++) u16[i] = dv.getUint16(i * 2, true);
  const out = new Float32Array(u16.length);
  for (let i = 0; i < u16.length; i++) out[i] = float16ToFloat32(u16[i]);
  return out;
}

export function parseNpy(bytes) {
  if (bytes[0] !== 0x93 || textDecoder.decode(bytes.subarray(1, 6)) !== "NUMPY") {
    throw new Error("npy-zip: bad .npy magic");
  }
  const major = bytes[6];
  let headerLen, headerStart;
  if (major === 1) {
    headerLen = bytes[8] | (bytes[9] << 8);
    headerStart = 10;
  } else {
    const dv = new DataView(bytes.buffer, bytes.byteOffset + 8, 4);
    headerLen = dv.getUint32(0, true);
    headerStart = 12;
  }
  const headerStr = textDecoder.decode(bytes.subarray(headerStart, headerStart + headerLen));

  const descrMatch = headerStr.match(/'descr':\s*'([^']+)'/);
  const shapeMatch = headerStr.match(/'shape':\s*\(([^)]*)\)/);
  const fortranMatch = headerStr.match(/'fortran_order':\s*(True|False)/);
  if (!descrMatch || !shapeMatch) throw new Error("npy-zip: could not parse .npy header: " + headerStr);
  const dtype = descrMatch[1];
  const shape = shapeMatch[1]
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map(Number);
  const fortranOrder = fortranMatch ? fortranMatch[1] === "True" : false;
  if (fortranOrder) throw new Error("npy-zip: fortran-order arrays not supported (not used by this pipeline)");

  const dataStart = headerStart + headerLen;
  const dataBytes = bytes.subarray(dataStart);
  const aligned = new Uint8Array(dataBytes.length);
  aligned.set(dataBytes);

  let data;
  if (dtype === "<f2") {
    data = decodeFloat16Array(aligned);
  } else {
    const Ctor = DTYPE_CTORS[dtype];
    if (!Ctor) throw new Error(`npy-zip: unsupported dtype ${dtype}`);
    data = new Ctor(aligned.buffer);
  }

  return { dtype, shape, data };
}

export function readNpz(buf) {
  const zip = readZip(buf);
  const out = {};
  for (const [name, raw] of Object.entries(zip)) {
    if (!name.endsWith(".npy")) continue;
    out[name.slice(0, -4)] = parseNpy(raw);
  }
  return out;
}
