/**
 * Shared formatters for document rows. Every list of materials in the app
 * (dashboard recent strip, ``/upload`` browser, folder view, course
 * materials tab) renders the same file-type pill + relative-time pair so
 * students get consistent affordances across surfaces.
 */

export function friendlyExt(filename: string, mime: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot >= 0 && dot < filename.length - 1) {
    return filename.slice(dot + 1).toLowerCase().slice(0, 4);
  }
  if (mime.startsWith('audio/')) return 'aud';
  if (mime.startsWith('image/')) return 'img';
  if (mime.includes('pdf')) return 'pdf';
  return 'doc';
}

/**
 * Friendly upcoming-deadline label. Pre-deadline says "tomorrow" / "in 5
 * days"; on or just past the day shows "today" / "yesterday" / "N days
 * ago"; falls back to a locale date for anything further out. Strips
 * time-of-day so a deadline doesn't tick to "yesterday" at 12:01 AM
 * while a student is still pulling an all-nighter.
 */
export function relativeDayLabel(iso: string, today: Date = new Date()): string {
  const target = new Date(iso);
  const targetDay = new Date(target.getFullYear(), target.getMonth(), target.getDate());
  const todayDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const days = Math.round(
    (targetDay.getTime() - todayDay.getTime()) / (24 * 60 * 60 * 1000),
  );
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days > 1 && days <= 30) return `in ${days} days`;
  if (days === -1) return 'yesterday';
  if (days < -1 && days >= -7) return `${-days} days ago`;
  return target.toLocaleDateString();
}

export function relativeTime(iso: string, now: Date = new Date()): string {
  const t = new Date(iso).getTime();
  const seconds = Math.max(0, Math.floor((now.getTime() - t) / 1000));
  if (seconds < 60) return 'just now';
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w ago`;
  return new Date(iso).toLocaleDateString();
}
