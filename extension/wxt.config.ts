import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Helium Synk',
    description: 'Private browser sync. This foundation build transfers encrypted test notes only.',
    minimum_chrome_version: '120',
    action: { default_title: 'Open Helium Synk' },
    permissions: ['storage', 'unlimitedStorage', 'alarms'],
    host_permissions: ['http://localhost/*', 'http://127.0.0.1/*'],
    optional_host_permissions: ['https://*.ts.net/*'],
    // Browser-content permissions arrive with their respective adapter milestones.
  },
});
