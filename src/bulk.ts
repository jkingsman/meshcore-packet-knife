import { MeshCorePacketDecoder, ChannelCrypto } from '@michaelhart/meshcore-decoder';
import {
  GroupTextCracker,
  PUBLIC_ROOM_NAME,
  PUBLIC_KEY,
  getChannelHash,
  verifyMac,
  isTimestampValid as coreIsTimestampValid,
  isValidUtf8 as coreIsValidUtf8,
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
const knownKeys: Map<string, { roomName: string; key: string }> = new Map();

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
let currentRate = 0;

// Filter settings
let useTimestampFilter = true;
let useUnicodeFilter = true;

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
  // Library v1.2.0+: startFrom means "start AFTER" (exclusive), and resumeFrom is set on success
  if (item.resumeFrom) {
    item.startFrom = item.resumeFrom;
    item.startFromType = item.resumeType;
  }

  // Clear the cracked result
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
      // Set resume info for skip functionality
      item.resumeFrom = known.roomName;
      item.resumeType = 'bruteforce';
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
      // Set resume info for skip functionality
      item.resumeFrom = PUBLIC_ROOM_NAME;
      item.resumeType = 'bruteforce';
      foundCount++;
      addKnownKey(item.channelHash, PUBLIC_ROOM_NAME, PUBLIC_KEY);
      return true;
    }
  }

  return false;
}

// Process a single queue item using the cracker library
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
      useUtf8Filter: useUnicodeFilter,
      startFrom: item.startFrom,
      startFromType: item.startFromType,
    };
    const result = await cracker.crack(item.packetHex, crackOptions, (progress: ProgressReport) => {
      currentRate = progress.rateKeysPerSec;
      item.testedUpToLength = progress.currentLength;
      item.progressPercent = progress.percent;
      item.checkedCount = progress.checked;
      item.totalCandidates = progress.total;
      item.testedUpTo = progress.currentPosition;
      item.phase = progress.phase;
      updateRow(item);
      updateStatusBar();
    });

    if (result.found && result.roomName && result.key) {
      // Decrypt to get sender/message
      const decrypted = ChannelCrypto.decryptGroupTextMessage(
        item.ciphertext!,
        item.cipherMac!,
        result.key,
      );

      item.status = 'found';
      item.roomName = result.roomName;
      item.key = result.key;
      item.testedUpToLength = result.roomName.length;
      // Save resume info for skip functionality - use values from library result
      item.resumeFrom = result.resumeFrom || result.roomName;
      item.resumeType = result.resumeType;
      if (decrypted.success && decrypted.data) {
        item.sender = decrypted.data.sender;
        item.message = decrypted.data.message;
      }
      foundCount++;
      addKnownKey(item.channelHash!, result.roomName, result.key);
    } else {
      item.status = 'failed';
      item.testedUpToLength = item.maxLength;
      // Save resume info for retry functionality
      item.resumeFrom = result.resumeFrom;
      item.resumeType = result.resumeType;
      failedCount++;
    }
  } catch (e) {
    item.status = 'failed';
    item.error = (e as Error).message;
    item.testedUpToLength = item.maxLength;
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

    // First try known keys (fast local lookup)
    if (tryKnownKeys(item)) {
      updateRow(item);
      updateStatusBar();
      updateKnownKeysDisplay();
      continue;
    }

    // Use the cracker library for dictionary + brute force
    await processItem(item);
    updateRow(item);
    updateStatusBar();
  }

  currentStatusEl.textContent = 'Idle';
  currentRate = 0;
  updateStatusBar();
  isProcessing = false;
}

// Add packet to queue
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

  // Load known keys from localStorage and update display
  loadKnownKeysFromStorage();
  updateKnownKeysDisplay();

  const packetInput = document.getElementById('packet-input') as HTMLTextAreaElement;
  const addBtn = document.getElementById('add-btn') as HTMLButtonElement;

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

  // Initialize cracker
  const crackerStatus = document.getElementById('cracker-status');
  cracker = new GroupTextCracker();

  // Load wordlist for dictionary attacks
  try {
    await cracker.loadWordlist('./words_alpha.txt');
    if (crackerStatus) {
      crackerStatus.textContent = 'Cracker: Ready';
      crackerStatus.classList.add('success');
    }
  } catch {
    if (crackerStatus) {
      crackerStatus.textContent = 'Cracker: Ready (no wordlist)';
      crackerStatus.classList.add('warning');
    }
  }

  // Add button handler
  addBtn.addEventListener('click', () => {
    const value = packetInput.value.trim();
    const maxLength = parseInt(maxLengthInput.value) || 6;
    if (value) {
      const packets = value.split('\n').filter((p) => p.trim());
      for (const packet of packets) {
        addPacket(packet, maxLength);
      }
      packetInput.value = '';
    }
  });

  // Enter key handler
  packetInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      addBtn.click();
    }
  });

  // Check for packet in URL
  const urlParams = new URLSearchParams(window.location.search);
  const packetFromUrl = urlParams.get('packet');
  if (packetFromUrl) {
    const maxLength = parseInt(maxLengthInput.value) || 6;
    addPacket(packetFromUrl, maxLength);
  }
});
