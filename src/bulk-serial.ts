import { MeshCorePacketDecoder, ChannelCrypto, PayloadType } from '@michaelhart/meshcore-decoder';
// @ts-expect-error - meshcore.js doesn't have type definitions
import { WebSerialConnection, Constants } from '@liamcottle/meshcore.js';
import { getGpuBruteForce, isWebGpuSupported, GpuBruteForce } from './gpu-bruteforce';
import {
  PUBLIC_ROOM_NAME,
  PUBLIC_KEY,
  indexToRoomName,
  roomNameToIndex,
  deriveKeyFromRoomName,
  getChannelHash,
  verifyMac,
  escapeHtml,
  countNamesForLength,
  isTimestampValid as coreIsTimestampValid,
  isValidUtf8 as coreIsValidUtf8,
} from './core';

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
  startFromLength: number;
  startFromOffset: number;
  progressPercent?: number;
  totalCandidates?: number;
  checkedCount?: number;
  skipDictionary?: boolean;
  error?: string;
}

// State
const queue: QueueItem[] = [];
const knownKeys: Map<string, { roomName: string; key: string }> = new Map();
const seenPackets: Set<string> = new Set(); // For duplicate detection
let nextId = 1;
let isProcessing = false;
let gpuInstance: GpuBruteForce | null = null;
let foundCount = 0;
let failedCount = 0;
let currentRate = 0;
let packetsReceived = 0;

// Serial connection state
let connection: typeof WebSerialConnection | null = null;
let radioName: string | null = null;
let lastPacketTime: Date | null = null;

// Wordlist for dictionary attack
let wordlist: string[] = [];
let wordlistLoaded = false;

// Filter settings
let useTimestampFilter = true;
let useUnicodeFilter = true;

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

// Valid room name pattern: a-z, 0-9, dash (not at start/end, no consecutive)
const VALID_ROOM_CHARS = /^[a-z0-9-]+$/;
function isValidRoomName(word: string): boolean {
  if (!word || word.length === 0) {
    return false;
  }
  if (!VALID_ROOM_CHARS.test(word)) {
    return false;
  }
  if (word.startsWith('-') || word.endsWith('-')) {
    return false;
  }
  if (word.includes('--')) {
    return false;
  }
  return true;
}

// Load wordlist
async function loadWordlist(): Promise<void> {
  try {
    const response = await fetch('./words_alpha.txt');
    if (!response.ok) {
      console.warn('Failed to load wordlist:', response.status);
      return;
    }
    const text = await response.text();
    const allWords = text.split('\n').map((w) => w.trim().toLowerCase());
    // Filter to valid room names only
    wordlist = allWords.filter(isValidRoomName);
    wordlistLoaded = true;
    // Wordlist loaded successfully
  } catch (err) {
    console.warn('Error loading wordlist:', err);
  }
}

// DOM elements
let resultsBody: HTMLTableSectionElement;
let queueCountEl: HTMLElement;
let currentStatusEl: HTMLElement;
let foundCountEl: HTMLElement;
let failedCountEl: HTMLElement;
let currentRateEl: HTMLElement;
let knownKeysEl: HTMLElement;
let knownKeysListEl: HTMLElement;
let maxLengthInput: HTMLInputElement;
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
    .map(
      (k) =>
        `<div class="known-key-item">#${escapeHtml(k.roomName)} → ${k.key.substring(0, 16)}...</div>`,
    )
    .join('');
}

