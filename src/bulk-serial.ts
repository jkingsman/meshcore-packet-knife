import { MeshCorePacketDecoder, ChannelCrypto, PayloadType } from '@michaelhart/meshcore-decoder';
// @ts-expect-error - meshcore.js doesn't have type definitions
import { WebSerialConnection, Constants } from '@liamcottle/meshcore.js';
import NoSleep from 'nosleep.js';
import {
  GroupTextCracker,
  deriveKeyFromRoomName,
  getChannelHash,
  verifyMac,
  PUBLIC_ROOM_NAME,
  PUBLIC_KEY,
  ProgressReport,
} from 'meshcore-hashtag-cracker';
import { ENGLISH_WORDLIST } from 'meshcore-hashtag-cracker/wordlist';
import { escapeHtml, formatRate } from './utils';
import { renderQueueItemRow } from './render-utils';
import {
  loadKnownKeysFromStorage,
  getKnownKeys,
  addKnownKey,
  removeKnownKey,
  tryKnownKeys,
} from './known-keys';

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
  startFrom?: string;
  startFromType?: 'dictionary' | 'bruteforce';
  resumeFrom?: string;
  resumeType?: 'dictionary' | 'bruteforce';
  progressPercent?: number;
  totalCandidates?: number;
  checkedCount?: number;
  phase?: 'public-key' | 'wordlist' | 'bruteforce';
  error?: string;
}

// State
const queue: QueueItem[] = [];
const seenPackets: Set<string> = new Set(); // For duplicate detection

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
let useUtf8Filter = true;
let useSenderFilter = true;
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

// Update known keys display
function updateKnownKeysDisplay(): void {
  const knownKeys = getKnownKeys();
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
  const knownKeys = getKnownKeys();
  const existing = knownKeys.get(channelHash);
  if (existing) {
    console.log(`Room #${cleanName} already exists with key ${key}`);
    return;
  }

  // Add to known keys
  addKnownKey(channelHash, cleanName, key);
  updateKnownKeysDisplay();
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
  const knownKeys = getKnownKeys();
  const existing = knownKeys.get(channelHash);
  if (!existing) {
    console.log(`Room #${cleanName} not found in known keys`);
    return;
  }

  // Remove from known keys
  removeKnownKey(channelHash);
  updateKnownKeysDisplay();
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

// Render a single row (delegates to pure render-utils)
function renderRow(item: QueueItem): string {
  return renderQueueItemRow(item, currentRate);
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

  // Increase max length by 1, start from where we left off
  item.maxLength = (item.testedUpToLength || item.maxLength) + 1;
  // Use resume position if available, otherwise start at next length
  if (item.resumeFrom) {
    item.startFrom = item.resumeFrom;
    item.startFromType = item.resumeType;
  } else {
    const newStartLength = (item.testedUpToLength || 1) + 1;
    item.startFrom = 'a'.repeat(newStartLength);
    item.startFromType = 'bruteforce';
  }
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

  // Resume from after the false positive using library's resume info
  if (item.resumeFrom) {
    item.startFrom = item.resumeFrom;
    item.startFromType = item.resumeType;
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

// Try known keys on a packet (fast path - skips cracking if we already know the key)
function tryKnownKeysOnItem(item: QueueItem): boolean {
  if (!item.channelHash || !item.ciphertext || !item.cipherMac) {
    return false;
  }

  const match = tryKnownKeys(item.channelHash, item.ciphertext, item.cipherMac);
  if (match.found && match.roomName && match.key) {
    item.status = 'found';
    item.roomName = match.roomName;
    item.key = match.key;
    item.sender = match.sender;
    item.message = match.message;
    // Set resume info for skip functionality
    item.resumeFrom = match.roomName;
    item.resumeType = 'bruteforce';
    foundCount++;
    return true;
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
    const crackOptions = {
      maxLength: item.maxLength,
      useTimestampFilter,
      useUtf8Filter,
      useSenderFilter,
      startFrom: item.startFrom,
      startFromType: item.startFromType,
    };
    const result = await cracker.crack(item.packetHex, crackOptions, (progress: ProgressReport) => {
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
    });

    if (result.found && result.roomName && result.key) {
      item.status = 'found';
      item.roomName = result.roomName;
      item.key = result.key;
      item.testedUpToLength = result.roomName.length;
      // Save resume info for skip functionality
      item.resumeFrom = result.resumeFrom || result.roomName;
      item.resumeType = result.resumeType;

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
      // Save resume info for retry functionality
      item.resumeFrom = result.resumeFrom;
      item.resumeType = result.resumeType;
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
    if (tryKnownKeysOnItem(item)) {
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
  const cleanHex = packetHex.trim().replace(/\s+/g, '').replace(/^0x/i, '');

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
  const utf8Filter = document.getElementById('unicode-filter') as HTMLInputElement | null;

  if (timestampFilter) {
    timestampFilter.checked = useTimestampFilter;
    timestampFilter.addEventListener('change', () => {
      useTimestampFilter = timestampFilter.checked;
    });
  }

  if (utf8Filter) {
    utf8Filter.checked = useUtf8Filter;
    utf8Filter.addEventListener('change', () => {
      useUtf8Filter = utf8Filter.checked;
    });
  }

  // Sender filter toggle
  const senderFilter = document.getElementById('sender-filter') as HTMLInputElement | null;
  if (senderFilter) {
    senderFilter.checked = useSenderFilter;
    senderFilter.addEventListener('change', () => {
      useSenderFilter = senderFilter.checked;
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

  // Initialize cracker with bundled wordlist
  cracker = new GroupTextCracker();
  cracker.setWordlist(ENGLISH_WORDLIST);

  crackerStatus.textContent = 'Cracker: Ready';
  crackerStatus.classList.add('success');

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
