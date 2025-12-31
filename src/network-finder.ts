// @ts-expect-error - meshcore.js doesn't have type definitions
import { WebSerialConnection, Constants } from '@liamcottle/meshcore.js';

// Convert Uint8Array to hex string
function toHexString(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// Scan configurations
interface ScanConfig {
  name: string;
  description: string;
  frequencies: { freq: number; label: string }[];
  bandwidths: number[];
  spreadingFactors: number[];
}

const SCAN_CONFIGS: Record<string, ScanConfig> = {
  test: {
    name: 'Test Scan',
    description: 'Quick test with common USA frequencies',
    frequencies: [
      { freq: 910.525, label: 'USA/CAN Recommended' },
      { freq: 927.875, label: 'SoCal' },
    ],
    bandwidths: [62.5, 125, 250],
    spreadingFactors: [6, 7],
  },
  amer: {
    name: 'Americas Scan',
    description: 'Comprehensive scan of Americas frequencies',
    frequencies: [
      { freq: 907.875, label: 'Texas' },
      { freq: 910.525, label: 'USA/CAN/TX/CO' },
      { freq: 927.875, label: 'SoCal' },
    ],
    bandwidths: [7.8, 10.4, 15.6, 20.8, 31.25, 41.7, 62.5, 125, 250, 500],
    spreadingFactors: [5, 6, 7, 8, 9, 10, 11, 12],
  },
  global: {
    name: 'Global Scan',
    description: 'Full global frequency scan',
    frequencies: [
      { freq: 869.525, label: 'EU/UK Long/Medium, Czech' },
      { freq: 869.618, label: 'EU/UK Narrow, Portugal' },
      { freq: 907.875, label: 'Texas' },
      { freq: 910.525, label: 'USA/CAN/TX/CO' },
      { freq: 915.8, label: 'Australia' },
      { freq: 916.575, label: 'Australia VIC' },
      { freq: 917.375, label: 'NZ/NZ Narrow' },
      { freq: 920.25, label: 'Vietnam' },
      { freq: 927.875, label: 'SoCal' },
    ],
    bandwidths: [7.8, 10.4, 15.6, 20.8, 31.25, 41.7, 62.5, 125, 250, 500],
    spreadingFactors: [5, 6, 7, 8, 9, 10, 11, 12],
  },
};

// Scan info descriptions for the info box
const SCAN_INFO: Record<string, string> = {
  test: `<h4>Test Scan</h4>
<ul>
  <li><strong>Frequencies:</strong> 910.525 MHz (USA/CAN), 927.875 MHz (SoCal)</li>
  <li><strong>Bandwidths:</strong> 62.5, 125, 250 kHz</li>
  <li><strong>Spreading Factors:</strong> 6, 7</li>
</ul>`,
  amer: `<h4>Americas Scan</h4>
<ul>
  <li><strong>Frequencies:</strong> 907.875 (TX), 910.525 (USA/CAN/TX/CO), 927.875 (SoCal) MHz</li>
  <li><strong>Bandwidths:</strong> 7.8, 10.4, 15.6, 20.8, 31.25, 41.7, 62.5, 125, 250, 500 kHz</li>
  <li><strong>Spreading Factors:</strong> 5-12</li>
</ul>`,
  global: `<h4>Global Scan</h4>
<ul>
  <li><strong>Frequencies:</strong> EU/UK (869.525, 869.618), Americas (907.875, 910.525, 927.875), AUS (915.8, 916.575), NZ (917.375), Vietnam (920.25) MHz</li>
  <li><strong>Bandwidths:</strong> 7.8, 10.4, 15.6, 20.8, 31.25, 41.7, 62.5, 125, 250, 500 kHz</li>
  <li><strong>Spreading Factors:</strong> 5-12</li>
</ul>`,
};

// Generate all combinations for a scan config
interface Combination {
  freq: number;
  freqLabel: string;
  bw: number;
  sf: number;
}

function generateCombinations(config: ScanConfig): Combination[] {
  const combos: Combination[] = [];
  for (const freqInfo of config.frequencies) {
    for (const bw of config.bandwidths) {
      for (const sf of config.spreadingFactors) {
        combos.push({
          freq: freqInfo.freq,
          freqLabel: freqInfo.label,
          bw,
          sf,
        });
      }
    }
  }
  return combos;
}

// Build custom scan config from user inputs
function buildCustomScanConfig(): ScanConfig {
  const freqFrom = parseFloat(customFreqFromInput?.value) || 900;
  const freqTo = parseFloat(customFreqToInput?.value) || 930;
  const freqStep = parseFloat(customFreqStepInput?.value) || 0.25;

  // Generate frequencies from range
  const frequencies: { freq: number; label: string }[] = [];
  for (let freq = freqFrom; freq <= freqTo + 0.0001; freq += freqStep) {
    const roundedFreq = Math.round(freq * 1000) / 1000; // Round to 3 decimal places
    frequencies.push({ freq: roundedFreq, label: `${roundedFreq} MHz` });
  }

  // Parse bandwidths
  const bwStr =
    customBandwidthsInput?.value || '7.8, 10.4, 15.6, 20.8, 31.25, 41.7, 62.5, 125, 250, 500';
  const bandwidths = bwStr
    .split(',')
    .map((s) => parseFloat(s.trim()))
    .filter((n) => !isNaN(n) && n > 0);

  // Parse spreading factors
  const sfStr = customSfsInput?.value || '5, 6, 7, 8, 9, 10, 11, 12';
  const spreadingFactors = sfStr
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n) && n >= 5 && n <= 12);

  return {
    name: 'Custom Scan',
    description: 'User-defined frequency range and parameters',
    frequencies: frequencies.length > 0 ? frequencies : [{ freq: 915, label: '915 MHz' }],
    bandwidths: bandwidths.length > 0 ? bandwidths : [125],
    spreadingFactors: spreadingFactors.length > 0 ? spreadingFactors : [7],
  };
}

