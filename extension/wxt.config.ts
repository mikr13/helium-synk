import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Helium Synk',
    description:
      'Private encrypted browser sync with durable offline bookmarks, sessions and history.',
    minimum_chrome_version: '134',
    action: { default_title: 'Open Helium Synk' },
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
