import type { MeetingSummary, TemplateId } from './types';

export const TEMPLATES: Record<TemplateId, { name: string; focus: string }> = {
  general: {
    name: 'Complete meeting minutes',
    focus:
      'Produce complete, formal meeting minutes: every topic discussed, the arguments and figures behind it, all decisions, and every commitment as an action item.',
  },
  standup: {
    name: 'Daily stand-up',
    focus:
      'This is a stand-up. For each person capture what they did, what they will do next and their blockers. Put each person as a topic, and every blocker that needs follow-up as an action item.',
  },
  lecture: {
    name: 'Lecture / class / webinar',
    focus:
      'This is a lecture, class or webinar. Focus on the concepts taught, definitions, explanations, examples, formulas and the Q&A. Topics should read like structured study notes. Assignments and deadlines go to action items.',
  },
  interview: {
    name: 'Client / user interview',
    focus:
      'This is an interview with a client or user. Capture their background, needs, goals, pain points, current tools, requirements and notable quotes (verbatim, in the original language). Follow-ups go to action items.',
  },
  sales: {
    name: 'Sales call',
    focus:
      "This is a sales call. Capture the prospect's company and role, needs, budget, timeline, decision makers, objections and how they were handled, pricing discussed, competitors mentioned and agreed next steps.",
  },
  brainstorm: {
    name: 'Brainstorm / workshop',
    focus:
      'This is a brainstorming session or workshop. List every idea proposed with who proposed it, pros and cons raised, how ideas were grouped or voted, and which ideas were selected.',
  },
};

const SCHEMA = `{
  "language": "BCP-47 code of the language you are writing in, e.g. \\"en\\", \\"id\\", \\"ja\\", \\"ar\\"",
  "labels": {
    "minutes": "", "date": "", "duration": "", "platform": "", "spokenLanguages": "", "participants": "",
    "executiveSummary": "", "keyPoints": "", "topics": "", "decisions": "", "actionItems": "",
    "task": "", "owner": "", "deadline": "", "priority": "", "openQuestions": "", "nextSteps": "",
    "timeline": "", "transcript": ""
  },
  "title": "short descriptive title of the meeting",
  "spokenLanguages": ["name of each language spoken in the meeting"],
  "participants": [{ "name": "", "role": "role or organisation if mentioned, else empty" }],
  "executiveSummary": "1-3 paragraphs: purpose, main outcomes, most important decisions",
  "keyPoints": ["the most important takeaways"],
  "topics": [{ "title": "", "time": "HH:MM:SS where the topic starts", "summary": "what was discussed and concluded", "points": ["details, figures, arguments"] }],
  "decisions": [{ "decision": "", "context": "reason or condition, if stated" }],
  "actionItems": [{ "task": "", "owner": "person responsible or empty", "deadline": "as stated or empty", "priority": "high / medium / low in the output language, or empty" }],
  "openQuestions": ["unresolved questions or issues"],
  "nextSteps": ["planned follow-ups, next meeting"],
  "timeline": [{ "time": "HH:MM:SS", "event": "short description" }]
}`;

const NOTES_SCHEMA = `{
  "spokenLanguages": ["name of each language spoken in this part"],
  "participants": [{ "name": "", "role": "" }],
  "summary": "dense summary of this part",
  "topics": [{ "title": "", "time": "HH:MM:SS", "summary": "", "points": [""] }],
  "decisions": [{ "decision": "", "context": "" }],
  "actionItems": [{ "task": "", "owner": "", "deadline": "", "priority": "" }],
  "openQuestions": [""],
  "timeline": [{ "time": "HH:MM:SS", "event": "" }]
}`;

function languageRule(outputLanguage: string, scope: 'meeting' | 'part'): string {
  if (outputLanguage.trim()) {
    return `Write every human-readable value (including "labels") in ${outputLanguage.trim()}, even if the meeting was held in other languages.`;
  }
  return scope === 'meeting'
    ? 'Write every human-readable value (including "labels") in the language that was spoken most in the meeting overall. If languages were mixed, still pick that single dominant language.'
    : 'Write the notes in the language that was spoken most in this part.';
}

const COMMON_RULES = `- Use ONLY information found in the transcript and the context given. Never invent names, numbers, dates or decisions; leave a field empty or an array empty when unknown.
- The transcript was produced by automatic speech recognition and may contain errors. Silently fix obvious recognition mistakes when the meaning is clear; keep names, numbers and technical terms exact.
- The meeting may switch between several languages. Understand all of them.
- Keep proper nouns, product names and direct quotes in their original form and script.
- Speaker labels such as "A" or "B" (if any) are only consistent within one transcription segment; identify people by name when the conversation makes it clear.
- Times use the [HH:MM:SS] markers from the transcript.
- Be complete and concrete: cover every topic, not only the main one; prefer specific details (figures, dates, owners) over generic statements.
- Reply with ONE JSON object only. No markdown, no code fences, no commentary.`;

export interface PromptContext {
  title: string;
  platform: string;
  date: string;
  duration: string;
  notes: string;
  template: TemplateId;
  outputLanguage: string;
  customInstructions: string;
}

