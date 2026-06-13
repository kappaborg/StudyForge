/**
 * Human-friendly "N units ago" for a millisecond epoch. Shared between
 * the offline-state banners on review and roadmap surfaces so the copy
 * stays consistent.
 */
export function formatCacheAge(cachedAt: number): string {
  const elapsedMin = Math.max(0, Math.round((Date.now() - cachedAt) / 60_000));
  if (elapsedMin < 1) return 'a moment';
  if (elapsedMin < 60) return `${elapsedMin} min`;
  const hours = Math.round(elapsedMin / 60);
  if (hours < 24) return `${hours} hr`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}
