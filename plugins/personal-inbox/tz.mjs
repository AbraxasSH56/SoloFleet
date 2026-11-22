// Time-zone helpers: every "today", business date and local clock time is computed in the
// configured IANA zone (config "timezone", default UTC). No fixed offsets anywhere.
import { crew } from './crew-config.mjs';

export const tzName = () => crew.timezone || 'UTC';

function parts(ms, tz = tzName()) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return Object.fromEntries(f.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
}

/** Offset (ms) of the zone from UTC at the given instant. */
export function offsetMs(ms, tz = tzName()) {
  const p = parts(ms, tz);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** "YYYY-MM-DD" in the configured zone. */
export function localDate(ms, tz = tzName()) {
  const p = parts(ms, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

/** "YYYY-MM-DD HH:MM:SS" in the configured zone. */
export function localDateTime(ms, tz = tzName()) {
  const p = parts(ms, tz);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

/** "+HH:MM" suffix at the given instant (UTC gives "+00:00"). */
export function offsetSuffix(ms, tz = tzName()) {
  const o = Math.round(offsetMs(ms, tz) / 60000);
  const sign = o < 0 ? '-' : '+';
  const a = Math.abs(o);
  return `${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

/** ISO-8601 string with the zone's offset, e.g. 2026-11-22T09:30:00+05:30. */
export function localIso(ms, tz = tzName()) {
  return `${localDateTime(ms, tz).replace(' ', 'T')}${offsetSuffix(ms, tz)}`;
}

/** Epoch ms of a local wall-clock time ("YYYY-MM-DD", hour, minute) in the configured zone. */
export function localToMs(dateStr, hour = 0, minute = 0, second = 0, tz = tzName()) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, hour, minute, second);
  let ms = guess - offsetMs(guess, tz);
  ms = guess - offsetMs(ms, tz); // second pass handles zones whose offset changes near the guess
  return ms;
}

/** Same wall-clock time as an ISO string with the right offset: "2026-11-22T18:05:00+05:30". */
export function localIsoAt(dateStr, hour, minute = 0, second = 0, tz = tzName()) {
  return localIso(localToMs(dateStr, hour, minute, second, tz), tz);
}

/** Start of the given local date as epoch ms. */
export const localDayStart = (dateStr, tz = tzName()) => localToMs(dateStr, 0, 0, 0, tz);
