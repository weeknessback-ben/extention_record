import type { Platform } from './types';

export function detectPlatform(url: string): Platform {
  try {
    const host = new URL(url).hostname;
    if (host === 'meet.google.com') return 'meet';
    if (host === 'zoom.us' || host.endsWith('.zoom.us')) return 'zoom';
  } catch {
    // ignore
  }
  return 'other';
}

/** "app.zoom.us" -> "zoom.us": navigating within the same site keeps recording. */
export function siteOf(url: string): string {
  try {
    return new URL(url).hostname.split('.').slice(-2).join('.');
  } catch {
    return '';
  }
}

/** Turns "Meet - abc-defg-hij" or "Weekly sync - Zoom" into a usable title. */
export function cleanTabTitle(title: string, url: string): string {
  const cleaned = title
    .replace(/^(google\s+)?meet\s*[-–—:|]\s*/i, '')
    .replace(/\s*[-–—|]\s*(google meet|zoom( meeting| workplace)?)$/i, '')
    .trim();
  if (cleaned && !/^(meet|zoom|zoom meeting|zoom workplace|google meet)$/i.test(cleaned)) return cleaned;
  const platform = detectPlatform(url);
  if (platform === 'meet') {
    const code = new URL(url).pathname.replace(/\//g, '');
    return code ? `Google Meet ${code}` : 'Google Meet';
  }
  if (platform === 'zoom') return 'Zoom meeting';
  return title.trim() || 'Meeting';
}
