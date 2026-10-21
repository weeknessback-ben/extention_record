export type Platform = 'meet' | 'zoom' | 'other';

export type RecordingStatus =
  | 'recording'
  | 'saving'
  | 'recorded'
  /** Sending audio and screenshots to the processing server. */
  | 'uploading'
  /** Waiting for its turn on the processing server. */
  | 'queued'
  | 'transcribing'
  | 'analyzing'
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
  stage: 'saving' | 'uploading' | 'transcribing' | 'analyzing' | 'summarizing';
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
  /** Non-fatal problem, e.g. the images could not be analysed. */
  warning?: string;
  video: VideoFileInfo;
  audioSegments: AudioSegmentMeta[];
  /** Screenshots taken when the shared screen changed (see FrameRecord). */
  frameCount?: number;
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
  /** Set once the recording was sent to a processing server. */
  server?: ServerJob;
}

export type TelegramStatus = 'off' | 'pending' | 'sending' | 'sent' | 'failed';

export interface ServerJob {
  /** Meeting id on the server. */
  id: string;
  baseUrl: string;
  uploadedAudio: number[];
  uploadedFrames: number[];
  telegram?: TelegramStatus;
}

export type FrameKind =
  | 'slide'
  | 'document'
  | 'chart'
  | 'diagram'
  | 'code'
  | 'whiteboard'
  | 'website'
  | 'screen'
  | 'people'
  | 'other';

/** What the vision model read from a screenshot. */
export interface FrameAnalysis {
  kind: FrameKind;
  /** 0-10: how useful the image is to document the meeting. */
  useful: number;
  caption: string;
  /** Most important visible text, verbatim. */
  text: string;
}

/** A screenshot of the meeting tab, stored in IndexedDB. */
export interface FrameRecord {
  id?: number;
  recId: string;
  /** Offset from the start of the recording, in ms. */
  t: number;
  width: number;
  height: number;
  blob: Blob;
  analysis?: FrameAnalysis;
}

/** An image the AI picked to illustrate a topic. */
export interface TopicImage {
  id: number;
  caption: string;
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
  topics: { title: string; time?: string; summary: string; points: string[]; images: TopicImage[] }[];
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