// Get combo count for custom scan (for display)
function getCustomComboCount(): number {
  const config = buildCustomScanConfig();
  return config.frequencies.length * config.bandwidths.length * config.spreadingFactors.length;
}

// Update custom combo count display
function updateCustomComboCount(): void {
  if (customComboCountEl) {
    const count = getCustomComboCount();
    customComboCountEl.textContent = `${count} combinations`;
  }
  if (currentScanType === 'custom') {
    updateEstimatedTime();
  }
}

// Found network tracking
interface FoundNetwork {
  freq: number;
  bw: number;
  sf: number;
  packetCount: number;
  firstSeen: Date;
  lastSeen: Date;
}

// DOM elements
let connectBtn: HTMLButtonElement;
let disconnectBtn: HTMLButtonElement;
let connectionStatusEl: HTMLElement;
let scanBtn: HTMLButtonElement;
let lingerTimeInput: HTMLInputElement;
let estimatedTimeEl: HTMLElement;
let scanInfoEl: HTMLElement;
let scanStatusBar: HTMLElement;
let timeRunningEl: HTMLElement;
let currentComboEl: HTMLElement;
let comboProgressEl: HTMLElement;
let progressFillEl: HTMLElement;
let progressTextEl: HTMLElement;
let networksCountEl: HTMLElement;
let foundNetworksEl: HTMLElement;
let packetListEl: HTMLElement;
let customConfigEl: HTMLElement;
let customFreqFromInput: HTMLInputElement;
let customFreqToInput: HTMLInputElement;
let customFreqStepInput: HTMLInputElement;
let customBandwidthsInput: HTMLInputElement;
let customSfsInput: HTMLInputElement;
let customComboCountEl: HTMLElement;

// Recent packets storage (last 5)
interface RecentPacket {
  hex: string;
  time: Date;
}
const recentPackets: RecentPacket[] = [];
const MAX_RECENT_PACKETS = 5;

// State
let connection: typeof WebSerialConnection | null = null;
let isScanning = false;
let scanStartTime: Date | null = null;
let currentScanType = 'test';
let combinations: Combination[] = [];
let currentComboIndex = 0;
let scanCycleCount = 0;
const foundNetworks: Map<string, FoundNetwork> = new Map();
let lingerTimeoutId: number | null = null;
let statusUpdateIntervalId: number | null = null;

// Get combo key for map
function getComboKey(freq: number, bw: number, sf: number): string {
  return `${freq}-${bw}-${sf}`;
}

