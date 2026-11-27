import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { ExtractionError, inspectFacebookVideo } from './server/fbExtractor.ts';
import {
  assertSafePublicHost,
  stripLoneSurrogates,
  verifyMediaToken,
} from './server/security.ts';
import type { MediaTokenPayload } from './server/security.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 3000);
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

interface CachedProcessedFile {
  workDir: string;
  filePath: string;
  size: number;
  createdAt: number;
}

const PROCESSED_TTL_MS = 15 * 60 * 1000;
const processedFileCache = new Map<string, CachedProcessedFile>();
const inFlightProcessing = new Map<string, Promise<CachedProcessedFile>>();

function cleanupExpiredProcessedFiles(): void {
  const now = Date.now();
  for (const [key, entry] of processedFileCache.entries()) {
    if (now - entry.createdAt > PROCESSED_TTL_MS) {
      processedFileCache.delete(key);
      void fsp.rm(entry.workDir, { recursive: true, force: true });
    }
  }
  while (processedFileCache.size > 40) {
    const oldestKey = processedFileCache.keys().next().value;
    if (!oldestKey) break;
    const entry = processedFileCache.get(oldestKey);
    processedFileCache.delete(oldestKey);
    if (entry) {
      void fsp.rm(entry.workDir, { recursive: true, force: true });
    }
  }
}

async function fetchCdnStream(url: string, rangeHeader?: string): Promise<globalThis.Response> {
  const headersWithReferer: Record<string, string> = {
    'User-Agent': USER_AGENT,
    Referer: 'https://www.facebook.com/',
    ...(rangeHeader ? { Range: rangeHeader } : {}),
  };

  let upstream = await fetch(url, { headers: headersWithReferer });
  if (upstream.status === 403 || upstream.status === 400) {
    upstream = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        ...(rangeHeader ? { Range: rangeHeader } : {}),
      },
    });
  }
  return upstream;
}

async function downloadUrlToFile(url: string, destPath: string): Promise<void> {
  const upstream = await fetchCdnStream(url);
  if (!upstream.ok || !upstream.body) {
    throw new Error(`Upstream CDN returned HTTP ${upstream.status}`);
  }
  const nodeReadable = Readable.fromWeb(
    upstream.body as unknown as import('node:stream/web').ReadableStream
  );
  const fileStream = fs.createWriteStream(destPath);
  await pipeline(nodeReadable, fileStream);
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', args, { shell: false });
    let stderr = '';
    ff.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 4096) {
        stderr += chunk.toString('utf8');
      }
    });
    ff.on('error', (err) => reject(err));
    ff.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr.trim() || `FFmpeg exited with status ${code}`));
      }
    });
  });
}

