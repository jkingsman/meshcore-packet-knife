import { MeshCorePacketDecoder, ChannelCrypto, PayloadType } from '@michaelhart/meshcore-decoder';
// @ts-expect-error - meshcore.js doesn't have type definitions
import { WebSerialConnection, Constants } from '@liamcottle/meshcore.js';
import NoSleep from 'nosleep.js';
import {
  GroupTextCracker,
  deriveKeyFromRoomName,
  getChannelHash,
  verifyMac,
  isTimestampValid as coreIsTimestampValid,
  isValidUtf8 as coreIsValidUtf8,
  PUBLIC_ROOM_NAME,
  PUBLIC_KEY,
  roomNameToIndex,
  countNamesForLength,
  ProgressReport,
} from 'meshcore-hashtag-cracker';
import { escapeHtml } from './utils';

// Types
interface QueueItem {
  id: number;
  packetHex: string;
  status: 'pending' | 'processing' | 'found' | 'failed';
  channelHash?: string;
  ciphertext?: string;
  cipherMac?: string;
  roomName?: string;
  key?: string;
  sender?: string;
  message?: string;
  testedUpTo?: string;
  testedUpToLength?: number;
  maxLength: number;
  startFrom?: string; // Resume position in "length:index" format
  progressPercent?: number;
  totalCandidates?: number;
  checkedCount?: number;
  phase?: 'public-key' | 'wordlist' | 'bruteforce';
  error?: string;
}

// State
const queue: QueueItem[] = [];
const knownKeys: Map<string, { roomName: string; key: string }> = new Map();
const seenPackets: Set<string> = new Set(); // For duplicate detection

// LocalStorage key for persisting known room keys
const KNOWN_KEYS_STORAGE_KEY = 'meshcore-known-room-keys';