// Format time as M:SS or H:MM:SS
function formatTime(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Update connection status UI
function updateConnectionStatus(status: 'disconnected' | 'connecting' | 'connected'): void {
  connectionStatusEl.className = `connection-status ${status}`;
  switch (status) {
    case 'disconnected':
      connectionStatusEl.textContent = 'Disconnected';
      connectBtn.disabled = false;
      disconnectBtn.disabled = true;
      scanBtn.disabled = true;
      break;
    case 'connecting':
      connectionStatusEl.textContent = 'Connecting...';
      connectBtn.disabled = true;
      disconnectBtn.disabled = true;
      scanBtn.disabled = true;
      break;
    case 'connected':
      connectionStatusEl.textContent = 'Connected';
      connectBtn.disabled = true;
      disconnectBtn.disabled = false;
      scanBtn.disabled = false;
      break;
  }
}

// Calculate and display estimated time
function updateEstimatedTime(): void {
  const config =
    currentScanType === 'custom' ? buildCustomScanConfig() : SCAN_CONFIGS[currentScanType];
  const comboCount =
    config.frequencies.length * config.bandwidths.length * config.spreadingFactors.length;
  const lingerMinutes = parseFloat(lingerTimeInput.value) || 1;
  const totalMinutes = comboCount * lingerMinutes;

  let timeStr: string;
  if (totalMinutes < 60) {
    timeStr = `${Math.round(totalMinutes)} minutes`;
  } else {
    const hours = Math.floor(totalMinutes / 60);
    const mins = Math.round(totalMinutes % 60);
    timeStr = mins > 0 ? `${hours}h ${mins}m` : `${hours} hours`;
  }

  estimatedTimeEl.innerHTML = `Estimated scan time: <strong>${timeStr}</strong>`;
}

// Generate info box content for custom scan
function getCustomScanInfo(): string {
  const config = buildCustomScanConfig();
  const freqFrom = parseFloat(customFreqFromInput?.value) || 900;
  const freqTo = parseFloat(customFreqToInput?.value) || 930;
  const freqStep = parseFloat(customFreqStepInput?.value) || 0.25;

  return `<h4>Custom Scan</h4>
<ul>
  <li><strong>Frequencies:</strong> ${freqFrom} - ${freqTo} MHz (step ${freqStep} MHz, ${config.frequencies.length} frequencies)</li>
  <li><strong>Bandwidths:</strong> ${config.bandwidths.join(', ')} kHz</li>
  <li><strong>Spreading Factors:</strong> ${config.spreadingFactors.join(', ')}</li>
</ul>`;
}

// Update scan type selection UI
function updateScanTypeSelection(): void {
  document.querySelectorAll('.scan-type-option').forEach((el) => {
    const input = el.querySelector('input') as HTMLInputElement;
    if (input.value === currentScanType) {
      el.classList.add('selected');
    } else {
      el.classList.remove('selected');
    }
  });

  // Show/hide custom config panel
  if (customConfigEl) {
    customConfigEl.style.display = currentScanType === 'custom' ? 'flex' : 'none';
  }

  // Update info box
  if (currentScanType === 'custom') {
    scanInfoEl.innerHTML = getCustomScanInfo();
    updateCustomComboCount();
  } else {
    scanInfoEl.innerHTML = SCAN_INFO[currentScanType];
  }

  updateEstimatedTime();
}

// Update status display
function updateStatusDisplay(): void {
  if (!scanStartTime) {
    return;
  }

  const elapsed = Math.floor((Date.now() - scanStartTime.getTime()) / 1000);
  timeRunningEl.textContent = formatTime(elapsed);

  const combo = combinations[currentComboIndex];
  if (combo) {
    currentComboEl.textContent = `${combo.freq} MHz | BW ${combo.bw} | SF${combo.sf}`;
  }

  comboProgressEl.textContent = `${currentComboIndex + 1} / ${combinations.length}`;

  // Calculate progress
  const baseProgress = (currentComboIndex / combinations.length) * 100;

  if (scanCycleCount === 0) {
    progressFillEl.style.width = `${baseProgress}%`;
    progressTextEl.textContent = `${Math.round(baseProgress)}%`;
  } else {
    progressFillEl.style.width = '100%';
    progressTextEl.textContent = `100% [${Math.round(baseProgress)}% cycle #${scanCycleCount + 1}]`;
  }
}

// Update found networks display
function updateFoundNetworksDisplay(): void {
  networksCountEl.textContent = String(foundNetworks.size);

  if (foundNetworks.size === 0) {
    foundNetworksEl.innerHTML =
      '<div class="no-networks">No networks found yet. Start a scan to search for MeshCore traffic.</div>';
    return;
  }

  const sorted = Array.from(foundNetworks.values()).sort(
    (a, b) => b.lastSeen.getTime() - a.lastSeen.getTime(),
  );

  foundNetworksEl.innerHTML = sorted
    .map((net) => {
      const timeStr = net.lastSeen.toLocaleTimeString('en-US', { hour12: false });
      return `<div class="network-item">
        <span class="network-config">${net.freq} MHz | BW ${net.bw} kHz | SF${net.sf}</span>
        <span class="network-packets">${net.packetCount} packet${net.packetCount !== 1 ? 's' : ''}</span>
        <span class="network-time">Last: ${timeStr}</span>
      </div>`;
    })
    .join('');
}

// Handle received packet
// Update recent packets display
function updateRecentPacketsDisplay(): void {
  if (recentPackets.length === 0) {
    packetListEl.innerHTML = '<div class="no-packets">No packets received yet.</div>';
    return;
  }

  packetListEl.innerHTML = recentPackets
    .map((pkt) => {
      const timeStr = pkt.time.toLocaleTimeString('en-US', { hour12: false });
      const truncatedHex = pkt.hex.length > 80 ? pkt.hex.substring(0, 80) + '...' : pkt.hex;
      const analyzeUrl = `./index.html?packet=${encodeURIComponent(pkt.hex)}`;
      return `<div class="packet-item">
        <span class="packet-time">${timeStr}</span>
        <span class="packet-hex" title="${pkt.hex}">${truncatedHex}</span>
        <a href="${analyzeUrl}" target="_blank" class="packet-link">Analyze</a>
      </div>`;
    })
    .join('');
}

// Handle received packet
function onPacketReceived(hexData: string): void {
  // Add to recent packets (newest first)
  recentPackets.unshift({ hex: hexData, time: new Date() });
  if (recentPackets.length > MAX_RECENT_PACKETS) {
    recentPackets.pop();
  }
  updateRecentPacketsDisplay();

  // Update network tracking
  const combo = combinations[currentComboIndex];
  if (!combo) {
    return;
  }

  const key = getComboKey(combo.freq, combo.bw, combo.sf);
  const existing = foundNetworks.get(key);

  if (existing) {
    existing.packetCount++;
    existing.lastSeen = new Date();
  } else {
    foundNetworks.set(key, {
      freq: combo.freq,
      bw: combo.bw,
      sf: combo.sf,
      packetCount: 1,
      firstSeen: new Date(),
      lastSeen: new Date(),
    });
  }

  updateFoundNetworksDisplay();
}

// Set radio parameters
async function setRadioParams(freq: number, bw: number, sf: number): Promise<boolean> {
  if (!connection) {
    return false;
  }

  try {
    // meshcore.js expects freq in kHz and bw in Hz
    await connection.sendCommandSetRadioParams(
      Math.round(freq * 1000), // freq in kHz
      Math.round(bw * 1000), // bw in Hz
      sf,
      5, // CR fixed at 5
    );

    // Wait for OK response
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        connection.off(Constants.ResponseCodes.Ok, handler);
        resolve(false);
      }, 3000);

      const handler = () => {
        clearTimeout(timeout);
        connection.off(Constants.ResponseCodes.Ok, handler);
        resolve(true);
      };

      connection.on(Constants.ResponseCodes.Ok, handler);
    });
  } catch {
    return false;
  }
}

