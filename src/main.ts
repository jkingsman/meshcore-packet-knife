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
let useTimestampFilter = true; // Filter by timestamp (last month)
let useUnicodeFilter = true; // Filter invalid unicode characters

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
  const statusEl = document.getElementById('brute-status')!;
  const bruteBtn = document.getElementById('brute-btn') as HTMLButtonElement;
  const skipBtn = document.getElementById('brute-skip-btn') as HTMLButtonElement;

  // If starting from a specific position, advance generator
  if (startFrom) {
    const pos = roomNameToIndex(startFrom);
    if (pos) {
      gen.skipTo(pos.length, pos.index);
    }
  }

  let count = 0;
  let hashMatches = 0;
  const startTime = performance.now();
  let lastUpdate = performance.now();
  const BATCH_SIZE = 10000; // Larger batches since we update less frequently
  const UPDATE_INTERVAL = 100; // ms - 10 updates per second

  // Save for potential resume
  savedTargetChannelHash = targetChannelHash;
  savedCiphertext = ciphertext;
  savedCipherMac = cipherMac;

  bruteForceRunning = true;
  bruteForceAbort = false;
  bruteBtn.disabled = false;
  bruteBtn.textContent = 'Stop';
  bruteBtn.classList.add('running');
  skipBtn.style.display = 'none';

  // Check public key first (only on fresh start)
  if (!startFrom) {
    const publicChannelHash = getChannelHash(PUBLIC_KEY);
    if (publicChannelHash === targetChannelHash) {
      if (verifyMac(ciphertext, cipherMac, PUBLIC_KEY)) {
        statusEl.innerHTML = `<div class="stat found">Found: ${PUBLIC_ROOM_NAME}</div>`;
        bruteForceRunning = false;
        bruteBtn.textContent = 'Start';
        bruteBtn.classList.remove('running');
        skipBtn.style.display = 'inline-block';
        saveResumePosition('a'); // Next position after public key check
        return Promise.resolve({ found: true, roomName: PUBLIC_ROOM_NAME, key: PUBLIC_KEY });
      }
    }
  }

  return new Promise((resolve) => {
    function processBatch() {
      if (bruteForceAbort) {
        // Save current position for resume
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
          hashMatches++;
          // Potential match - verify MAC and optionally timestamp
          if (verifyMacAndTimestamp(ciphertext, cipherMac, key)) {
            updateStatus(roomName, count, hashMatches, startTime, gen, true);
            // Save next position for skip/resume
            gen.nextValid();
            saveResumePosition(gen.current());
            finishFound(roomName, key);
            return;
          }
        }

        if (!gen.nextValid()) {
          // Exhausted all possibilities (shouldn't happen in practice)
          finish(false);
          return;
        }
      }

      const now = performance.now();
      if (now - lastUpdate >= UPDATE_INTERVAL) {
        updateStatus(gen.current(), count, hashMatches, startTime, gen, false);
        lastUpdate = now;
      }

      // Yield to UI
      setTimeout(processBatch, 0);
    }

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
      if (rate >= 1000) {
        return `${(rate / 1000).toFixed(1)} kkeys/s`;
      }
      return `${rate} keys/s`;
    }

    function updateStatus(
      current: string,
      total: number,
      _matches: number,
      start: number,
      g: RoomNameGenerator,
      found: boolean,
    ) {
      const elapsed = (performance.now() - start) / 1000;
      const rate = Math.round(total / elapsed);
      const remaining = g.getRemainingInLength();
      const etaSeconds = rate > 0 ? remaining / rate : 0;
      const pct =
        g.getTotalForLength() > 0
          ? (((g.getTotalForLength() - remaining) / g.getTotalForLength()) * 100).toFixed(1)
          : '0';

      if (found) {
        statusEl.innerHTML =
          `<div class="stat found">Found: #${escapeHtml(current)}</div>` +
          `<div class="stat">Checked: ${total.toLocaleString()} keys in ${formatTime(elapsed)}</div>` +
          `<div class="stat">Rate: ${formatRate(rate)}</div>`;
      } else {
        statusEl.innerHTML =
          `<div class="stat">Current: #${escapeHtml(current)}</div>` +
          `<div class="stat">Elapsed: ${formatTime(elapsed)} | Checked: ${total.toLocaleString()} keys (${formatRate(rate)})</div>` +
          `<div class="stat">Length ${g.getLength()}: ${pct}% complete, ~${formatTime(etaSeconds)} remaining</div>`;
      }
    }

    function finishFound(roomName: string, key: string) {
      bruteForceRunning = false;
      bruteBtn.textContent = 'Start';
      bruteBtn.classList.remove('running');
      skipBtn.style.display = 'inline-block';
      resolve({ found: true, roomName, key });
    }

    function finish(found: boolean, roomName?: string, key?: string) {
      bruteForceRunning = false;
      bruteBtn.textContent = 'Start';
      bruteBtn.classList.remove('running');
      // Show skip button if we stopped mid-search (resume field has a value)
      const resumeInput = getResumeInput();
      skipBtn.style.display = resumeInput?.value ? 'inline-block' : 'none';
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

  const statusEl = document.getElementById('brute-status')!;
  const bruteBtn = document.getElementById('brute-btn') as HTMLButtonElement;
  const skipBtn = document.getElementById('brute-skip-btn') as HTMLButtonElement;

  bruteForceRunning = true;
  bruteForceAbort = false;
  bruteBtn.disabled = false;
  bruteBtn.textContent = 'Stop';
  bruteBtn.classList.add('running');
  skipBtn.style.display = 'none';

  // Save for potential resume
  savedTargetChannelHash = targetChannelHash;
  savedCiphertext = ciphertext;
  savedCipherMac = cipherMac;

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
    const publicChannelHash = getChannelHash(PUBLIC_KEY);
    if (publicChannelHash === targetChannelHash) {
      if (verifyMac(ciphertext, cipherMac, PUBLIC_KEY)) {
        statusEl.innerHTML =
          `<div class="stat found">Found: ${PUBLIC_ROOM_NAME}</div>` +
          '<div class="stat">Mode: GPU accelerated</div>';
        bruteForceRunning = false;
        bruteBtn.textContent = 'Start';
        bruteBtn.classList.remove('running');
        skipBtn.style.display = 'inline-block';
        saveResumePosition('a');
        return { found: true, roomName: PUBLIC_ROOM_NAME, key: PUBLIC_KEY };
      }
    }
  }

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
    if (rate >= 1000000) {
      return `${(rate / 1000000).toFixed(2)} Mkeys/s`;
    }
    if (rate >= 1000) {
      return `${(rate / 1000).toFixed(1)} kkeys/s`;
    }
    return `${rate} keys/s`;
  }

  const GPU_BATCH_SIZE = 65536; // 64k items per GPU dispatch
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
      const batchSize = Math.min(GPU_BATCH_SIZE, totalForLength - offset);

      // Run GPU batch with MAC verification
      const matches = await gpuInstance.runBatch(
        targetHashByte,
        length,
        offset,
        batchSize,
        ciphertext,
        cipherMac,
      );

      totalChecked += batchSize;

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
            '<div class="stat">Mode: GPU accelerated</div>' +
            `<div class="stat">Checked: ${totalChecked.toLocaleString()} keys in ${formatTime(elapsed)}</div>` +
            `<div class="stat">Rate: ${formatRate(rate)}</div>`;

          bruteForceRunning = false;
          bruteBtn.textContent = 'Start';
          bruteBtn.classList.remove('running');
          skipBtn.style.display = 'inline-block';
          // Save next position after the found match for resume
          const nextName =
            indexToRoomName(length, matchIdx + 1) || indexToRoomName(length + 1, 0) || '';
          saveResumePosition(nextName);
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

        statusEl.innerHTML =
          '<div class="stat">Mode: GPU accelerated</div>' +
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

  bruteForceRunning = false;
  bruteBtn.textContent = 'Start';
  bruteBtn.classList.remove('running');
  // Show skip if we stopped mid-search
  const resumeInput = getResumeInput();
  skipBtn.style.display = resumeInput?.value ? 'inline-block' : 'none';
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

  const decodedPayloadHtml = packet.payload?.decoded
    ? '<div class="section">' +
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
    }

    outputEl.innerHTML = formatOutput(packet, structure, channelKey);
  } catch (e) {
    outputEl.innerHTML = `<span class="error">Error: ${escapeHtml((e as Error).message)}</span>`;
    if (!bruteForceRunning) {
      bruteBtn.disabled = true;
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

  const demoBtn = document.getElementById('demo-btn') as HTMLButtonElement;
  demoBtn.addEventListener('click', () => {
    packetInput.value =
      '150013CA60BF7C841CA46BFC7A23021C814FD3AA8DEC007457CD7A6733F2D1B8E99FCC1AFDEBC21B2D8A451342F8CE1370818E6308';
    roomInput.value = 'aa';
    keyInput.value = deriveKeyFromRoomName('#aa');
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