// Load known keys from localStorage
function loadKnownKeysFromStorage(): void {
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

// Save known keys to localStorage
function saveKnownKeysToStorage(): void {
  try {
    const entries = Array.from(knownKeys.entries());
    localStorage.setItem(KNOWN_KEYS_STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Ignore storage errors (e.g., quota exceeded)
  }
}

// Add a known key (and persist)
function addKnownKey(channelHash: string, roomName: string, key: string): void {
  knownKeys.set(channelHash, { roomName, key });
  saveKnownKeysToStorage();
  updateKnownKeysDisplay();
}

// Remove a known key (and persist)
function removeKnownKey(channelHash: string): void {
  knownKeys.delete(channelHash);
  saveKnownKeysToStorage();
  updateKnownKeysDisplay();
}
let nextId = 1;
let isProcessing = false;
let cracker: GroupTextCracker | null = null;
let foundCount = 0;
let failedCount = 0;
let filteredCount = 0;
let currentRate = 0;
let packetsReceived = 0;

// NoSleep instance for preventing screen sleep
let noSleep: NoSleep | null = null;
let noSleepEnabled = false;

// Serial connection state
let connection: typeof WebSerialConnection | null = null;
let radioName: string | null = null;
let lastPacketTime: Date | null = null;

// Filter settings
let useTimestampFilter = true;
let useUnicodeFilter = true;
let autoRetryEnabled = false;
let autoRetryIntervalId: number | null = null;

// Ignored rooms - maps channelHash to room name for quick lookup
const ignoredRooms: Map<string, string> = new Map();

// Parse ignore list and compute keys
function updateIgnoredRooms(ignoreListStr: string): void {
  ignoredRooms.clear();
  const rooms = ignoreListStr
    .split(',')
    .map((r) => r.trim())
    .filter((r) => r.length > 0);

  for (const room of rooms) {
    let key: string;
    let displayName: string;

    if (room === '[[public room]]' || room === PUBLIC_ROOM_NAME) {
      key = PUBLIC_KEY;
      displayName = PUBLIC_ROOM_NAME;
    } else {
      // Add # prefix if not present for key derivation
      const roomWithHash = room.startsWith('#') ? room : '#' + room;
      key = deriveKeyFromRoomName(roomWithHash);
      displayName = room.startsWith('#') ? room : '#' + room;
    }

    const channelHash = getChannelHash(key);
    ignoredRooms.set(channelHash, displayName);
  }
}

// Check if a packet should be ignored (decrypts with an ignored room's key)
function shouldIgnorePacket(channelHash: string, ciphertext: string, cipherMac: string): boolean {
  // First check if channel hash matches any ignored room
  const ignoredRoom = ignoredRooms.get(channelHash);
  if (!ignoredRoom) {
    return false;
  }

  // Channel hash matches, verify MAC to confirm
  let key: string;
  if (ignoredRoom === PUBLIC_ROOM_NAME) {
    key = PUBLIC_KEY;
  } else {
    key = deriveKeyFromRoomName(ignoredRoom);
  }

  return verifyMac(ciphertext, cipherMac, key);
}

// DOM elements
let resultsBody: HTMLTableSectionElement;
let queueCountEl: HTMLElement;
let currentStatusEl: HTMLElement;
let foundCountEl: HTMLElement;
let failedCountEl: HTMLElement;
let filteredCountEl: HTMLElement;
let currentRateEl: HTMLElement;
let knownKeysEl: HTMLElement;
let knownKeysListEl: HTMLElement;
let maxLengthInput: HTMLInputElement;
let noSleepBtn: HTMLButtonElement;
let connectBtn: HTMLButtonElement;
let disconnectBtn: HTMLButtonElement;
let connectionStatusEl: HTMLElement;
let packetsReceivedEl: HTMLElement;
let lastPacketTimeEl: HTMLElement;

// Filter wrappers
function isTimestampValid(timestamp: number): boolean {
  return !useTimestampFilter || coreIsTimestampValid(timestamp);
}

function isValidUtf8(text: string): boolean {
  return !useUnicodeFilter || coreIsValidUtf8(text);
}

// Verify MAC and check filters
function verifyMacAndFilters(
  ciphertext: string,
  cipherMac: string,
  keyHex: string,
): { valid: boolean; sender?: string; message?: string } {
  if (!verifyMac(ciphertext, cipherMac, keyHex)) {
    return { valid: false };
  }

  const result = ChannelCrypto.decryptGroupTextMessage(ciphertext, cipherMac, keyHex);
  if (!result.success || !result.data) {
    return { valid: false };
  }

  if (!isTimestampValid(result.data.timestamp)) {
    return { valid: false };
  }

  if (!isValidUtf8(result.data.message)) {
    return { valid: false };
  }

  return { valid: true, sender: result.data.sender, message: result.data.message };
}

// Formatting helpers
function formatTime(seconds: number): string {
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

function formatRate(rate: number): string {
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

// Update known keys display
function updateKnownKeysDisplay(): void {
  if (knownKeys.size === 0) {
    knownKeysEl.style.display = 'none';
    return;
  }
  knownKeysEl.style.display = 'block';
  knownKeysListEl.innerHTML = Array.from(knownKeys.values())
    .map((k) => {
      // Don't add # prefix for public room
      const displayName =
        k.roomName === PUBLIC_ROOM_NAME ? k.roomName : `#${escapeHtml(k.roomName)}`;
      return `<div class="known-key-item"><span class="known-room-name">${displayName}</span> <span class="known-room-key">${k.key}</span></div>`;
    })
    .join('');
}

// Console function to add a room name directly (without cracking)
// Usage: addRoomName('roomname') - without the leading #
// Special case: addRoomName('[[public room]]') uses the precomputed public key
function addRoomNameFromConsole(roomName: string): void {
  if (!roomName || typeof roomName !== 'string') {
    console.error('Usage: addRoomName("roomname") - provide room name without leading #');
    return;
  }

  let cleanName: string;
  let key: string;

  // Handle public room special case
  if (roomName === '[[public room]]' || roomName === PUBLIC_ROOM_NAME) {
    cleanName = PUBLIC_ROOM_NAME;
    key = PUBLIC_KEY;
  } else {
    // Remove leading # if accidentally included
    cleanName = roomName.startsWith('#') ? roomName.slice(1) : roomName;
    // Derive key from room name
    key = deriveKeyFromRoomName('#' + cleanName);
  }

  const channelHash = getChannelHash(key);

  // Check if already exists
  const existing = knownKeys.get(channelHash);
  if (existing) {
    console.log(`Room #${cleanName} already exists with key ${key}`);
    return;
  }

  // Add to known keys
  addKnownKey(channelHash, cleanName, key);
  console.log(`Added room #${cleanName} with key ${key} (channel hash: ${channelHash})`);
}

// Console function to remove a room name from known keys
// Usage: removeRoomName('roomname') - without the leading #
// Special case: removeRoomName('[[public room]]') removes the public room key
function removeRoomNameFromConsole(roomName: string): void {
  if (!roomName || typeof roomName !== 'string') {
    console.error('Usage: removeRoomName("roomname") - provide room name without leading #');
    return;
  }

  let cleanName: string;
  let key: string;

  // Handle public room special case
  if (roomName === '[[public room]]' || roomName === PUBLIC_ROOM_NAME) {
    cleanName = PUBLIC_ROOM_NAME;
    key = PUBLIC_KEY;
  } else {
    // Remove leading # if accidentally included
    cleanName = roomName.startsWith('#') ? roomName.slice(1) : roomName;
    // Derive key from room name
    key = deriveKeyFromRoomName('#' + cleanName);
  }

  const channelHash = getChannelHash(key);

  // Check if it exists
  const existing = knownKeys.get(channelHash);
  if (!existing) {
    console.log(`Room #${cleanName} not found in known keys`);
    return;
  }

  // Remove from known keys
  removeKnownKey(channelHash);
  console.log(`Removed room #${cleanName} with key ${key} (channel hash: ${channelHash})`);
}

// Expose to window for console access
declare global {
  interface Window {
    addRoomName: typeof addRoomNameFromConsole;
    removeRoomName: typeof removeRoomNameFromConsole;
  }
}
window.addRoomName = addRoomNameFromConsole;
window.removeRoomName = removeRoomNameFromConsole;

// Get length for a found item (from roomName or testedUpToLength)
function getFoundLength(item: QueueItem): number {
  if (item.testedUpToLength) {
    return item.testedUpToLength;
  }
  if (item.roomName) {
    // For public room or dictionary finds, use the room name length
    if (item.roomName === PUBLIC_ROOM_NAME) {
      return 0; // Special case for public room
    }
    return item.roomName.length;
  }
  return 0;
}

// Update status bar
function updateStatusBar(): void {
  queueCountEl.textContent = String(queue.filter((q) => q.status === 'pending').length);
  filteredCountEl.textContent = String(filteredCount);
  currentRateEl.textContent = currentRate > 0 ? formatRate(currentRate) : '-';

  // Update found/failed with breakdown
  const foundItems = queue.filter((q) => q.status === 'found');
  const failedItems = queue.filter((q) => q.status === 'failed');
  const total = foundItems.length + failedItems.length;

  // Build found breakdown
  let foundText = String(foundCount);
  if (total > 0 && foundItems.length > 0) {
    const foundByLength: Map<number, number> = new Map();
    for (const item of foundItems) {
      const len = getFoundLength(item);
      foundByLength.set(len, (foundByLength.get(len) || 0) + 1);
    }
    const details: string[] = [];
    const sortedLengths = Array.from(foundByLength.keys()).sort((a, b) => a - b);
    for (const len of sortedLengths) {
      const count = foundByLength.get(len)!;
      const pct = ((count / total) * 100).toFixed(0);
      if (len === 0) {
        details.push(`${pct}% dict`);
      } else {
        details.push(`${pct}% len ${len}`);
      }
    }
    if (details.length > 0) {
      foundText += ` (${details.join(', ')})`;
    }
  }
  foundCountEl.textContent = foundText;

  // Build failed breakdown
  let failedText = String(failedCount);
  if (total > 0 && failedItems.length > 0) {
    const failedByLength: Map<number, number> = new Map();
    for (const item of failedItems) {
      const len = item.testedUpToLength || 0;
      failedByLength.set(len, (failedByLength.get(len) || 0) + 1);
    }
    const details: string[] = [];
    const sortedLengths = Array.from(failedByLength.keys()).sort((a, b) => a - b);
    for (const len of sortedLengths) {
      const count = failedByLength.get(len)!;
      const pct = ((count / total) * 100).toFixed(0);
      details.push(`${pct}% len ${len}`);
    }
    if (details.length > 0) {
      failedText += ` (${details.join(', ')})`;
    }
  }
  failedCountEl.textContent = failedText;
}

// Update packets received counter
function updatePacketsReceivedDisplay(): void {
  if (packetsReceived > 0) {
    packetsReceivedEl.textContent = `${packetsReceived} GroupText packets received`;
  } else {
    packetsReceivedEl.textContent = '';
  }
}

// Update last packet time display
function updateLastPacketTimeDisplay(): void {
  if (lastPacketTime) {
    const timeStr = lastPacketTime.toLocaleTimeString('en-US', { hour12: false });
    lastPacketTimeEl.textContent = `Last packet: ${timeStr}`;
  } else {
    lastPacketTimeEl.textContent = '';
  }
}

// Render a single row
function renderRow(item: QueueItem): string {
  let statusClass = '';
  let statusText = '';
  let resultText = '';
  let actionsHtml = '';

  switch (item.status) {
    case 'pending':
      statusClass = 'status-pending';
      statusText = `Pending (max ${item.maxLength})`;
      resultText = '-';
      break;
    case 'processing': {
      statusClass = 'status-processing';
      const pct = item.progressPercent ?? 0;
      statusText = `Processing ${pct.toFixed(1)}%`;

      if (item.phase === 'wordlist') {
        resultText = `dict: ${escapeHtml(item.testedUpTo || '')}`;
      } else {
        let etaText = '';
        if (
          currentRate > 0 &&
          item.totalCandidates &&
          item.checkedCount !== undefined &&
          item.checkedCount > 0
        ) {
          const remaining = item.totalCandidates - item.checkedCount;
          const etaSeconds = remaining / currentRate;
          etaText = `; ETA ${formatTime(etaSeconds)}`;
        }
        const lengthText = item.testedUpToLength
          ? `GPU length ${item.testedUpToLength}`
          : 'Starting';
        resultText = `${lengthText}${etaText}`;
      }
      break;
    }
    case 'found':
      statusClass = 'status-found';
      statusText = 'Found';
      resultText = item.sender
        ? `<strong>${escapeHtml(item.sender)}:</strong> ${escapeHtml(item.message || '')}`
        : escapeHtml(item.message || '');
      actionsHtml = `
        <button class="action-btn skip-btn" data-id="${item.id}" title="Skip this result (MAC collision) and continue searching">Skip this match and keep looking</button>
      `;
      break;
    case 'failed':
      statusClass = 'status-failed';
      statusText = 'Not found';
      resultText = `No key found of length ${item.testedUpToLength || '?'}`;
      actionsHtml = `
        <button class="action-btn retry-btn" data-id="${item.id}" title="Retry with higher max length">Retry +1</button>
      `;
      break;
  }

  const packetPreview = item.packetHex.substring(0, 32) + (item.packetHex.length > 32 ? '...' : '');

  return `
    <tr data-id="${item.id}">
      <td>${item.id}</td>
      <td class="${statusClass}">${statusText}</td>
      <td class="mono packet-preview" title="${escapeHtml(item.packetHex)}">${escapeHtml(packetPreview)}</td>
      <td class="mono">${item.roomName ? '#' + escapeHtml(item.roomName) : '-'}</td>
      <td class="message-cell">${resultText}${actionsHtml ? '<div class="action-btns">' + actionsHtml + '</div>' : ''}</td>
    </tr>
  `;
}

// Update a single row in the table
function updateRow(item: QueueItem): void {
  const existingRow = resultsBody.querySelector(`tr[data-id="${item.id}"]`);
  if (existingRow) {
    existingRow.outerHTML = renderRow(item);
    bindRowActions(item);
  }
}

// Bind action button handlers for a row
function bindRowActions(item: QueueItem): void {
  const row = resultsBody.querySelector(`tr[data-id="${item.id}"]`);
  if (!row) {
    return;
  }

  const retryBtn = row.querySelector('.retry-btn');
  const skipBtn = row.querySelector('.skip-btn');

  if (retryBtn) {
    retryBtn.addEventListener('click', () => retryWithHigherLimit(item.id));
  }
  if (skipBtn) {
    skipBtn.addEventListener('click', () => skipAndContinue(item.id));
  }
}

// Add item to results table
function addRowToTable(item: QueueItem): void {
  const emptyRow = resultsBody.querySelector('.empty-state-row');
  if (emptyRow) {
    emptyRow.remove();
  }
  resultsBody.insertAdjacentHTML('beforeend', renderRow(item));
  bindRowActions(item);
}

// Retry a failed item with a higher limit
function retryWithHigherLimit(id: number): void {
  const item = queue.find((q) => q.id === id);
  if (!item || item.status !== 'failed') {
    return;
  }

  // Increase max length by 1, start from the next length
  const nextLength = (item.testedUpToLength || item.maxLength) + 1;
  item.maxLength = nextLength;
  item.startFrom = `${nextLength}:0`;
  item.status = 'pending';
  item.testedUpTo = undefined;
  item.progressPercent = undefined;
  item.totalCandidates = undefined;
  item.checkedCount = undefined;
  failedCount--;

  updateRow(item);
  updateStatusBar();
  processQueue();
}

// Skip MAC collision and continue searching from where we found the false positive
function skipAndContinue(id: number): void {
  const item = queue.find((q) => q.id === id);
  if (!item || item.status !== 'found') {
    return;
  }

  // Remove this key from known keys so it doesn't match again
  if (item.channelHash) {
    removeKnownKey(item.channelHash);
  }

  // Resume from the position after the false positive
  if (item.roomName) {
    const pos = roomNameToIndex(item.roomName);
    if (pos) {
      const nextIndex = pos.index + 1;
      // If we've exhausted this length, move to next
      if (nextIndex >= countNamesForLength(pos.length)) {
        item.startFrom = `${pos.length + 1}:0`;
      } else {
        item.startFrom = `${pos.length}:${nextIndex}`;
      }
    }
  }

  // Clear the found result
  item.status = 'pending';
  item.roomName = undefined;
  item.key = undefined;
  item.sender = undefined;
  item.message = undefined;
  item.progressPercent = undefined;
  item.totalCandidates = undefined;
  item.checkedCount = undefined;
  foundCount--;

  updateRow(item);
  updateStatusBar();
  processQueue();
}

// Auto-retry check: if queue is empty and there are failed items, retry the lowest length one
// Max auto-retry length is 8 (won't automatically start length 9 cracking)
const AUTO_RETRY_MAX_LENGTH = 8;

function checkAutoRetry(): void {
  if (!autoRetryEnabled) {
    return;
  }

  // Check if queue has any pending or processing items
  const hasPendingWork = queue.some((q) => q.status === 'pending' || q.status === 'processing');
  if (hasPendingWork) {
    return;
  }

  // Find all failed items and get the one with the lowest testedUpToLength
  const failedItems = queue.filter((q) => q.status === 'failed');
  if (failedItems.length === 0) {
    return;
  }

  // Sort by testedUpToLength to get the lowest
  failedItems.sort((a, b) => (a.testedUpToLength || 0) - (b.testedUpToLength || 0));

  // Pick a random one from those with the lowest length
  const lowestLength = failedItems[0].testedUpToLength || 0;

  // Don't auto-retry if we've already reached the max length
  if (lowestLength >= AUTO_RETRY_MAX_LENGTH) {
    return;
  }

  const lowestLengthItems = failedItems.filter((q) => (q.testedUpToLength || 0) === lowestLength);
  const randomItem = lowestLengthItems[Math.floor(Math.random() * lowestLengthItems.length)];

  // Retry it
  retryWithHigherLimit(randomItem.id);
}

// Try known keys on a packet
function tryKnownKeys(item: QueueItem): boolean {
  if (!item.channelHash || !item.ciphertext || !item.cipherMac) {
    return false;
  }

  // Check if we have a known key for this channel hash
  const known = knownKeys.get(item.channelHash);
  if (known) {
    const result = verifyMacAndFilters(item.ciphertext, item.cipherMac, known.key);
    if (result.valid) {
      item.status = 'found';
      item.roomName = known.roomName;
      item.key = known.key;
      item.sender = result.sender;
      item.message = result.message;
      foundCount++;
      return true;
    }
  }

  // Also try public key
  const publicChannelHash = getChannelHash(PUBLIC_KEY);
  if (item.channelHash === publicChannelHash) {
    const result = verifyMacAndFilters(item.ciphertext, item.cipherMac, PUBLIC_KEY);
    if (result.valid) {
      item.status = 'found';
      item.roomName = PUBLIC_ROOM_NAME;
      item.key = PUBLIC_KEY;
      item.sender = result.sender;
      item.message = result.message;
      foundCount++;
      addKnownKey(item.channelHash, PUBLIC_ROOM_NAME, PUBLIC_KEY);
      return true;
    }
  }

  return false;
}

// Process a single queue item with the cracker
async function processItem(item: QueueItem): Promise<void> {
  if (!cracker) {
    item.status = 'failed';
    item.error = 'Cracker not available';
    item.testedUpTo = 'N/A';
    failedCount++;
    return;
  }

  try {
    const result = await cracker.crack(
      item.packetHex,
      {
        maxLength: item.maxLength,
        useTimestampFilter,
        useUtf8Filter: useUnicodeFilter,
        startFrom: item.startFrom,
      },
      (progress: ProgressReport) => {
        // Update UI with progress
        currentRate = progress.rateKeysPerSec;
        item.progressPercent = progress.percent;
        item.checkedCount = progress.checked;
        item.totalCandidates = progress.total;
        item.testedUpToLength = progress.currentLength;
        item.testedUpTo = progress.currentPosition;
        item.phase = progress.phase;

        updateRow(item);
        updateStatusBar();
      },
    );

    if (result.found && result.roomName && result.key) {
      item.status = 'found';
      item.roomName = result.roomName;
      item.key = result.key;
      item.testedUpToLength = result.roomName.length;

      // Decrypt to get sender/message
      if (item.ciphertext && item.cipherMac) {
        const decrypted = ChannelCrypto.decryptGroupTextMessage(
          item.ciphertext,
          item.cipherMac,
          result.key,
        );
        if (decrypted.success && decrypted.data) {
          item.sender = decrypted.data.sender;
          item.message = decrypted.data.message;
        }
      }

      foundCount++;

      // Add to known keys cache
      if (item.channelHash) {
        addKnownKey(item.channelHash, result.roomName, result.key);
      }
    } else {
      item.status = 'failed';
      item.testedUpToLength = item.maxLength;
      failedCount++;
    }
  } catch (err) {
    item.status = 'failed';
    item.error = err instanceof Error ? err.message : 'Unknown error';
    failedCount++;
  }
}

// Main processing loop
async function processQueue(): Promise<void> {
  if (isProcessing) {
    return;
  }
  isProcessing = true;

  while (true) {
    const item = queue.find((q) => q.status === 'pending');
    if (!item) {
      break;
    }

    item.status = 'processing';
    currentStatusEl.textContent = `#${item.id}`;
    updateRow(item);
    updateStatusBar();

    // First try known keys
    if (tryKnownKeys(item)) {
      updateRow(item);
      updateStatusBar();
      updateKnownKeysDisplay();
      continue;
    }

    // Use the cracker (handles dictionary and brute force)
    await processItem(item);
    updateRow(item);
    updateStatusBar();
  }

  currentStatusEl.textContent = 'Idle';
  currentRate = 0;
  updateStatusBar();
  isProcessing = false;
}

// Convert bytes to hex string
function toHexString(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// Add packet to queue (called when receiving from serial)
async function addPacket(packetHex: string, maxLength: number): Promise<void> {
  const cleanHex = packetHex.trim().replace(/\s+/g, '').replace(/^0x/i, '').toLowerCase();

  if (!cleanHex || !/^[0-9a-fA-F]+$/.test(cleanHex)) {
    return;
  }

  try {
    const decoded = await MeshCorePacketDecoder.decodeWithVerification(cleanHex, {});
    const payload = decoded.payload?.decoded as {
      channelHash?: string;
      ciphertext?: string;
      cipherMac?: string;
    } | null;

    if (!payload?.channelHash || !payload?.ciphertext || !payload?.cipherMac) {
      return;
    }

    // Check for duplicates based on ciphertext (same message via different relay paths)
    if (seenPackets.has(payload.ciphertext)) {
      filteredCount++;
      filteredCountEl.textContent = String(filteredCount);
      return;
    }

    // Mark ciphertext as seen (even if ignored, so we don't re-process)
    seenPackets.add(payload.ciphertext);

    // Check if this packet is from an ignored room
    if (
      shouldIgnorePacket(payload.channelHash.toLowerCase(), payload.ciphertext, payload.cipherMac)
    ) {
      filteredCount++;
      filteredCountEl.textContent = String(filteredCount);
      return;
    }

    packetsReceived++;
    updatePacketsReceivedDisplay();

    const item: QueueItem = {
      id: nextId++,
      packetHex: cleanHex,
      status: 'pending',
      channelHash: payload.channelHash.toLowerCase(),
      ciphertext: payload.ciphertext,
      cipherMac: payload.cipherMac,
      maxLength,
    };

    queue.push(item);
    addRowToTable(item);
    updateStatusBar();

    processQueue();
  } catch {
    // Invalid packet, ignore
  }
}

// Update connection status UI
function updateConnectionStatus(status: 'disconnected' | 'connecting' | 'connected'): void {
  connectionStatusEl.className = `connection-status ${status}`;
  switch (status) {
    case 'disconnected':
      connectionStatusEl.textContent = 'Disconnected';
      connectBtn.disabled = false;
      disconnectBtn.disabled = true;
      radioName = null;
      lastPacketTime = null;
      updateLastPacketTimeDisplay();
      break;
    case 'connecting':
      connectionStatusEl.textContent = 'Connecting...';
      connectBtn.disabled = true;
      disconnectBtn.disabled = true;
      break;
    case 'connected':
      connectionStatusEl.textContent = radioName ? `Connected: ${radioName}` : 'Connected';
      connectBtn.disabled = true;
      disconnectBtn.disabled = false;
      break;
  }
}

// Setup serial event listeners
function setupSerialListeners(conn: typeof WebSerialConnection): void {
  // Listen for raw radio packets
  conn.on(Constants.PushCodes.LogRxData, async (data: { raw: Uint8Array }) => {
    // Update last packet time for any packet
    lastPacketTime = new Date();
    updateLastPacketTimeDisplay();

    try {
      const hexData = toHexString(data.raw);
      const decoded = MeshCorePacketDecoder.decode(hexData);

      // Only process GroupText packets for room discovery
      if (decoded.payloadType === PayloadType.GroupText) {
        const maxLength = parseInt(maxLengthInput.value) || 7;
        await addPacket(hexData, maxLength);
      }
    } catch {
      // Decoding failed, skip
    }
  });

  // Handle disconnection
  conn.on('disconnected', () => {
    updateConnectionStatus('disconnected');
    connection = null;
  });
}

// Connect to radio
async function connectToRadio(): Promise<void> {
  try {
    updateConnectionStatus('connecting');

    connection = await WebSerialConnection.open();
    if (!connection) {
      updateConnectionStatus('disconnected');
      return;
    }

    setupSerialListeners(connection);

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout')), 10000);
      connection.on('connected', async () => {
        clearTimeout(timeout);

        // Try to get radio name
        try {
          const selfInfo = await connection.getSelfInfo();
          if (selfInfo?.name) {
            radioName = selfInfo.name;
          }
        } catch {
          // Ignore errors getting self info
        }

        updateConnectionStatus('connected');

        try {
          await connection.syncDeviceTime();
        } catch {
          // Ignore time sync errors
        }
        resolve();
      });
    });
  } catch (e) {
    console.error('Connection error:', e);
    updateConnectionStatus('disconnected');
    if (connection) {
      try {
        connection.close();
      } catch {
        // Ignore close errors
      }
      connection = null;
    }
  }
}

// Disconnect from radio
function disconnectFromRadio(): void {
  if (connection) {
    connection.close();
    connection = null;
  }
  updateConnectionStatus('disconnected');
}

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  resultsBody = document.getElementById('results-body') as HTMLTableSectionElement;
  queueCountEl = document.getElementById('queue-count')!;
  currentStatusEl = document.getElementById('current-status')!;
  foundCountEl = document.getElementById('found-count')!;
  failedCountEl = document.getElementById('failed-count')!;
  filteredCountEl = document.getElementById('filtered-count')!;
  currentRateEl = document.getElementById('current-rate')!;
  knownKeysEl = document.getElementById('known-keys')!;
  knownKeysListEl = document.getElementById('known-keys-list')!;
  maxLengthInput = document.getElementById('max-length') as HTMLInputElement;
  noSleepBtn = document.getElementById('nosleep-btn') as HTMLButtonElement;
  connectBtn = document.getElementById('connect-btn') as HTMLButtonElement;
  disconnectBtn = document.getElementById('disconnect-btn') as HTMLButtonElement;
  connectionStatusEl = document.getElementById('connection-status')!;
  packetsReceivedEl = document.getElementById('packets-received')!;
  lastPacketTimeEl = document.getElementById('last-packet-time')!;

  // Load known keys from localStorage and update display
  loadKnownKeysFromStorage();
  updateKnownKeysDisplay();

  const crackerStatus = document.getElementById('cracker-status')!;
  const serialNotSupported = document.getElementById('serial-not-supported')!;

  // Check for Web Serial support
  if (!navigator.serial) {
    serialNotSupported.style.display = 'block';
    connectBtn.disabled = true;
  }

  // Filter toggles
  const timestampFilter = document.getElementById('timestamp-filter') as HTMLInputElement | null;
  const unicodeFilter = document.getElementById('unicode-filter') as HTMLInputElement | null;

  if (timestampFilter) {
    timestampFilter.checked = useTimestampFilter;
    timestampFilter.addEventListener('change', () => {
      useTimestampFilter = timestampFilter.checked;
    });
  }

  if (unicodeFilter) {
    unicodeFilter.checked = useUnicodeFilter;
    unicodeFilter.addEventListener('change', () => {
      useUnicodeFilter = unicodeFilter.checked;
    });
  }

  // Ignore rooms input
  const ignoreRoomsInput = document.getElementById('ignore-rooms') as HTMLInputElement | null;
  if (ignoreRoomsInput) {
    // Initialize with default values
    updateIgnoredRooms(ignoreRoomsInput.value);
    // Update on change
    ignoreRoomsInput.addEventListener('input', () => {
      updateIgnoredRooms(ignoreRoomsInput.value);
    });
  }

  // Auto-retry toggle
  const autoRetryCheckbox = document.getElementById('auto-retry') as HTMLInputElement | null;
  if (autoRetryCheckbox) {
    autoRetryCheckbox.checked = autoRetryEnabled;
    autoRetryCheckbox.addEventListener('change', () => {
      autoRetryEnabled = autoRetryCheckbox.checked;
      if (autoRetryEnabled && autoRetryIntervalId === null) {
        // Start checking every 2 seconds
        autoRetryIntervalId = window.setInterval(checkAutoRetry, 2000);
        // Also check immediately
        checkAutoRetry();
      } else if (!autoRetryEnabled && autoRetryIntervalId !== null) {
        clearInterval(autoRetryIntervalId);
        autoRetryIntervalId = null;
      }
    });
  }

  // Initialize cracker and load wordlist
  try {
    cracker = new GroupTextCracker();
    await cracker.loadWordlist('./words_alpha.txt');
    crackerStatus.textContent = 'Cracker: Ready';
    crackerStatus.classList.add('success');
  } catch (err) {
    console.error('Failed to initialize cracker:', err);
    crackerStatus.textContent = 'Cracker: Init failed';
    crackerStatus.classList.add('warning');
  }

  // Serial button handlers
  connectBtn.addEventListener('click', connectToRadio);
  disconnectBtn.addEventListener('click', disconnectFromRadio);

  // NoSleep button handler - must be in user event to work
  noSleep = new NoSleep();
  noSleepBtn.addEventListener('click', () => {
    if (noSleepEnabled) {
      noSleep!.disable();
      noSleepEnabled = false;
      noSleepBtn.textContent = 'Prevent Sleep';
    } else {
      noSleep!.enable();
      noSleepEnabled = true;
      noSleepBtn.textContent = 'Allow Sleep';
    }
  });
});
