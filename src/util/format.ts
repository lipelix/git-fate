const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
];

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** "3 days ago", "last year", "now". */
export function fromNow(time: number, now: number = Date.now()): string {
  const seconds = Math.round((time - now) / 1000);
  const abs = Math.abs(seconds);
  for (const [unit, size] of UNITS) {
    if (abs >= size) {
      return relative.format(Math.trunc(seconds / size), unit);
    }
  }
  return 'just now';
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** "2026-11-24 09:15" in local time. */
export function absoluteDate(time: number): string {
  const d = new Date(time);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Replaces `${token}` placeholders; unknown tokens stay as they are. */
export function interpolate(template: string, values: Record<string, string>): string {
  return template.replace(/\$\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match,
  );
}

/** Cuts text to `max` characters, ending with an ellipsis when shortened. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/**
 * Heat of a change between 0 (oldest in the file) and 1 (newest), on a log scale of
 * age so that recent changes stay distinguishable in files with a long history.
 */
export function heat(time: number, oldest: number, newest: number): number {
  if (newest <= oldest) {
    return 1;
  }
  const age = Math.max(0, newest - time);
  const span = newest - oldest;
  return 1 - Math.log1p(age / 3_600_000) / Math.log1p(span / 3_600_000);
}

/** Color for a heat value: warm orange for new changes, cool blue for old ones. */
export function heatColor(value: number): string {
  const v = Math.min(1, Math.max(0, value));
  const cold = [70, 130, 220];
  const hot = [245, 130, 40];
  const rgb = cold.map((c, i) => Math.round(c + (hot[i] - c) * v));
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${(0.6 + 0.4 * v).toFixed(2)})`;
}
