import crypto from 'node:crypto';
import type { InspectedVideo, VideoFormat } from '../src/types/video.ts';
import {
  assertSafePublicHost,
  isAllowedCdnHost,
  normalizeAndValidateFacebookUrl,
  sanitizeFilename,
  signMediaToken,
  stripLoneSurrogates,
} from './security.ts';

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';

interface RawDashTrack {
  url: string;
  mimeType: string;
  codecs: string;
  width: number | null;
  height: number | null;
  bandwidth: number | null;
  qualityLabel: string;
}

interface ExtractedStreamCandidate {
  url: string;
  audioUrl?: string;
  width: number | null;
  height: number | null;
  quality: string;
  label: string;
  codec: string;
  bandwidth: number | null;
  isMuxed: boolean;
  mode: 'direct' | 'mux';
}

export class ExtractionError extends Error {
  code: string;
  statusCode: number;

  constructor(message: string, code: string, statusCode = 422) {
    super(message);
    this.name = 'ExtractionError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function decodeHtmlAndJsonString(value: string): string {
  const safeCodePoint = (num: number): string => {
    if (!Number.isFinite(num) || num <= 0 || num > 0x10ffff) return '';
    try {
      return String.fromCodePoint(num);
    } catch {
      return '';
    }
  };

  let out = value
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\\//g, '/')
    .replace(/\\"/g, '"')
    .replace(/\\n/g, ' ')
    .replace(/\\t/g, ' ')
    .replace(/\\r/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeCodePoint(parseInt(dec, 10)));

  return stripLoneSurrogates(out).trim();
}

export async function fetchWithSafeRedirects(
  initialUrl: string,
  headers: Record<string, string>,
  allowCdn = false,
  timeoutMs = 12000
): Promise<{ html: string; finalUrl: string; status: number }> {
  let currentUrl = initialUrl;

  for (let hop = 0; hop < 6; hop += 1) {
    const parsed = new URL(currentUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new ExtractionError('Unsupported redirect protocol.', 'INVALID_URL', 400);
    }

    await assertSafePublicHost(parsed.hostname, allowCdn);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res: Response;
    try {
      res = await fetch(currentUrl, {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) {
        break;
      }
      const nextUrl = new URL(loc, currentUrl);
      if (nextUrl.pathname.startsWith('/login')) {
        return { html: '', finalUrl: nextUrl.toString(), status: 401 };
      }
      const nextHost = nextUrl.hostname.toLowerCase();
      if (!isAllowedCdnHost(nextHost)) {
        throw new ExtractionError('Redirect pointed outside allowed Facebook domains.', 'INVALID_REDIRECT', 400);
      }
      currentUrl = nextUrl.toString();
      continue;
    }

    const text = await res.text();
    return { html: text, finalUrl: currentUrl, status: res.status };
  }

  throw new ExtractionError('Too many redirects while resolving Facebook link.', 'REDIRECT_LIMIT', 422);
}

function extractVideoId(urlStr: string, html: string): string {
  try {
    const parsed = new URL(urlStr);
    const vParam = parsed.searchParams.get('v');
    if (vParam && /^\d+$/.test(vParam)) return vParam;

    const pathMatch =
      parsed.pathname.match(/\/videos\/(?:[^/]+\/)?(\d+)/) ||
      parsed.pathname.match(/\/reel\/(\d+)/) ||
      parsed.pathname.match(/\/watch\/(\d+)/);
    if (pathMatch?.[1]) return pathMatch[1];
  } catch {
    // ignore URL parse error
  }

  const htmlIdMatch =
    html.match(/"video_id":"(\d+)"/) ||
    html.match(/"playable_video_id":"(\d+)"/) ||
    html.match(/fb:\/\/video\/(\d+)/);
  if (htmlIdMatch?.[1]) return htmlIdMatch[1];

  return crypto.createHash('sha1').update(urlStr).digest('hex').slice(0, 12);
}

function extractMetadata(html: string): {
  title: string;
  author: string;
  thumbnail: string | null;
  durationSec: number | null;
} {
  let title = '';
  const ogTitle =
    html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
  const titleTag = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const jsonTitle =
    html.match(/"title":\{"text":"([^"\\]*(?:\\.[^"\\]*)*)"/) ||
    html.match(/"savable_title":\{"text":"([^"\\]*(?:\\.[^"\\]*)*)"/);

  if (jsonTitle?.[1]) {
    title = decodeHtmlAndJsonString(jsonTitle[1]);
  } else if (ogTitle?.[1]) {
    title = decodeHtmlAndJsonString(ogTitle[1]);
  } else if (titleTag?.[1]) {
    title = decodeHtmlAndJsonString(titleTag[1]);
  }

  title = title
    .replace(/\s*\|\s*Facebook\s*$/i, '')
    .replace(/^Facebook\s*[-–—]\s*/i, '')
    .trim();

  if (!title || /^log in or sign up/i.test(title) || /^facebook$/i.test(title)) {
    title = 'Facebook Video';
  }

  let author = 'Facebook Creator';
  const ownerMatch =
    html.match(/"owner":\{[^}]*"name":"([^"\\]*(?:\\.[^"\\]*)*)"/) ||
    html.match(/"actors":\[\{[^}]*"name":"([^"\\]*(?:\\.[^"\\]*)*)"/) ||
    html.match(/"author":\{"name":"([^"\\]*(?:\\.[^"\\]*)*)"/);
  if (ownerMatch?.[1]) {
    const decodedAuthor = decodeHtmlAndJsonString(ownerMatch[1]);
    if (decodedAuthor && decodedAuthor.length < 80) {
      author = decodedAuthor;
    }
  } else if (title.includes(' | ')) {
    const parts = title.split(' | ');
    if (parts.length === 2 && parts[1].length < 50) {
      author = parts[1].trim();
      title = parts[0].trim();
    }
  }

  let thumbnail: string | null = null;
  const thumbMatches = [
    html.match(/"preferred_thumbnail":\{"image":\{"uri":"([^"\\]*(?:\\.[^"\\]*)*)"/),
    html.match(/"thumbnailImage":\{"uri":"([^"\\]*(?:\\.[^"\\]*)*)"/),
    html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i),
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i),
  ];

  for (const m of thumbMatches) {
    if (m?.[1]) {
      const candidate = decodeHtmlAndJsonString(m[1]);
      if (candidate.startsWith('http')) {
        try {
          if (isAllowedCdnHost(new URL(candidate).hostname)) {
            thumbnail = candidate;
            break;
          }
        } catch {
          // ignore
        }
      }
    }
  }

  let durationSec: number | null = null;
  const durMsMatch = html.match(/"playable_duration_in_ms":(\d+)/);
  if (durMsMatch?.[1]) {
    const ms = Number(durMsMatch[1]);
    if (Number.isFinite(ms) && ms > 0) {
      durationSec = Math.round(ms / 1000);
    }
  } else {
    const durSecMatch = html.match(/"length_in_second":(\d+)/) || html.match(/"duration":(\d+)/);
    if (durSecMatch?.[1]) {
      const s = Number(durSecMatch[1]);
      if (Number.isFinite(s) && s > 0 && s < 86400) {
        durationSec = s;
      }
    }
  }

  return { title, author, thumbnail, durationSec };
}

function resolutionLabelFromHeight(height: number | null, fallbackQuality: string): { quality: string; label: string } {
  if (!height) {
    return { quality: fallbackQuality, label: fallbackQuality };
  }
  if (height >= 2160) return { quality: '2160p', label: '2160p (4K UHD)' };
  if (height >= 1440) return { quality: '1440p', label: '1440p (2K QHD)' };
  if (height >= 1080) return { quality: '1080p', label: '1080p (Full HD)' };
  if (height >= 720) return { quality: '720p', label: '720p (HD)' };
  if (height >= 480) return { quality: '480p', label: '480p (SD)' };
  if (height >= 360) return { quality: '360p', label: '360p (SD)' };
  return { quality: `${height}p`, label: `${height}p (Low)` };
}

function parseDashManifestXml(rawXml: string): { videos: RawDashTrack[]; audios: RawDashTrack[] } {
  const xml = decodeHtmlAndJsonString(rawXml);
  const videos: RawDashTrack[] = [];
  const audios: RawDashTrack[] = [];

  const adaptationRegex = /<AdaptationSet\b([^>]*)>([\s\S]*?)<\/AdaptationSet>/gi;
  let adaptMatch: RegExpExecArray | null;

  while ((adaptMatch = adaptationRegex.exec(xml)) !== null) {
    const adaptAttrs = adaptMatch[1] || '';
    const adaptBody = adaptMatch[2] || '';
    const adaptMime = (adaptAttrs.match(/mimeType=["']([^"']+)["']/i)?.[1] || '').toLowerCase();

    const repRegex = /<Representation\b([^>]*)>([\s\S]*?)<\/Representation>/gi;
    let repMatch: RegExpExecArray | null;

    while ((repMatch = repRegex.exec(adaptBody)) !== null) {
      const repAttrs = repMatch[1] || '';
      const repBody = repMatch[2] || '';

      const baseUrlMatch = repBody.match(/<BaseURL[^>]*>([\s\S]*?)<\/BaseURL>/i);
      if (!baseUrlMatch?.[1]) continue;

      const streamUrl = decodeHtmlAndJsonString(baseUrlMatch[1]);
      if (!streamUrl.startsWith('http')) continue;

      try {
        if (!isAllowedCdnHost(new URL(streamUrl).hostname)) continue;
      } catch {
        continue;
      }

      const repMime = (repAttrs.match(/mimeType=["']([^"']+)["']/i)?.[1] || adaptMime).toLowerCase();
      const codecs = repAttrs.match(/codecs=["']([^"']+)["']/i)?.[1] || '';
      const widthRaw = repAttrs.match(/\bwidth=["'](\d+)["']/i)?.[1];
      const heightRaw = repAttrs.match(/\bheight=["'](\d+)["']/i)?.[1];
      const bwRaw = repAttrs.match(/\bbandwidth=["'](\d+)["']/i)?.[1];
      const fbQuality = repAttrs.match(/FBQualityLabel=["']([^"']+)["']/i)?.[1] || '';

      const track: RawDashTrack = {
        url: streamUrl,
        mimeType: repMime,
        codecs,
        width: widthRaw ? Number(widthRaw) : null,
        height: heightRaw ? Number(heightRaw) : null,
        bandwidth: bwRaw ? Number(bwRaw) : null,
        qualityLabel: fbQuality,
      };

      if (repMime.startsWith('audio/') || (!track.width && !track.height && codecs.startsWith('mp4a'))) {
        audios.push(track);
      } else {
        videos.push(track);
      }
    }
  }

  return { videos, audios };
}

function extractProgressiveUrls(html: string): { hdUrls: string[]; sdUrls: string[] } {
  const hdUrls: string[] = [];
  const sdUrls: string[] = [];

  const hdPatterns = [
    /"browser_native_hd_url":"([^"\\]*(?:\\.[^"\\]*)*)"/g,
    /"playable_url_quality_hd":"([^"\\]*(?:\\.[^"\\]*)*)"/g,
    /"hd_src_no_ratelimit":"([^"\\]*(?:\\.[^"\\]*)*)"/g,
    /"hd_src":"([^"\\]*(?:\\.[^"\\]*)*)"/g,
  ];

  const sdPatterns = [
    /"browser_native_sd_url":"([^"\\]*(?:\\.[^"\\]*)*)"/g,
    /"playable_url":"([^"\\]*(?:\\.[^"\\]*)*)"/g,
    /"sd_src_no_ratelimit":"([^"\\]*(?:\\.[^"\\]*)*)"/g,
    /"sd_src":"([^"\\]*(?:\\.[^"\\]*)*)"/g,
  ];

  const pushIfValid = (raw: string, target: string[]) => {
    const decoded = decodeHtmlAndJsonString(raw);
    if (!decoded.startsWith('http')) return;
    try {
      if (isAllowedCdnHost(new URL(decoded).hostname) && !target.includes(decoded)) {
        target.push(decoded);
      }
    } catch {
      // ignore
    }
  };

  for (const regex of hdPatterns) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(html)) !== null) {
      if (match[1]) pushIfValid(match[1], hdUrls);
    }
  }

  for (const regex of sdPatterns) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(html)) !== null) {
      if (match[1]) pushIfValid(match[1], sdUrls);
    }
  }

  // Modern videoDeliveryResponseFragment progressive_urls
  const progEntryRegex =
    /"progressive_url":"([^"\\]*(?:\\.[^"\\]*)*)"[^}]*"metadata":\{[^}]*"quality":"([^"]+)"/g;
  let progMatch: RegExpExecArray | null;
  while ((progMatch = progEntryRegex.exec(html)) !== null) {
    const q = (progMatch[2] || '').toUpperCase();
    if (q === 'HD' || q === 'FHD' || q === '1080P') {
      pushIfValid(progMatch[1], hdUrls);
    } else {
      pushIfValid(progMatch[1], sdUrls);
    }
  }

  // Fallback progressive_url without nearby metadata
  const genericProgRegex = /"progressive_url":"([^"\\]*(?:\\.[^"\\]*)*)"/g;
  while ((progMatch = genericProgRegex.exec(html)) !== null) {
    const decoded = decodeHtmlAndJsonString(progMatch[1]);
    if (decoded.includes('tag=hd') || decoded.includes('.hd')) {
      pushIfValid(progMatch[1], hdUrls);
    } else if (!hdUrls.includes(decoded)) {
      pushIfValid(progMatch[1], sdUrls);
    }
  }

  const redirectRegex = /\/video_redirect\/\?src=([^"'&]+)/g;
  let redMatch: RegExpExecArray | null;
  while ((redMatch = redirectRegex.exec(html)) !== null) {
    try {
      const decoded = decodeURIComponent(redMatch[1]);
      if (decoded.startsWith('http') && isAllowedCdnHost(new URL(decoded).hostname)) {
        if (!sdUrls.includes(decoded) && !hdUrls.includes(decoded)) {
          sdUrls.push(decoded);
        }
      }
    } catch {
      // ignore
    }
  }

  return { hdUrls, sdUrls };
}

function collectDashManifestStrings(html: string): string[] {
  const patterns = [
    /"dash_manifest(?:_xml_string|_url)?":"([^"\\]*(?:\\.[^"\\]*)*)"/g,
    /"manifest_xml":"([^"\\]*(?:\\.[^"\\]*)*)"/g,
  ];
  const results: string[] = [];
  for (const regex of patterns) {
    let m: RegExpExecArray | null;
    while ((m = regex.exec(html)) !== null) {
      if (m[1] && m[1] !== 'null' && !results.includes(m[1])) {
        results.push(m[1]);
      }
    }
  }
  return results;
}

async function probeContentLength(urlStr: string): Promise<number | null> {
  try {
    const parsed = new URL(urlStr);
    await assertSafePublicHost(parsed.hostname, true);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3200);
    try {
      const res = await fetch(urlStr, {
        method: 'HEAD',
        headers: {
          'User-Agent': DESKTOP_UA,
        },
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const len = res.headers.get('content-length');
      if (!len) return null;
      const bytes = Number(len);
      return Number.isFinite(bytes) && bytes > 0 ? bytes : null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

export async function inspectFacebookVideo(rawInput: string): Promise<InspectedVideo> {
  const validatedUrl = normalizeAndValidateFacebookUrl(rawInput);

  const desktopHeaders: Record<string, string> = {
    'User-Agent': DESKTOP_UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
  };

  const primaryResult = await fetchWithSafeRedirects(validatedUrl.toString(), desktopHeaders, false);
  let combinedHtml = primaryResult.html;
  const canonicalUrl = primaryResult.finalUrl || validatedUrl.toString();

  let { hdUrls, sdUrls } = extractProgressiveUrls(combinedHtml);
  let dashMatches = collectDashManifestStrings(combinedHtml);

  // Probe embed player endpoint if HD progressive or DASH manifest is missing
  if (hdUrls.length === 0 || dashMatches.length === 0) {
    try {
      const pluginUrl = `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(
        canonicalUrl
      )}&show_text=false&width=1280`;
      const pluginRes = await fetchWithSafeRedirects(pluginUrl, desktopHeaders, false, 9000);
      if (pluginRes.html) {
        combinedHtml += `\n${pluginRes.html}`;
        const pProg = extractProgressiveUrls(combinedHtml);
        hdUrls = pProg.hdUrls;
        sdUrls = pProg.sdUrls;
        dashMatches = collectDashManifestStrings(combinedHtml);
      }
    } catch {
      // continue to mobile fallback
    }
  }

  // Probe mbasic mobile view if still missing streams
  if (hdUrls.length === 0 && sdUrls.length === 0 && dashMatches.length === 0) {
    try {
      const mobileUrl = new URL(canonicalUrl);
      if (mobileUrl.hostname.endsWith('facebook.com')) {
        mobileUrl.hostname = 'mbasic.facebook.com';
        const mobRes = await fetchWithSafeRedirects(
          mobileUrl.toString(),
          {
            'User-Agent': MOBILE_UA,
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
          },
          false,
          9000
        );
        if (mobRes.html) {
          combinedHtml += `\n${mobRes.html}`;
          const mProg = extractProgressiveUrls(combinedHtml);
          hdUrls = mProg.hdUrls;
          sdUrls = mProg.sdUrls;
          dashMatches = collectDashManifestStrings(combinedHtml);
        }
      }
    } catch {
      // continue
    }
  }

  const dashVideos: RawDashTrack[] = [];
  const dashAudios: RawDashTrack[] = [];

  const xmlBlockMatches = combinedHtml.matchAll(/(<MPD\b[\s\S]*?<\/MPD>)/gi);
  for (const m of xmlBlockMatches) {
    const parsed = parseDashManifestXml(m[1]);
    dashVideos.push(...parsed.videos);
    dashAudios.push(...parsed.audios);
  }

  for (const rawManifest of dashMatches) {
    const decoded = decodeHtmlAndJsonString(rawManifest);
    if (decoded.startsWith('<MPD') || decoded.includes('<Representation')) {
      const parsed = parseDashManifestXml(decoded);
      dashVideos.push(...parsed.videos);
      dashAudios.push(...parsed.audios);
    } else if (decoded.startsWith('http')) {
      try {
        if (isAllowedCdnHost(new URL(decoded).hostname)) {
          const manifestRes = await fetchWithSafeRedirects(decoded, desktopHeaders, true, 7000);
          if (manifestRes.html.includes('<Representation')) {
            const parsed = parseDashManifestXml(manifestRes.html);
            dashVideos.push(...parsed.videos);
            dashAudios.push(...parsed.audios);
          }
        }
      } catch {
        // skip manifest fetch error
      }
    }
  }

  dashAudios.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
  const bestDashAudio = dashAudios[0] || null;

  const candidates: ExtractedStreamCandidate[] = [];

  if (hdUrls[0]) {
    candidates.push({
      url: hdUrls[0],
      width: 1280,
      height: 720,
      quality: '720p',
      label: '720p (HD)',
      codec: 'H.264 / AAC',
      bandwidth: null,
      isMuxed: true,
      mode: 'direct',
    });
  }

  if (sdUrls[0]) {
    candidates.push({
      url: sdUrls[0],
      width: 640,
      height: 360,
      quality: '360p',
      label: '360p (SD)',
      codec: 'H.264 / AAC',
      bandwidth: null,
      isMuxed: true,
      mode: 'direct',
    });
  }

  for (const track of dashVideos) {
    const height = track.height;
    const { quality, label } = resolutionLabelFromHeight(height, track.qualityLabel || 'HD');
    const codecLabel = track.codecs.includes('vp09')
      ? 'VP9'
      : track.codecs.includes('av01')
      ? 'AV1'
      : 'H.264';

    const alreadyHasProgressiveSameRes = candidates.some(
      (c) => c.mode === 'direct' && c.quality === quality
    );
    if (alreadyHasProgressiveSameRes && (height || 0) <= 720) {
      continue;
    }

    if (bestDashAudio) {
      candidates.push({
        url: track.url,
        audioUrl: bestDashAudio.url,
        width: track.width,
        height: track.height,
        quality,
        label,
        codec: `${codecLabel} / AAC`,
        bandwidth: track.bandwidth,
        isMuxed: true,
        mode: 'mux',
      });
    } else {
      candidates.push({
        url: track.url,
        width: track.width,
        height: track.height,
        quality,
        label: `${label} (Video Only)`,
        codec: codecLabel,
        bandwidth: track.bandwidth,
        isMuxed: false,
        mode: 'direct',
      });
    }
  }

  if (candidates.length === 0) {
    const lowerHtml = combinedHtml.toLowerCase();
    const isPrivateOrLogin =
      primaryResult.status === 401 ||
      lowerHtml.includes('log in to continue') ||
      lowerHtml.includes('you must log in') ||
      lowerHtml.includes("this content isn't available") ||
      lowerHtml.includes("this page isn't available");

    if (isPrivateOrLogin) {
      throw new ExtractionError(
        'This video appears to be private, restricted, or requires a Facebook login. ClearReel can only download publicly accessible videos and Reels.',
        'PRIVATE_OR_LOGIN',
        403
      );
    }

    throw new ExtractionError(
      'No downloadable video streams were found at this Facebook link. Verify the link points to a public Video, Watch post, or Reel.',
      'EXTRACTION_FAILED',
      422
    );
  }

  const dedupedMap = new Map<string, ExtractedStreamCandidate>();
  for (const cand of candidates) {
    const existing = dedupedMap.get(cand.quality);
    if (!existing) {
      dedupedMap.set(cand.quality, cand);
    } else {
      if (cand.mode === 'direct' && existing.mode !== 'direct') {
        dedupedMap.set(cand.quality, cand);
      } else if ((cand.bandwidth || 0) > (existing.bandwidth || 0)) {
        dedupedMap.set(cand.quality, cand);
      }
    }
  }

  const sortedCandidates = Array.from(dedupedMap.values()).sort((a, b) => {
    const hDiff = (b.height || 0) - (a.height || 0);
    if (hDiff !== 0) return hDiff;
    return (b.bandwidth || 0) - (a.bandwidth || 0);
  });

  const meta = extractMetadata(combinedHtml);
  const videoId = extractVideoId(canonicalUrl, combinedHtml);

  const sizeResults = await Promise.all(
    sortedCandidates.map(async (cand) => {
      const videoSize = await probeContentLength(cand.url);
      if (cand.audioUrl && videoSize !== null) {
        const audioSize = await probeContentLength(cand.audioUrl);
        return audioSize !== null ? videoSize + audioSize : videoSize;
      }
      return videoSize;
    })
  );

  const formats: VideoFormat[] = sortedCandidates.map((cand, idx) => {
    const filename = sanitizeFilename(`${meta.title} [${cand.quality}]`, 'mp4');
    const downloadToken = signMediaToken({
      kind: 'download',
      videoUrl: cand.url,
      audioUrl: cand.audioUrl,
      mode: cand.mode,
      filename,
      mimeType: 'video/mp4',
    });

    return {
      id: `fmt-${cand.quality}-${idx}`,
      label: cand.label,
      quality: cand.quality,
      resolution:
        cand.width && cand.height ? `${cand.width}×${cand.height}` : cand.quality,
      width: cand.width,
      height: cand.height,
      container: 'MP4',
      codec: cand.codec,
      hasAudio: cand.isMuxed,
      isMuxed: cand.mode === 'mux',
      sizeBytes: sizeResults[idx],
      bitrateKbps: cand.bandwidth ? Math.round(cand.bandwidth / 1000) : null,
      mode: cand.mode,
      downloadToken,
      filename,
    };
  });

  const audioSourceUrl = bestDashAudio?.url || sdUrls[0] || hdUrls[0];
  if (audioSourceUrl) {
    const m4aFilename = sanitizeFilename(`${meta.title} [Audio]`, 'm4a');
    const mp3Filename = sanitizeFilename(`${meta.title} [Audio]`, 'mp3');
    const audioSize = bestDashAudio ? await probeContentLength(bestDashAudio.url) : null;

    formats.push({
      id: 'fmt-audio-m4a',
      label: 'Audio Only (AAC)',
      quality: 'Audio',
      resolution: 'Audio Stream',
      width: null,
      height: null,
      container: 'M4A',
      codec: 'AAC 128-192k',
      hasAudio: true,
      isMuxed: false,
      sizeBytes: audioSize,
      bitrateKbps: bestDashAudio?.bandwidth ? Math.round(bestDashAudio.bandwidth / 1000) : 128,
      mode: 'm4a',
      downloadToken: signMediaToken({
        kind: 'download',
        videoUrl: audioSourceUrl,
        mode: 'm4a',
        filename: m4aFilename,
        mimeType: 'audio/mp4',
      }),
      filename: m4aFilename,
    });

    formats.push({
      id: 'fmt-audio-mp3',
      label: 'Audio Only (MP3)',
      quality: 'MP3',
      resolution: '192 kbps',
      width: null,
      height: null,
      container: 'MP3',
      codec: 'MP3 LAME',
      hasAudio: true,
      isMuxed: false,
      sizeBytes: null,
      bitrateKbps: 192,
      mode: 'mp3',
      downloadToken: signMediaToken({
        kind: 'download',
        videoUrl: audioSourceUrl,
        mode: 'mp3',
        filename: mp3Filename,
        mimeType: 'audio/mpeg',
      }),
      filename: mp3Filename,
    });
  }

  let thumbnailToken: string | null = null;
  if (meta.thumbnail) {
    thumbnailToken = signMediaToken({
      kind: 'thumbnail',
      videoUrl: meta.thumbnail,
      mode: 'thumbnail',
      filename: 'thumbnail.jpg',
      mimeType: 'image/jpeg',
    });
  }

  return {
    id: videoId,
    sourceUrl: validatedUrl.toString(),
    canonicalUrl,
    title: meta.title,
    author: meta.author,
    durationSec: meta.durationSec,
    thumbnailToken,
    formats,
    inspectedAt: new Date().toISOString(),
  };
}
