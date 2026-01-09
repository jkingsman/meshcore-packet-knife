/**
 * Shared module for managing known room keys.
 * Used by bulk.ts and bulk-serial.ts for caching discovered room keys.
 */

import { ChannelCrypto } from '@michaelhart/meshcore-decoder';
import { getChannelHash, verifyMac, PUBLIC_ROOM_NAME, PUBLIC_KEY } from 'meshcore-hashtag-cracker';

// LocalStorage key for persisting known room keys
const KNOWN_KEYS_STORAGE_KEY = 'meshcore-known-room-keys';

// Known keys map: channelHash -> { roomName, key }
const knownKeys: Map<string, { roomName: string; key: string }> = new Map();

// Callback for UI updates when known keys change
let onChangeCallback: (() => void) | null = null;

/**
 * Set a callback to be called when known keys change.
 */
export function setOnChangeCallback(callback: () => void): void {
  onChangeCallback = callback;
}

/**
 * Get the known keys map (read-only access).
 */
export function getKnownKeys(): ReadonlyMap<string, { roomName: string; key: string }> {
  return knownKeys;
}

/**
 * Load known keys from localStorage.
 * Call this once during initialization.
 */
export function loadKnownKeysFromStorage(): void {
  try {
    const stored = localStorage.getItem(KNOWN_KEYS_STORAGE_KEY);
    if (stored) {
      const entries: [string, { roomName: string; key: string }][] = JSON.parse(stored);
      for (const [channelHash, value] of entries) {
        knownKeys.set(channelHash, value);
      }
    }
  } catch {
    // Ignore parse errors, start with empty map
  }
}

/**
 * Save known keys to localStorage.
 */
function saveKnownKeysToStorage(): void {
  try {
    const entries = Array.from(knownKeys.entries());
    localStorage.setItem(KNOWN_KEYS_STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Ignore storage errors (e.g., quota exceeded)
  }
}

/**
 * Add a known key and persist to storage.
 */
export function addKnownKey(channelHash: string, roomName: string, key: string): void {
  knownKeys.set(channelHash, { roomName, key });
  saveKnownKeysToStorage();
  onChangeCallback?.();
}

/**
 * Remove a known key and persist to storage.
 */
export function removeKnownKey(channelHash: string): void {
  knownKeys.delete(channelHash);
  saveKnownKeysToStorage();
  onChangeCallback?.();
}

/**
 * Result of trying known keys against a packet.
 */
export interface KnownKeyMatch {
  found: boolean;
  roomName?: string;
  key?: string;
  sender?: string;
  message?: string;
}

/**
 * Try known keys against a packet's cipher data.
 * Returns match info if a known key works, or { found: false } otherwise.
 *
 * @param channelHash - The packet's channel hash (lowercase hex)
 * @param ciphertext - The encrypted ciphertext (hex)
 * @param cipherMac - The MAC for verification (hex)
 */
export function tryKnownKeys(
  channelHash: string,
  ciphertext: string,
  cipherMac: string,
): KnownKeyMatch {
  // Check if we have a known key for this channel hash
  const known = knownKeys.get(channelHash);
  if (known) {
    // Verify MAC matches
    if (verifyMac(ciphertext, cipherMac, known.key)) {
      // Decrypt to get sender/message
      const result = ChannelCrypto.decryptGroupTextMessage(ciphertext, cipherMac, known.key);
      if (result.success && result.data) {
        return {
          found: true,
          roomName: known.roomName,
          key: known.key,
          sender: result.data.sender,
          message: result.data.message,
        };
      }
    }
  }

  // Also try public key
  const publicChannelHash = getChannelHash(PUBLIC_KEY);
  if (channelHash === publicChannelHash) {
    if (verifyMac(ciphertext, cipherMac, PUBLIC_KEY)) {
      const result = ChannelCrypto.decryptGroupTextMessage(ciphertext, cipherMac, PUBLIC_KEY);
      if (result.success && result.data) {
        // Add to known keys for future lookups
        addKnownKey(channelHash, PUBLIC_ROOM_NAME, PUBLIC_KEY);
        return {
          found: true,
          roomName: PUBLIC_ROOM_NAME,
          key: PUBLIC_KEY,
          sender: result.data.sender,
          message: result.data.message,
        };
      }
    }
  }

  return { found: false };
}
