import type ICAL from 'ical.js';
import { parseIcs } from './parse';

/**
 * A subscription is an ordinary .ics file in the Drive folder that carries where it comes from
 * and when it was last downloaded, as X- properties on the VCALENDAR:
 *
 *   X-OWNAGENDA-SOURCE-URL:https://…/calendar.ics
 *   X-OWNAGENDA-LAST-UPDATE:2025-03-01T08:00:00.000Z
 *
 * Its events are a copy of the online calendar, so they are read-only in the app.
 */
export const SOURCE_URL_PROP = 'x-ownagenda-source-url';
export const LAST_UPDATE_PROP = 'x-ownagenda-last-update';

/** Re-download a subscription when its copy is older than this. */
export const SUBSCRIPTION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface SubscriptionInfo {
  url: string;
  /** Null if never recorded (or unreadable): treated as stale. */
  lastUpdate: Date | null;
}

export function subscriptionInfo(vcalendar: ICAL.Component): SubscriptionInfo | null {
  const url = vcalendar.getFirstPropertyValue(SOURCE_URL_PROP);
  if (typeof url !== 'string' || !url) return null;
  const raw = vcalendar.getFirstPropertyValue(LAST_UPDATE_PROP);
  const ms = typeof raw === 'string' ? Date.parse(raw) : NaN;
  return { url, lastUpdate: Number.isNaN(ms) ? null : new Date(ms) };
}

export function isStale(info: SubscriptionInfo, now = new Date()): boolean {
  return !info.lastUpdate || now.getTime() - info.lastUpdate.getTime() > SUBSCRIPTION_MAX_AGE_MS;
}

/**
 * Validates a subscription URL. webcal:// (common for calendar links) is turned into https://.
 * Throws with a readable message if it isn't an http(s) URL.
 */
export function normalizeSubscriptionUrl(input: string): string {
  const trimmed = input.trim().replace(/^webcals?:\/\//i, 'https://');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error('Please enter a valid calendar link (https://…).');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('The calendar link must start with https:// (or webcal://).');
  }
  return url.toString();
}

/**
 * Builds the subscription calendar from the downloaded .ics text: the online calendar's events
 * and timezones, our name, the source URL and the download time.
 */
export function buildSubscriptionCalendar(
  remoteText: string,
  url: string,
  name: string,
  now = new Date(),
): ICAL.Component {
  const vcalendar = parseIcs(remoteText);
  vcalendar.updatePropertyWithValue('x-wr-calname', name);
  vcalendar.updatePropertyWithValue(SOURCE_URL_PROP, url);
  vcalendar.updatePropertyWithValue(LAST_UPDATE_PROP, now.toISOString());
  return vcalendar;
}
