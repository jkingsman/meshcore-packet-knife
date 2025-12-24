import {
  MeshCorePacketDecoder,
  Utils,
  DecodedPacket,
  PacketStructure,
  ChannelCrypto,
} from '@michaelhart/meshcore-decoder';
import { getGpuBruteForce, isWebGpuSupported, GpuBruteForce } from './gpu-bruteforce';
import {
  PUBLIC_ROOM_NAME,
  PUBLIC_KEY,
  roomNameToIndex,
  indexToRoomName,
  deriveKeyFromRoomName,
  getChannelHash,
  verifyMac,
  escapeHtml,
  isTimestampValid as coreIsTimestampValid,
  isValidUtf8 as coreIsValidUtf8,
  RoomNameGenerator,
} from './core';

// Brute force state
let bruteForceRunning = false;
let bruteForceAbort = false;
let savedTargetChannelHash = '';
let savedCiphertext = '';
let savedCipherMac = '';

// GPU state
let gpuInstance: GpuBruteForce | null = null;
let gpuAvailable = false;
let useGpu = true; // User preference
let useAutoTune = true; // Dynamically find optimal batch size
let useTimestampFilter = true; // Filter by timestamp (last month)
let useUnicodeFilter = true; // Filter invalid unicode characters

// Fixed batch size when auto-tune is disabled
const FIXED_BATCH_SIZE = 262144; // 256K - conservative default
const UPDATE_INTERVAL = 100; // ms - 10 updates per second