// Update status bar
function updateStatusBar(): void {
  queueCountEl.textContent = String(queue.filter((q) => q.status === 'pending').length);
  foundCountEl.textContent = String(foundCount);
  failedCountEl.textContent = String(failedCount);
  currentRateEl.textContent = currentRate > 0 ? formatRate(currentRate) : '-';
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

      // Check if we're in dictionary mode
      const inDictMode = item.testedUpTo?.startsWith('dict:');

      if (inDictMode) {
        const word = item.testedUpTo?.substring(5) || '';
        resultText = `Dictionary: ${escapeHtml(word)}...`;
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
          ? `Searching length ${item.testedUpToLength}`
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
  item.maxLength = (item.testedUpToLength || item.maxLength) + 1;
  item.startFromLength = (item.testedUpToLength || 1) + 1;
  item.startFromOffset = 0;
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
    knownKeys.delete(item.channelHash);
    updateKnownKeysDisplay();
  }

  // Resume from the position after the false positive
  if (item.roomName) {
    const pos = roomNameToIndex(item.roomName);
    if (pos) {
      item.startFromLength = pos.length;
      // Start from the next index after the false positive
      item.startFromOffset = pos.index + 1;
      // If we've exhausted this length, move to next
      if (item.startFromOffset >= countNamesForLength(pos.length)) {
        item.startFromLength = pos.length + 1;
        item.startFromOffset = 0;
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
      knownKeys.set(item.channelHash, { roomName: PUBLIC_ROOM_NAME, key: PUBLIC_KEY });
      return true;
    }
  }

  return false;
}

// Try dictionary attack on a packet
async function tryDictionary(item: QueueItem): Promise<boolean> {
  if (!wordlistLoaded || wordlist.length === 0 || item.skipDictionary) {
    return false;
  }

  const targetHashByte = parseInt(item.channelHash!, 16);
  const startTime = performance.now();
  let lastUpdate = performance.now();
  const totalWords = wordlist.length;

  for (let i = 0; i < totalWords; i++) {
    const word = wordlist[i];

    // Derive key and check channel hash first (fast filter)
    const key = deriveKeyFromRoomName('#' + word);
    const channelHash = getChannelHash(key);
    if (parseInt(channelHash, 16) !== targetHashByte) {
      continue;
    }

    // Channel hash matches, verify MAC and filters
    const result = verifyMacAndFilters(item.ciphertext!, item.cipherMac!, key);
    if (result.valid) {
      item.status = 'found';
      item.roomName = word;
      item.key = key;
      item.sender = result.sender;
      item.message = result.message;
      item.testedUpTo = `dict:${word}`;
      foundCount++;

      knownKeys.set(item.channelHash!, { roomName: word, key });
      updateKnownKeysDisplay();
      return true;
    }

    // Update UI periodically
    const now = performance.now();
    if (now - lastUpdate >= 200) {
      const elapsed = (now - startTime) / 1000;
      currentRate = Math.round(i / elapsed);
      item.testedUpTo = `dict:${word}`;
      item.progressPercent = (i / totalWords) * 100;
      updateRow(item);
      updateStatusBar();
      lastUpdate = now;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  return false;
}

// Process a single queue item with brute force
async function processItem(item: QueueItem): Promise<void> {
  if (!gpuInstance) {
    item.status = 'failed';
    item.error = 'GPU not available';
    item.testedUpTo = 'N/A';
    failedCount++;
    return;
  }

  const targetHashByte = parseInt(item.channelHash!, 16);
  const startTime = performance.now();
  let totalChecked = 0;
  let lastRateUpdate = performance.now();

  // Auto-tuning
  const INITIAL_BATCH_SIZE = 32768;
  const TARGET_DISPATCH_MS = 1000;
  let currentBatchSize = INITIAL_BATCH_SIZE;
  let batchSizeTuned = false;

  // Calculate total candidates for progress tracking
  let totalCandidates = 0;
  for (let l = item.startFromLength; l <= item.maxLength; l++) {
    totalCandidates += countNamesForLength(l);
  }
  // Subtract the offset we're starting from
  totalCandidates -= item.startFromOffset;
  item.totalCandidates = totalCandidates;

  for (let length = item.startFromLength; length <= item.maxLength; length++) {
    const totalForLength = countNamesForLength(length);
    // Use startFromOffset for the first length, then 0 for subsequent lengths
    let offset = length === item.startFromLength ? item.startFromOffset : 0;

    while (offset < totalForLength) {
      const batchSize = Math.min(currentBatchSize, totalForLength - offset);
      const dispatchStart = performance.now();

      const matches = await gpuInstance.runBatch(
        targetHashByte,
        length,
        offset,
        batchSize,
        item.ciphertext!,
        item.cipherMac!,
      );

      const dispatchTime = performance.now() - dispatchStart;
      totalChecked += batchSize;

      // Auto-tune
      if (!batchSizeTuned && batchSize >= INITIAL_BATCH_SIZE && dispatchTime > 0) {
        const scaleFactor = TARGET_DISPATCH_MS / dispatchTime;
        const optimalBatchSize = Math.round(batchSize * scaleFactor);
        const rounded = Math.pow(
          2,
          Math.round(Math.log2(Math.max(INITIAL_BATCH_SIZE, optimalBatchSize))),
        );
        currentBatchSize = Math.max(INITIAL_BATCH_SIZE, rounded);
        batchSizeTuned = true;
      }

      // Check matches
      for (const matchIdx of matches) {
        const roomName = indexToRoomName(length, matchIdx);
        if (!roomName) {
          continue;
        }

        const key = deriveKeyFromRoomName('#' + roomName);
        const result = verifyMacAndFilters(item.ciphertext!, item.cipherMac!, key);
        if (result.valid) {
          item.status = 'found';
          item.roomName = roomName;
          item.key = key;
          item.sender = result.sender;
          item.message = result.message;
          item.testedUpToLength = length;
          foundCount++;

          knownKeys.set(item.channelHash!, { roomName, key });
          updateKnownKeysDisplay();

          return;
        }
      }

      offset += batchSize;

      // Update rate periodically
      const now = performance.now();
      if (now - lastRateUpdate >= 200) {
        const elapsed = (now - startTime) / 1000;
        currentRate = Math.round(totalChecked / elapsed);
        item.testedUpTo =
          indexToRoomName(length, Math.min(offset, totalForLength - 1)) || item.testedUpTo;
        item.testedUpToLength = length;
        item.checkedCount = totalChecked;
        item.progressPercent =
          totalCandidates > 0 ? Math.min(100, (totalChecked / totalCandidates) * 100) : 0;
        updateRow(item);
        updateStatusBar();
        lastRateUpdate = now;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
  }

  // Not found
  item.status = 'failed';
  item.testedUpTo =
    indexToRoomName(item.maxLength, countNamesForLength(item.maxLength) - 1) ||
    `length ${item.maxLength}`;
  item.testedUpToLength = item.maxLength;
  failedCount++;
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

    // Try dictionary attack
    if (await tryDictionary(item)) {
      updateRow(item);
      updateStatusBar();
      continue;
    }

    // Mark dictionary as done so retries skip it
    item.skipDictionary = true;

    // Brute force
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
      return;
    }

    // Mark ciphertext as seen (even if ignored, so we don't re-process)
    seenPackets.add(payload.ciphertext);

    // Check if this packet is from an ignored room
    if (
      shouldIgnorePacket(payload.channelHash.toLowerCase(), payload.ciphertext, payload.cipherMac)
    ) {
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
      startFromLength: 1,
      startFromOffset: 0,
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
        const maxLength = parseInt(maxLengthInput.value) || 6;
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
  currentRateEl = document.getElementById('current-rate')!;
  knownKeysEl = document.getElementById('known-keys')!;
  knownKeysListEl = document.getElementById('known-keys-list')!;
  maxLengthInput = document.getElementById('max-length') as HTMLInputElement;
  connectBtn = document.getElementById('connect-btn') as HTMLButtonElement;
  disconnectBtn = document.getElementById('disconnect-btn') as HTMLButtonElement;
  connectionStatusEl = document.getElementById('connection-status')!;
  packetsReceivedEl = document.getElementById('packets-received')!;
  lastPacketTimeEl = document.getElementById('last-packet-time')!;

  const gpuStatus = document.getElementById('gpu-status')!;
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

  // Load wordlist and initialize GPU in parallel
  const [, gpuResult] = await Promise.all([
    loadWordlist(),
    isWebGpuSupported() ? getGpuBruteForce() : Promise.resolve(null),
  ]);
  gpuInstance = gpuResult;

  if (gpuInstance) {
    gpuStatus.textContent = 'GPU: Ready';
    gpuStatus.classList.add('success');
  } else if (isWebGpuSupported()) {
    gpuStatus.textContent = 'GPU: Init failed';
    gpuStatus.classList.add('warning');
  } else {
    gpuStatus.textContent = 'GPU: Not supported';
  }

  // Serial button handlers
  connectBtn.addEventListener('click', connectToRadio);
  disconnectBtn.addEventListener('click', disconnectFromRadio);
});
