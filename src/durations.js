const DURATION_UNITS = Object.freeze({
  ms: 1,
  s: 1000,
  sec: 1000,
  secs: 1000,
  second: 1000,
  seconds: 1000,
  m: 60 * 1000,
  min: 60 * 1000,
  mins: 60 * 1000,
  minute: 60 * 1000,
  minutes: 60 * 1000,
  h: 60 * 60 * 1000,
  hr: 60 * 60 * 1000,
  hrs: 60 * 60 * 1000,
  hour: 60 * 60 * 1000,
  hours: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  days: 24 * 60 * 60 * 1000
});

export function parseDurationMs(value, {
  name = 'duration',
  defaultMs = null,
  minMs = 1,
  maxMs = 30 * 24 * 60 * 60 * 1000,
  allowZero = false
} = {}) {
  if (value === undefined || value === null || value === '') {
    return defaultMs;
  }
  const text = String(value).trim().toLowerCase();
  const match = /^(\d+)(?:\s*([a-z]+))?$/.exec(text);
  if (!match) {
    throw new Error(`${name} must be an integer duration such as 30000, 30s, 15m, 2h, or 1d.`);
  }
  const amount = Number.parseInt(match[1], 10);
  const unit = match[2] ?? 'ms';
  const multiplier = DURATION_UNITS[unit];
  if (!Number.isInteger(amount) || multiplier === undefined) {
    throw new Error(`${name} must use a supported duration unit: ms, s, m, h, or d.`);
  }
  const ms = amount * multiplier;
  const effectiveMin = allowZero ? 0 : minMs;
  if (!Number.isSafeInteger(ms) || ms < effectiveMin || ms > maxMs) {
    throw new Error(`${name} must be between ${effectiveMin} and ${maxMs} milliseconds.`);
  }
  return ms;
}