// Formatting helpers
function formatTime(seconds: number): string {
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}:${m.toString().padStart(2, '0')}:${Math.round(seconds % 60)
    .toString()
    .padStart(2, '0')}`;
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

function formatBatchSize(size: number): string {
  if (size >= 1048576) {
    return `${(size / 1048576).toFixed(1)}M`;
  }
  return `${(size / 1024).toFixed(0)}K`;
}

function getBatchInfo(currentBatchSize: number, batchSizeTuned: boolean): string {
  if (!useAutoTune) {
    return ` | Batch: ${formatBatchSize(FIXED_BATCH_SIZE)} (fixed)`;
  }
  return batchSizeTuned ? ` | Batch: ${formatBatchSize(currentBatchSize)}` : ' | Tuning...';
}

// Brute force UI state helpers
function getBruteForceElements() {
  return {
    statusEl: document.getElementById('brute-status')!,
    bruteBtn: document.getElementById('brute-btn') as HTMLButtonElement,
    skipBtn: document.getElementById('brute-skip-btn') as HTMLButtonElement,
  };
}

function startBruteForceUI() {
  const { bruteBtn, skipBtn } = getBruteForceElements();
  bruteForceRunning = true;
  bruteForceAbort = false;
  bruteBtn.disabled = false;
  bruteBtn.textContent = 'Stop';
  bruteBtn.classList.add('running');
  skipBtn.style.display = 'none';
}

function finishBruteForceUI(showSkip: boolean) {
  const { bruteBtn, skipBtn } = getBruteForceElements();
  bruteForceRunning = false;
  bruteBtn.textContent = 'Start';
  bruteBtn.classList.remove('running');
  skipBtn.style.display = showSkip ? 'inline-block' : 'none';
}

// Check if public key matches (returns result or null to continue)
function checkPublicKey(
  targetChannelHash: string,
  ciphertext: string,
  cipherMac: string,
  gpuMode: boolean,
): { found: true; roomName: string; key: string } | null {
  const { statusEl } = getBruteForceElements();
  const publicChannelHash = getChannelHash(PUBLIC_KEY);
  if (publicChannelHash === targetChannelHash) {
    if (verifyMac(ciphertext, cipherMac, PUBLIC_KEY)) {
      const modeInfo = gpuMode ? '<div class="stat">Mode: GPU accelerated</div>' : '';
      statusEl.innerHTML = `<div class="stat found">Found: ${PUBLIC_ROOM_NAME}</div>${modeInfo}`;
      finishBruteForceUI(true);
      saveResumePosition('a');
      return { found: true, roomName: PUBLIC_ROOM_NAME, key: PUBLIC_KEY };
    }
  }
  return null;
}

// Wrapper functions that respect filter toggle state
function isTimestampValid(timestamp: number): boolean {
  if (!useTimestampFilter) {
    return true;
  }
  return coreIsTimestampValid(timestamp);
}

function isValidUtf8(text: string): boolean {
  if (!useUnicodeFilter) {
    return true;
  }
  return coreIsValidUtf8(text);
}

// Verify MAC and optionally check timestamp and unicode
function verifyMacAndTimestamp(ciphertext: string, cipherMac: string, keyHex: string): boolean {
  if (!verifyMac(ciphertext, cipherMac, keyHex)) {
    return false;
  }

  if (!useTimestampFilter && !useUnicodeFilter) {
    return true;
  }

  // Decrypt and check filters
  const result = ChannelCrypto.decryptGroupTextMessage(ciphertext, cipherMac, keyHex);
  if (!result.success || !result.data) {
    return false;
  }

  if (useTimestampFilter && !isTimestampValid(result.data.timestamp)) {
    return false;
  }

  if (useUnicodeFilter && !isValidUtf8(result.data.message)) {
    return false;
  }

  return true;
}

// Get resume input element
function getResumeInput(): HTMLInputElement | null {
  return document.getElementById('resume-from') as HTMLInputElement | null;
}

// Save current position for resume
function saveResumePosition(roomName: string) {
  const resumeInput = getResumeInput();
  if (resumeInput) {
    resumeInput.value = roomName;
  }
}

async function bruteForce(
  targetChannelHash: string,
  ciphertext: string,
  cipherMac: string,
  startFrom?: string,
): Promise<{ found: boolean; roomName?: string; key?: string }> {
  const gen = new RoomNameGenerator();
  const { statusEl } = getBruteForceElements();

  // If starting from a specific position, advance generator
  if (startFrom) {
    const pos = roomNameToIndex(startFrom);
    if (pos) {
      gen.skipTo(pos.length, pos.index);
    }
  }

  let count = 0;
  const startTime = performance.now();
  let lastUpdate = performance.now();
  const BATCH_SIZE = 10000;

  // Save for potential resume
  savedTargetChannelHash = targetChannelHash;
  savedCiphertext = ciphertext;
  savedCipherMac = cipherMac;

  startBruteForceUI();

  // Check public key first (only on fresh start)
  if (!startFrom) {
    const publicResult = checkPublicKey(targetChannelHash, ciphertext, cipherMac, false);
    if (publicResult) {
      return publicResult;
    }
  }

  return new Promise((resolve) => {
    function processBatch() {
      if (bruteForceAbort) {
        saveResumePosition(gen.current());
        finish(false);
        return;
      }

      for (let i = 0; i < BATCH_SIZE; i++) {
        const roomName = gen.current();
        const key = deriveKeyFromRoomName('#' + roomName);
        const channelHash = getChannelHash(key);

        count++;

        if (channelHash === targetChannelHash) {
          if (verifyMacAndTimestamp(ciphertext, cipherMac, key)) {
            updateStatus(roomName, true);
            gen.nextValid();
            saveResumePosition(gen.current());
            finishBruteForceUI(true);
            resolve({ found: true, roomName, key });
            return;
          }
        }

        if (!gen.nextValid()) {
          finish(false);
          return;
        }
      }

      const now = performance.now();
      if (now - lastUpdate >= UPDATE_INTERVAL) {
        updateStatus(gen.current(), false);
        lastUpdate = now;
      }

      setTimeout(processBatch, 0);
    }

    function updateStatus(current: string, found: boolean) {
      const elapsed = (performance.now() - startTime) / 1000;
      const rate = Math.round(count / elapsed);
      const remaining = gen.getRemainingInLength();
      const etaSeconds = rate > 0 ? remaining / rate : 0;
      const pct =
        gen.getTotalForLength() > 0
          ? (((gen.getTotalForLength() - remaining) / gen.getTotalForLength()) * 100).toFixed(1)
          : '0';

      if (found) {
        statusEl.innerHTML =
          `<div class="stat found">Found: #${escapeHtml(current)}</div>` +
          `<div class="stat">Checked: ${count.toLocaleString()} keys in ${formatTime(elapsed)}</div>` +
          `<div class="stat">Rate: ${formatRate(rate)}</div>`;
      } else {
        statusEl.innerHTML =
          `<div class="stat">Current: #${escapeHtml(current)}</div>` +
          `<div class="stat">Elapsed: ${formatTime(elapsed)} | Checked: ${count.toLocaleString()} keys (${formatRate(rate)})</div>` +
          `<div class="stat">Length ${gen.getLength()}: ${pct}% complete, ~${formatTime(etaSeconds)} remaining</div>`;
      }
    }

    function finish(found: boolean, roomName?: string, key?: string) {
      const resumeInput = getResumeInput();
      finishBruteForceUI(!!resumeInput?.value);
      resolve({ found, roomName, key });
    }

    processBatch();
  });
}

