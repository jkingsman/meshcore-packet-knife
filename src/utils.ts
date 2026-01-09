/**
 * Escape HTML special characters to prevent XSS.
 */
export function escapeHtml(str: string): string {
  return String(str).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] || c,
  );
}

/**
 * Format seconds into a human-readable time string.
 * Returns formats like "45s", "3m 20s", "2h 15m"
 */
export function formatTime(seconds: number): string {
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }
  if (seconds < 3600) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.round(seconds % 60);
    return `${mins}m ${secs}s`;
  }
  const hours = Math.floor(seconds / 3600);
  const mins = Math.round((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}

/**
 * Format seconds into a compact time string (HH:MM:SS or MM:SS format).
 * Used for inline display where space is limited.
 */
export function formatTimeCompact(seconds: number): string {
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}:${m.toString().padStart(2, '0')}:${Math.round(seconds % 60)
    .toString()
    .padStart(2, '0')}`;
}

/**
 * Format a rate (keys per second) into a human-readable string.
 * Returns formats like "500 keys/s", "1.5 kkeys/s", "2.30 Mkeys/s", "1.50 Gkeys/s"
 */
export function formatRate(rate: number): string {
  if (rate >= 1000000000) {
    return `${(rate / 1000000000).toFixed(2)} Gkeys/s`;
  }
  if (rate >= 1000000) {
    return `${(rate / 1000000).toFixed(2)} Mkeys/s`;
  }
  if (rate >= 1000) {
    return `${(rate / 1000).toFixed(1)} kkeys/s`;
  }
  return `${rate} keys/s`;
}
