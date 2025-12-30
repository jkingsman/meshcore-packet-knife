import { MeshCorePacketDecoder, Utils } from '@michaelhart/meshcore-decoder';
// @ts-expect-error - meshcore.js doesn't have type definitions
import { WebSerialConnection, Constants } from '@liamcottle/meshcore.js';
import { escapeHtml } from './core';

// Convert Uint8Array to hex string
function toHexString(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// DOM elements
let connectBtn: HTMLButtonElement;
let disconnectBtn: HTMLButtonElement;
let connectionStatusEl: HTMLElement;
let radioInfoEl: HTMLElement;
let packetCountEl: HTMLElement;
let clearBtn: HTMLButtonElement;
let autoScrollCheckbox: HTMLInputElement;
let packetBody: HTMLTableSectionElement;

// State
let connection: typeof WebSerialConnection | null = null;
let packetCount = 0;

// Update connection status UI
function updateConnectionStatus(status: 'disconnected' | 'connecting' | 'connected'): void {
  connectionStatusEl.className = `connection-status ${status}`;
  switch (status) {
    case 'disconnected':
      connectionStatusEl.textContent = 'Disconnected';
      connectBtn.disabled = false;
      disconnectBtn.disabled = true;
      break;
    case 'connecting':
      connectionStatusEl.textContent = 'Connecting...';
      connectBtn.disabled = true;
      disconnectBtn.disabled = true;
      break;
    case 'connected':
      connectionStatusEl.textContent = 'Connected';
      connectBtn.disabled = true;
      disconnectBtn.disabled = false;
      break;
  }
}

// Update packet count display
function updatePacketCount(): void {
  packetCountEl.textContent = `${packetCount} packet${packetCount !== 1 ? 's' : ''} received`;
}

// Get pill class based on payload type name
function getPayloadPillClass(payloadTypeName: string): string {
  const lower = payloadTypeName.toLowerCase();
  if (lower.includes('grouptext')) {
    return 'pill-grouptext';
  }
  if (lower.includes('advert')) {
    return 'pill-advert';
  }
  return 'pill-payload';
}

// Add a packet row to the table
function addPacketRow(hexData: string, timestamp: Date): void {
  // Remove empty state row if present
  const emptyRow = packetBody.querySelector('.empty-state-row');
  if (emptyRow) {
    emptyRow.remove();
  }

  let routeTypeName = 'Unknown';
  let payloadTypeName = 'Unknown';

  try {
    const decoded = MeshCorePacketDecoder.decode(hexData);
    routeTypeName = Utils.getRouteTypeName(decoded.routeType);
    payloadTypeName = Utils.getPayloadTypeName(decoded.payloadType);
  } catch {
    // Decoding failed, use defaults
  }

  const row = document.createElement('tr');

  // Timestamp cell
  const timeCell = document.createElement('td');
  timeCell.className = 'timestamp-col';
  timeCell.textContent = timestamp.toLocaleTimeString('en-US', { hour12: false });
  row.appendChild(timeCell);

  // Type pills cell
  const typeCell = document.createElement('td');
  typeCell.innerHTML =
    `<span class="pill pill-route">${escapeHtml(routeTypeName)}</span>` +
    `<span class="pill ${getPayloadPillClass(payloadTypeName)}">${escapeHtml(payloadTypeName)}</span>`;
  row.appendChild(typeCell);

  // Packet hex cell
  const hexCell = document.createElement('td');
  hexCell.className = 'packet-hex';
  hexCell.textContent = hexData;
  hexCell.title = hexData; // Full hex on hover
  row.appendChild(hexCell);

  // Action cell with analyze link
  const actionCell = document.createElement('td');
  const analyzeUrl = `./index.html?packet=${encodeURIComponent(hexData)}`;
  actionCell.innerHTML = `<a href="${analyzeUrl}" target="_blank" class="analyze-link">Analyze</a>`;
  row.appendChild(actionCell);

  packetBody.appendChild(row);
  packetCount++;
  updatePacketCount();

  // Auto-scroll if enabled
  if (autoScrollCheckbox.checked) {
    row.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }
}

// Clear all packets
function clearPackets(): void {
  packetBody.innerHTML =
    '<tr class="empty-state-row"><td colspan="4" class="empty-state">No packets received yet. Connect to a radio to start receiving packets.</td></tr>';
  packetCount = 0;
  updatePacketCount();
}

// Setup serial connection listeners
function setupSerialListeners(conn: typeof WebSerialConnection): void {
  // Listen for raw radio packets
  conn.on(Constants.PushCodes.LogRxData, (data: { raw: Uint8Array }) => {
    const hexData = toHexString(data.raw);
    addPacketRow(hexData, new Date());
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
        updateConnectionStatus('connected');

        // Fetch and display radio settings
        try {
          const selfInfo = await connection.getSelfInfo();
          if (selfInfo) {
            const freqMHz = (selfInfo.radioFreq / 1000).toFixed(3);
            const bwKHz = (selfInfo.radioBw / 1000).toFixed(1);
            const name = selfInfo.name || 'Unknown';
            radioInfoEl.textContent = `${name} | ${freqMHz} MHz | BW ${bwKHz} kHz | SF${selfInfo.radioSf} | CR${selfInfo.radioCr}`;
          }
        } catch {
          // Ignore errors fetching self info
        }

        // Sync device time
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
    try {
      connection.close();
    } catch {
      // Ignore close errors
    }
    connection = null;
  }
  updateConnectionStatus('disconnected');
  radioInfoEl.textContent = '';
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  connectBtn = document.getElementById('connect-btn') as HTMLButtonElement;
  disconnectBtn = document.getElementById('disconnect-btn') as HTMLButtonElement;
  connectionStatusEl = document.getElementById('connection-status')!;
  radioInfoEl = document.getElementById('radio-info')!;
  packetCountEl = document.getElementById('packet-count')!;
  clearBtn = document.getElementById('clear-btn') as HTMLButtonElement;
  autoScrollCheckbox = document.getElementById('auto-scroll') as HTMLInputElement;
  packetBody = document.getElementById('packet-body') as HTMLTableSectionElement;

  const serialNotSupported = document.getElementById('serial-not-supported')!;

  // Check for Web Serial support
  if (!navigator.serial) {
    serialNotSupported.style.display = 'block';
    connectBtn.disabled = true;
  }

  // Button handlers
  connectBtn.addEventListener('click', connectToRadio);
  disconnectBtn.addEventListener('click', disconnectFromRadio);
  clearBtn.addEventListener('click', clearPackets);

  updatePacketCount();
});