// GPU-accelerated brute force
async function bruteForceGpu(
  targetChannelHash: string,
  ciphertext: string,
  cipherMac: string,
  startFrom?: string,
): Promise<{ found: boolean; roomName?: string; key?: string }> {
  if (!gpuInstance) {
    throw new Error('GPU not available');
  }

  const { statusEl } = getBruteForceElements();

  // Save for potential resume
  savedTargetChannelHash = targetChannelHash;
  savedCiphertext = ciphertext;
  savedCipherMac = cipherMac;

  startBruteForceUI();

  const startTime = performance.now();
  let totalChecked = 0;
  const targetHashByte = parseInt(targetChannelHash, 16);

  // Parse start position
  let startLength = 1;
  let startOffset = 0;
  if (startFrom) {
    const pos = roomNameToIndex(startFrom);
    if (pos) {
      startLength = pos.length;
      startOffset = pos.index;
    }
  }

  // Check public key first (only if starting from beginning)
  if (!startFrom) {
    const publicResult = checkPublicKey(targetChannelHash, ciphertext, cipherMac, true);
    if (publicResult) {
      return publicResult;
    }
  }

  // Auto-tuning parameters
  const INITIAL_BATCH_SIZE = 32768; // Start small (32K)
  const TARGET_DISPATCH_MS = 1000; // Target ~1s per dispatch
  const MIN_BATCH_SIZE = 32768; // Don't go below 32K
  let currentBatchSize = useAutoTune ? INITIAL_BATCH_SIZE : FIXED_BATCH_SIZE;
  let batchSizeTuned = !useAutoTune; // Skip tuning if disabled

  const UPDATE_INTERVAL = 100; // ms - 10 updates per second
  let lastUpdate = performance.now();
  let currentLength = startLength;
  let currentOffset = startOffset;

  // Iterate through lengths
  for (let length = startLength; length <= 20 && !bruteForceAbort; length++) {
    const totalForLength = gpuInstance.countNamesForLength(length);
    let offset = length === startLength ? startOffset : 0;

    while (offset < totalForLength && !bruteForceAbort) {
      currentLength = length;
      currentOffset = offset;
      const batchSize = Math.min(currentBatchSize, totalForLength - offset);

      // Time the GPU dispatch for auto-tuning
      const dispatchStart = performance.now();

      // Run GPU batch with MAC verification
      const matches = await gpuInstance.runBatch(
        targetHashByte,
        length,
        offset,
        batchSize,
        ciphertext,
        cipherMac,
      );

      const dispatchTime = performance.now() - dispatchStart;
      totalChecked += batchSize;

      // Auto-tune batch size after first full-sized dispatch
      // Only tune if we actually ran a full batch (not a partial at end of length)
      if (!batchSizeTuned && batchSize >= INITIAL_BATCH_SIZE && dispatchTime > 0) {
        // Calculate optimal batch size to hit target time
        const scaleFactor = TARGET_DISPATCH_MS / dispatchTime;
        const optimalBatchSize = Math.round(batchSize * scaleFactor);
        // Round to nearest power of 2, with minimum
        const rounded = Math.pow(
          2,
          Math.round(Math.log2(Math.max(MIN_BATCH_SIZE, optimalBatchSize))),
        );
        currentBatchSize = Math.max(MIN_BATCH_SIZE, rounded);
        batchSizeTuned = true;
        console.log(
          `GPU auto-tune: ${batchSize.toLocaleString()} keys in ${dispatchTime.toFixed(1)}ms ` +
            `(scale=${scaleFactor.toFixed(1)}x) → batch size ${currentBatchSize.toLocaleString()}`,
        );
      }

      // Verify MAC for each match (on CPU)
      for (const matchIdx of matches) {
        const roomName = gpuInstance.indexToRoomName(matchIdx, length);
        if (!roomName) {
          continue;
        }

        const key = deriveKeyFromRoomName('#' + roomName);
        if (verifyMacAndTimestamp(ciphertext, cipherMac, key)) {
          const elapsed = (performance.now() - startTime) / 1000;
          const rate = Math.round(totalChecked / elapsed);
          statusEl.innerHTML =
            `<div class="stat found">Found: #${escapeHtml(roomName)}</div>` +
            `<div class="stat">Mode: GPU accelerated${getBatchInfo(currentBatchSize, batchSizeTuned)}</div>` +
            `<div class="stat">Checked: ${totalChecked.toLocaleString()} keys in ${formatTime(elapsed)}</div>` +
            `<div class="stat">Rate: ${formatRate(rate)}</div>`;

          // Save next position after the found match for resume
          const nextName =
            indexToRoomName(length, matchIdx + 1) || indexToRoomName(length + 1, 0) || '';
          saveResumePosition(nextName);
          finishBruteForceUI(true);
          return { found: true, roomName, key };
        }
      }

      offset += batchSize;

      // Update status at most 10 times per second
      const now = performance.now();
      if (now - lastUpdate >= UPDATE_INTERVAL) {
        const elapsed = (now - startTime) / 1000;
        const rate = Math.round(totalChecked / elapsed);
        const remaining = totalForLength - offset;
        const etaSeconds = rate > 0 ? remaining / rate : 0;
        const pct = ((offset / totalForLength) * 100).toFixed(1);

        const batchInfo = getBatchInfo(currentBatchSize, batchSizeTuned);
        statusEl.innerHTML =
          `<div class="stat">Mode: GPU accelerated${batchInfo}</div>` +
          `<div class="stat">Elapsed: ${formatTime(elapsed)} | Checked: ${totalChecked.toLocaleString()} keys (${formatRate(rate)})</div>` +
          `<div class="stat">Length ${length}: ${pct}% complete, ~${formatTime(etaSeconds)} remaining</div>`;

        lastUpdate = now;

        // Yield to UI
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
  }

  // Save position if we were aborted
  if (bruteForceAbort) {
    const currentName = indexToRoomName(currentLength, currentOffset) || '';
    saveResumePosition(currentName);
  }

  const resumeInput = getResumeInput();
  finishBruteForceUI(!!resumeInput?.value);
  return { found: false };
}

function formatPayload(decoded: any, keyUsed: string | null, isEncryptedPayload: boolean): string {
  if (decoded.decrypted) {
    const keyInfo = keyUsed ? ` with key ${keyUsed.substring(0, 8)}...` : '';
    const timestamp = new Date(decoded.decrypted.timestamp * 1000).toISOString();
    const sender = decoded.decrypted.sender
      ? `<div class="field"><span class="field-name">Sender:</span> ${escapeHtml(decoded.decrypted.sender)}</div>`
      : '';

    return (
      `<div class="field success">Decrypted successfully${keyInfo}</div>` +
      `<div class="field"><span class="field-name">Timestamp:</span> ${timestamp}</div>` +
      sender +
      `<div class="field"><span class="field-name">Message:</span> ${escapeHtml(decoded.decrypted.message)}</div>`
    );
  }

  let html = '';

  if (keyUsed && isEncryptedPayload) {
    html +=
      '<div class="field warning">Decryption failed - key may be incorrect or channel hash mismatch</div>';
  }

  const blockFields = ['ciphertext', 'payload', 'rawPayload'];

  for (const [key, value] of Object.entries(decoded)) {
    if (key === 'segments') {
      continue;
    }

    let displayValue: string;
    if (typeof value === 'object' && value !== null) {
      displayValue = JSON.stringify(value, null, 2);
    } else if (key === 'timestamp' && typeof value === 'number' && value > 1000000000) {
      displayValue = `${new Date(value * 1000).toISOString()} (${value})`;
    } else {
      displayValue = String(value);
    }

    if (blockFields.includes(key)) {
      html += `<div class="field field-block"><span class="field-name">${escapeHtml(key)}:</span><span class="field-value">${escapeHtml(displayValue)}</span></div>`;
    } else {
      html += `<div class="field"><span class="field-name">${escapeHtml(key)}:</span> ${escapeHtml(displayValue)}</div>`;
    }
  }

  return html;
}

function formatOutput(
  packet: DecodedPacket,
  structure: PacketStructure,
  keyUsed: string | null,
): string {
  const isEncryptedPayload = Utils.getPayloadTypeName(packet.payloadType) === 'GroupText';

  const pathHtml = packet.path?.length
    ? `<div class="field"><span class="field-name">Path:</span> ${packet.path.join(' ')}</div>`
    : '';

  const isDecrypted = !!packet.payload?.decoded?.decrypted;
  const decodedPayloadHtml = packet.payload?.decoded
    ? `<div class="section${isDecrypted ? ' decrypted' : ''}">` +
      '<div class="section-title">Decoded Payload</div>' +
      formatPayload(packet.payload.decoded, keyUsed, isEncryptedPayload) +
      '</div>'
    : '';

  const errorsHtml =
    !packet.isValid && packet.errors
      ? '<div class="section">' +
        '<div class="section-title error">Validation Errors</div>' +
        packet.errors.map((err) => `<div class="field error">${escapeHtml(err)}</div>`).join('') +
        '</div>'
      : '';

  const leftCol =
    '<div class="section">' +
    '<div class="section-title">Packet Header</div>' +
    `<div class="field"><span class="field-name">Route Type:</span> ${Utils.getRouteTypeName(packet.routeType)}</div>` +
    `<div class="field"><span class="field-name">Payload Type:</span> ${Utils.getPayloadTypeName(packet.payloadType)}</div>` +
    `<div class="field"><span class="field-name">Version:</span> ${packet.payloadVersion}</div>` +
    `<div class="field"><span class="field-name">Message Hash:</span> ${packet.messageHash}</div>` +
    `<div class="field"><span class="field-name">Total Bytes:</span> ${packet.totalBytes}</div>` +
    pathHtml +
    '</div>' +
    decodedPayloadHtml +
    errorsHtml;

  const isBlockField = (name: string) =>
    /payload|ciphertext/i.test(name) && !/type|version|hash/i.test(name);

  const structureHtml = structure.segments?.length
    ? '<div class="section">' +
      '<div class="section-title">Structure Breakdown</div>' +
      structure.segments
        .map((seg) => {
          const titleAttr = seg.description ? ` title="${escapeHtml(seg.description)}"` : '';
          const headerFields =
            seg.headerBreakdown?.fields
              .map(
                (field) =>
                  '<div class="field" style="margin-left: 20px;">' +
                  `<span class="muted">bits ${field.bits}:</span> ${field.field} = ${escapeHtml(field.value)}` +
                  '</div>',
              )
              .join('') || '';

          if (isBlockField(seg.name)) {
            return (
              '<div class="field field-block">' +
              `<span class="field-name"${titleAttr}>[${seg.startByte}-${seg.endByte}] ${seg.name}:</span><span class="field-value">${escapeHtml(seg.value)}</span>` +
              '</div>' +
              headerFields
            );
          }
          return (
            '<div class="field">' +
            `<span class="field-name"${titleAttr}>[${seg.startByte}-${seg.endByte}] ${seg.name}:</span> ${escapeHtml(seg.value)}` +
            '</div>' +
            headerFields
          );
        })
        .join('') +
      '</div>'
    : '';

  const payloadBreakdownHtml = structure.payload?.segments?.length
    ? '<div class="section">' +
      `<div class="section-title">Payload Breakdown (${structure.payload.type})</div>` +
      structure.payload.segments
        .map((seg) => {
          const titleAttr = seg.description ? ` title="${escapeHtml(seg.description)}"` : '';
          if (isBlockField(seg.name)) {
            return (
              '<div class="field field-block">' +
              `<span class="field-name"${titleAttr}>[${seg.startByte}-${seg.endByte}] ${seg.name}:</span><span class="field-value">${escapeHtml(String(seg.value))}</span>` +
              '</div>'
            );
          }
          return (
            '<div class="field">' +
            `<span class="field-name"${titleAttr}>[${seg.startByte}-${seg.endByte}] ${seg.name}:</span> ${escapeHtml(String(seg.value))}` +
            '</div>'
          );
        })
        .join('') +
      '</div>'
    : '';

  const rightCol = structureHtml + payloadBreakdownHtml;

  return `<div class="columns"><div class="column">${leftCol}</div><div class="column">${rightCol}</div></div>`;
}

let lastPacket: DecodedPacket | null = null;
let autoDetectedPublic = false;

function updateRoomPrefix() {
  const roomInput = document.getElementById('room') as HTMLInputElement | null;
  const roomPrefix = document.querySelector('.room-prefix') as HTMLElement | null;
  if (roomInput && roomPrefix) {
    const isPublic = roomInput.value.trim() === PUBLIC_ROOM_NAME;
    roomPrefix.style.display = isPublic ? 'none' : '';
  }
}

async function analyze(): Promise<void> {
  const packetInput = document.getElementById('packet') as HTMLTextAreaElement;
  const keyInput = document.getElementById('key') as HTMLInputElement;
  const roomInput = document.getElementById('room') as HTMLInputElement;
  const outputEl = document.getElementById('output') as HTMLDivElement;
  const bruteBtn = document.getElementById('brute-btn') as HTMLButtonElement;

  const packetHex = packetInput.value.trim().replace(/\s+/g, '').replace(/^0x/i, '');

  if (!packetHex) {
    outputEl.style.display = 'none';
    bruteBtn.disabled = true;
    bruteBtn.textContent = 'Start';
    lastPacket = null;
    autoDetectedPublic = false;
    return;
  }

  outputEl.style.display = 'block';

  try {
    let channelKey = keyInput.value.trim().replace(/^0x/i, '') || null;

    // Auto-detect public key if no key is provided
    if (!channelKey && !autoDetectedPublic) {
      const testKeyStore = MeshCorePacketDecoder.createKeyStore({ channelSecrets: [PUBLIC_KEY] });
      const testPacket = await MeshCorePacketDecoder.decodeWithVerification(packetHex, {
        keyStore: testKeyStore,
      });

      if (testPacket.payload?.decoded?.decrypted) {
        // Public key works! Auto-populate
        channelKey = PUBLIC_KEY;
        keyInput.value = PUBLIC_KEY;
        roomInput.value = PUBLIC_ROOM_NAME;
        autoDetectedPublic = true;
        updateRoomPrefix();
      }
    }

    const keyStore = channelKey
      ? MeshCorePacketDecoder.createKeyStore({ channelSecrets: [channelKey] })
      : null;

    const structure = await MeshCorePacketDecoder.analyzeStructureWithVerification(packetHex, {
      keyStore,
    });
    const packet = await MeshCorePacketDecoder.decodeWithVerification(packetHex, { keyStore });

    lastPacket = packet;

    // Enable brute force button only for GroupText payloads
    // Don't change button state if brute force is running (user needs to be able to stop it)
    if (!bruteForceRunning) {
      const isGroupText = Utils.getPayloadTypeName(packet.payloadType) === 'GroupText';
      const isDecrypted = packet.payload?.decoded?.decrypted;
      bruteBtn.disabled = !isGroupText || !!isDecrypted;
      bruteBtn.textContent = isDecrypted ? 'Key already known!' : 'Start';
    }

    outputEl.innerHTML = formatOutput(packet, structure, channelKey);
  } catch (e) {
    outputEl.innerHTML = `<span class="error">Error: ${escapeHtml((e as Error).message)}</span>`;
    if (!bruteForceRunning) {
      bruteBtn.disabled = true;
      bruteBtn.textContent = 'Start';
    }
    lastPacket = null;
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const roomInput = document.getElementById('room') as HTMLInputElement;
  const keyInput = document.getElementById('key') as HTMLInputElement;
  const packetInput = document.getElementById('packet') as HTMLTextAreaElement;
  const bruteBtn = document.getElementById('brute-btn') as HTMLButtonElement;
  const statusEl = document.getElementById('brute-status')!;
  const gpuToggle = document.getElementById('gpu-toggle') as HTMLInputElement | null;
  const gpuStatus = document.getElementById('gpu-status') as HTMLElement | null;

  // Initialize GPU
  if (isWebGpuSupported()) {
    gpuInstance = await getGpuBruteForce();
    gpuAvailable = gpuInstance !== null;
  }

  // Update GPU status in UI
  if (gpuStatus) {
    if (gpuAvailable) {
      gpuStatus.textContent = 'GPU: Available';
      gpuStatus.classList.add('success');
    } else if (isWebGpuSupported()) {
      gpuStatus.textContent = 'GPU: Init failed';
      gpuStatus.classList.add('warning');
    } else {
      gpuStatus.textContent = 'GPU: Not supported';
      gpuStatus.classList.add('muted');
    }
  }

  // GPU toggle handler
  if (gpuToggle) {
    gpuToggle.checked = gpuAvailable && useGpu;
    gpuToggle.disabled = !gpuAvailable;
    gpuToggle.addEventListener('change', () => {
      useGpu = gpuToggle.checked;
    });
  }

  // Auto-tune toggle handler
  const autoTuneToggle = document.getElementById('auto-tune-toggle') as HTMLInputElement | null;
  if (autoTuneToggle) {
    autoTuneToggle.checked = useAutoTune;
    autoTuneToggle.addEventListener('change', () => {
      useAutoTune = autoTuneToggle.checked;
    });
  }

  // Timestamp filter toggle handler
  const timestampFilter = document.getElementById('timestamp-filter') as HTMLInputElement | null;
  if (timestampFilter) {
    timestampFilter.checked = useTimestampFilter;
    timestampFilter.addEventListener('change', () => {
      useTimestampFilter = timestampFilter.checked;
    });
  }

  // Unicode filter toggle handler
  const unicodeFilter = document.getElementById('unicode-filter') as HTMLInputElement | null;
  if (unicodeFilter) {
    unicodeFilter.checked = useUnicodeFilter;
    unicodeFilter.addEventListener('change', () => {
      useUnicodeFilter = unicodeFilter.checked;
    });
  }

  let isUpdatingFromRoom = false;

  roomInput.addEventListener('input', () => {
    const room = roomInput.value.trim();
    isUpdatingFromRoom = true;
    if (room === PUBLIC_ROOM_NAME) {
      keyInput.value = PUBLIC_KEY;
    } else if (room) {
      keyInput.value = deriveKeyFromRoomName('#' + room);
    } else {
      keyInput.value = '';
    }
    isUpdatingFromRoom = false;
    updateRoomPrefix();
    analyze();
  });

  const publicBtn = document.getElementById('public-btn') as HTMLButtonElement;
  publicBtn.addEventListener('click', () => {
    roomInput.value = PUBLIC_ROOM_NAME;
    keyInput.value = PUBLIC_KEY;
    updateRoomPrefix();
    analyze();
  });

  const demoBtn1 = document.getElementById('demo-btn-1') as HTMLButtonElement;
  demoBtn1.addEventListener('click', () => {
    packetInput.value =
      '150013CA60BF7C841CA46BFC7A23021C814FD3AA8DEC007457CD7A6733F2D1B8E99FCC1AFDEBC21B2D8A451342F8CE1370818E6308';
    roomInput.value = 'aa';
    keyInput.value = deriveKeyFromRoomName('#aa');
    updateRoomPrefix();
    analyze();
  });

  const demoBtn2 = document.getElementById('demo-btn-2') as HTMLButtonElement;
  demoBtn2.addEventListener('click', () => {
    packetInput.value =
      '1500E69C7A89DD0AF6A2D69F5823B88F9720731E4B887C56932BF889255D8D926D99195927144323A42DD8A158F878B518B8304DF55E80501C7D02A9FFD578D3518283156BBA257BF8413E80A237393B2E4149BBBC864371140A9BBC4E23EB9BF203EF0D029214B3E3AAC3C0295690ACDB89A28619E7E5F22C83E16073AD679D25FA904D07E5ACF1DB5A7C77D7E1719FB9AE5BF55541EE0D7F59ED890E12CF0FEED6700818';
    roomInput.value = '';
    keyInput.value = '';
    updateRoomPrefix();
    analyze();
  });

  keyInput.addEventListener('input', () => {
    if (!isUpdatingFromRoom) {
      roomInput.value = '';
      updateRoomPrefix();
    }
    analyze();
  });

  packetInput.addEventListener('input', () => {
    statusEl.innerHTML = '';
    autoDetectedPublic = false;
    analyze();
  });

  const resumeInput = document.getElementById('resume-from') as HTMLInputElement;

  bruteBtn.addEventListener('click', async () => {
    if (bruteForceRunning) {
      bruteForceAbort = true;
      return;
    }

    if (!lastPacket?.payload?.decoded) {
      return;
    }

    const decoded = lastPacket.payload.decoded as any;
    if (!decoded.channelHash || !decoded.ciphertext || !decoded.cipherMac) {
      return;
    }

    // Get resume position from input
    const startFrom = resumeInput.value.trim() || undefined;

    let result: { found: boolean; roomName?: string; key?: string };

    if (gpuAvailable && useGpu) {
      // Use GPU-accelerated brute force
      result = await bruteForceGpu(
        decoded.channelHash.toLowerCase(),
        decoded.ciphertext,
        decoded.cipherMac,
        startFrom,
      );
    } else {
      // Fall back to CPU brute force
      result = await bruteForce(
        decoded.channelHash.toLowerCase(),
        decoded.ciphertext,
        decoded.cipherMac,
        startFrom,
      );
    }

    if (result.found && result.roomName && result.key) {
      // Populate fields and re-analyze
      roomInput.value = result.roomName === PUBLIC_ROOM_NAME ? PUBLIC_ROOM_NAME : result.roomName;
      keyInput.value = result.key;
      analyze();
    }
  });

  const skipBtn = document.getElementById('brute-skip-btn') as HTMLButtonElement;
  skipBtn.addEventListener('click', async () => {
    if (bruteForceRunning) {
      return;
    }

    const startFrom = resumeInput.value.trim();
    if (!startFrom) {
      return;
    }

    // Clear the populated fields
    roomInput.value = '';
    keyInput.value = '';
    analyze();

    // Resume search from saved position
    let result: { found: boolean; roomName?: string; key?: string };

    if (gpuAvailable && useGpu) {
      result = await bruteForceGpu(
        savedTargetChannelHash,
        savedCiphertext,
        savedCipherMac,
        startFrom,
      );
    } else {
      result = await bruteForce(savedTargetChannelHash, savedCiphertext, savedCipherMac, startFrom);
    }

    if (result.found && result.roomName && result.key) {
      roomInput.value = result.roomName;
      keyInput.value = result.key;
      analyze();
    }
  });
});
