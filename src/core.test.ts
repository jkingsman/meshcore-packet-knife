import { describe, it, expect } from 'vitest';
import {
  CHARS,
  CHARS_LEN,
  CHARS_WITH_DASH,
  PUBLIC_ROOM_NAME,
  PUBLIC_KEY,
  roomNameToIndex,
  indexToRoomName,
  deriveKeyFromRoomName,
  getChannelHash,
  verifyMac,
  countNamesForLength,
  escapeHtml,
  isTimestampValid,
  isValidUtf8,
  RoomNameGenerator,
} from './core';

describe('constants', () => {
  it('should have correct character set', () => {
    expect(CHARS).toBe('abcdefghijklmnopqrstuvwxyz0123456789');
    expect(CHARS_LEN).toBe(36);
    expect(CHARS_WITH_DASH).toBe('abcdefghijklmnopqrstuvwxyz0123456789-');
  });

  it('should have correct public room values', () => {
    expect(PUBLIC_ROOM_NAME).toBe('[[public room]]');
    expect(PUBLIC_KEY).toBe('8b3387e9c5cdea6ac9e5edbaa115cd72');
  });
});

describe('roomNameToIndex', () => {
  it('should return null for empty string', () => {
    expect(roomNameToIndex('')).toBeNull();
  });

  it('should return null for null/undefined', () => {
    expect(roomNameToIndex(null as any)).toBeNull();
    expect(roomNameToIndex(undefined as any)).toBeNull();
  });

  it('should handle single character names', () => {
    expect(roomNameToIndex('a')).toEqual({ length: 1, index: 0 });
    expect(roomNameToIndex('b')).toEqual({ length: 1, index: 1 });
    expect(roomNameToIndex('z')).toEqual({ length: 1, index: 25 });
    expect(roomNameToIndex('0')).toEqual({ length: 1, index: 26 });
    expect(roomNameToIndex('9')).toEqual({ length: 1, index: 35 });
  });

  it('should handle two character names (LSB first)', () => {
    // 'aa' = 0*1 + 0*36 = 0
    expect(roomNameToIndex('aa')).toEqual({ length: 2, index: 0 });
    // 'ba' = 1*1 + 0*36 = 1 (first char is LSB)
    expect(roomNameToIndex('ba')).toEqual({ length: 2, index: 1 });
    // 'ab' = 0*1 + 1*36 = 36
    expect(roomNameToIndex('ab')).toEqual({ length: 2, index: 36 });
    // 'bb' = 1*1 + 1*36 = 37
    expect(roomNameToIndex('bb')).toEqual({ length: 2, index: 37 });
  });

  it('should reject invalid characters', () => {
    expect(roomNameToIndex('A')).toBeNull(); // uppercase
    expect(roomNameToIndex('!')).toBeNull(); // special char
    expect(roomNameToIndex('a b')).toBeNull(); // space
  });

  it('should reject leading dash', () => {
    expect(roomNameToIndex('-a')).toBeNull();
    expect(roomNameToIndex('-')).toBeNull();
  });

  it('should reject trailing dash', () => {
    expect(roomNameToIndex('a-')).toBeNull();
  });

  it('should allow dash in middle', () => {
    const result = roomNameToIndex('a-a');
    expect(result).not.toBeNull();
    expect(result!.length).toBe(3);
  });
});

describe('indexToRoomName', () => {
  it('should return null for invalid length', () => {
    expect(indexToRoomName(0, 0)).toBeNull();
    expect(indexToRoomName(-1, 0)).toBeNull();
  });

  it('should handle single character names', () => {
    expect(indexToRoomName(1, 0)).toBe('a');
    expect(indexToRoomName(1, 1)).toBe('b');
    expect(indexToRoomName(1, 25)).toBe('z');
    expect(indexToRoomName(1, 26)).toBe('0');
    expect(indexToRoomName(1, 35)).toBe('9');
  });

  it('should handle two character names (LSB first)', () => {
    expect(indexToRoomName(2, 0)).toBe('aa');
    expect(indexToRoomName(2, 1)).toBe('ba'); // first char is LSB
    expect(indexToRoomName(2, 36)).toBe('ab');
    expect(indexToRoomName(2, 37)).toBe('bb');
  });
});

describe('roomNameToIndex and indexToRoomName roundtrip', () => {
  it('should be inverse operations for length 1', () => {
    for (let i = 0; i < 36; i++) {
      const name = indexToRoomName(1, i);
      expect(name).not.toBeNull();
      const result = roomNameToIndex(name!);
      expect(result).toEqual({ length: 1, index: i });
    }
  });

  it('should be inverse operations for length 2', () => {
    for (let i = 0; i < 100; i++) {
      const name = indexToRoomName(2, i);
      expect(name).not.toBeNull();
      const result = roomNameToIndex(name!);
      expect(result).toEqual({ length: 2, index: i });
    }
  });

  it('should be inverse operations for length 3', () => {
    let validCount = 0;
    for (let i = 0; validCount < 100 && i < 10000; i++) {
      const name = indexToRoomName(3, i);
      if (name) {
        const result = roomNameToIndex(name);
        expect(result).toEqual({ length: 3, index: i });
        validCount++;
      }
    }
    expect(validCount).toBe(100);
  });

  it('should handle specific room names', () => {
    const testNames = ['test', 'hello', 'abc', 'z9', 'a1b2'];
    for (const name of testNames) {
      const indexed = roomNameToIndex(name);
      expect(indexed).not.toBeNull();
      const recovered = indexToRoomName(indexed!.length, indexed!.index);
      expect(recovered).toBe(name);
    }
  });
});

