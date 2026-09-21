/**
 * @jest-environment node
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The share image and the favicon set -- `32_SEO_METADATA.md`.
 *
 * They are static PNG files in `app/`, picked up by Next's file conventions,
 * because messengers do not fetch an SVG for a link preview. The suite reads
 * each file's real dimensions from its PNG header, so a swapped or truncated
 * file fails here rather than in a chat app after release.
 */

const APP = join(__dirname, '..', 'app');
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function dimensions(file: string): { width: number; height: number } {
  const bytes = readFileSync(join(APP, file));
  expect(bytes.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe('the placeholder brand imagery', () => {
  it.each([
    ['opengraph-image.png', 1200, 630],
    ['twitter-image.png', 1200, 630],
    ['apple-icon.png', 180, 180],
    ['icon1.png', 16, 16],
    ['icon2.png', 32, 32],
    ['icon3.png', 512, 512],
  ])('%s is %ix%i', (file, width, height) => {
    expect(dimensions(file)).toEqual({ width, height });
  });

  it('describes the share images with the site name and nothing invented', () => {
    for (const file of ['opengraph-image.alt.txt', 'twitter-image.alt.txt']) {
      expect(readFileSync(join(APP, file), 'utf8')).toBe('BeauClick');
    }
  });
});
