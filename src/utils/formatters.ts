import type { QualityPreset, VideoFormat } from '../types/video';

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) {
    return 'Stream';
  }
  const units = ['B', 'KB', 'MB', 'GB'];
  let idx = 0;
  let value = bytes;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value >= 100 || idx === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[idx]}`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) {
    return '—';
  }
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  if (h > 0) {
    return `${h}:${pad(m)}:${pad(s)}`;
  }
  return `${pad(m)}:${pad(s)}`;
}

export function extractFacebookUrlsFromText(rawText: string): string[] {
  const lines = rawText
    .split(/[\r\n,;]+/)
    .map((line) => line.trim())
    .filter(Boolean);

  const seen = new Set<string>();
  const valid: string[] = [];

  for (const item of lines) {
    const cleaned = item.replace(/^["'<]+|["'>]+$/g, '').trim();
    if (!cleaned) continue;

    const normalized = /^https?:\/\//i.test(cleaned) ? cleaned : `https://${cleaned}`;
    try {
      const parsed = new URL(normalized);
      const host = parsed.hostname.toLowerCase();
      const isFb =
        host === 'fb.watch' ||
        host.endsWith('.fb.watch') ||
        host === 'facebook.com' ||
        host.endsWith('.facebook.com') ||
        host === 'fb.com' ||
        host.endsWith('.fb.com');
      if (isFb && !seen.has(parsed.toString())) {
        seen.add(parsed.toString());
        valid.push(parsed.toString());
      }
    } catch {
      // skip invalid tokens
    }
  }

  return valid;
}

export function pickFormatForPreset(formats: VideoFormat[], preset: QualityPreset): VideoFormat | undefined {
  if (formats.length === 0) return undefined;

  if (preset === 'mp3') {
    return formats.find((f) => f.container === 'MP3') || formats.find((f) => f.container === 'M4A') || formats[0];
  }

  const videoFormats = formats.filter((f) => f.container === 'MP4');
  if (videoFormats.length === 0) return formats[0];

  if (preset === 'highest') {
    return videoFormats[0];
  }

  if (preset === '1080p') {
    return (
      videoFormats.find((f) => (f.height || 0) === 1080) ||
      videoFormats.find((f) => (f.height || 0) <= 1080 && (f.height || 0) >= 720) ||
      videoFormats[0]
    );
  }

  if (preset === '720p') {
    return (
      videoFormats.find((f) => (f.height || 0) === 720) ||
      videoFormats.find((f) => f.quality.includes('720')) ||
      videoFormats.find((f) => (f.height || 0) <= 720) ||
      videoFormats[0]
    );
  }

  // sd
  return (
    videoFormats.find((f) => (f.height || 0) <= 480) ||
    videoFormats[videoFormats.length - 1]
  );
}