describe('deriveKeyFromRoomName', () => {
  it('should return public key for public room', () => {
    expect(deriveKeyFromRoomName(PUBLIC_ROOM_NAME)).toBe(PUBLIC_KEY);
  });

  it('should return valid 32-char hex key', () => {
    const key = deriveKeyFromRoomName('#test');
    expect(key).toHaveLength(32);
    expect(key).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('getChannelHash', () => {
  it('should return 2 hex characters (1 byte)', () => {
    const hash = getChannelHash(PUBLIC_KEY);
    expect(hash).toHaveLength(2);
    expect(hash).toMatch(/^[0-9a-f]{2}$/);
  });
});

describe('verifyMac', () => {
  it('should be case insensitive for MAC comparison', () => {
    const ciphertext = 'deadbeef';
    const key = '00000000000000000000000000000000';
    const resultLower = verifyMac(ciphertext, 'abcd', key);
    const resultUpper = verifyMac(ciphertext, 'ABCD', key);
    expect(resultLower).toBe(resultUpper);
  });
});

describe('countNamesForLength', () => {
  it('should return 36 for length 1', () => {
    expect(countNamesForLength(1)).toBe(36);
  });

  it('should return 36*36 for length 2', () => {
    expect(countNamesForLength(2)).toBe(36 * 36);
  });

  it('should handle length 3 with dash rules', () => {
    // First: 36, Middle: 37 (with dash), Last: 36
    expect(countNamesForLength(3)).toBe(36 * 37 * 36);
  });

  it('should increase with length', () => {
    expect(countNamesForLength(2)).toBeGreaterThan(countNamesForLength(1));
    expect(countNamesForLength(3)).toBeGreaterThan(countNamesForLength(2));
    expect(countNamesForLength(4)).toBeGreaterThan(countNamesForLength(3));
  });
});

describe('escapeHtml', () => {
  it('should escape all dangerous characters', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'
    );
    expect(escapeHtml("a'b")).toBe('a&#39;b');
    expect(escapeHtml('a&b')).toBe('a&amp;b');
  });

  it('should handle empty string', () => {
    expect(escapeHtml('')).toBe('');
  });

  it('should convert non-strings to strings', () => {
    expect(escapeHtml(123 as any)).toBe('123');
  });
});

describe('isTimestampValid', () => {
  const ONE_MONTH_SECONDS = 30 * 24 * 60 * 60;

  it('should accept timestamp exactly at upper bound (now)', () => {
    const now = 1000000;
    expect(isTimestampValid(now, now)).toBe(true);
  });

  it('should reject timestamp 1 second in future', () => {
    const now = 1000000;
    expect(isTimestampValid(now + 1, now)).toBe(false);
  });

  it('should accept timestamp exactly at lower bound (30 days ago)', () => {
    const now = 1000000;
    expect(isTimestampValid(now - ONE_MONTH_SECONDS, now)).toBe(true);
  });

  it('should reject timestamp 1 second past lower bound', () => {
    const now = 1000000;
    expect(isTimestampValid(now - ONE_MONTH_SECONDS - 1, now)).toBe(false);
  });
});

describe('isValidUtf8', () => {
  it('should accept valid text', () => {
    expect(isValidUtf8('Hello, World!')).toBe(true);
    expect(isValidUtf8('Hello, 世界! 🎉')).toBe(true);
    expect(isValidUtf8('')).toBe(true);
  });

  it('should reject text with replacement character', () => {
    expect(isValidUtf8('Hello\uFFFDWorld')).toBe(false);
  });
});

describe('RoomNameGenerator', () => {
  it('should start with "a"', () => {
    const gen = new RoomNameGenerator();
    expect(gen.current()).toBe('a');
    expect(gen.getLength()).toBe(1);
  });

  it('should iterate through single character names', () => {
    const gen = new RoomNameGenerator();
    const names: string[] = [];
    for (let i = 0; i < 36; i++) {
      names.push(gen.current());
      gen.nextValid();
    }
    expect(names).toEqual(CHARS.split(''));
  });

  it('should transition to length 2 after exhausting length 1', () => {
    const gen = new RoomNameGenerator();
    for (let i = 0; i < 36; i++) {
      gen.nextValid();
    }
    expect(gen.getLength()).toBe(2);
    expect(gen.current()).toBe('aa');
  });

  it('should support skipTo and resume correctly', () => {
    const gen = new RoomNameGenerator();
    const testIndex = roomNameToIndex('test');
    expect(testIndex).not.toBeNull();

    gen.skipTo(testIndex!.length, testIndex!.index);
    expect(gen.current()).toBe('test');
  });

  it('should not generate names with invalid dashes', () => {
    const gen = new RoomNameGenerator();
    gen.skipTo(5, 0);

    for (let i = 0; i < 5000; i++) {
      const name = gen.current();
      expect(name[0]).not.toBe('-');
      expect(name[name.length - 1]).not.toBe('-');
      expect(name).not.toContain('--');
      gen.nextValid();
    }
  });
});

describe('integration: public key format', () => {
  it('public key should have valid format and produce valid channel hash', () => {
    expect(PUBLIC_KEY).toMatch(/^[0-9a-f]{32}$/);
    const hash = getChannelHash(PUBLIC_KEY);
    expect(hash).toMatch(/^[0-9a-f]{2}$/);
  });
});
