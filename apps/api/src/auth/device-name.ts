// A friendly name for a session's device, from its User-Agent. Display
// only: the header is chosen by the client, so it is never trusted for a
// decision (THREATS.md S23).

const BROWSERS: [RegExp, string][] = [
  [/\bEdg(?:e|A|iOS)?\//, 'Edge'],
  [/\bOPR\/|\bOpera\b/, 'Opera'],
  [/\bSamsungBrowser\//, 'Samsung Internet'],
  [/\bFirefox\/|\bFxiOS\//, 'Firefox'],
  [/\bChrome\/|\bCriOS\//, 'Chrome'],
  [/\bSafari\//, 'Safari'],
];

const SYSTEMS: [RegExp, string][] = [
  [/\bAndroid\b/, 'Android'],
  [/\biPhone\b/, 'iPhone'],
  [/\biPad\b/, 'iPad'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bWindows\b/, 'Windows'],
  [/\bMac OS X\b|\bMacintosh\b/, 'Mac'],
  [/\bLinux\b/, 'Linux'],
];

export function deviceName(ua: string | null | undefined): string {
  if (!ua) return 'Unknown device';
  // The Android app names itself (apps/mobile/lib/core/api.dart).
  const app = /^TrustVault Android app(?: \(([^)]{1,60})\))?/.exec(ua);
  if (app) return app[1] ? `TrustVault app on ${app[1]}` : 'TrustVault Android app';
  const browser = BROWSERS.find(([re]) => re.test(ua))?.[1];
  const system = SYSTEMS.find(([re]) => re.test(ua))?.[1];
  if (browser && system) return `${browser} on ${system}`;
  if (browser || system) return (browser ?? system)!;
  return ua.length > 40 ? `${ua.slice(0, 40)}…` : ua;
}
