/** Normalize URL or hostname:port:login:password without exposing credentials. */
export function proxyUrl(value: unknown): string {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || value.length > 2048) throw Error('Invalid proxy settings.');
  const input = value.trim();
  if (!input) return '';
  const tuple = /^(?:(https?):\/\/)?(\[[^\]]+\]|[^:\/\s]+):(\d+):([^:]*):(.*)$/.exec(input);
  let url: URL;
  try {
    if (tuple) {
      url = new URL(`${tuple[1] || 'http'}://${tuple[2]}:${tuple[3]}`);
      url.username = tuple[4];
      url.password = tuple[5];
    } else url = new URL(/^[a-z]+:\/\//i.test(input) ? input : 'http://' + input);
  } catch { throw Error('Use hostname:port:login:password or an HTTP/HTTPS proxy URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.hash || url.search || url.pathname !== '/') throw Error('Use an HTTP/HTTPS proxy without a path or query.');
  if (tuple && (!Number(tuple[3]) || Number(tuple[3]) > 65535)) throw Error('Proxy port must be 1–65535.');
  if (url.port === '0') throw Error('Proxy port must be 1–65535.');
  return url.toString();
}