// Move to next combination
async function nextCombination(): Promise<void> {
  if (!isScanning) {
    return;
  }

  currentComboIndex++;

  if (currentComboIndex >= combinations.length) {
    // Completed a full cycle
    scanCycleCount++;
    currentComboIndex = 0;
  }

  const combo = combinations[currentComboIndex];
  const success = await setRadioParams(combo.freq, combo.bw, combo.sf);

  if (!success) {
    console.warn('Failed to set radio params, continuing anyway');
  }

  updateStatusDisplay();

  // Schedule next combination
  const lingerMs = (parseFloat(lingerTimeInput.value) || 1) * 60 * 1000;
  lingerTimeoutId = window.setTimeout(() => nextCombination(), lingerMs);
}

// Start scanning
async function startScan(): Promise<void> {
  if (!connection || isScanning) {
    return;
  }

  isScanning = true;
  scanStartTime = new Date();
  currentComboIndex = 0;
  scanCycleCount = 0;

  // Generate combinations for selected scan type
  const config =
    currentScanType === 'custom' ? buildCustomScanConfig() : SCAN_CONFIGS[currentScanType];
  combinations = generateCombinations(config);

  // Update UI
  scanBtn.textContent = 'Stop Scan';
  scanBtn.classList.add('scanning');
  scanStatusBar.style.display = 'flex';

  // Disable scan type selection during scan
  document.querySelectorAll('.scan-type-option input').forEach((el) => {
    (el as HTMLInputElement).disabled = true;
  });
  lingerTimeInput.disabled = true;

  // Set initial combo
  const combo = combinations[0];
  await setRadioParams(combo.freq, combo.bw, combo.sf);

  updateStatusDisplay();

  // Start status update interval
  statusUpdateIntervalId = window.setInterval(() => updateStatusDisplay(), 1000);

  // Schedule first transition
  const lingerMs = (parseFloat(lingerTimeInput.value) || 1) * 60 * 1000;
  lingerTimeoutId = window.setTimeout(() => nextCombination(), lingerMs);
}

