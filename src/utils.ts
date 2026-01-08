/**
 * Escape HTML special characters to prevent XSS.
 */
export function escapeHtml(str: string): string {
  return String(str).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] || c,
  );
}