async function getOrBuildProcessedFile(
  tokenKey: string,
  payload: MediaTokenPayload
): Promise<CachedProcessedFile> {
  cleanupExpiredProcessedFiles();

  const existing = processedFileCache.get(tokenKey);
  if (existing) {
    try {
      const stat = await fsp.stat(existing.filePath);
      if (stat.size > 0) {
        return existing;
      }
    } catch {
      processedFileCache.delete(tokenKey);
    }
  }

  const inflight = inFlightProcessing.get(tokenKey);
  if (inflight) {
    return inflight;
  }

  const job = (async (): Promise<CachedProcessedFile> => {
    const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'clearreel-'));
    try {
      const videoFile = path.join(workDir, 'video.bin');
      const ext = payload.mode === 'mp3' ? 'mp3' : payload.mode === 'm4a' ? 'm4a' : 'mp4';
      const outputFile = path.join(workDir, `output.${ext}`);

      if (payload.mode === 'mux' && payload.audioUrl) {
        const audioFile = path.join(workDir, 'audio.bin');
        await Promise.all([
          downloadUrlToFile(payload.videoUrl, videoFile),
          downloadUrlToFile(payload.audioUrl, audioFile),
        ]);

        try {
          await runFfmpeg([
            '-hide_banner',
            '-loglevel',
            'error',
            '-y',
            '-i',
            videoFile,
            '-i',
            audioFile,
            '-c',
            'copy',
            '-movflags',
            '+faststart',
            '-f',
            'mp4',
            outputFile,
          ]);
        } catch {
          await runFfmpeg([
            '-hide_banner',
            '-loglevel',
            'error',
            '-y',
            '-i',
            videoFile,
            '-i',
            audioFile,
            '-c:v',
            'copy',
            '-c:a',
            'aac',
            '-b:a',
            '192k',
            '-movflags',
            '+faststart',
            '-f',
            'mp4',
            outputFile,
          ]);
        }
      } else if (payload.mode === 'm4a') {
        await downloadUrlToFile(payload.videoUrl, videoFile);
        await runFfmpeg([
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-i',
          videoFile,
          '-vn',
          '-c:a',
          'aac',
          '-b:a',
          '192k',
          '-movflags',
          '+faststart',
          '-f',
          'mp4',
          outputFile,
        ]);
      } else if (payload.mode === 'mp3') {
        await downloadUrlToFile(payload.videoUrl, videoFile);
        await runFfmpeg([
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-i',
          videoFile,
          '-vn',
          '-c:a',
          'libmp3lame',
          '-b:a',
          '192k',
          '-f',
          'mp3',
          outputFile,
        ]);
      } else {
        throw new Error('Unsupported media processing mode.');
      }

      // Remove raw intermediate files right away to save tmpfs space
      await fsp.rm(videoFile, { force: true }).catch(() => {});
      await fsp.rm(path.join(workDir, 'audio.bin'), { force: true }).catch(() => {});

      const stat = await fsp.stat(outputFile);
      const entry: CachedProcessedFile = {
        workDir,
        filePath: outputFile,
        size: stat.size,
        createdAt: Date.now(),
      };
      processedFileCache.set(tokenKey, entry);
      return entry;
    } catch (err) {
      await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
      throw err;
    } finally {
      inFlightProcessing.delete(tokenKey);
    }
  })();

  inFlightProcessing.set(tokenKey, job);
  return job;
}

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  app.post('/api/inspect', async (req: Request, res: Response) => {
    const rawUrl = typeof req.body?.url === 'string' ? req.body.url : '';
    if (!rawUrl.trim()) {
      res.status(400).json({ error: 'Please provide a Facebook video URL.' });
      return;
    }

    try {
      const inspected = await inspectFacebookVideo(rawUrl);
      res.json(inspected);
    } catch (err) {
      if (err instanceof ExtractionError) {
        res.status(err.statusCode).json({ error: err.message, code: err.code });
        return;
      }
      const message =
        err instanceof Error && err.message
          ? err.message
          : 'Unable to inspect the provided Facebook link.';
      res.status(400).json({ error: message });
    }
  });

  app.get('/api/thumbnail', async (req: Request, res: Response) => {
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    try {
      const payload = verifyMediaToken(token);
      if (payload.kind !== 'thumbnail') {
        res.status(403).json({ error: 'Invalid thumbnail token.' });
        return;
      }

      const parsed = new URL(payload.videoUrl);
      await assertSafePublicHost(parsed.hostname, true);

      const upstream = await fetchCdnStream(payload.videoUrl);
      if (!upstream.ok || !upstream.body) {
        res.status(502).end();
        return;
      }

      const contentType = upstream.headers.get('content-type') || 'image/jpeg';
      if (!contentType.startsWith('image/')) {
        res.status(415).end();
        return;
      }

      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=1800');
      const nodeStream = Readable.fromWeb(
        upstream.body as unknown as import('node:stream/web').ReadableStream
      );
      nodeStream.pipe(res);
    } catch {
      res.status(404).end();
    }
  });

  app.get('/api/download', async (req: Request, res: Response) => {
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    const inlinePreview = req.query.preview === '1';

    const startQuery = typeof req.query.start === 'string' ? Number(req.query.start) : null;
    const endQuery = typeof req.query.end === 'string' ? Number(req.query.end) : null;
    const hasExplicitChunk =
      startQuery !== null &&
      endQuery !== null &&
      Number.isInteger(startQuery) &&
      Number.isInteger(endQuery) &&
      startQuery >= 0 &&
      endQuery >= startQuery;

    let payload: MediaTokenPayload;
    try {
      payload = verifyMediaToken(token);
      if (payload.kind !== 'download') {
        res.status(403).json({ error: 'Invalid download token.' });
        return;
      }
      await assertSafePublicHost(new URL(payload.videoUrl).hostname, true);
      if (payload.audioUrl) {
        await assertSafePublicHost(new URL(payload.audioUrl).hostname, true);
      }
    } catch (err) {
      const msg =
        err instanceof Error && err.message ? err.message : 'Invalid download request.';
      res.status(403).json({ error: msg });
      return;
    }

    const safeFilename = stripLoneSurrogates(payload.filename);
    const asciiFallback = safeFilename.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, "'");
    let encodedFilename = asciiFallback;
    try {
      encodedFilename = encodeURIComponent(safeFilename);
    } catch {
      encodedFilename = encodeURIComponent(asciiFallback);
    }
    const disposition = inlinePreview ? 'inline' : 'attachment';

    const setDownloadHeaders = (contentLength?: string | number | null) => {
      res.setHeader(
        'Content-Disposition',
        `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encodedFilename}`
      );
      res.setHeader('Content-Type', payload.mimeType);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-store');
      if (contentLength !== undefined && contentLength !== null) {
        res.setHeader('Content-Length', String(contentLength));
      }
    };

    // Direct progressive stream proxy
    if (payload.mode === 'direct') {
      try {
        const rangeHeader = hasExplicitChunk
          ? `bytes=${startQuery}-${endQuery}`
          : typeof req.headers.range === 'string'
          ? req.headers.range
          : undefined;

        const upstream = await fetchCdnStream(payload.videoUrl, rangeHeader);

        if (!upstream.ok || !upstream.body) {
          res.status(502).json({
            error: `Upstream Facebook CDN returned HTTP ${upstream.status}. Try re-analyzing the video URL.`,
          });
          return;
        }

        const contentLength = upstream.headers.get('content-length');
        const contentRange = upstream.headers.get('content-range');
        const acceptRanges = upstream.headers.get('accept-ranges');

        if (hasExplicitChunk) {
          // Return chunk as HTTP 200 with metadata headers so proxies & Cloud Run (<32MB) never choke
          if (contentRange) {
            const match = contentRange.match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i);
            if (match) {
              res.setHeader('X-Chunk-Start', match[1]);
              res.setHeader('X-Chunk-End', match[2]);
              if (match[3] !== '*') {
                res.setHeader('X-Total-Bytes', match[3]);
              }
            }
          } else if (contentLength) {
            res.setHeader('X-Total-Bytes', contentLength);
            res.setHeader('X-Full-Stream', '1');
          }
          setDownloadHeaders(contentLength);
          res.status(200);
        } else {
          setDownloadHeaders(contentLength);
          if (contentRange) res.setHeader('Content-Range', contentRange);
          if (acceptRanges) res.setHeader('Accept-Ranges', acceptRanges);
          res.status(upstream.status);
        }

        const nodeStream = Readable.fromWeb(
          upstream.body as unknown as import('node:stream/web').ReadableStream
        );
        res.on('close', () => {
          if (!res.writableFinished) {
            nodeStream.destroy();
          }
        });
        nodeStream.pipe(res);
      } catch (err) {
        console.error('[download direct error]', err);
        if (!res.headersSent) {
          const message =
            err instanceof Error && err.message
              ? err.message
              : 'Failed to stream video from Facebook CDN.';
          res.status(502).json({ error: message });
        }
      }
      return;
    }

    // FFmpeg-processed streams (mux, m4a, mp3) served from cached temp file with chunk support
    try {
      const processed = await getOrBuildProcessedFile(token, payload);
      const totalSize = processed.size;

      if (hasExplicitChunk) {
        const start = Math.min(startQuery, Math.max(0, totalSize - 1));
        const end = Math.min(endQuery, Math.max(0, totalSize - 1));
        const chunkLen = Math.max(0, end - start + 1);

        res.setHeader('X-Chunk-Start', String(start));
        res.setHeader('X-Chunk-End', String(end));
        res.setHeader('X-Total-Bytes', String(totalSize));
        setDownloadHeaders(chunkLen);
        res.status(200);

        const readStream = fs.createReadStream(processed.filePath, { start, end });
        res.on('close', () => {
          if (!res.writableFinished) {
            readStream.destroy();
          }
        });
        await pipeline(readStream, res);
        return;
      }

      const rangeHeader = typeof req.headers.range === 'string' ? req.headers.range : undefined;
      if (rangeHeader) {
        const m = rangeHeader.match(/^bytes=(\d+)-(\d*)$/);
        if (m) {
          const start = Number(m[1]);
          const end = m[2] ? Math.min(Number(m[2]), totalSize - 1) : totalSize - 1;
          if (start >= totalSize || end < start) {
            res.status(416).setHeader('Content-Range', `bytes */${totalSize}`).end();
            return;
          }
          res.setHeader('Content-Range', `bytes ${start}-${end}/${totalSize}`);
          res.setHeader('Accept-Ranges', 'bytes');
          setDownloadHeaders(end - start + 1);
          res.status(206);
          const readStream = fs.createReadStream(processed.filePath, { start, end });
          res.on('close', () => {
            if (!res.writableFinished) {
              readStream.destroy();
            }
          });
          await pipeline(readStream, res);
          return;
        }
      }

      res.setHeader('Accept-Ranges', 'bytes');
      setDownloadHeaders(totalSize);
      res.status(200);
      const readStream = fs.createReadStream(processed.filePath);
      res.on('close', () => {
        if (!res.writableFinished) {
          readStream.destroy();
        }
      });
      await pipeline(readStream, res);
    } catch (err) {
      console.error('[download processed error]', err);
      if (!res.headersSent) {
        const message =
          err instanceof Error && err.message
            ? err.message
            : 'Unable to process the selected HD stream.';
        res.status(502).json({ error: message });
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  });

  app.use('/api', (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[api error]', err);
    if (!res.headersSent) {
      const message =
        err instanceof Error && err.message ? err.message : 'Unexpected server error.';
      res.status(500).json({ error: message });
    }
  });

  return app;
}

async function startServer() {
  const app = createApp();
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`ClearReel server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
