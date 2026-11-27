export function FormatGuide() {
  const formatRows = [
    {
      resolution: '2160p (4K UHD) / 1440p (2K)',
      delivery: 'Adaptive DASH Video + Audio',
      container: 'MP4 (H.264 / VP9 + AAC)',
      notes: 'Muxed on the fly by the server into a single playable MP4 file when published in 2K/4K.',
    },
    {
      resolution: '1080p (Full HD)',
      delivery: 'Adaptive DASH Video + Audio',
      container: 'MP4 (H.264 + AAC)',
      notes: 'Full high-definition stream with automatic audio track merging.',
    },
    {
      resolution: '720p (HD)',
      delivery: 'Progressive Direct Stream',
      container: 'MP4 (H.264 + AAC)',
      notes: 'Fast direct download with pre-muxed video and audio and exact file size.',
    },
    {
      resolution: '480p / 360p (SD)',
      delivery: 'Progressive Direct Stream',
      container: 'MP4 (H.264 + AAC)',
      notes: 'Compact file size suited for quick previews and mobile playback.',
    },
    {
      resolution: 'Audio Only',
      delivery: 'Extracted Audio Stream',
      container: 'M4A (AAC) / MP3 (192 kbps)',
      notes: 'Audio-only extraction for podcasts, talks, and music clips.',
    },
  ];

  const supportedLinks = [
    'https://www.facebook.com/watch/?v=...',
    'https://www.facebook.com/reel/...',
    'https://www.facebook.com/<page>/videos/...',
    'https://www.facebook.com/share/v/...',
    'https://fb.watch/...',
  ];

  return (
    <section className="space-y-8">
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="p-5 sm:px-6 border-b border-slate-200 dark:border-slate-800">
          <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
            Supported Formats & High-Resolution Processing
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            ClearReel extracts both progressive streams and high-bitrate adaptive DASH tracks for every public video.
          </p>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/50 text-xs font-medium text-slate-500 dark:text-slate-400">
                <th className="py-3 pl-6 pr-3">Resolution</th>
                <th className="py-3 px-3">Delivery</th>
                <th className="py-3 px-3">Container & Codec</th>
                <th className="py-3 pl-3 pr-6">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800 text-sm">
              {formatRows.map((row) => (
                <tr key={row.resolution}>
                  <td className="py-3 pl-6 pr-3 font-medium text-slate-900 dark:text-slate-100 whitespace-nowrap">
                    {row.resolution}
                  </td>
                  <td className="py-3 px-3 text-xs text-slate-600 dark:text-slate-300 whitespace-nowrap">
                    {row.delivery}
                  </td>
                  <td className="py-3 px-3 font-mono text-xs text-slate-700 dark:text-slate-300 whitespace-nowrap">
                    {row.container}
                  </td>
                  <td className="py-3 pl-3 pr-6 text-xs text-slate-600 dark:text-slate-400">
                    {row.notes}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 sm:p-6 space-y-3">
        <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
          Supported Facebook Link Patterns
        </h3>
        <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs font-mono text-slate-600 dark:text-slate-300">
          {supportedLinks.map((pattern) => (
            <li
              key={pattern}
              className="px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 truncate"
            >
              {pattern}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
