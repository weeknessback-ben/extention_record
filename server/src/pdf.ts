import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Minutes, type MinutesImages } from '@/components/Minutes';
import uiCss from '@/components/ui.css?raw';
import reportCss from '@/entrypoints/report/report.css?raw';
import { escapeHtml, isRtl, pdfFooterTemplate } from '@/lib/format';
import type { MeetingSummary, Recording } from '@/lib/types';

/** The same document the report page shows, as a standalone HTML page. */
export function minutesHtml(rec: Recording, s: MeetingSummary, includeTranscript: boolean, images: MinutesImages): string {
  const body = renderToStaticMarkup(createElement(Minutes, { rec, s, includeTranscript, images }));
  const lang = escapeHtml(s.language || 'en');
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>${escapeHtml(s.title || rec.title)}</title>
<style>${uiCss}\n${reportCss}</style></head>
<body><div class="page"><article class="doc" lang="${lang}" dir="${isRtl(s.language) ? 'rtl' : 'ltr'}">${body}</article></div></body></html>`;
}

/** Prints HTML with headless Chromium, with the paper, margins and footer of the extension's PDF. */
export async function htmlToPdf(html: string, footerTitle: string, executablePath = ''): Promise<Uint8Array> {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: executablePath || undefined });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    return await page.pdf({
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate: pdfFooterTemplate(footerTitle),
      width: '8.27in',
      height: '11.69in',
      margin: { top: '0.6in', bottom: '0.75in', left: '0.6in', right: '0.6in' },
    });
  } finally {
    await browser.close();
  }
}
