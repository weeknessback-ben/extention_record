import { describe, expect, it } from 'vitest';
import { endpointUrl, parseExtraHeaders, parseJsonLoose, transcriptionFormat } from '@/lib/ai';
import { recordingFolder, sanitizeFolder, sanitizeSegment } from '@/lib/files';
import { chunkLines, formatClock, groupTranscript, isRtl, summaryToMarkdown } from '@/lib/format';
import { cleanTabTitle, detectPlatform, siteOf } from '@/lib/meeting';
import { finalSystemPrompt, normalizeSummary } from '@/lib/prompts';
import { DEFAULT_SETTINGS, isAiConfigured, mergeSettings, summaryEndpoint } from '@/lib/settings';
import type { Recording } from '@/lib/types';

describe('files', () => {
  it('sanitizes names but keeps non-Latin scripts', () => {
    expect(sanitizeSegment('Rapat: Q3/Q4 "final"?')).toBe('Rapat_ Q3_Q4 _final__');
    expect(sanitizeSegment('会議 – 東京')).toBe('会議 – 東京');
    expect(sanitizeSegment('  ..hidden. ')).toBe('hidden');
    expect(sanitizeSegment('CON')).toBe('_CON');
    expect(sanitizeSegment('')).toBe('untitled');
  });

  it('sanitizes folders and blocks traversal', () => {
    expect(sanitizeFolder('../Work\\Meetings/./x')).toBe('Work/Meetings/x');
    expect(sanitizeFolder('')).toBe('MeetingRecorder');
  });

  it('builds a dated folder per recording', () => {
    const ts = new Date(2026, 9, 20, 9, 5).getTime();
    expect(recordingFolder('MeetingRecorder', ts, 'Weekly sync')).toBe('MeetingRecorder/2026-10-20 09.05 - Weekly sync');
  });
});

describe('ai helpers', () => {
  it('joins base URLs and paths', () => {
    expect(endpointUrl('https://api.openai.com/v1/', '/chat/completions')).toBe('https://api.openai.com/v1/chat/completions');
    expect(endpointUrl('http://localhost:8080/v1?api-version=1', '/audio/transcriptions')).toBe(
      'http://localhost:8080/v1/audio/transcriptions?api-version=1',
    );
  });

  it('parses JSON from messy replies', () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonLoose('Here:\n```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(parseJsonLoose('Sure! {"a":3} hope it helps')).toEqual({ a: 3 });
    expect(() => parseJsonLoose('nope')).toThrow();
  });

  it('validates extra headers', () => {
    expect(parseExtraHeaders('')).toEqual({});
    expect(parseExtraHeaders('{"api-key": 12}')).toEqual({ 'api-key': '12' });
    expect(() => parseExtraHeaders('[1]')).toThrow();
  });

  it('chooses response formats per model', () => {
    expect(transcriptionFormat('whisper-1')).toBe('verbose_json');
    expect(transcriptionFormat('gpt-4o-transcribe')).toBe('json');
    expect(transcriptionFormat('gpt-4o-transcribe-diarize')).toBe('diarized_json');
  });
});

describe('format', () => {
  it('formats clocks', () => {
    expect(formatClock(3725.9)).toBe('01:02:05');
  });

  it('groups transcript segments into paragraphs', () => {
    const grouped = groupTranscript([
      { start: 0, end: 5, text: 'Halo semua.' },
      { start: 5, end: 9, text: 'Let us start.' },
      { start: 70, end: 75, text: 'Next topic.' },
    ]);
    expect(grouped).toHaveLength(2);
    expect(grouped[0]!.text).toBe('Halo semua. Let us start.');
  });

  it('chunks lines without splitting them', () => {
    expect(chunkLines(['aaaa', 'bbbb', 'cccc'], 9)).toEqual(['aaaa\nbbbb', 'cccc']);
  });

  it('detects right-to-left languages', () => {
    expect(isRtl('ar')).toBe(true);
    expect(isRtl('fa-IR')).toBe(true);
    expect(isRtl('id')).toBe(false);
  });
});

