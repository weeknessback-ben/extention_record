import type { MeetingSummary, Recording, SummaryLabels, TranscriptSegment } from './types';

export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h, m, sec].map((n) => String(n).padStart(2, '0')).join(':');
}

export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

/**
 * Merges short recognition segments into readable paragraphs (same speaker,
 * at most ~60 s or ~700 characters each).
 */
export function groupTranscript(segments: TranscriptSegment[]): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  for (const seg of [...segments].sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1];
    if (last && last.speaker === seg.speaker && seg.start - last.start < 60 && last.text.length + seg.text.length < 700) {
      last.text = `${last.text} ${seg.text}`;
      last.end = Math.max(last.end, seg.end);
    } else {
      out.push({ ...seg });
    }
  }
  return out;
}

function transcriptLine(s: TranscriptSegment): string {
  return `[${formatClock(s.start)}]${s.speaker ? ` ${s.speaker}:` : ''} ${s.text}`;
}

export function transcriptLines(segments: TranscriptSegment[]): string[] {
  return groupTranscript(segments).map(transcriptLine);
}

/**
 * Splits the transcript into chunks of at most `maxChars` characters without
 * cutting a paragraph; `start` is where each chunk begins, in seconds.
 */
export function chunkTranscript(segments: TranscriptSegment[], maxChars: number): { text: string; start: number }[] {
  const chunks: { text: string; start: number }[] = [];
  let current: { text: string; start: number } | undefined;
  for (const seg of groupTranscript(segments)) {
    const line = transcriptLine(seg);
    if (current && current.text.length + line.length + 1 > maxChars) {
      chunks.push(current);
      current = undefined;
    }
    current = current ? { ...current, text: `${current.text}\n${line}` } : { text: line, start: seg.start };
  }
  if (current) chunks.push(current);
  return chunks;
}

export const DEFAULT_LABELS: SummaryLabels = {
  minutes: 'Meeting Minutes',
  date: 'Date',
  duration: 'Duration',
  platform: 'Platform',
  spokenLanguages: 'Languages',
  participants: 'Participants',
  executiveSummary: 'Executive Summary',
  keyPoints: 'Key Points',
  topics: 'Discussion',
  decisions: 'Decisions',
  actionItems: 'Action Items',
  task: 'Task',
  owner: 'Owner',
  deadline: 'Deadline',
  priority: 'Priority',
  openQuestions: 'Open Questions',
  nextSteps: 'Next Steps',
  timeline: 'Timeline',
  transcript: 'Transcript',
};

export function labelsFor(summary: MeetingSummary): SummaryLabels {
  const out = { ...DEFAULT_LABELS };
  for (const [k, v] of Object.entries(summary.labels ?? {})) {
    if (typeof v === 'string' && v.trim() && k in out) out[k as keyof SummaryLabels] = v.trim();
  }
  return out;
}

const RTL_LANGS = new Set(['ar', 'arc', 'ckb', 'dv', 'fa', 'he', 'iw', 'ku', 'ps', 'sd', 'ug', 'ur', 'yi']);

export function isRtl(language: string): boolean {
  return RTL_LANGS.has(language.toLowerCase().split(/[-_]/)[0] ?? '');
}

export function platformName(p: Recording['platform']): string {
  return p === 'meet' ? 'Google Meet' : p === 'zoom' ? 'Zoom' : 'Web';
}

export function formatDate(ts: number, locale?: string): string {
  try {
    return new Date(ts).toLocaleString(locale || undefined, { dateStyle: 'full', timeStyle: 'short' });
  } catch {
    return new Date(ts).toLocaleString();
  }
}

/** File name of a screenshot saved next to the minutes, e.g. "images/slide-00-12-30.jpg". */
export function imageFileName(t: number): string {
  return `images/slide-${formatClock(t / 1000).replace(/:/g, '-')}.jpg`;
}

export function transcriptToText(rec: Recording): string {
  const header = [
    rec.title,
    `${platformName(rec.platform)} · ${formatDate(rec.startedAt)} · ${formatDuration(rec.durationMs)}`,
    '',
  ];
  return [...header, ...transcriptLines(rec.transcript ?? [])].join('\n') + '\n';
}

function bullets(items: string[]): string {
  return items.map((i) => `- ${i}`).join('\n');
}

function mdCell(s?: string): string {
  return (s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export function summaryToMarkdown(
  rec: Recording,
  s: MeetingSummary,
  includeTranscript: boolean,
  /** Relative path of a saved screenshot, by frame id. */
  imagePath?: (id: number) => string | undefined,
): string {
  const L = labelsFor(s);
  const out: string[] = [`# ${s.title || rec.title}`, ''];
  out.push(`**${L.date}:** ${formatDate(rec.startedAt, s.language)}  `);
  out.push(`**${L.duration}:** ${formatDuration(rec.durationMs)}  `);
  out.push(`**${L.platform}:** ${platformName(rec.platform)}  `);
  if (s.spokenLanguages.length) out.push(`**${L.spokenLanguages}:** ${s.spokenLanguages.join(', ')}  `);
  if (s.participants.length) {
    out.push(`**${L.participants}:** ${s.participants.map((p) => (p.role ? `${p.name} (${p.role})` : p.name)).join(', ')}`);
  }
  out.push('');
  if (s.executiveSummary) out.push(`## ${L.executiveSummary}`, '', s.executiveSummary, '');
  if (s.keyPoints.length) out.push(`## ${L.keyPoints}`, '', bullets(s.keyPoints), '');
  if (s.topics.length) {
    out.push(`## ${L.topics}`, '');
    for (const t of s.topics) {
      out.push(`### ${t.time ? `[${t.time}] ` : ''}${t.title}`, '');
      if (t.summary) out.push(t.summary, '');
      if (t.points.length) out.push(bullets(t.points), '');
      for (const img of t.images) {
        const path = imagePath?.(img.id);
        if (path) out.push(`![${img.caption.replace(/[[\]]/g, '')}](${encodeURI(path)})`, `*${img.caption}*`, '');
      }
    }
  }
  if (s.decisions.length) {
    out.push(
      `## ${L.decisions}`,
      '',
      bullets(s.decisions.map((d) => (d.context ? `${d.decision} — ${d.context}` : d.decision))),
      '',
    );
  }
  if (s.actionItems.length) {
    out.push(
      `## ${L.actionItems}`,
      '',
      `| # | ${L.task} | ${L.owner} | ${L.deadline} | ${L.priority} |`,
      '|---|---|---|---|---|',
    );
    s.actionItems.forEach((a, i) =>
      out.push(`| ${i + 1} | ${mdCell(a.task)} | ${mdCell(a.owner)} | ${mdCell(a.deadline)} | ${mdCell(a.priority)} |`),
    );
    out.push('');
  }
  if (s.openQuestions.length) out.push(`## ${L.openQuestions}`, '', bullets(s.openQuestions), '');
  if (s.nextSteps.length) out.push(`## ${L.nextSteps}`, '', bullets(s.nextSteps), '');
  if (s.timeline.length) out.push(`## ${L.timeline}`, '', bullets(s.timeline.map((t) => `**${t.time}** ${t.event}`)), '');
  if (includeTranscript && rec.transcript?.length) {
    out.push(`## ${L.transcript}`, '', ...transcriptLines(rec.transcript).map((l) => `${l}  `), '');
  }
  return out.join('\n');
}
