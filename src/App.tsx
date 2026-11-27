import { useCallback, useEffect, useRef, useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import { BatchDownloader } from './components/BatchDownloader';
import { FormatGuide } from './components/FormatGuide';
import { Header, type WorkspaceSection } from './components/Header';
import { HistoryPanel } from './components/HistoryPanel';
import { SingleInspector } from './components/SingleInspector';
import type {
  BatchItem,
  HistoryEntry,
  InspectedVideo,
  QualityPreset,
} from './types/video';
import { pickFormatForPreset } from './utils/formatters';

const HISTORY_STORAGE_KEY = 'clearreel.history.v1';
const THEME_STORAGE_KEY = 'clearreel.theme.v1';
const MAX_CONCURRENT_INSPECTIONS = 3;

function loadStoredHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as HistoryEntry[]) : [];
  } catch {
    return [];
  }
}

function loadInitialTheme(): 'light' | 'dark' {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'dark' || stored === 'light') return stored;
  } catch {
    // ignore storage errors
  }
  return 'light';
}

export default function App() {
  const [theme, setTheme] = useState<'light' | 'dark'>(loadInitialTheme);
  const [activeSection, setActiveSection] = useState<WorkspaceSection>('single');
  const [singleUrl, setSingleUrl] = useState('');
  const [singleInspected, setSingleInspected] = useState<InspectedVideo | null>(null);

  const [defaultPreset, setDefaultPreset] = useState<QualityPreset>('highest');
  const [batchItems, setBatchItems] = useState<BatchItem[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>(loadStoredHistory);

  const batchTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const activeInspectCountRef = useRef(0);
  const inspectingIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // ignore storage errors
    }
  }, [theme]);

  useEffect(() => {
    try {
      localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history.slice(0, 100)));
    } catch {
      // ignore storage errors
    }
  }, [history]);

  const updateBatchItem = useCallback(
    (id: string, updater: (item: BatchItem) => BatchItem) => {
      setBatchItems((prev) => prev.map((item) => (item.id === id ? updater(item) : item)));
    },
    []
  );

  // Bounded-concurrency background inspector for pending batch items
  useEffect(() => {
    const pendingItems = batchItems.filter(
      (item) => item.status === 'pending' && !inspectingIdsRef.current.has(item.id)
    );

    if (pendingItems.length === 0) return;

    const availableSlots = MAX_CONCURRENT_INSPECTIONS - activeInspectCountRef.current;
    if (availableSlots <= 0) return;

    const toStart = pendingItems.slice(0, availableSlots);

    toStart.forEach((target) => {
      inspectingIdsRef.current.add(target.id);
      activeInspectCountRef.current += 1;

      updateBatchItem(target.id, (prev) => ({
        ...prev,
        status: 'inspecting',
        error: undefined,
      }));

      void (async () => {
        try {
          const res = await fetch('/api/inspect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: target.url }),
          });
          const data = (await res.json()) as InspectedVideo & { error?: string };
          if (!res.ok) {
            throw new Error(data.error || 'Unable to extract video.');
          }
          const matched = pickFormatForPreset(data.formats, defaultPreset);
          updateBatchItem(target.id, (prev) => ({
            ...prev,
            status: 'ready',
            video: data,
            selectedFormatId: matched?.id || data.formats[0]?.id,
            error: undefined,
          }));
        } catch (err) {
          updateBatchItem(target.id, (prev) => ({
            ...prev,
            status: 'failed',
            error: err instanceof Error ? err.message : 'Inspection failed.',
          }));
        } finally {
          inspectingIdsRef.current.delete(target.id);
          activeInspectCountRef.current = Math.max(0, activeInspectCountRef.current - 1);
        }
      })();
    });
  }, [batchItems, defaultPreset, updateBatchItem]);

  const handleEnqueueUrls = (urls: string[]) => {
    setBatchItems((prev) => {
      const existingUrls = new Set(prev.map((p) => p.url));
      const newItems: BatchItem[] = urls
        .filter((u) => !existingUrls.has(u))
        .map((url, idx) => ({
          id: `batch-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 7)}`,
          url,
          status: 'pending',
          selected: true,
          progress: 0,
        }));
      return [...prev, ...newItems];
    });
  };

  const handleAddInspectedToBatch = (video: InspectedVideo) => {
    const matched = pickFormatForPreset(video.formats, defaultPreset);
    setBatchItems((prev) => {
      if (prev.some((item) => item.url === video.sourceUrl || item.video?.id === video.id)) {
        return prev;
      }
      return [
        ...prev,
        {
          id: `batch-${video.id}-${Date.now()}`,
          url: video.sourceUrl,
          status: 'ready',
          selected: true,
          progress: 0,
          video,
          selectedFormatId: matched?.id || video.formats[0]?.id,
        },
      ];
    });
  };

  const handleRecordHistory = (entry: HistoryEntry) => {
    setHistory((prev) => [entry, ...prev].slice(0, 100));
  };

  const handleQuickBatchImport = () => {
    setActiveSection('batch');
    setTimeout(() => {
      batchTextareaRef.current?.focus();
    }, 50);
  };

  const handleReinspectFromHistory = (url: string) => {
    setSingleUrl(url);
    setActiveSection('single');
  };

  const workspaceTabs: { id: WorkspaceSection; label: string }[] = [
    { id: 'single', label: 'Single Video' },
    { id: 'batch', label: batchItems.length > 0 ? `Batch Queue (${batchItems.length})` : 'Batch Queue' },
    { id: 'history', label: 'History' },
    { id: 'guide', label: 'Format Guide' },
  ];

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 transition-colors duration-150">
      <Header
        activeSection={activeSection}
        batchCount={batchItems.length}
        onNavigate={setActiveSection}
        onQuickBatchImport={handleQuickBatchImport}
      />

      <main className="flex-1 w-full max-w-6xl mx-auto px-4 sm:px-6 py-8 sm:py-10 space-y-8">
        {/* Hero Header + Workspace Controls */}
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-6">
          <div className="space-y-2 max-w-2xl">
            <h1 className="font-display text-2xl sm:text-4xl font-bold tracking-tight text-slate-900 dark:text-slate-100 text-balance">
              Download Facebook Videos in Full HD
            </h1>
            <p className="text-sm sm:text-base text-slate-600 dark:text-slate-400 leading-relaxed">
              Save public Facebook Watch videos, Reels, and Page clips in up to 4K, 1080p Full HD, 720p HD, or MP3 audio—individually or across a batch queue.
            </p>
          </div>

          <div className="flex items-center justify-between md:justify-end gap-3 shrink-0">
            <div className="flex items-center gap-1 p-1 bg-slate-200/75 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-x-auto">
              {workspaceTabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveSection(tab.id)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    activeSection === tab.id
                      ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={() => setTheme((prev) => (prev === 'light' ? 'dark' : 'light'))}
              aria-label={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
              className="h-9 w-9 inline-flex items-center justify-center rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors shrink-0 cursor-pointer"
            >
              {theme === 'light' ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
            </button>
          </div>
        </div>

        {/* Active Workspace Section */}
        {activeSection === 'single' && (
          <SingleInspector
            inspected={singleInspected}
            urlInput={singleUrl}
            onUrlInputChange={setSingleUrl}
            onInspectComplete={setSingleInspected}
            onAddToBatch={handleAddInspectedToBatch}
            onRecordHistory={handleRecordHistory}
            onSwitchToBatch={() => setActiveSection('batch')}
          />
        )}

        {activeSection === 'batch' && (
          <BatchDownloader
            items={batchItems}
            defaultPreset={defaultPreset}
            onDefaultPresetChange={setDefaultPreset}
            onEnqueueUrls={handleEnqueueUrls}
            onUpdateItem={updateBatchItem}
            onRemoveItem={(id) =>
              setBatchItems((prev) => prev.filter((item) => item.id !== id))
            }
            onClearCompleted={() =>
              setBatchItems((prev) => prev.filter((item) => item.status !== 'completed'))
            }
            onClearAll={() => setBatchItems([])}
            onRecordHistory={handleRecordHistory}
            textareaRef={batchTextareaRef}
          />
        )}

        {activeSection === 'history' && (
          <HistoryPanel
            entries={history}
            onReinspect={handleReinspectFromHistory}
            onClearHistory={() => setHistory([])}
          />
        )}

        {activeSection === 'guide' && <FormatGuide />}
      </main>

      <footer className="border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-5 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-slate-500 dark:text-slate-400">
          <span>ClearReel · Public Facebook HD Video & Batch Downloader</span>
          <span>For publicly accessible videos you are authorized to save.</span>
        </div>
      </footer>
    </div>
  );
}
