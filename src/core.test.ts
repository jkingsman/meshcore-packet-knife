import { describe, it, expect } from 'vitest';
import { escapeHtml } from './utils';

// Note: Tests for meshcore-hashtag-cracker library functions are run in the library itself.
// This file only tests local utility functions.

describe('escapeHtml (local utils)', () => {
  it('should escape all dangerous characters', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;',
    );
    expect(escapeHtml("a'b")).toBe('a&#39;b');
    expect(escapeHtml('a&b')).toBe('a&amp;b');
  });

  it('should handle empty string', () => {
    expect(escapeHtml('')).toBe('');
  });

  it('should convert non-strings to strings', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(escapeHtml(123 as any)).toBe('123');
  });

  it('should not double-escape', () => {
    expect(escapeHtml('&amp;')).toBe('&amp;amp;');
  });

  it('should handle all special characters at once', () => {
    expect(escapeHtml('<div class="test" data-value=\'foo\'>a & b</div>')).toBe(
      '&lt;div class=&quot;test&quot; data-value=&#39;foo&#39;&gt;a &amp; b&lt;/div&gt;',
    );
  });
});
