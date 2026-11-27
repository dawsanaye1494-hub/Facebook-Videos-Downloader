import { useState } from 'react';
import { Clock, RotateCcw, Search, Trash2 } from 'lucide-react';
import type { HistoryEntry } from '../types/video';
import { formatBytes, formatDuration } from '../utils/formatters';

interface HistoryPanelProps {
  entries: HistoryEntry[];
  onReinspect: (url: string) => void;
  onClearHistory: () => void;
}

export function HistoryPanel({ entries, onReinspect, onClearHistory }: HistoryPanelProps) {
  const [query, setQuery] = useState('');

  const filtered = entries.filter((entry) => {
    if (!query.trim()) return true;
    const q = query.toLowerCase();
    return (
      entry.title.toLowerCase().includes(q) ||
      entry.author.toLowerCase().includes(q) ||
      entry.url.toLowerCase().includes(q)
    );
  });

  return (
    <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
      <div className="p-4 sm:px-6 border-b border-slate-200 dark:border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
            Recent Downloads
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Stored locally in your browser. Re-analyze any previous Facebook link with one click.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search history..."
              className="h-9 pl-8 pr-3 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600 w-48"
            />
          </div>
          {entries.length > 0 && (
            <button
              type="button"
              onClick={onClearHistory}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-600 dark:text-slate-300 hover:text-red-600 dark:hover:text-red-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Clear History
            </button>
          )}
        </div>
      </div>

      {entries.length === 0 ? (
        <div className="p-10 text-center space-y-2">
          <Clock className="w-6 h-6 text-slate-400 mx-auto" />
          <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
            No downloads recorded yet
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Completed single and batch downloads appear here for quick re-inspection.
          </p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="p-8 text-center text-xs text-slate-500 dark:text-slate-400">
          No history entries match your search.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/50 text-xs font-medium text-slate-500 dark:text-slate-400">
                <th className="py-3 pl-6 pr-3">Video</th>
                <th className="py-3 px-3">Format</th>
                <th className="py-3 px-3 text-right">Duration</th>
                <th className="py-3 px-3 text-right">Size</th>
                <th className="py-3 px-3 text-right">Saved</th>
                <th className="py-3 pl-3 pr-6 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800 text-sm">
              {filtered.map((entry) => (
                <tr
                  key={entry.id}
                  className="hover:bg-slate-50/80 dark:hover:bg-slate-800/35 transition-colors"
                >
                  <td className="py-3 pl-6 pr-3 max-w-sm">
                    <div className="font-medium text-slate-900 dark:text-slate-100 truncate">
                      {entry.title}
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400 truncate">
                      {entry.author} · {entry.url}
                    </div>
                  </td>
                  <td className="py-3 px-3 font-mono text-xs text-slate-700 dark:text-slate-300 whitespace-nowrap">
                    {entry.qualityLabel} · {entry.container}
                  </td>
                  <td className="py-3 px-3 text-right font-mono text-xs text-slate-600 dark:text-slate-300 tabular-nums whitespace-nowrap">
                    {formatDuration(entry.durationSec)}
                  </td>
                  <td className="py-3 px-3 text-right font-mono text-xs text-slate-600 dark:text-slate-300 tabular-nums whitespace-nowrap">
                    {formatBytes(entry.sizeBytes)}
                  </td>
                  <td className="py-3 px-3 text-right font-mono text-xs text-slate-500 dark:text-slate-400 tabular-nums whitespace-nowrap">
                    {new Date(entry.timestamp).toLocaleDateString()}
                  </td>
                  <td className="py-3 pl-3 pr-6 text-right whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => onReinspect(entry.url)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/50 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      Re-inspect
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
