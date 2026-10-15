import {AsyncLocalStorage} from 'node:async_hooks';
import {proxyUrl} from './proxy-config.ts';
type Factory = (proxy: string) => typeof fetch;
let desktopFactory: Factory | undefined;
const requests = new AsyncLocalStorage<typeof fetch>();
/** Installed only by the bundled desktop backend, never by renderer content. */
export function installDesktopFetch(factory: Factory) { desktopFactory = factory; }
export function configuredFetch(proxy: unknown = ''): typeof fetch {
  const normalized = proxyUrl(proxy);
  if (desktopFactory) return desktopFactory(normalized);
  if (normalized) throw Error('HTTP/HTTPS proxy transport requires the Windows desktop app.');
  return fetch;
}
export function currentFetch(): typeof fetch { return requests.getStore() || configuredFetch(); }
export function withConfiguredFetch<T>(proxy: unknown, run: () => T): T {
  return requests.run(configuredFetch(proxy), run);
}
