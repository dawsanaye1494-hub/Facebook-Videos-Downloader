import { useState, type FormEvent } from 'react';
import {
  AlertCircle,
  Check,
  ClipboardPaste,
  Download,
  Film,
  ListPlus,
  Loader2,
  Play,
  Volume2,
  X,
} from 'lucide-react';
import type { HistoryEntry, InspectedVideo, VideoFormat } from '../types/video';
import { fetchFormatBlobWithProgress, triggerBrowserSave } from '../utils/download';
import { formatBytes, formatDuration } from '../utils/formatters';

interface SingleInspectorProps {
  inspected: InspectedVideo | null;
  urlInput: string;
  onUrlInputChange: (val: string) => void;
  onInspectComplete: (video: InspectedVideo) => void;
  onAddToBatch: (video: InspectedVideo) => void;
  onRecordHistory: (entry: HistoryEntry) => void;
  onSwitchToBatch: () => void;
}

export function SingleInspector({
  inspected,
  urlInput,
  onUrlInputChange,
  onInspectComplete,
  onAddToBatch,
  onRecordHistory,
  onSwitchToBatch,
}: SingleInspectorProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [thumbFailed, setThumbFailed] = useState(false);
  const [previewActive, setPreviewActive] = useState(false);
  const [addedToBatch, setAddedToBatch] = useState(false);
  const [downloadingFormatId, setDownloadingFormatId] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<number>(0);
  const [downloadedBytes, setDownloadedBytes] = useState<number>(0);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const inspectUrl = async (targetUrl: string) => {
    const trimmed = targetUrl.trim();
    if (!trimmed) {
      setError('Enter a public Facebook video, Watch, or Reel link to inspect.');
      return;
    }

    setLoading(true);
    setError(null);
    setDownloadError(null);
    setThumbFailed(false);
    setPreviewActive(false);
    setAddedToBatch(false);

    try {
      const res = await fetch('/api/inspect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: trimmed }),
      });
      const data = (await res.json()) as InspectedVideo & { error?: string };
      if (!res.ok) {
        throw new Error(data.error || 'Could not inspect this Facebook video URL.');
      }
      onInspectComplete(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to analyze this URL.');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    void inspectUrl(urlInput);
  };

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        onUrlInputChange(text.trim());
        setError(null);
      }
    } catch {
      setError('Clipboard access was denied. Paste the link manually into the field.');
    }
  };

  const handleDownloadFormat = async (format: VideoFormat) => {
    if (!inspected || downloadingFormatId) return;
    setDownloadingFormatId(format.id);
    setDownloadProgress(0);
    setDownloadedBytes(0);
    setDownloadError(null);

    try {
      const blob = await fetchFormatBlobWithProgress(format, {
        onProgress: (percent, received) => {
          setDownloadProgress(percent);
          setDownloadedBytes(received);
        },
      });
      triggerBrowserSave(blob, format.filename);
      onRecordHistory({
        id: `${inspected.id}-${format.id}-${Date.now()}`,
        url: inspected.sourceUrl,
        title: inspected.title,
        author: inspected.author,
        durationSec: inspected.durationSec,
        qualityLabel: format.label,
        container: format.container,
        sizeBytes: blob.size || format.sizeBytes,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : 'Download failed.');
    } finally {
      setDownloadingFormatId(null);
      setDownloadProgress(0);
    }
  };

  const previewFormat = inspected?.formats.find((f) => f.mode === 'direct' && f.container === 'MP4') || null;

  return (
    <section className="space-y-8">
      {/* URL Input Form */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 sm:p-6">
        <form onSubmit={handleSubmit} className="space-y-3">
          <label
            htmlFor="fb-single-url"
            className="block text-sm font-medium text-slate-900 dark:text-slate-100"
          >
            Facebook Video or Reel URL
          </label>
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <input
                id="fb-single-url"
                type="url"
                value={urlInput}
                onChange={(e) => {
                  onUrlInputChange(e.target.value);
                  if (error) setError(null);
                }}
                placeholder="https://www.facebook.com/watch/?v=... or https://fb.watch/..."
                className="w-full h-11 pl-4 pr-24 text-sm bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-blue-600 font-mono"
              />
              <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                {urlInput && (
                  <button
                    type="button"
                    onClick={() => {
                      onUrlInputChange('');
                      setError(null);
                    }}
                    aria-label="Clear URL"
                    className="p-1.5 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 rounded transition-colors cursor-pointer"
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={handlePaste}
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <ClipboardPaste className="w-3.5 h-3.5" />
                  Paste
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="h-11 px-6 inline-flex items-center justify-center gap-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 active:bg-blue-800 disabled:opacity-60 disabled:cursor-not-allowed rounded-lg transition-colors duration-150 whitespace-nowrap shrink-0 cursor-pointer"
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Inspecting
                </>
              ) : (
                'Analyze Video'
              )}
            </button>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
            <span>
              Supports Watch, Reels, Page Videos, Share links, and fb.watch · Public videos only
            </span>
            <button
              type="button"
              onClick={onSwitchToBatch}
              className="text-blue-600 dark:text-blue-400 hover:underline font-medium whitespace-nowrap shrink-0 cursor-pointer"
            >
              Need multiple videos? Open Batch Queue
            </button>
          </div>
        </form>

        {error && (
          <div
            role="alert"
            className="mt-4 flex items-start gap-3 p-3.5 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/60 text-sm text-red-800 dark:text-red-200"
          >
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-red-600 dark:text-red-400" />
            <span>{error}</span>
          </div>
        )}
      </div>

      {/* Loading Skeleton */}
      {loading && (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 grid grid-cols-1 lg:grid-cols-12 gap-6 animate-pulse">
          <div className="lg:col-span-5 aspect-video bg-slate-200 dark:bg-slate-800 rounded-lg" />
          <div className="lg:col-span-7 space-y-4">
            <div className="h-6 bg-slate-200 dark:bg-slate-800 rounded w-3/4" />
            <div className="h-4 bg-slate-200 dark:bg-slate-800 rounded w-1/2" />
            <div className="pt-4 space-y-2.5">
              <div className="h-10 bg-slate-100 dark:bg-slate-800/70 rounded" />
              <div className="h-10 bg-slate-100 dark:bg-slate-800/70 rounded" />
              <div className="h-10 bg-slate-100 dark:bg-slate-800/70 rounded" />
            </div>
          </div>
        </div>
      )}

      {/* Inspected Result Panel */}
      {!loading && inspected && (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 sm:p-6">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 lg:gap-8 items-stretch">
            {/* Media Preview Column */}
            <div className="lg:col-span-5 flex flex-col gap-3">
              <div className="relative aspect-video w-full rounded-lg overflow-hidden bg-slate-950 border border-slate-200 dark:border-slate-800">
                {previewActive && previewFormat ? (
                  <video
                    src={`/api/download?token=${encodeURIComponent(previewFormat.downloadToken)}&preview=1`}
                    controls
                    autoPlay
                    playsInline
                    className="w-full h-full object-contain bg-black"
                  />
                ) : inspected.thumbnailToken && !thumbFailed ? (
                  <>
                    <img
                      src={`/api/thumbnail?token=${encodeURIComponent(inspected.thumbnailToken)}`}
                      alt={inspected.title}
                      referrerPolicy="no-referrer"
                      onError={() => setThumbFailed(true)}
                      className="w-full h-full object-cover"
                    />
                    <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/80 via-black/40 to-transparent pointer-events-none" />
                  </>
                ) : (
                  <div className="w-full h-full flex flex-col items-center justify-center gap-2 bg-gradient-to-br from-slate-800 to-slate-950 text-slate-300 p-4 text-center">
                    <Film className="w-8 h-8 text-slate-400" />
                    <span className="text-xs font-medium text-slate-300 line-clamp-2 max-w-xs">
                      {inspected.title}
                    </span>
                  </div>
                )}

                {!previewActive && inspected.durationSec !== null && (
                  <span className="absolute bottom-2.5 right-2.5 px-2 py-0.5 rounded bg-slate-950/85 text-white font-mono text-xs tabular-nums">
                    {formatDuration(inspected.durationSec)}
                  </span>
                )}
              </div>

              <div className="flex items-center justify-between gap-3">
                {previewFormat ? (
                  <button
                    type="button"
                    onClick={() => setPreviewActive((prev) => !prev)}
                    className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <Play className="w-3.5 h-3.5" />
                    {previewActive ? 'Show Thumbnail' : 'Preview Stream'}
                  </button>
                ) : (
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    Direct HD stream ready
                  </span>
                )}

                <button
                  type="button"
                  onClick={() => {
                    onAddToBatch(inspected);
                    setAddedToBatch(true);
                  }}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  {addedToBatch ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                      Added to Batch
                    </>
                  ) : (
                    <>
                      <ListPlus className="w-3.5 h-3.5" />
                      Add to Batch Queue
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* Metadata + Resolution Matrix Column */}
            <div className="lg:col-span-7 flex flex-col justify-between gap-5">
              <div className="space-y-1.5">
                <h2 className="font-display text-xl font-semibold text-slate-900 dark:text-slate-100 leading-snug text-balance">
                  {inspected.title}
                </h2>
                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                  <span className="font-medium text-slate-700 dark:text-slate-300">{inspected.author}</span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums">
                    Duration {formatDuration(inspected.durationSec)}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums">
                    {inspected.formats.length} formats found
                  </span>
                </div>
              </div>

              {downloadError && (
                <div
                  role="alert"
                  className="flex items-start gap-2.5 p-3 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/60 text-xs text-red-800 dark:text-red-200"
                >
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{downloadError}</span>
                </div>
              )}

              <div className="overflow-x-auto border border-slate-200 dark:border-slate-800 rounded-lg">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 text-xs font-medium text-slate-500 dark:text-slate-400">
                      <th className="py-2.5 px-3.5">Quality</th>
                      <th className="py-2.5 px-3.5">Format</th>
                      <th className="py-2.5 px-3.5">Audio</th>
                      <th className="py-2.5 px-3.5 text-right">Size</th>
                      <th className="py-2.5 px-3.5 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 dark:divide-slate-800 text-sm">
                    {inspected.formats.map((format) => {
                      const isDownloading = downloadingFormatId === format.id;
                      return (
                        <tr
                          key={format.id}
                          className="hover:bg-slate-50/80 dark:hover:bg-slate-800/40 transition-colors"
                        >
                          <td className="py-2.5 px-3.5 font-medium text-slate-900 dark:text-slate-100 whitespace-nowrap">
                            <span>{format.label}</span>
                            {format.isMuxed && (
                              <span className="ml-2 text-xs font-normal text-slate-500 dark:text-slate-400">
                                Muxed HD
                              </span>
                            )}
                          </td>
                          <td className="py-2.5 px-3.5 font-mono text-xs text-slate-600 dark:text-slate-300 whitespace-nowrap">
                            {format.container} · {format.codec}
                          </td>
                          <td className="py-2.5 px-3.5 text-xs text-slate-600 dark:text-slate-300 whitespace-nowrap">
                            {format.hasAudio ? (
                              <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
                                <Volume2 className="w-3.5 h-3.5" />
                                Included
                              </span>
                            ) : (
                              <span className="text-slate-400 dark:text-slate-500">Video only</span>
                            )}
                          </td>
                          <td className="py-2.5 px-3.5 font-mono text-xs text-right text-slate-600 dark:text-slate-300 tabular-nums whitespace-nowrap">
                            {formatBytes(format.sizeBytes)}
                          </td>
                          <td className="py-2 px-3.5 text-right whitespace-nowrap">
                            <button
                              type="button"
                              disabled={Boolean(downloadingFormatId)}
                              onClick={() => void handleDownloadFormat(format)}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                            >
                              {isDownloading ? (
                                <>
                                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                  <span className="font-mono tabular-nums">
                                    {downloadProgress > 0 && downloadProgress < 100
                                      ? `${downloadProgress}%`
                                      : formatBytes(downloadedBytes)}
                                  </span>
                                </>
                              ) : (
                                <>
                                  <Download className="w-3.5 h-3.5" />
                                  Download
                                </>
                              )}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Empty State */}
      {!loading && !inspected && (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-8 text-center space-y-4">
          <div className="w-11 h-11 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 mx-auto flex items-center justify-center">
            <Film className="w-5 h-5" />
          </div>
          <div className="max-w-lg mx-auto space-y-1.5">
            <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
              Ready to extract high-resolution Facebook streams
            </h3>
            <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
              Paste any public Facebook Watch, Reel, or Page video URL above to inspect all available resolutions up to 4K/1080p HD, progressive MP4, and audio tracks.
            </p>
          </div>
          <div className="pt-1 flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              onClick={onSwitchToBatch}
              className="px-4 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              Open Batch Queue
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