function contextBlock(c: PromptContext): string {
  const lines = [
    `Meeting title (from the browser tab): ${c.title}`,
    `Platform: ${c.platform}`,
    `Date: ${c.date}`,
    `Duration: ${c.duration}`,
  ];
  if (c.notes.trim()) lines.push(`Context from the user (participants, agenda, spelling of names...):\n${c.notes.trim()}`);
  return lines.join('\n');
}

function extraInstructions(c: PromptContext): string {
  return c.customInstructions.trim()
    ? `\nAdditional instructions from the user (follow them):\n${c.customInstructions.trim()}\n`
    : '';
}

export function finalSystemPrompt(c: PromptContext): string {
  return `You are an expert meeting secretary. You turn automatic transcripts of online meetings (Google Meet / Zoom) into complete, accurate, well-structured minutes.

Focus: ${TEMPLATES[c.template].focus}

Rules:
${COMMON_RULES}
- ${languageRule(c.outputLanguage, 'meeting')}
- "labels" are the section headings of the document, translated into the output language.
${extraInstructions(c)}
JSON schema to follow exactly:
${SCHEMA}`;
}

export function finalUserPrompt(c: PromptContext, transcript: string): string {
  return `${contextBlock(c)}\n\nTranscript:\n${transcript}`;
}

export function partSystemPrompt(c: PromptContext, index: number, total: number): string {
  return `You are an expert meeting secretary processing part ${index} of ${total} of a long meeting transcript. Extract detailed notes from THIS PART ONLY; they will later be merged with the notes of the other parts into the final minutes.

Focus: ${TEMPLATES[c.template].focus}

Rules:
${COMMON_RULES}
- ${languageRule(c.outputLanguage, 'part')}
${extraInstructions(c)}
JSON schema to follow exactly:
${NOTES_SCHEMA}`;
}

export function partUserPrompt(c: PromptContext, transcriptPart: string): string {
  return `${contextBlock(c)}\n\nTranscript part:\n${transcriptPart}`;
}

export function mergeSystemPrompt(c: PromptContext): string {
  return `You are an expert meeting secretary. A long meeting was split into consecutive parts and detailed notes were extracted from each part (in order). Merge them into the final minutes of the whole meeting: remove duplicates, connect topics that continue across parts, keep every decision and action item, and write a single executive summary for the whole meeting.

Focus: ${TEMPLATES[c.template].focus}

Rules:
${COMMON_RULES}
- ${languageRule(c.outputLanguage, 'meeting')} Judge the dominant language from the notes and their "spokenLanguages".
- "labels" are the section headings of the document, translated into the output language.
${extraInstructions(c)}
JSON schema to follow exactly:
${SCHEMA}`;
}

export function mergeUserPrompt(c: PromptContext, partNotes: unknown[]): string {
  const parts = partNotes.map((n, i) => `### Part ${i + 1}\n${JSON.stringify(n)}`).join('\n\n');
  return `${contextBlock(c)}\n\nNotes of each part, in order:\n${parts}`;
}

// ---------------------------------------------------------------------------
// Normalisation: models do not always follow the schema exactly.

function str(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

function arr(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v === null || v === undefined || v === '') return [];
  return [v];
}

function strList(v: unknown): string[] {
  return arr(v)
    .map((x) => (typeof x === 'object' && x ? str(Object.values(x)[0]) : str(x)))
    .filter(Boolean);
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function normalizeSummary(raw: unknown, fallbackTitle: string): MeetingSummary {
  const r = obj(raw);
  const labels = obj(r.labels);
  return {
    language: str(r.language) || 'en',
    labels: Object.fromEntries(
      Object.entries(labels)
        .map(([k, v]) => [k, str(v)])
        .filter(([, v]) => v),
    ),
    title: str(r.title) || fallbackTitle,
    spokenLanguages: strList(r.spokenLanguages),
    participants: arr(r.participants)
      .map((p) => (typeof p === 'string' ? { name: p.trim() } : { name: str(obj(p).name), role: str(obj(p).role) || undefined }))
      .filter((p) => p.name),
    executiveSummary: str(r.executiveSummary),
    keyPoints: strList(r.keyPoints),
    topics: arr(r.topics)
      .map((t) => {
        const o = obj(t);
        return { title: str(o.title), time: str(o.time) || undefined, summary: str(o.summary), points: strList(o.points) };
      })
      .filter((t) => t.title || t.summary),
    decisions: arr(r.decisions)
      .map((d) =>
        typeof d === 'string'
          ? { decision: d.trim() }
          : { decision: str(obj(d).decision), context: str(obj(d).context) || undefined },
      )
      .filter((d) => d.decision),
    actionItems: arr(r.actionItems)
      .map((a) => {
        if (typeof a === 'string') return { task: a.trim() };
        const o = obj(a);
        return {
          task: str(o.task),
          owner: str(o.owner) || undefined,
          deadline: str(o.deadline) || undefined,
          priority: str(o.priority) || undefined,
        };
      })
      .filter((a) => a.task),
    openQuestions: strList(r.openQuestions),
    nextSteps: strList(r.nextSteps),
    timeline: arr(r.timeline)
      .map((t) => ({ time: str(obj(t).time), event: str(obj(t).event) }))
      .filter((t) => t.event),
  };
}
