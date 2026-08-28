import { IMAGE_PROBE_BYTES, probeImage } from './image-probe';
import { jpegFixture, pdfFixture, pngFixture, svgFixture, webpFixture } from './testing/image-fixtures';

/**
 * The server-side content check, tested against real file structure.
 *
 * Two properties are under test and they are not the same thing:
 *
 *   1. **Identification.** What the bytes ARE, independent of what anything
 *      claimed. This is `V3_SECURITY_MODEL.md` §8's "content-sniff uploaded
 *      file types server-side" and it is the control that a declared
 *      content-type allow-list cannot provide -- a client simply lies.
 *   2. **Measurement.** Intrinsic width and height, which is what makes the
 *      zero-layout-shift requirement achievable at all.
 */
describe('probeImage', () => {
  describe('identification', () => {
    it('identifies a PNG and reads its IHDR dimensions', () => {
      expect(probeImage(pngFixture(800, 600))).toEqual({ format: 'image/png', width: 800, height: 600 });
    });

    it('identifies a JPEG by walking the segment chain to SOF0', () => {
      // The fixture puts a JFIF APP0 segment before the frame header, so a
      // parser reading a fixed offset instead of walking segments fails here.
      expect(probeImage(jpegFixture(1024, 768))).toEqual({ format: 'image/jpeg', width: 1024, height: 768 });
    });

    it('identifies a lossless WebP', () => {
      expect(probeImage(webpFixture(640, 480))).toEqual({ format: 'image/webp', width: 640, height: 480 });
    });

    it('handles a non-square image without transposing width and height', () => {
      // JPEG stores height BEFORE width, which is the one place this is easy
      // to get backwards and impossible to notice with a square fixture.
      const probed = probeImage(jpegFixture(300, 900));
      expect(probed).toEqual({ format: 'image/jpeg', width: 300, height: 900 });
    });
  });

  describe('refusal', () => {
    it('refuses a PDF', () => {
      expect(probeImage(pdfFixture())).toBeNull();
    });

    it('refuses an SVG, which is an executable document', () => {
      // The attack this closes: declare `image/png`, upload this, and have it
      // served from an origin that holds a session. The declared-type
      // allow-list does not catch it; the sniff does.
      expect(probeImage(svgFixture())).toBeNull();
    });

    it('refuses an empty buffer', () => {
      expect(probeImage(Buffer.alloc(0))).toBeNull();
    });

    it('refuses random bytes', () => {
      expect(probeImage(Buffer.from([0x12, 0x34, 0x56, 0x78, 0x9a]))).toBeNull();
    });

    it('refuses a truncated PNG whose signature is intact but whose IHDR is not', () => {
      expect(probeImage(pngFixture(100, 100).subarray(0, 14))).toBeNull();
    });

    it('refuses a zero-dimension image rather than reporting it', () => {
      // A zero would divide by zero in every aspect-ratio calculation
      // downstream, so it is refused here rather than stored and defended
      // against at each renderer.
      expect(probeImage(pngFixture(0, 100))).toBeNull();
    });

    it('terminates on a JPEG whose segment chain is corrupt', () => {
      // The regression this guards: a scanner that searches forward for the
      // next marker byte loops forever on a file engineered to have none.
      const broken = jpegFixture(100, 100);
      broken[2] = 0x00; // where a marker's 0xFF prefix should be
      expect(probeImage(broken)).toBeNull();
    });

    it('refuses a JPEG that reaches start-of-scan without a frame header', () => {
      const soi = Buffer.from([0xff, 0xd8]);
      const sos = Buffer.from([0xff, 0xda, 0x00, 0x02]);
      expect(probeImage(Buffer.concat([soi, sos, Buffer.alloc(64)]))).toBeNull();
    });
  });

  describe('the probe window', () => {
    it('is large enough for a JPEG carrying a realistic EXIF block', () => {
      // Phone cameras routinely emit APP1/EXIF segments of tens of kilobytes
      // before the frame header. The window has to clear that, or every photo
      // taken on a phone is rejected as "not a valid image".
      const withBigExif = Buffer.concat([
        Buffer.from([0xff, 0xd8]),
        (() => {
          const exif = Buffer.alloc(48 * 1024);
          exif[0] = 0xff;
          exif[1] = 0xe1;
          exif.writeUInt16BE(exif.length - 2, 2);
          return exif;
        })(),
        jpegFixture(1200, 1600).subarray(2),
      ]);

      expect(withBigExif.length).toBeLessThan(IMAGE_PROBE_BYTES);
      expect(probeImage(withBigExif.subarray(0, IMAGE_PROBE_BYTES))).toEqual({
        format: 'image/jpeg',
        width: 1200,
        height: 1600,
      });
    });
  });
});
