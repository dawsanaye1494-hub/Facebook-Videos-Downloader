import { useMemo, useRef, useState, type ChangeEvent } from 'react';
import JSZip from 'jszip';
import {
  AlertCircle,
  Archive,
  CheckCircle2,
  Download,
  Film,
  Loader2,
  RefreshCw,
  Search,
  Trash2,
  Upload,
} from 'lucide-react';
import type {
  BatchItem,
  HistoryEntry,
  InspectedVideo,
  QualityPreset,
  VideoFormat,
} from '../types/video';
import { fetchFormatBlobWithProgress, triggerBrowserSave } from '../utils/download';
import {
  extractFacebookUrlsFromText,
  formatBytes,
  formatDuration,
  pickFormatForPreset,
} from '../utils/formatters';

interface BatchDownloaderProps {
  items: BatchItem[];
  defaultPreset: QualityPreset;
  onDefaultPresetChange: (preset: QualityPreset) => void;
  onEnqueueUrls: (urls: string[]) => void;
  onUpdateItem: (id: string, updater: (item: BatchItem) => BatchItem) => void;
  onRemoveItem: (id: string) => void;
  onClearCompleted: () => void;
  onClearAll: () => void;
  onRecordHistory: (entry: HistoryEntry) => void;
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
}

const PRESET_OPTIONS: { value: QualityPreset; label: string }[] = [
  { value: 'highest', label: 'Highest Available (4K / 1080p)' },
  { value: '1080p', label: '1080p Full HD' },
  { value: '720p', label: '720p HD' },
  { value: 'sd', label: 'SD (480p / 360p)' },
  { value: 'mp3', label: 'Audio Only (MP3)' },
];

