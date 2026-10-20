export type Platform = 'meet' | 'zoom' | 'other';

export type RecordingStatus =
  | 'recording'
  | 'saving'
  | 'recorded'
  | 'transcribing'
  | 'summarizing'
  | 'done'
  | 'error'
  | 'interrupted';

export type TemplateId = 'general' | 'standup' | 'lecture' | 'interview' | 'sales' | 'brainstorm';

/** One finished audio segment, recorded as a standalone WebM file. */
export interface AudioSegmentMeta {
  index: number;
  /** Offset from the start of the recording, in ms. */
  startMs: number;
  endMs: number;
  bytes: number;
}

export interface TranscriptSegment {
  /** Seconds from the start of the recording. */
  start: number;
  end: number;
  text: string;
  speaker?: string;
}

export interface VideoFileInfo {
  status: 'pending' | 'saving' | 'saved' | 'failed';
  filename?: string;
  downloadId?: number;
  bytes?: number;
  error?: string;
}

export interface Progress {
  stage: 'saving' | 'transcribing' | 'summarizing';
  done: number;
  total: number;
}

export interface Recording {
  id: string;
  title: string;
  platform: Platform;
  pageUrl: string;
  startedAt: number;
  endedAt?: number;
  durationMs: number;
  /** Folder relative to the Chrome downloads directory. */
  folder: string;
  mimeType: string;
  hasMic: boolean;
  micError?: string;
  status: RecordingStatus;
  progress?: Progress;
  error?: string;
  video: VideoFileInfo;
  audioSegments: AudioSegmentMeta[];
  /** Extra context from the user (participants, agenda, ...) passed to the AI. */
  notes: string;
  template?: TemplateId;
  /** Transcript per audio segment index, kept so processing can resume. */
  transcriptParts?: Record<number, TranscriptSegment[]>;
  transcript?: TranscriptSegment[];
  summary?: MeetingSummary;
  summaryModel?: string;
  processedAt?: number;
  pdf?: { filename: string; savedAt: number };
}

export interface SummaryLabels {
  minutes: string;
  date: string;
  duration: string;
  platform: string;
  spokenLanguages: string;
  participants: string;
  executiveSummary: string;
  keyPoints: string;
  topics: string;
  decisions: string;
  actionItems: string;
  task: string;
  owner: string;
  deadline: string;
  priority: string;
  openQuestions: string;
  nextSteps: string;
  timeline: string;
  transcript: string;
}

export interface MeetingSummary {
  /** BCP-47 code of the language the summary is written in. */
  language: string;
  labels: Partial<SummaryLabels>;
  title: string;
  spokenLanguages: string[];
  participants: { name: string; role?: string }[];
  executiveSummary: string;
  keyPoints: string[];
  topics: { title: string; time?: string; summary: string; points: string[] }[];
  decisions: { decision: string; context?: string }[];
  actionItems: { task: string; owner?: string; deadline?: string; priority?: string }[];
  openQuestions: string[];
  nextSteps: string[];
  timeline: { time: string; event: string }[];
}

export interface ActiveRecording {
  recId: string;
  tabId: number;
  title: string;
  startedAt: number;
  pageOrigin: string;
}
