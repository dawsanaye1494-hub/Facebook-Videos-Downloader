export type FormatMode = 'direct' | 'mux' | 'm4a' | 'mp3';

export interface VideoFormat {
  id: string;
  label: string;
  quality: string;
  resolution: string;
  width: number | null;
  height: number | null;
  container: 'MP4' | 'M4A' | 'MP3';
  codec: string;
  hasAudio: boolean;
  isMuxed: boolean;
  sizeBytes: number | null;
  bitrateKbps: number | null;
  mode: FormatMode;
  downloadToken: string;
  filename: string;
}

export interface InspectedVideo {
  id: string;
  sourceUrl: string;
  canonicalUrl: string;
  title: string;
  author: string;
  durationSec: number | null;
  thumbnailToken: string | null;
  formats: VideoFormat[];
  inspectedAt: string;
}

export type QualityPreset =
  | 'highest'
  | '1080p'
  | '720p'
  | 'sd'
  | 'mp3';

export type BatchItemStatus =
  | 'pending'
  | 'inspecting'
  | 'ready'
  | 'downloading'
  | 'completed'
  | 'failed';

export interface BatchItem {
  id: string;
  url: string;
  status: BatchItemStatus;
  selected: boolean;
  progress: number;
  error?: string;
  video?: InspectedVideo;
  selectedFormatId?: string;
}

export interface HistoryEntry {
  id: string;
  url: string;
  title: string;
  author: string;
  durationSec: number | null;
  qualityLabel: string;
  container: string;
  sizeBytes: number | null;
  timestamp: string;
}
