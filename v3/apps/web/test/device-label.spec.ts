import { UNKNOWN_DEVICE_LABEL, deviceName, deviceTitle } from '@/lib/device-label';
import { relativePastLabel } from '@/lib/relative-time';

const UA = {
  chromeWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  edgeWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
  safariMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  safariIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  chromeIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.0.0 Mobile/15E148 Safari/604.1',
  chromeAndroid: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0',
  operaWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 OPR/111.0.0.0',
};

describe('deviceTitle', () => {
  it.each([
    [UA.chromeWin, 'Chrome · Windows'],
    [UA.edgeWin, 'Edge · Windows'], // Edge also says Chrome
    [UA.operaWin, 'Opera · Windows'], // so does Opera
    [UA.safariMac, 'Safari · macOS'],
    [UA.safariIphone, 'Safari · iOS'],
    [UA.chromeIphone, 'Chrome · iOS'], // Chrome on iOS also says Safari
    [UA.chromeAndroid, 'Chrome · Android'], // and Android also says Linux
    [UA.firefoxLinux, 'Firefox · Linux'],
  ])('reads %#  as %s', (ua, expected) => {
    expect(deviceTitle(ua)).toBe(expected);
  });

  it('says one neutral thing — never the raw string — for a device it cannot read', () => {
    expect(deviceTitle(null)).toBe(UNKNOWN_DEVICE_LABEL);
    expect(deviceTitle('')).toBe(UNKNOWN_DEVICE_LABEL);
    expect(deviceTitle('curl/8.0')).toBe(UNKNOWN_DEVICE_LABEL);
  });

  it('gives what it can when only one of the two is readable', () => {
    expect(deviceName('Mozilla/5.0 (Windows NT 10.0)')).toEqual({ browser: null, system: 'Windows' });
    expect(deviceTitle('Mozilla/5.0 (Windows NT 10.0)')).toBe('Windows');
  });
});

describe('relativePastLabel', () => {
  const NOW = new Date('2026-09-21T10:00:00.000Z').getTime();
  const ago = (ms: number) => new Date(NOW - ms).toISOString();
  const M = 60_000;
  const H = 60 * M;
  const D = 24 * H;

  it.each([
    [10_000, 'همین حالا'],
    [5 * M, '۵ دقیقه پیش'],
    [3 * H, '۳ ساعت پیش'],
    [2 * D, '۲ روز پیش'],
    [21 * D, '۳ هفته پیش'],
    [90 * D, '۳ ماه پیش'],
    [800 * D, '۲ سال پیش'],
  ])('reads %d ms ago as %s', (ms, expected) => {
    expect(relativePastLabel(ago(ms), NOW)).toBe(expected);
  });

  it('reads a time in the future — a clock a little ahead — as just now, never negative', () => {
    expect(relativePastLabel(new Date(NOW + 5 * M).toISOString(), NOW)).toBe('همین حالا');
  });

  it('reads an unparseable time as just now rather than NaN', () => {
    expect(relativePastLabel('not a date', NOW)).toBe('همین حالا');
  });
});