export function BatchDownloader({
  items,
  defaultPreset,
  onDefaultPresetChange,
  onEnqueueUrls,
  onUpdateItem,
  onRemoveItem,
  onClearCompleted,
  onClearAll,
  onRecordHistory,
  textareaRef,
}: BatchDownloaderProps) {
  const [rawUrls, setRawUrls] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'ready' | 'completed' | 'failed'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [isBatchDownloading, setIsBatchDownloading] = useState(false);
  const [isZipping, setIsZipping] = useState(false);
  const [zipMessage, setZipMessage] = useState<string | null>(null);
  const [batchError, setBatchError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const detectedUrls = useMemo(() => extractFacebookUrlsFromText(rawUrls), [rawUrls]);

  const inspectSingleBatchItem = async (item: BatchItem) => {
    onUpdateItem(item.id, (prev) => ({
      ...prev,
      status: 'inspecting',
      error: undefined,
      progress: 0,
    }));

    try {
      const res = await fetch('/api/inspect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: item.url }),
      });
      const data = (await res.json()) as InspectedVideo & { error?: string };
      if (!res.ok) {
        throw new Error(data.error || 'Failed to inspect URL.');
      }

      const matched = pickFormatForPreset(data.formats, defaultPreset);
      onUpdateItem(item.id, (prev) => ({
        ...prev,
        status: 'ready',
        video: data,
        selectedFormatId: matched?.id || data.formats[0]?.id,
        error: undefined,
      }));
    } catch (err) {
      onUpdateItem(item.id, (prev) => ({
        ...prev,
        status: 'failed',
        error: err instanceof Error ? err.message : 'Unable to extract video.',
      }));
    }
  };

  const handleAnalyzeBatch = async () => {
    setBatchError(null);
    if (detectedUrls.length === 0) {
      setBatchError('Paste at least one valid Facebook video or Reel URL (facebook.com or fb.watch).');
      return;
    }

    onEnqueueUrls(detectedUrls);
    setRawUrls('');
  };

  const handleFileUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const content = await file.text();
      setRawUrls((prev) => (prev.trim() ? `${prev.trim()}\n${content}` : content));
      setBatchError(null);
    } catch {
      setBatchError('Could not read the selected text file.');
    } finally {
      e.target.value = '';
    }
  };

  const getSelectedFormat = (item: BatchItem): VideoFormat | undefined => {
    if (!item.video) return undefined;
    return (
      item.video.formats.find((f) => f.id === item.selectedFormatId) ||
      pickFormatForPreset(item.video.formats, defaultPreset) ||
      item.video.formats[0]
    );
  };

  const downloadSingleItem = async (item: BatchItem): Promise<void> => {
    const format = getSelectedFormat(item);
    if (!item.video || !format) return;

    onUpdateItem(item.id, (prev) => ({
      ...prev,
      status: 'downloading',
      progress: 0,
      error: undefined,
    }));

    try {
      const blob = await fetchFormatBlobWithProgress(format, {
        onProgress: (percent) => {
          onUpdateItem(item.id, (prev) => ({
            ...prev,
            progress: percent,
          }));
        },
      });
      triggerBrowserSave(blob, format.filename);
      onUpdateItem(item.id, (prev) => ({
        ...prev,
        status: 'completed',
        progress: 100,
      }));
      onRecordHistory({
        id: `${item.video.id}-${format.id}-${Date.now()}`,
        url: item.url,
        title: item.video.title,
        author: item.video.author,
        durationSec: item.video.durationSec,
        qualityLabel: format.label,
        container: format.container,
        sizeBytes: blob.size || format.sizeBytes,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      onUpdateItem(item.id, (prev) => ({
        ...prev,
        status: 'failed',
        error: err instanceof Error ? err.message : 'Download failed.',
      }));
    }
  };

  const readySelectedItems = items.filter(
    (item) => item.selected && item.video && (item.status === 'ready' || item.status === 'completed')
  );

  const handleDownloadSelectedSequentially = async () => {
    if (readySelectedItems.length === 0 || isBatchDownloading || isZipping) return;
    setIsBatchDownloading(true);
    setBatchError(null);
    try {
      for (const item of readySelectedItems) {
        await downloadSingleItem(item);
      }
    } finally {
      setIsBatchDownloading(false);
    }
  };

  const handleDownloadAsZip = async () => {
    if (readySelectedItems.length === 0 || isBatchDownloading || isZipping) return;
    setIsZipping(true);
    setBatchError(null);
    setZipMessage(`Preparing ${readySelectedItems.length} files for ZIP archive...`);

    const zip = new JSZip();
    const usedNames = new Map<string, number>();

    try {
      for (let i = 0; i < readySelectedItems.length; i += 1) {
        const item = readySelectedItems[i];
        const format = getSelectedFormat(item);
        if (!item.video || !format) continue;

        setZipMessage(`Fetching ${i + 1} of ${readySelectedItems.length}: ${item.video.title}`);
        onUpdateItem(item.id, (prev) => ({ ...prev, status: 'downloading', progress: 0 }));

        const blob = await fetchFormatBlobWithProgress(format, {
          onProgress: (percent) => {
            onUpdateItem(item.id, (prev) => ({ ...prev, progress: percent }));
          },
        });

        let archiveName = format.filename;
        const count = usedNames.get(archiveName) || 0;
        if (count > 0) {
          const dotIdx = archiveName.lastIndexOf('.');
          const base = dotIdx > 0 ? archiveName.slice(0, dotIdx) : archiveName;
          const ext = dotIdx > 0 ? archiveName.slice(dotIdx) : '';
          archiveName = `${base} (${count + 1})${ext}`;
        }
        usedNames.set(format.filename, count + 1);

        zip.file(archiveName, blob);
        onUpdateItem(item.id, (prev) => ({ ...prev, status: 'completed', progress: 100 }));
        onRecordHistory({
          id: `${item.video.id}-${format.id}-${Date.now()}`,
          url: item.url,
          title: item.video.title,
          author: item.video.author,
          durationSec: item.video.durationSec,
          qualityLabel: format.label,
          container: format.container,
          sizeBytes: blob.size || format.sizeBytes,
          timestamp: new Date().toISOString(),
        });
      }

      setZipMessage('Compressing ZIP archive...');
      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const dateStr = new Date().toISOString().slice(0, 10);
      triggerBrowserSave(zipBlob, `ClearReel-Batch-${dateStr}.zip`);
    } catch (err) {
      setBatchError(err instanceof Error ? err.message : 'Failed to build batch ZIP archive.');
    } finally {
      setIsZipping(false);
      setZipMessage(null);
    }
  };

  const filteredItems = items.filter((item) => {
    if (statusFilter === 'ready' && item.status !== 'ready') return false;
    if (statusFilter === 'completed' && item.status !== 'completed') return false;
    if (statusFilter === 'failed' && item.status !== 'failed') return false;

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const title = item.video?.title.toLowerCase() || '';
      const author = item.video?.author.toLowerCase() || '';
      return title.includes(q) || author.includes(q) || item.url.toLowerCase().includes(q);
    }
    return true;
  });

  const allSelected =
    filteredItems.length > 0 && filteredItems.every((item) => item.selected);

  const toggleAllVisible = () => {
    const nextVal = !allSelected;
    filteredItems.forEach((item) => {
      onUpdateItem(item.id, (prev) => ({ ...prev, selected: nextVal }));
    });
  };

  const applyPresetToAllReady = (preset: QualityPreset) => {
    onDefaultPresetChange(preset);
    items.forEach((item) => {
      if (item.video) {
        const picked = pickFormatForPreset(item.video.formats, preset);
        if (picked) {
          onUpdateItem(item.id, (prev) => ({ ...prev, selectedFormatId: picked.id }));
        }
      }
    });
  };

  return (
    <section className="space-y-8">
      {/* Multi-URL Input Panel */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 sm:p-6 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
              Batch URL Importer
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Paste multiple public Facebook Watch, Reel, or Video links (one per line) or upload a .txt file.
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <input
              ref={fileInputRef}
              type="file"
              accept=".txt,.csv"
              onChange={handleFileUpload}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Upload className="w-3.5 h-3.5" />
              Import .txt
            </button>
          </div>
        </div>

        <textarea
          ref={textareaRef}
          rows={4}
          value={rawUrls}
          onChange={(e) => {
            setRawUrls(e.target.value);
            if (batchError) setBatchError(null);
          }}
          placeholder={
            'https://www.facebook.com/watch/?v=1234567890\nhttps://www.facebook.com/reel/9876543210\nhttps://fb.watch/example/'
          }
          className="w-full p-3.5 text-sm font-mono bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-blue-600 resize-y"
        />

        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <label
              htmlFor="batch-default-preset"
              className="text-xs font-medium text-slate-600 dark:text-slate-400 whitespace-nowrap"
            >
              Preferred Resolution
            </label>
            <select
              id="batch-default-preset"
              value={defaultPreset}
              onChange={(e) => applyPresetToAllReady(e.target.value as QualityPreset)}
              className="h-10 px-3 text-xs font-medium bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
            >
              {PRESET_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-3">
            <span className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
              {detectedUrls.length} valid {detectedUrls.length === 1 ? 'URL' : 'URLs'} detected
            </span>
            <button
              type="button"
              onClick={handleAnalyzeBatch}
              className="h-10 px-5 inline-flex items-center justify-center gap-2 text-xs sm:text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 active:bg-blue-800 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {detectedUrls.length > 0 ? `Analyze ${detectedUrls.length} URLs` : 'Analyze Batch'}
            </button>
          </div>
        </div>

        {batchError && (
          <div
            role="alert"
            className="flex items-start gap-2.5 p-3 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/60 text-xs text-red-800 dark:text-red-200"
          >
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{batchError}</span>
          </div>
        )}
      </div>

      {/* Batch Queue Data Grid */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        {/* Toolbar */}
        <div className="p-4 sm:px-6 border-b border-slate-200 dark:border-slate-800 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-950 rounded-lg">
              {(['all', 'ready', 'completed', 'failed'] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setStatusFilter(tab)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 capitalize cursor-pointer ${
                    statusFilter === tab
                      ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
                  }`}
                >
                  {tab}
                </button>
              ))}
            </div>

            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Filter queue..."
                className="h-9 pl-8 pr-3 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600 w-48"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            {items.some((i) => i.status === 'completed') && (
              <button
                type="button"
                onClick={onClearCompleted}
                className="px-3 py-2 text-xs font-medium text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                Clear Completed
              </button>
            )}
            {items.length > 0 && (
              <button
                type="button"
                onClick={onClearAll}
                disabled={isBatchDownloading || isZipping}
                className="px-3 py-2 text-xs font-medium text-slate-600 dark:text-slate-300 hover:text-red-600 dark:hover:text-red-400 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                Clear Queue
              </button>
            )}

            <button
              type="button"
              disabled={readySelectedItems.length === 0 || isBatchDownloading || isZipping}
              onClick={handleDownloadAsZip}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {isZipping ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Archive className="w-3.5 h-3.5" />}
              Save as ZIP
            </button>

            <button
              type="button"
              disabled={readySelectedItems.length === 0 || isBatchDownloading || isZipping}
              onClick={handleDownloadSelectedSequentially}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {isBatchDownloading ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Download className="w-3.5 h-3.5" />
              )}
              Download Selected ({readySelectedItems.length})
            </button>
          </div>
        </div>

        {zipMessage && (
          <div className="px-6 py-2.5 bg-blue-50 dark:bg-blue-950/40 border-b border-blue-200 dark:border-blue-900/60 text-xs text-blue-800 dark:text-blue-200 flex items-center gap-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
            <span className="truncate">{zipMessage}</span>
          </div>
        )}

        {items.length === 0 ? (
          <div className="p-10 text-center space-y-2">
            <Film className="w-6 h-6 text-slate-400 mx-auto" />
            <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
              Your batch queue is empty
            </p>
            <p className="text-xs text-slate-500 dark:text-slate-400 max-w-md mx-auto">
              Paste multiple Facebook video or Reel links above and click Analyze Batch to queue them for simultaneous HD resolution selection and download.
            </p>
          </div>
        ) : filteredItems.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-500 dark:text-slate-400">
            No queued items match the current filter.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/50 text-xs font-medium text-slate-500 dark:text-slate-400">
                  <th className="py-3 pl-5 pr-2 w-10">
                    <input
                      type="checkbox"
                      aria-label="Select all visible videos"
                      checked={allSelected}
                      onChange={toggleAllVisible}
                      className="w-4 h-4 rounded border-slate-300 dark:border-slate-700 text-blue-600 focus:ring-blue-600 cursor-pointer"
                    />
                  </th>
                  <th className="py-3 px-3">Video</th>
                  <th className="py-3 px-3">Resolution</th>
                  <th className="py-3 px-3 text-right">Duration</th>
                  <th className="py-3 px-3 text-right">Size</th>
                  <th className="py-3 px-3">Status</th>
                  <th className="py-3 pl-3 pr-5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800 text-sm">
                {filteredItems.map((item) => {
                  const chosenFormat = getSelectedFormat(item);
                  return (
                    <tr
                      key={item.id}
                      className="hover:bg-slate-50/80 dark:hover:bg-slate-800/35 transition-colors"
                    >
                      <td className="py-3 pl-5 pr-2 align-middle">
                        <input
                          type="checkbox"
                          aria-label={`Select ${item.video?.title || item.url}`}
                          checked={item.selected}
                          onChange={(e) =>
                            onUpdateItem(item.id, (prev) => ({
                              ...prev,
                              selected: e.target.checked,
                            }))
                          }
                          className="w-4 h-4 rounded border-slate-300 dark:border-slate-700 text-blue-600 focus:ring-blue-600 cursor-pointer"
                        />
                      </td>

                      <td className="py-3 px-3 max-w-xs">
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="w-16 h-9 rounded bg-slate-200 dark:bg-slate-800 overflow-hidden shrink-0 flex items-center justify-center">
                            {item.video?.thumbnailToken ? (
                              <img
                                src={`/api/thumbnail?token=${encodeURIComponent(item.video.thumbnailToken)}`}
                                alt={item.video.title}
                                referrerPolicy="no-referrer"
                                className="w-full h-full object-cover"
                              />
                            ) : (
                              <Film className="w-4 h-4 text-slate-400" />
                            )}
                          </div>
                          <div className="min-w-0">
                            <div
                              title={item.video?.title || item.url}
                              className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate"
                            >
                              {item.video ? item.video.title : item.url}
                            </div>
                            <div className="text-xs text-slate-500 dark:text-slate-400 truncate">
                              {item.video ? item.video.author : 'Inspecting Facebook URL'}
                            </div>
                          </div>
                        </div>
                      </td>

                      <td className="py-3 px-3 whitespace-nowrap">
                        {item.video ? (
                          <select
                            aria-label={`Select format for ${item.video.title}`}
                            value={chosenFormat?.id || ''}
                            disabled={item.status === 'downloading'}
                            onChange={(e) =>
                              onUpdateItem(item.id, (prev) => ({
                                ...prev,
                                selectedFormatId: e.target.value,
                              }))
                            }
                            className="h-8 px-2.5 text-xs font-mono bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
                          >
                            {item.video.formats.map((f) => (
                              <option key={f.id} value={f.id}>
                                {f.label} · {f.container}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span className="text-xs text-slate-400">—</span>
                        )}
                      </td>

                      <td className="py-3 px-3 text-right font-mono text-xs text-slate-600 dark:text-slate-300 tabular-nums whitespace-nowrap">
                        {formatDuration(item.video?.durationSec)}
                      </td>

                      <td className="py-3 px-3 text-right font-mono text-xs text-slate-600 dark:text-slate-300 tabular-nums whitespace-nowrap">
                        {chosenFormat ? formatBytes(chosenFormat.sizeBytes) : '—'}
                      </td>

                      <td className="py-3 px-3 whitespace-nowrap">
                        {item.status === 'pending' && (
                          <span className="text-xs text-slate-500 dark:text-slate-400">Queued</span>
                        )}
                        {item.status === 'inspecting' && (
                          <span className="inline-flex items-center gap-1.5 text-xs text-blue-600 dark:text-blue-400">
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            Inspecting
                          </span>
                        )}
                        {item.status === 'ready' && (
                          <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
                            Ready
                          </span>
                        )}
                        {item.status === 'downloading' && (
                          <div className="w-28 space-y-1">
                            <div className="flex items-center justify-between text-xs font-mono tabular-nums text-blue-600 dark:text-blue-400">
                              <span>Saving</span>
                              <span>{item.progress}%</span>
                            </div>
                            <div className="h-1.5 w-full bg-slate-200 dark:bg-slate-800 rounded-full overflow-hidden">
                              <div
                                className="h-full bg-blue-600 transition-transform duration-150"
                                style={{ width: `${Math.max(8, item.progress)}%` }}
                              />
                            </div>
                          </div>
                        )}
                        {item.status === 'completed' && (
                          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            Saved
                          </span>
                        )}
                        {item.status === 'failed' && (
                          <span
                            title={item.error}
                            className="inline-flex items-center gap-1.5 text-xs font-medium text-red-600 dark:text-red-400 max-w-[180px]"
                          >
                            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                            <span className="truncate">{item.error || 'Unavailable'}</span>
                          </span>
                        )}
                      </td>

                      <td className="py-3 pl-3 pr-5 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1.5">
                          {(item.status === 'ready' || item.status === 'completed') && (
                            <button
                              type="button"
                              disabled={isBatchDownloading || isZipping}
                              onClick={() => void downloadSingleItem(item)}
                              aria-label="Download video"
                              className="p-2 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/50 rounded-md transition-colors cursor-pointer"
                            >
                              <Download className="w-4 h-4" />
                            </button>
                          )}
                          {item.status === 'failed' && (
                            <button
                              type="button"
                              onClick={() => void inspectSingleBatchItem(item)}
                              aria-label="Retry inspect"
                              className="p-2 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md transition-colors cursor-pointer"
                            >
                              <RefreshCw className="w-4 h-4" />
                            </button>
                          )}
                          <button
                            type="button"
                            disabled={item.status === 'downloading'}
                            onClick={() => onRemoveItem(item.id)}
                            aria-label="Remove from queue"
                            className="p-2 text-slate-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md transition-colors cursor-pointer"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
