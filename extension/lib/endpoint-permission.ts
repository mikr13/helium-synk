import { browser } from 'wxt/browser';
export async function grantEndpoint(endpoint: string): Promise<void> {
  const hostname = new URL(endpoint).hostname;
  if (hostname === 'localhost' || hostname === '127.0.0.1') return;
  if (!hostname.endsWith('.ts.net'))
    throw new Error('This build supports localhost and Tailscale HTTPS endpoints.');
  if (!(await browser.permissions.request({ origins: [`${endpoint}/*`] })))
    throw new Error('Server access permission was not granted.');
}