describe('meeting', () => {
  it('detects platforms and cleans titles', () => {
    expect(detectPlatform('https://meet.google.com/abc-defg-hij')).toBe('meet');
    expect(detectPlatform('https://app.zoom.us/wc/123/join')).toBe('zoom');
    expect(detectPlatform('https://example.com')).toBe('other');
    expect(cleanTabTitle('Meet - Weekly sync', 'https://meet.google.com/abc-defg-hij')).toBe('Weekly sync');
    expect(cleanTabTitle('Meet', 'https://meet.google.com/abc-defg-hij')).toBe('Google Meet abc-defg-hij');
    expect(cleanTabTitle('Zoom', 'https://app.zoom.us/wc/1/join')).toBe('Zoom meeting');
    expect(siteOf('https://app.zoom.us/wc/1')).toBe(siteOf('https://zoom.us/j/1'));
    expect(siteOf('https://meet.google.com/x')).not.toBe(siteOf('https://example.com'));
  });
});

describe('settings', () => {
  it('merges nested defaults', () => {
    const s = mergeSettings({ transcription: { apiKey: 'k' } as never });
    expect(s.transcription.apiKey).toBe('k');
    expect(s.transcription.model).toBe(DEFAULT_SETTINGS.transcription.model);
    expect(s.summary.model).toBe(DEFAULT_SETTINGS.summary.model);
  });

  it('reuses the transcription credentials for summaries', () => {
    const s = mergeSettings({ transcription: { ...DEFAULT_SETTINGS.transcription, apiKey: 'k' } });
    expect(summaryEndpoint(s).apiKey).toBe('k');
    expect(isAiConfigured(s)).toBe(true);
    expect(isAiConfigured(DEFAULT_SETTINGS)).toBe(false);
    const local = mergeSettings({ transcription: { ...DEFAULT_SETTINGS.transcription, baseUrl: 'http://localhost:8000/v1' } });
    expect(isAiConfigured(local)).toBe(true);
  });
});

describe('prompts', () => {
  it('asks for the configured output language', () => {
    const ctx = {
      title: 't',
      platform: 'Zoom',
      date: 'd',
      duration: '1m',
      notes: '',
      template: 'general' as const,
      outputLanguage: '日本語',
      customInstructions: '',
    };
    expect(finalSystemPrompt(ctx)).toContain('in 日本語');
    expect(finalSystemPrompt({ ...ctx, outputLanguage: '' })).toContain('spoken most in the meeting');
  });

  it('normalizes sloppy model output', () => {
    const s = normalizeSummary(
      {
        title: 'Rapat',
        participants: ['Budi', { name: 'Ana', role: 'PM' }, { role: 'nobody' }],
        keyPoints: 'single string',
        actionItems: [{ task: 'Kirim laporan', owner: 'Budi', deadline: 'Jumat' }, 'Follow up'],
        decisions: [{ decision: '' }],
        labels: { minutes: 'Notulen Rapat', bogus: 1 },
      },
      'fallback',
    );
    expect(s.participants).toEqual([{ name: 'Budi' }, { name: 'Ana', role: 'PM' }]);
    expect(s.keyPoints).toEqual(['single string']);
    expect(s.actionItems).toHaveLength(2);
    expect(s.decisions).toHaveLength(0);
    expect(s.labels.minutes).toBe('Notulen Rapat');
    expect(normalizeSummary(null, 'fallback').title).toBe('fallback');
  });

  it('renders markdown with localized labels', () => {
    const rec = {
      id: '1',
      title: 'Weekly',
      platform: 'meet',
      startedAt: 0,
      durationMs: 60_000,
      transcript: [{ start: 1, end: 2, text: 'Halo' }],
    } as unknown as Recording;
    const s = normalizeSummary(
      { title: 'Rapat Mingguan', labels: { actionItems: 'Tindak Lanjut', task: 'Tugas' }, actionItems: [{ task: 'A | B' }] },
      'x',
    );
    const md = summaryToMarkdown(rec, s, true);
    expect(md).toContain('# Rapat Mingguan');
    expect(md).toContain('## Tindak Lanjut');
    expect(md).toContain('| 1 | A \\| B |');
    expect(md).toContain('[00:00:01] Halo');
  });
});
