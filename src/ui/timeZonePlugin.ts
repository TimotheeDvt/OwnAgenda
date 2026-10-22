import { createPlugin } from '@fullcalendar/core';
import { NamedTimeZoneImpl } from '@fullcalendar/core/internal';
import { epochToZonedArray, zonedArrayToEpoch, zoneOffsetMinutes } from '../util/timeZone';

/**
 * Lets FullCalendar display named IANA time zones (settings.timeZone) using Intl, so we don't
 * need Luxon or Moment just for this.
 */
class IntlNamedTimeZone extends NamedTimeZoneImpl {
  offsetForArray(a: number[]): number {
    return zoneOffsetMinutes(zonedArrayToEpoch(a, this.timeZoneName), this.timeZoneName);
  }

  timestampToArray(ms: number): number[] {
    return epochToZonedArray(ms, this.timeZoneName);
  }
}

export default createPlugin({
  name: 'intl-named-time-zone',
  namedTimeZonedImpl: IntlNamedTimeZone,
});