// Stop scanning
function stopScan(): void {
  isScanning = false;

  if (lingerTimeoutId !== null) {
    clearTimeout(lingerTimeoutId);
    lingerTimeoutId = null;
  }

  if (statusUpdateIntervalId !== null) {
    clearInterval(statusUpdateIntervalId);
    statusUpdateIntervalId = null;
  }

  // Update UI
  scanBtn.textContent = 'Start Scan';
  scanBtn.classList.remove('scanning');

  // Re-enable scan type selection
  document.querySelectorAll('.scan-type-option input').forEach((el) => {
    (el as HTMLInputElement).disabled = false;
  });
  lingerTimeInput.disabled = false;
}

// Setup serial connection listeners
function setupSerialListeners(conn: typeof WebSerialConnection): void {
  // Listen for raw radio packets
  conn.on(Constants.PushCodes.LogRxData, (data: { raw: Uint8Array }) => {
    if (isScanning) {
      const hexData = toHexString(data.raw);
      onPacketReceived(hexData);
    }
  });

  // Handle disconnection
  conn.on('disconnected', () => {
    stopScan();
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
  stopScan();

  if (connection) {
    try {
      connection.close();
    } catch {
      // Ignore close errors
    }
    connection = null;
  }
  updateConnectionStatus('disconnected');
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  connectBtn = document.getElementById('connect-btn') as HTMLButtonElement;
  disconnectBtn = document.getElementById('disconnect-btn') as HTMLButtonElement;
  connectionStatusEl = document.getElementById('connection-status')!;
  scanBtn = document.getElementById('scan-btn') as HTMLButtonElement;
  lingerTimeInput = document.getElementById('linger-time') as HTMLInputElement;
  estimatedTimeEl = document.getElementById('estimated-time')!;
  scanInfoEl = document.getElementById('scan-info')!;
  scanStatusBar = document.getElementById('scan-status-bar')!;
  timeRunningEl = document.getElementById('time-running')!;
  currentComboEl = document.getElementById('current-combo')!;
  comboProgressEl = document.getElementById('combo-progress')!;
  progressFillEl = document.getElementById('progress-fill')!;
  progressTextEl = document.getElementById('progress-text')!;
  networksCountEl = document.getElementById('networks-count')!;
  foundNetworksEl = document.getElementById('found-networks')!;
  packetListEl = document.getElementById('packet-list')!;

  // Custom config elements
  customConfigEl = document.getElementById('custom-config')!;
  customFreqFromInput = document.getElementById('custom-freq-from') as HTMLInputElement;
  customFreqToInput = document.getElementById('custom-freq-to') as HTMLInputElement;
  customFreqStepInput = document.getElementById('custom-freq-step') as HTMLInputElement;
  customBandwidthsInput = document.getElementById('custom-bandwidths') as HTMLInputElement;
  customSfsInput = document.getElementById('custom-sfs') as HTMLInputElement;
  customComboCountEl = document.getElementById('custom-combo-count')!;

  const serialNotSupported = document.getElementById('serial-not-supported')!;

  // Check for Web Serial support
  if (!navigator.serial) {
    serialNotSupported.style.display = 'block';
    connectBtn.disabled = true;
  }

  // Button handlers
  connectBtn.addEventListener('click', connectToRadio);
  disconnectBtn.addEventListener('click', disconnectFromRadio);

  scanBtn.addEventListener('click', () => {
    if (isScanning) {
      stopScan();
    } else {
      startScan();
    }
  });

  // Scan type selection
  document.querySelectorAll('.scan-type-option input').forEach((el) => {
    el.addEventListener('change', (e) => {
      currentScanType = (e.target as HTMLInputElement).value;
      updateScanTypeSelection();
    });
  });

  // Linger time change
  lingerTimeInput.addEventListener('input', () => {
    updateEstimatedTime();
  });

  // Custom config input handlers
  const customInputs = [
    customFreqFromInput,
    customFreqToInput,
    customFreqStepInput,
    customBandwidthsInput,
    customSfsInput,
  ];
  customInputs.forEach((input) => {
    if (input) {
      input.addEventListener('input', () => {
        updateCustomComboCount();
        if (currentScanType === 'custom') {
          scanInfoEl.innerHTML = getCustomScanInfo();
        }
      });
    }
  });

  // Initialize display
  updateScanTypeSelection();
  updateFoundNetworksDisplay();
  updateRecentPacketsDisplay();
});
