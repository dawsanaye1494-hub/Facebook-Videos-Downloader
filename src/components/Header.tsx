export type WorkspaceSection = 'single' | 'batch' | 'history' | 'guide';

interface HeaderProps {
  activeSection: WorkspaceSection;
  batchCount: number;
  onNavigate: (section: WorkspaceSection) => void;
  onQuickBatchImport: () => void;
}

export function Header({
  activeSection,
  batchCount,
  onNavigate,
  onQuickBatchImport,
}: HeaderProps) {
  const navItems: { id: WorkspaceSection; label: string }[] = [
    { id: 'single', label: 'Single Video' },
    { id: 'batch', label: batchCount > 0 ? `Batch Queue (${batchCount})` : 'Batch Queue' },
    { id: 'history', label: 'History' },
    { id: 'guide', label: 'Format Guide' },
  ];

  return (
    <header className="border-b border-slate-200 dark:border-slate-800 bg-white/95 dark:bg-slate-950/95 backdrop-blur-sm">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-8">
        <button
          type="button"
          onClick={() => onNavigate('single')}
          className="font-display text-lg font-bold tracking-tight text-slate-900 dark:text-slate-100 whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 rounded"
        >
          ClearReel
        </button>

        <nav className="hidden md:flex items-center gap-6 text-sm font-medium">
          {navItems.map((item) => {
            const isActive = activeSection === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onNavigate(item.id)}
                className={`py-1 transition-colors duration-150 whitespace-nowrap shrink-0 border-b-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 rounded-t ${
                  isActive
                    ? 'border-blue-600 text-slate-900 dark:text-slate-100'
                    : 'border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:border-slate-300 dark:hover:border-slate-700'
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </nav>

        <div className="flex items-center shrink-0">
          <button
            type="button"
            onClick={onQuickBatchImport}
            className="px-4 py-2 text-xs sm:text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 active:bg-blue-800 rounded-lg transition-colors duration-150 whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-950 cursor-pointer"
          >
            Batch Import
          </button>
        </div>
      </div>
    </header>
  );
}
