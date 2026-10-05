/**
 * IANA TIME ZONES, VALIDATED BY THE PLATFORM'S OWN DATABASE.
 *
 * `Intl` throws on a zone it does not know, and that throw is the check. A
 * hard-coded list would rot the first time a country moved its clocks, and
 * nothing here needs a dependency to avoid that: Node ships the tz database.
 *
 * The same trick already guards a home banner's schedule
 * (`home-banner-service.validateTimezone`). This is the shared, error-free form
 * of it, so a second caller does not have to throw a banner's error to ask a
 * simple question.
 */

/** Whether a string is a time zone this runtime recognises. */
export function isValidTimezone(zone: string): boolean {
  const trimmed = zone.trim();
  if (trimmed.length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: trimmed });
    return true;
  } catch {
    return false;
  }
}

/**
 * The wall-clock date and time in a zone, as a person there would say it:
 * "Sunday, 5 October 2026 at 21:40".
 *
 * COMPUTED, NEVER STORED. A stored local time is wrong a second later, wrong
 * again every spring, and wrong for anybody reading it from somewhere else.
 * The only durable fact is the zone; the clock is derived from it on the spot.
 *
 * Null for a zone this runtime does not know, so a bad value shows nothing
 * rather than silently falling back to the server's own clock -- which would
 * tell her she is in a time zone she is not in.
 */
export function localTimeIn(zone: string, now: Date = new Date()): string | null {
  if (!isValidTimezone(zone)) return null;
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: zone.trim(),
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(now);
  } catch {
    return null;
  }
}
