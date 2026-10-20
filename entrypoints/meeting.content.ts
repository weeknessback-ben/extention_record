import { browser } from 'wxt/browser';
import type { ContentMessage } from '@/lib/messages';

// Shows a "● REC" pill inside the meeting page while it is being recorded, so
// it is obvious (also on screen shares) that the meeting is recorded.
export default defineContentScript({
  matches: ['https://meet.google.com/*', 'https://*.zoom.us/*'],
  runAt: 'document_idle',
  main() {
    let host: HTMLElement | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;

    const format = (ms: number) => {
      const s = Math.floor(ms / 1000);
      return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, '0')).join(':');
    };

    function show(startedAt: number) {
      hide();
      host = document.createElement('div');
      host.dataset.meetingRecorder = 'indicator';
      const shadow = host.attachShadow({ mode: 'closed' });
      shadow.innerHTML = `
        <style>
          .pill { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); z-index: 2147483647;
            display: flex; align-items: center; gap: 8px; padding: 6px 8px 6px 12px; border-radius: 999px;
            background: rgba(32, 33, 36, .92); color: #fff; font: 600 12px/1.2 system-ui, sans-serif;
            box-shadow: 0 2px 8px rgba(0,0,0,.35); user-select: none; }
          .dot { width: 10px; height: 10px; border-radius: 50%; background: #ea4335; animation: blink 1.2s infinite; }
          @keyframes blink { 50% { opacity: .35; } }
          button { border: 0; border-radius: 999px; padding: 4px 10px; background: #ea4335; color: #fff;
            font: inherit; cursor: pointer; }
          button:hover { background: #c5221f; }
        </style>
        <div class="pill" role="status"><span class="dot"></span><span>REC <span class="time">00:00:00</span></span>
          <button type="button" title="Stop recording">■</button></div>`;
      const time = shadow.querySelector('.time')!;
      shadow.querySelector('button')!.addEventListener('click', () => {
        browser.runtime.sendMessage({ type: 'stop' }).catch(() => {});
      });
      const tick = () => (time.textContent = format(Date.now() - startedAt));
      tick();
      timer = setInterval(tick, 1000);
      document.documentElement.append(host);
    }

    function hide() {
      clearInterval(timer);
      host?.remove();
      host = undefined;
    }

    browser.runtime.onMessage.addListener((message: unknown) => {
      const msg = message as ContentMessage;
      if (msg?.type !== 'rec-indicator') return;
      if (msg.recording && msg.startedAt) show(msg.startedAt);
      else hide();
    });

    // Restore the indicator after a page reload during a recording.
    browser.runtime
      .sendMessage({ type: 'indicator-query' })
      .then((res: ContentMessage | undefined) => {
        if (res?.recording && res.startedAt) show(res.startedAt);
      })
      .catch(() => {});
  },
});
