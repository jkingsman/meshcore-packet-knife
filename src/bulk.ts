import { MeshCorePacketDecoder, ChannelCrypto } from '@michaelhart/meshcore-decoder';
import { GroupTextCracker, ProgressReport } from 'meshcore-hashtag-cracker';
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

let nextId = 1;
let isProcessing = false;
let cracker: GroupTextCracker | null = null;
let foundCount = 0;
let failedCount = 0;
let currentRate = 0;

// Filter settings
let useTimestampFilter = true;
let useUtf8Filter = true;
let useSenderFilter = true;

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

// Update known keys display
function updateKnownKeysDisplay(): void {
  const knownKeys = getKnownKeys();
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
      useUtf8Filter,
      useSenderFilter,
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
      // Save resume info for skip functionality
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
    if (tryKnownKeysOnItem(item)) {
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

  // Initialize cracker with bundled wordlist
  const crackerStatus = document.getElementById('cracker-status');
  cracker = new GroupTextCracker();
  cracker.setWordlist(ENGLISH_WORDLIST);

  if (crackerStatus) {
    crackerStatus.textContent = 'Cracker: Ready';
    crackerStatus.classList.add('success');
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
