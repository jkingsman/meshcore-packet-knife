import { describe, it, expect, beforeEach, vi } from 'vitest';
import { escapeHtml, formatTime, formatTimeCompact, formatRate } from './utils';
import { getStatusDisplay, truncatePacketHex, renderQueueItemRow } from './render-utils';

// Tests for local utility functions and shared modules only.
// External library tests (meshcore-hashtag-cracker, meshcore-decoder) are in their own repos.

// Mock external libraries to avoid import resolution issues in test environment
vi.mock('meshcore-hashtag-cracker', () => ({
  getChannelHash: vi.fn((key: string) => key.substring(0, 16)),
  verifyMac: vi.fn(() => true),
  PUBLIC_ROOM_NAME: '[[public room]]',
  PUBLIC_KEY: 'public-key-mock',
}));

vi.mock('@michaelhart/meshcore-decoder', () => ({
  ChannelCrypto: {
    decryptGroupTextMessage: vi.fn(() => ({
      success: true,
      data: { sender: 'TestSender', message: 'Test message' },
    })),
  },
}));

describe('utils.ts', () => {
  describe('escapeHtml', () => {
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

  describe('formatTime', () => {
    it('should format seconds under a minute', () => {
      expect(formatTime(0)).toBe('0s');
      expect(formatTime(1)).toBe('1s');
      expect(formatTime(30)).toBe('30s');
      expect(formatTime(59)).toBe('59s');
    });

    it('should round seconds', () => {
      expect(formatTime(30.4)).toBe('30s');
      expect(formatTime(30.6)).toBe('31s');
    });

    it('should format minutes and seconds', () => {
      expect(formatTime(60)).toBe('1m 0s');
      expect(formatTime(90)).toBe('1m 30s');
      expect(formatTime(125)).toBe('2m 5s');
      expect(formatTime(3599)).toBe('59m 59s');
    });

    it('should format hours and minutes', () => {
      expect(formatTime(3600)).toBe('1h 0m');
      expect(formatTime(3660)).toBe('1h 1m');
      expect(formatTime(7200)).toBe('2h 0m');
      expect(formatTime(7320)).toBe('2h 2m');
      expect(formatTime(86400)).toBe('24h 0m');
    });
  });

  describe('formatTimeCompact', () => {
    it('should format seconds under a minute with suffix', () => {
      expect(formatTimeCompact(0)).toBe('0s');
      expect(formatTimeCompact(1)).toBe('1s');
      expect(formatTimeCompact(59)).toBe('59s');
    });

    it('should format minutes as M:SS', () => {
      expect(formatTimeCompact(60)).toBe('1:00');
      expect(formatTimeCompact(90)).toBe('1:30');
      expect(formatTimeCompact(125)).toBe('2:05');
      expect(formatTimeCompact(605)).toBe('10:05');
    });

    it('should format hours as H:MM:SS', () => {
      expect(formatTimeCompact(3600)).toBe('1:00:00');
      expect(formatTimeCompact(3661)).toBe('1:01:01');
      expect(formatTimeCompact(7325)).toBe('2:02:05');
    });

    it('should pad minutes and seconds with zeros', () => {
      expect(formatTimeCompact(61)).toBe('1:01');
      expect(formatTimeCompact(3601)).toBe('1:00:01');
      expect(formatTimeCompact(3660)).toBe('1:01:00');
    });
  });

  describe('formatRate', () => {
    it('should format rates under 1000 as plain keys/s', () => {
      expect(formatRate(0)).toBe('0 keys/s');
      expect(formatRate(1)).toBe('1 keys/s');
      expect(formatRate(999)).toBe('999 keys/s');
    });

    it('should format rates in thousands as kkeys/s', () => {
      expect(formatRate(1000)).toBe('1.0 kkeys/s');
      expect(formatRate(1500)).toBe('1.5 kkeys/s');
      expect(formatRate(12345)).toBe('12.3 kkeys/s');
      expect(formatRate(999999)).toBe('1000.0 kkeys/s');
    });

    it('should format rates in millions as Mkeys/s', () => {
      expect(formatRate(1000000)).toBe('1.00 Mkeys/s');
      expect(formatRate(1500000)).toBe('1.50 Mkeys/s');
      expect(formatRate(12345678)).toBe('12.35 Mkeys/s');
      expect(formatRate(999999999)).toBe('1000.00 Mkeys/s');
    });

    it('should format rates in billions as Gkeys/s', () => {
      expect(formatRate(1000000000)).toBe('1.00 Gkeys/s');
      expect(formatRate(1500000000)).toBe('1.50 Gkeys/s');
      expect(formatRate(12345678901)).toBe('12.35 Gkeys/s');
    });
  });
});

describe('known-keys.ts', () => {
  // Mock localStorage
  const localStorageMock = (() => {
    let store: Record<string, string> = {};
    return {
      getItem: vi.fn((key: string) => store[key] ?? null),
      setItem: vi.fn((key: string, value: string) => {
        store[key] = value;
      }),
      removeItem: vi.fn((key: string) => {
        delete store[key];
      }),
      clear: vi.fn(() => {
        store = {};
      }),
      reset: () => {
        store = {};
        localStorageMock.getItem.mockClear();
        localStorageMock.setItem.mockClear();
      },
    };
  })();

  beforeEach(() => {
    localStorageMock.reset();
    vi.stubGlobal('localStorage', localStorageMock);
    vi.resetModules();
  });

  it('should load empty state when localStorage is empty', async () => {
    const { loadKnownKeysFromStorage, getKnownKeys } = await import('./known-keys');
    loadKnownKeysFromStorage();
    expect(getKnownKeys().size).toBe(0);
  });

  it('should load keys from localStorage', async () => {
    const testData: [string, { roomName: string; key: string }][] = [
      ['abc123', { roomName: 'test', key: 'deadbeef' }],
      ['def456', { roomName: 'other', key: 'cafebabe' }],
    ];
    localStorageMock.setItem('meshcore-known-room-keys', JSON.stringify(testData));

    const { loadKnownKeysFromStorage, getKnownKeys } = await import('./known-keys');
    loadKnownKeysFromStorage();

    const keys = getKnownKeys();
    expect(keys.size).toBe(2);
    expect(keys.get('abc123')).toEqual({ roomName: 'test', key: 'deadbeef' });
    expect(keys.get('def456')).toEqual({ roomName: 'other', key: 'cafebabe' });
  });

  it('should handle corrupted localStorage gracefully', async () => {
    localStorageMock.setItem('meshcore-known-room-keys', 'not valid json');

    const { loadKnownKeysFromStorage, getKnownKeys } = await import('./known-keys');
    loadKnownKeysFromStorage();

    // Should not throw, should just have empty state
    expect(getKnownKeys().size).toBe(0);
  });

  it('should handle missing localStorage key gracefully', async () => {
    // Don't set anything in localStorage

    const { loadKnownKeysFromStorage, getKnownKeys } = await import('./known-keys');
    loadKnownKeysFromStorage();

    expect(getKnownKeys().size).toBe(0);
  });

  it('should add keys and persist to localStorage', async () => {
    const { loadKnownKeysFromStorage, addKnownKey, getKnownKeys } = await import('./known-keys');
    loadKnownKeysFromStorage();

    addKnownKey('hash1', 'room1', 'key1');

    // Verify in-memory state
    const keys = getKnownKeys();
    expect(keys.size).toBe(1);
    expect(keys.get('hash1')).toEqual({ roomName: 'room1', key: 'key1' });

    // Verify it was persisted
    expect(localStorageMock.setItem).toHaveBeenCalledWith(
      'meshcore-known-room-keys',
      expect.any(String),
    );
    const lastCall = localStorageMock.setItem.mock.calls.find(
      (call) => call[0] === 'meshcore-known-room-keys',
    );
    const saved = JSON.parse(lastCall![1]);
    expect(saved).toEqual([['hash1', { roomName: 'room1', key: 'key1' }]]);
  });

  it('should add multiple keys', async () => {
    const { loadKnownKeysFromStorage, addKnownKey, getKnownKeys } = await import('./known-keys');
    loadKnownKeysFromStorage();

    addKnownKey('hash1', 'room1', 'key1');
    addKnownKey('hash2', 'room2', 'key2');
    addKnownKey('hash3', 'room3', 'key3');

    const keys = getKnownKeys();
    expect(keys.size).toBe(3);
  });

  it('should overwrite existing key with same hash', async () => {
    const { loadKnownKeysFromStorage, addKnownKey, getKnownKeys } = await import('./known-keys');
    loadKnownKeysFromStorage();

    addKnownKey('hash1', 'room1', 'key1');
    addKnownKey('hash1', 'room1-updated', 'key1-updated');

    const keys = getKnownKeys();
    expect(keys.size).toBe(1);
    expect(keys.get('hash1')).toEqual({ roomName: 'room1-updated', key: 'key1-updated' });
  });

  it('should remove keys and persist to localStorage', async () => {
    const testData: [string, { roomName: string; key: string }][] = [
      ['hash1', { roomName: 'room1', key: 'key1' }],
      ['hash2', { roomName: 'room2', key: 'key2' }],
    ];
    localStorageMock.setItem('meshcore-known-room-keys', JSON.stringify(testData));

    const { loadKnownKeysFromStorage, removeKnownKey, getKnownKeys } = await import('./known-keys');
    loadKnownKeysFromStorage();

    removeKnownKey('hash1');

    // Verify in-memory state
    const keys = getKnownKeys();
    expect(keys.size).toBe(1);
    expect(keys.has('hash1')).toBe(false);
    expect(keys.get('hash2')).toEqual({ roomName: 'room2', key: 'key2' });

    // Verify persistence (find the LAST call, not the first, since setup also calls setItem)
    const calls = localStorageMock.setItem.mock.calls.filter(
      (call) => call[0] === 'meshcore-known-room-keys',
    );
    const lastCall = calls[calls.length - 1];
    const saved = JSON.parse(lastCall![1]);
    expect(saved).toEqual([['hash2', { roomName: 'room2', key: 'key2' }]]);
  });

  it('should handle removing non-existent key gracefully', async () => {
    const { loadKnownKeysFromStorage, removeKnownKey, getKnownKeys } = await import('./known-keys');
    loadKnownKeysFromStorage();

    // Should not throw
    removeKnownKey('nonexistent');

    expect(getKnownKeys().size).toBe(0);
  });

  it('should return read-only map from getKnownKeys', async () => {
    const { loadKnownKeysFromStorage, addKnownKey, getKnownKeys } = await import('./known-keys');
    loadKnownKeysFromStorage();

    addKnownKey('hash1', 'room1', 'key1');

    const keys = getKnownKeys();

    // The returned map should be the same reference each time
    const keys2 = getKnownKeys();
    expect(keys).toBe(keys2);
  });

  it('should handle localStorage.setItem throwing (quota exceeded)', async () => {
    const { loadKnownKeysFromStorage, addKnownKey, getKnownKeys } = await import('./known-keys');
    loadKnownKeysFromStorage();

    // Make setItem throw
    localStorageMock.setItem.mockImplementationOnce(() => {
      throw new Error('QuotaExceededError');
    });

    // Should not throw, should still update in-memory state
    addKnownKey('hash1', 'room1', 'key1');

    const keys = getKnownKeys();
    expect(keys.size).toBe(1);
  });
});

describe('render-utils.ts', () => {
  describe('getStatusDisplay', () => {
    it('should return pending status info', () => {
      const item = {
        id: 1,
        packetHex: 'abcd1234',
        status: 'pending' as const,
        maxLength: 6,
      };

      const result = getStatusDisplay(item);

      expect(result.statusClass).toBe('status-pending');
      expect(result.statusText).toBe('Pending (max 6)');
      expect(result.resultText).toBe('-');
      expect(result.actionsHtml).toBe('');
    });

    it('should return processing status for wordlist phase', () => {
      const item = {
        id: 1,
        packetHex: 'abcd1234',
        status: 'processing' as const,
        maxLength: 6,
        phase: 'wordlist' as const,
        progressPercent: 45.67,
        testedUpTo: 'hello',
      };

      const result = getStatusDisplay(item);

      expect(result.statusClass).toBe('status-processing');
      expect(result.statusText).toBe('Processing 45.7%');
      expect(result.resultText).toBe('dict: hello');
    });

    it('should return processing status for bruteforce phase', () => {
      const item = {
        id: 1,
        packetHex: 'abcd1234',
        status: 'processing' as const,
        maxLength: 6,
        phase: 'bruteforce' as const,
        progressPercent: 25.0,
        testedUpToLength: 4,
      };

      const result = getStatusDisplay(item);

      expect(result.statusClass).toBe('status-processing');
      expect(result.statusText).toBe('Processing 25.0%');
      expect(result.resultText).toBe('GPU length 4');
    });

    it('should include ETA when rate and progress available', () => {
      const item = {
        id: 1,
        packetHex: 'abcd1234',
        status: 'processing' as const,
        maxLength: 6,
        phase: 'bruteforce' as const,
        progressPercent: 50.0,
        testedUpToLength: 4,
        totalCandidates: 10000,
        checkedCount: 5000,
      };

      // 5000 remaining at 1000/sec = 5 seconds
      const result = getStatusDisplay(item, 1000);

      expect(result.resultText).toContain('ETA');
      expect(result.resultText).toContain('5s');
    });

    it('should return found status with sender and message', () => {
      const item = {
        id: 1,
        packetHex: 'abcd1234',
        status: 'found' as const,
        maxLength: 6,
        sender: 'TestUser',
        message: 'Hello world!',
      };

      const result = getStatusDisplay(item);

      expect(result.statusClass).toBe('status-found');
      expect(result.statusText).toBe('Found');
      expect(result.resultText).toContain('<strong>TestUser:</strong>');
      expect(result.resultText).toContain('Hello world!');
      expect(result.actionsHtml).toContain('skip-btn');
    });

    it('should return found status with just message when no sender', () => {
      const item = {
        id: 1,
        packetHex: 'abcd1234',
        status: 'found' as const,
        maxLength: 6,
        message: 'Anonymous message',
      };

      const result = getStatusDisplay(item);

      expect(result.resultText).toBe('Anonymous message');
      expect(result.resultText).not.toContain('<strong>');
    });

    it('should escape HTML in sender and message', () => {
      const item = {
        id: 1,
        packetHex: 'abcd1234',
        status: 'found' as const,
        maxLength: 6,
        sender: '<script>evil</script>',
        message: '<img onerror=alert(1)>',
      };

      const result = getStatusDisplay(item);

      expect(result.resultText).toContain('&lt;script&gt;');
      expect(result.resultText).toContain('&lt;img');
      expect(result.resultText).not.toContain('<script>');
    });

    it('should return failed status info', () => {
      const item = {
        id: 1,
        packetHex: 'abcd1234',
        status: 'failed' as const,
        maxLength: 6,
        testedUpToLength: 6,
      };

      const result = getStatusDisplay(item);

      expect(result.statusClass).toBe('status-failed');
      expect(result.statusText).toBe('Not found');
      expect(result.resultText).toBe('No key found of length 6');
      expect(result.actionsHtml).toContain('retry-btn');
    });

    it('should handle failed status with unknown length', () => {
      const item = {
        id: 1,
        packetHex: 'abcd1234',
        status: 'failed' as const,
        maxLength: 6,
      };

      const result = getStatusDisplay(item);

      expect(result.resultText).toBe('No key found of length ?');
    });
  });

  describe('truncatePacketHex', () => {
    it('should not truncate short packets', () => {
      expect(truncatePacketHex('abcd1234')).toBe('abcd1234');
      expect(truncatePacketHex('a'.repeat(32))).toBe('a'.repeat(32));
    });

    it('should truncate long packets with ellipsis', () => {
      const longHex = 'a'.repeat(64);
      expect(truncatePacketHex(longHex)).toBe('a'.repeat(32) + '...');
    });

    it('should respect custom max length', () => {
      expect(truncatePacketHex('abcdefgh', 4)).toBe('abcd...');
      expect(truncatePacketHex('abcd', 4)).toBe('abcd');
    });
  });

  describe('renderQueueItemRow', () => {
    it('should render a complete table row', () => {
      const item = {
        id: 42,
        packetHex: 'deadbeef',
        status: 'pending' as const,
        maxLength: 8,
      };

      const html = renderQueueItemRow(item);

      expect(html).toContain('<tr data-id="42">');
      expect(html).toContain('<td>42</td>');
      expect(html).toContain('status-pending');
      expect(html).toContain('deadbeef');
      expect(html).toContain('</tr>');
    });

    it('should include room name when present', () => {
      const item = {
        id: 1,
        packetHex: 'abcd',
        status: 'found' as const,
        maxLength: 6,
        roomName: 'testroom',
        message: 'Hello',
      };

      const html = renderQueueItemRow(item);

      expect(html).toContain('#testroom');
    });

    it('should show dash when no room name', () => {
      const item = {
        id: 1,
        packetHex: 'abcd',
        status: 'pending' as const,
        maxLength: 6,
      };

      const html = renderQueueItemRow(item);

      expect(html).toContain('<td class="mono">-</td>');
    });

    it('should escape packet hex in title attribute', () => {
      const item = {
        id: 1,
        packetHex: '<script>',
        status: 'pending' as const,
        maxLength: 6,
      };

      const html = renderQueueItemRow(item);

      expect(html).toContain('title="&lt;script&gt;"');
    });

    it('should include action buttons container when actions present', () => {
      const item = {
        id: 1,
        packetHex: 'abcd',
        status: 'found' as const,
        maxLength: 6,
        message: 'Test',
      };

      const html = renderQueueItemRow(item);

      expect(html).toContain('<div class="action-btns">');
      expect(html).toContain('skip-btn');
    });
  });
});
