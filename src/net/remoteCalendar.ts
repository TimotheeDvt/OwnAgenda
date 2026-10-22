/**
 * Downloads an online calendar (.ics) from the browser.
 *
 * There is no backend, so the calendar server must allow cross-origin requests (CORS). Many
 * don't; for those, a CORS proxy can be configured in the options: a URL template where
 * "{url}" is replaced by the encoded calendar link, e.g. "https://my-proxy.example/?url={url}".
 */
export class RemoteCalendarError extends Error {
  override name = 'RemoteCalendarError';
}

export function applyProxy(url: string, proxyTemplate: string): string {
  const template = proxyTemplate.trim();
  if (!template) return url;
  return template.includes('{url}')
    ? template.replace('{url}', encodeURIComponent(url))
    : `${template}${encodeURIComponent(url)}`;
}

export async function fetchRemoteCalendar(url: string, proxyTemplate = ''): Promise<string> {
  let res: Response;
  try {
    res = await fetch(applyProxy(url, proxyTemplate), {
      cache: 'no-store',
      credentials: 'omit',
      headers: { Accept: 'text/calendar, text/plain, */*' },
    });
  } catch {
    // fetch() only rejects on network errors, which includes CORS refusals.
    throw new RemoteCalendarError(
      proxyTemplate
        ? 'Could not reach the calendar through the CORS proxy. Check the proxy and the link.'
        : 'Could not download the calendar. The server may not allow downloads from a web ' +
            'page (CORS): set a CORS proxy in Options and try again.',
    );
  }
  if (!res.ok) {
    throw new RemoteCalendarError(
      `The calendar server answered ${res.status}${res.statusText ? ` ${res.statusText}` : ''}.`,
    );
  }
  const text = await res.text();
  if (!/^\s*BEGIN:VCALENDAR/i.test(text)) {
    throw new RemoteCalendarError('The link did not return an iCalendar (.ics) file.');
  }
  return text;
}
