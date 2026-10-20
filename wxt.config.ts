import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: ({ mode }) => ({
    name: 'Meeting Recorder & AI Minutes',
    description:
      'Record Google Meet / Zoom Web meetings (video + audio) and turn them into AI-generated PDF minutes with any OpenAI-compatible API.',
    permissions: [
      'tabCapture',
      'offscreen',
      'activeTab',
      'tabs',
      'storage',
      'unlimitedStorage',
      'downloads',
      'notifications',
      'debugger',
    ],
    // tabCapture.getMediaStreamId from a service worker needs Chrome 116+.
    minimum_chrome_version: '116',
    // The e2e build talks to a local mock API without a permission prompt.
    host_permissions: ['https://api.openai.com/*', ...(mode === 'e2e' ? ['http://127.0.0.1/*'] : [])],
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    action: { default_title: 'Meeting Recorder' },
    commands: {
      'toggle-recording': {
        suggested_key: { default: 'Alt+Shift+R' },
        description: 'Start / stop recording the current tab',
      },
    },
  }),
});
