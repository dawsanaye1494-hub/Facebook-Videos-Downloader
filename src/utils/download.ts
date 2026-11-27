import type { VideoFormat } from '../types/video';

export interface StreamDownloadOptions {
  onProgress?: (percent: number, receivedBytes: number, totalBytes: number | null) => void;
  signal?: AbortSignal;
}

const CHUNK_SIZE_BYTES = 8 * 1024 * 1024; // 8 MB chunks stay safely below Cloud Run 32 MB cap

async function extractErrorFromResponse(response: Response): Promise<string> {
  let message = `Download failed (HTTP ${response.status}).`;
  const contentType = response.headers.get('content-type') || '';
  try {
    if (contentType.includes('application/json')) {
      const data = (await response.json()) as { error?: string };
      if (data?.error) message = data.error;
    } else {
      const text = (await response.text()).trim();
      if (text && !text.startsWith('<')) {
        message = text.slice(0, 200);
      }
    }
  } catch {
    // keep status fallback
  }
  return message;
}

async function fetchChunkWithRetry(
  url: string,
  signal?: AbortSignal,
  attempts = 2
): Promise<Response> {
  let lastErr: Error | null = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(url, { signal, cache: 'no-store' });
      if (!res.ok) {
        const msg = await extractErrorFromResponse(res);
        // Retry once on transient 5xx proxy errors
        if (res.status >= 500 && i + 1 < attempts) {
          lastErr = new Error(msg);
          await new Promise((r) => setTimeout(r, 400));
          continue;
        }
        throw new Error(msg);
      }
      return res;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error('Download was cancelled.');
      }
      lastErr = err instanceof Error ? err : new Error('Network error during download.');
      if (i + 1 < attempts) {
        await new Promise((r) => setTimeout(r, 400));
        continue;
      }
    }
  }
  throw lastErr || new Error('Network error while connecting to the download server.');
}

export async function fetchFormatBlobWithProgress(
  format: VideoFormat,
  options: StreamDownloadOptions = {}
): Promise<Blob> {
  const chunks: Uint8Array[] = [];
  let start = 0;
  let totalBytes: number | null = format.sizeBytes;
  let received = 0;

  while (true) {
    const end = start + CHUNK_SIZE_BYTES - 1;
    const chunkUrl = `/api/download?token=${encodeURIComponent(
      format.downloadToken
    )}&start=${start}&end=${end}`;

    const response = await fetchChunkWithRetry(chunkUrl, options.signal, 2);

    const totalHeader = response.headers.get('x-total-bytes');
    const chunkEndHeader = response.headers.get('x-chunk-end');
    const isFullStream = response.headers.get('x-full-stream') === '1';

    if (totalHeader) {
      const parsedTotal = Number(totalHeader);
      if (Number.isFinite(parsedTotal) && parsedTotal > 0) {
        totalBytes = parsedTotal;
      }
    } else {
      const clHeader = response.headers.get('content-length');
      if (clHeader && isFullStream) {
        const parsedCl = Number(clHeader);
        if (Number.isFinite(parsedCl) && parsedCl > 0) {
          totalBytes = parsedCl;
        }
      }
    }

    if (!response.body) {
      const buf = new Uint8Array(await response.arrayBuffer());
      if (buf.byteLength === 0) break;
      chunks.push(buf);
      received += buf.byteLength;
      const pct = totalBytes ? Math.min(99, Math.round((received / totalBytes) * 100)) : 50;
      options.onProgress?.(pct, received, totalBytes);
      if (isFullStream || (totalBytes !== null && received >= totalBytes)) break;
      start += buf.byteLength;
      continue;
    }

    const reader = response.body.getReader();
    let chunkReceived = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        chunkReceived += value.byteLength;
        received += value.byteLength;
        const pct = totalBytes ? Math.min(99, Math.round((received / totalBytes) * 100)) : 50;
        options.onProgress?.(pct, received, totalBytes);
      }
    }

    if (isFullStream || chunkReceived === 0) {
      break;
    }

    if (totalBytes !== null && received >= totalBytes) {
      break;
    }

    if (chunkEndHeader) {
      const parsedEnd = Number(chunkEndHeader);
      if (Number.isFinite(parsedEnd)) {
        if (totalBytes !== null && parsedEnd + 1 >= totalBytes) {
          break;
        }
        start = parsedEnd + 1;
        continue;
      }
    }

    // If server returned less than requested chunk without total header, stream finished
    if (chunkReceived < CHUNK_SIZE_BYTES) {
      break;
    }
    start += chunkReceived;
  }

  if (received === 0) {
    throw new Error('No video data was received. Try re-analyzing the video URL.');
  }

  const mimeType =
    format.container === 'MP3'
      ? 'audio/mpeg'
      : format.container === 'M4A'
      ? 'audio/mp4'
      : 'video/mp4';

  const blob = new Blob(chunks as BlobPart[], { type: mimeType });
  options.onProgress?.(100, blob.size, blob.size);
  return blob;
}

export function triggerBrowserSave(blob: Blob, filename: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = filename;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => {
    URL.revokeObjectURL(objectUrl);
  }, 15000);
}
