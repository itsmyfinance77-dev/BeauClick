/**
 * Server-side image identification, from the bytes that actually arrived.
 *
 * `V3_SECURITY_MODEL.md` §8: "Content-sniff uploaded file types server-side;
 * never trust a client-supplied MIME type or file extension." This is that
 * sniff. It runs at finalize against a range read back FROM the object store,
 * so what is inspected is the stored object, not the request that claimed to
 * create it -- a distinction that matters because with presigned direct
 * upload the API never sees the request body at all.
 *
 * It also extracts WIDTH AND HEIGHT, which is not decoration. The one
 * measurable Definition-of-Done item Phase C carries is "renders with zero
 * layout shift", and a browser cannot reserve space for an image whose
 * aspect ratio is unknown until it loads. Persisting the intrinsic
 * dimensions at upload time is what lets every later surface set an explicit
 * ratio without measuring anything.
 *
 * WHY NO IMAGE LIBRARY. `sharp` (or any libvips/ImageMagick binding) is a
 * native, platform-specific binary, and it would be pulled in to answer two
 * questions -- "what is this really" and "how big is it" -- that are
 * answerable from the file header in under 200 lines of pure TypeScript.
 * Decoding, resizing, and re-encoding are a different problem with a
 * different answer, and are deliberately NOT in this phase; see the phase
 * report's deferral of derivative generation.
 *
 * The formats accepted are exactly the three a 2026 Persian-language beauty
 * marketplace needs to accept from a phone camera or a designer: JPEG, PNG,
 * WebP. Anything else -- SVG most pointedly, which is an executable document
 * and a stored-XSS vector when served from an origin that holds a session --
 * is refused.
 */

export type ProbedImageFormat = 'image/jpeg' | 'image/png' | 'image/webp';

export interface ProbedImage {
  format: ProbedImageFormat;
  width: number;
  height: number;
}

/** How many bytes `probeImage` needs. JPEG's SOF marker can sit deep behind EXIF. */
export const IMAGE_PROBE_BYTES = 64 * 1024;

function probePng(buffer: Buffer): ProbedImage | null {
  // 8-byte signature, then an IHDR chunk whose length/type occupy 8 more.
  if (buffer.length < 24) return null;
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buffer.subarray(0, 8).equals(signature)) return null;
  if (buffer.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
  return { format: 'image/png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function probeJpeg(buffer: Buffer): ProbedImage | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;

  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      // Not sitting on a marker. Rather than scanning forward -- which is how
      // a malformed file turns into an infinite loop -- give up: a JPEG whose
      // segment chain is broken is one this platform declines to accept.
      return null;
    }
    const marker = buffer[offset + 1];

    // Standalone markers carry no length payload.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    // Start of scan: the entropy-coded data begins and no SOF will follow.
    if (marker === 0xda) return null;

    const segmentLength = buffer.readUInt16BE(offset + 2);
    if (segmentLength < 2) return null;

    // SOF0..SOF15, excluding the four that are not frame headers (DHT 0xC4,
    // JPG 0xC8, DAC 0xCC, and the RSTn range handled above).
    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) {
      // Layout: length(2) precision(1) height(2) width(2).
      if (offset + 9 > buffer.length) return null;
      return { format: 'image/jpeg', height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }

    offset += 2 + segmentLength;
  }
  return null;
}

function probeWebp(buffer: Buffer): ProbedImage | null {
  if (buffer.length < 30) return null;
  if (buffer.subarray(0, 4).toString('ascii') !== 'RIFF') return null;
  if (buffer.subarray(8, 12).toString('ascii') !== 'WEBP') return null;

  const chunk = buffer.subarray(12, 16).toString('ascii');

  // Lossy. The 10-byte VP8 frame header ends with 14-bit width and height.
  if (chunk === 'VP8 ') {
    const width = buffer.readUInt16LE(26) & 0x3fff;
    const height = buffer.readUInt16LE(28) & 0x3fff;
    return { format: 'image/webp', width, height };
  }

  // Lossless. 14-bit width-1 and height-1 packed across four bytes after the
  // 0x2f signature byte.
  if (chunk === 'VP8L') {
    const bits = buffer.readUInt32LE(21);
    return {
      format: 'image/webp',
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }

  // Extended. Canvas size is stored as three-byte little-endian minus one.
  if (chunk === 'VP8X') {
    const width = 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16));
    const height = 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16));
    return { format: 'image/webp', width, height };
  }

  return null;
}

/**
 * Identifies the image, or returns `null`.
 *
 * `null` means "this platform will not accept these bytes" and is the only
 * failure mode: a caller never learns WHY, because the distinction between
 * "corrupt JPEG" and "PDF renamed to .jpg" is only useful to somebody
 * probing what gets through.
 */
export function probeImage(buffer: Buffer): ProbedImage | null {
  const probed = probePng(buffer) ?? probeJpeg(buffer) ?? probeWebp(buffer);
  if (!probed) return null;
  // A zero dimension is not a real image, and it would divide by zero in
  // every aspect-ratio calculation downstream.
  if (probed.width <= 0 || probed.height <= 0) return null;
  return probed;
}
