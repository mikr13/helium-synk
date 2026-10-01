import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  alias: { '@': fileURLToPath(new URL('.', import.meta.url)) },
  vite: () => ({ plugins: [tailwindcss()] }),
  manifest: {
    name: 'Helium Synk',
    description:
      'Private encrypted browser sync with durable offline bookmarks, sessions and history.',
    minimum_chrome_version: '134',
    icons: {
      16: 'icons/16.png',
      32: 'icons/32.png',
      48: 'icons/48.png',
      128: 'icons/128.png',
    },
    action: {
      default_title: 'Open Helium Synk',
      default_icon: { 16: 'icons/16.png', 32: 'icons/32.png' },
    },
    permissions: [
      'storage',
      'unlimitedStorage',
      'alarms',
      'bookmarks',
      'tabs',
      'tabGroups',
      'sessions',
      'history',
    ],
    host_permissions: ['http://localhost/*', 'http://127.0.0.1/*'],
    optional_host_permissions: ['https://*.ts.net/*'],
    incognito: 'not_allowed',
  },
});
