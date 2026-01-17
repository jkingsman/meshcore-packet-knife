import {
  MeshCorePacketDecoder,
  Utils,
  DecodedPacket,
  PacketStructure,
  GroupTextPayload,
  PayloadData,
} from '@michaelhart/meshcore-decoder';
import {
  GroupTextCracker,
  deriveKeyFromRoomName,
  PUBLIC_ROOM_NAME,
  PUBLIC_KEY,
  CrackResult,
  ProgressReport,
} from 'meshcore-hashtag-cracker';
import { ENGLISH_WORDLIST } from 'meshcore-hashtag-cracker/wordlist';
import { escapeHtml, formatTimeCompact, formatRate } from './utils';

// Cracker instance
let cracker: GroupTextCracker | null = null;

// Brute force state
let bruteForceRunning = false;
let savedPacketHex = '';
let lastResumeFrom = '';
let lastResumeType: 'dictionary' | 'bruteforce' | undefined;

// Filter options
let useTimestampFilter = true;
let useUtf8Filter = true;
let useSenderFilter = true;

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

// Run cracking with the library
async function runCracker(
  packetHex: string,
  startFrom?: string,
  startFromType?: 'dictionary' | 'bruteforce',
): Promise<CrackResult> {
  if (!cracker) {
    return { found: false };
  }

  const { statusEl } = getBruteForceElements();
  savedPacketHex = packetHex;
  startBruteForceUI();

  try {
    const result = await cracker.crack(
      packetHex,
      {
        maxLength: 20,
        useTimestampFilter,
        useUtf8Filter,
        useSenderFilter,
        startFrom,
        startFromType,
      },
      (progress: ProgressReport) => {
        // Update UI with progress
        const modeText =
          progress.phase === 'wordlist'
            ? `dict: ${escapeHtml(progress.currentPosition)}`
            : `GPU length ${progress.currentLength}`;
        // Sanity check ETA - if > 1 year, progress tracking is likely wrong
        const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;
        const etaReasonable = progress.etaSeconds < ONE_YEAR_SECONDS && progress.percent > 0;
        const progressLine = etaReasonable
          ? `<div class="stat">${progress.percent.toFixed(1)}% complete, ~${formatTimeCompact(progress.etaSeconds)} remaining</div>`
          : `<div class="stat">Searching length ${progress.currentLength}...</div>`;
        statusEl.innerHTML =
          `<div class="stat">Mode: ${modeText}</div>` +
          `<div class="stat">Elapsed: ${formatTimeCompact(progress.elapsedSeconds)} | Checked: ${progress.checked.toLocaleString()} keys (${formatRate(progress.rateKeysPerSec)})</div>` +
          progressLine;
      },
    );

    if (result.found && result.roomName && result.key) {
      statusEl.innerHTML =
        `<div class="stat found">Found: #${escapeHtml(result.roomName)}</div>` +
        `<div class="stat">Key: ${result.key}</div>`;
      // Save resume info for skip functionality
      lastResumeFrom = result.resumeFrom || result.roomName;
      lastResumeType = result.resumeType;
      saveResumePosition(lastResumeFrom);
      finishBruteForceUI(true);
      return result;
    }

    if (result.aborted) {
      saveResumePosition(result.resumeFrom || '');
      finishBruteForceUI(!!result.resumeFrom);
      return result;
    }

    // Not found
    finishBruteForceUI(false);
    statusEl.innerHTML = '<div class="stat warning">Room name not found within search limits</div>';
    return result;
  } catch (e) {
    finishBruteForceUI(false);
    statusEl.innerHTML = `<div class="stat error">Error: ${escapeHtml((e as Error).message)}</div>`;
    return { found: false, error: (e as Error).message };
  }
}

function formatPayload(
  decoded: PayloadData,
  keyUsed: string | null,
  isEncryptedPayload: boolean,
): string {
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
let lastPacketHex = '';
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
    lastPacketHex = '';
    autoDetectedPublic = false;
    lastResumeFrom = '';
    lastResumeType = undefined;
    return;
  }

  lastPacketHex = packetHex;
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

  // Initialize cracker with bundled wordlist
  const crackerStatus = document.getElementById('cracker-status');
  cracker = new GroupTextCracker();
  cracker.setWordlist(ENGLISH_WORDLIST);

  if (crackerStatus) {
    crackerStatus.textContent = 'Cracker: Ready';
    crackerStatus.classList.add('success');
  }

  // Timestamp filter toggle handler
  const timestampFilter = document.getElementById('timestamp-filter') as HTMLInputElement | null;
  if (timestampFilter) {
    timestampFilter.checked = useTimestampFilter;
    timestampFilter.addEventListener('change', () => {
      useTimestampFilter = timestampFilter.checked;
    });
  }

  // UTF-8 filter toggle handler
  const utf8Filter = document.getElementById('unicode-filter') as HTMLInputElement | null;
  if (utf8Filter) {
    utf8Filter.checked = useUtf8Filter;
    utf8Filter.addEventListener('change', () => {
      useUtf8Filter = utf8Filter.checked;
    });
  }

  // Sender filter toggle handler
  const senderFilter = document.getElementById('sender-filter') as HTMLInputElement | null;
  if (senderFilter) {
    senderFilter.checked = useSenderFilter;
    senderFilter.addEventListener('change', () => {
      useSenderFilter = senderFilter.checked;
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
      cracker?.abort();
      return;
    }

    if (!lastPacket?.payload?.decoded || !lastPacketHex) {
      return;
    }

    const decoded = lastPacket.payload.decoded as GroupTextPayload;
    if (!decoded.channelHash || !decoded.ciphertext || !decoded.cipherMac) {
      return;
    }

    // Get resume position from input
    const startFrom = resumeInput.value.trim() || undefined;

    const result = await runCracker(lastPacketHex, startFrom);

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

    if (!lastResumeFrom || !savedPacketHex) {
      return;
    }

    // Clear the populated fields
    roomInput.value = '';
    keyInput.value = '';
    analyze();

    // Resume search from the position after the false positive
    const result = await runCracker(savedPacketHex, lastResumeFrom, lastResumeType);

    if (result.found && result.roomName && result.key) {
      roomInput.value = result.roomName;
      keyInput.value = result.key;
      analyze();
    }
  });

  // Check for packet in URL query param (e.g., ?packet=ABCDEF1234...)
  const urlParams = new URLSearchParams(window.location.search);
  const packetFromUrl = urlParams.get('packet');
  if (packetFromUrl && /^[0-9a-fA-F]+$/.test(packetFromUrl)) {
    packetInput.value = packetFromUrl;
    const bruteSection = document.getElementById('brute-section') as HTMLDetailsElement;
    if (bruteSection) {
      bruteSection.open = true;
    }
    // Analyze and start room discovery
    await analyze();
    // Small delay to ensure UI is ready, then click brute force button
    setTimeout(() => {
      if (!bruteBtn.disabled) {
        bruteBtn.click();
      }
    }, 100);
  }
});
