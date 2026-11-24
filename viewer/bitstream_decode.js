// Fetches a scene's compressed bitstream files and decodes them into per-Gaussian attributes.

import { decodeBitstream } from "./lib/vq-decode.js";

const REQUIRED_FILES = [
  "header.bin", "logits.npz", "cdf_tables.npz", "codebook.npz", "index_bitstream.bin",
  "position_static.npz", "position_disp.npz", "opacity_var.npz", "is_even.bin",
];
const OPTIONAL_FILES = [
  "use_wavelet_vq.bin", "use_delta_rot.bin", "compand_mu.bin",
  "position_motion_ref.npz", "rotation_ref.npz", "n_delta_frames.bin",
  "motion_wavelet_approx.npz",
];

async function fetchBytes(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  return new Uint8Array(await res.arrayBuffer());
}

export async function loadBitstreamPayload(dir, onProgress) {
  const manifest = await (await fetch(`${dir}/manifest.json`)).json();

  const raw = {};
  const allFiles = [...REQUIRED_FILES, ...OPTIONAL_FILES];
  let loaded = 0;
  await Promise.all(
    allFiles.map(async (name) => {
      const bytes = await fetchBytes(`${dir}/${name}`);
      if (bytes !== null) raw[name] = bytes;
      loaded++;
      onProgress?.(loaded, allFiles.length);
    }),
  );

  for (const name of REQUIRED_FILES) {
    if (!(name in raw)) throw new Error(`bitstream_decode: missing required file ${dir}/${name}`);
  }

  onProgress?.(allFiles.length, allFiles.length, "decoding…");
  return decodeBitstream(raw, manifest);
}
