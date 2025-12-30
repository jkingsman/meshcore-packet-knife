// @ts-expect-error - meshcore.js doesn't have type definitions
import { WebSerialConnection, Constants } from '@liamcottle/meshcore.js';

// DOM elements
let connectBtn: HTMLButtonElement;
let disconnectBtn: HTMLButtonElement;
let connectionStatusEl: HTMLElement;
let loadBtn: HTMLButtonElement;
let writeBtn: HTMLButtonElement;
let rebootBtn: HTMLButtonElement;
let statusLog: HTMLElement;

// Config inputs
let radioNameInput: HTMLInputElement;
let nodeTypeSelect: HTMLSelectElement;
let privateKeyInput: HTMLInputElement;
let publicKeyInput: HTMLInputElement;
let latitudeInput: HTMLInputElement;
let longitudeInput: HTMLInputElement;
let frequencyInput: HTMLInputElement;
let bandwidthInput: HTMLInputElement;
let spreadingFactorInput: HTMLInputElement;
let codingRateInput: HTMLInputElement;
let txPowerInput: HTMLInputElement;
let maxTxPowerInput: HTMLInputElement;
let deviceTimeInput: HTMLInputElement;
let syncTimeBtn: HTMLButtonElement;
let usaPresetBtn: HTMLButtonElement;
let manualAddContactsCheckbox: HTMLInputElement;
let firmwareInfoEl: HTMLElement;
let modelInfoEl: HTMLElement;
let rxDelayInput: HTMLInputElement;
let advertIntervalInput: HTMLInputElement;
let multiAcksInput: HTMLInputElement;
let advertLocPolicySelect: HTMLSelectElement;
let telemetryBaseSelect: HTMLSelectElement;
let telemetryLocSelect: HTMLSelectElement;
let telemetryEnvSelect: HTMLSelectElement;
let blePinInput: HTMLInputElement;

// State
let connection: typeof WebSerialConnection | null = null;
let timeIntervalId: number | null = null;

// Track which fields have been modified since loading
const dirtyFields: Set<string> = new Set();

// Hex validation and conversion
function isValidHex(str: string): boolean {
  return /^[0-9a-fA-F]*$/.test(str);
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array | number[]): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// Logging
function log(message: string, type: 'info' | 'success' | 'error' | 'warn' = 'info'): void {
  const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
  const line = document.createElement('div');
  line.className = `log-${type}`;
  line.textContent = `[${timestamp}] ${message}`;
  statusLog.appendChild(line);
  statusLog.scrollTop = statusLog.scrollHeight;
}

// Connection status UI
function updateConnectionStatus(status: 'disconnected' | 'connecting' | 'connected'): void {
  connectionStatusEl.className = `connection-status ${status}`;
  const isConnected = status === 'connected';

  switch (status) {
    case 'disconnected':
      connectionStatusEl.textContent = 'Disconnected';
      connectBtn.disabled = false;
      disconnectBtn.disabled = true;
      loadBtn.disabled = true;
      writeBtn.disabled = true;
      rebootBtn.disabled = true;
      break;
    case 'connecting':
      connectionStatusEl.textContent = 'Connecting...';
      connectBtn.disabled = true;
      disconnectBtn.disabled = true;
      loadBtn.disabled = true;
      writeBtn.disabled = true;
      rebootBtn.disabled = true;
      break;
    case 'connected':
      connectionStatusEl.textContent = 'Connected';
      connectBtn.disabled = true;
      disconnectBtn.disabled = false;
      loadBtn.disabled = !isConnected;
      writeBtn.disabled = !isConnected;
      rebootBtn.disabled = !isConnected;
      break;
  }
}

// Types for meshcore.js responses
interface SelfInfoResponse {
  type: number;
  txPower: number;
  maxTxPower: number;
  publicKey: Uint8Array;
  advLat: number;
  advLon: number;
  reserved: Uint8Array;
  manualAddContacts: number;
  radioFreq: number;
  radioBw: number;
  radioSf: number;
  radioCr: number;
  name: string;
}

interface CurrTimeResponse {
  epochSecs: number;
}

interface PrivateKeyResponse {
  privateKey: Uint8Array;
}

interface DeviceInfoResponse {
  firmwareVer: number;
  reserved: Uint8Array;
  firmware_build_date: string;
  manufacturerModel: string;
}

// Command codes not exposed by meshcore.js
const CMD_SET_TUNING_PARAMS = 0x15;
const CMD_SET_DEVICE_PIN = 0x25;
const CMD_SET_OTHER_PARAMS = 0x26;

// Helper to parse "reserved" bytes from SelfInfo which actually contain:
// byte 0: multi_acks
// byte 1: advert_loc_policy
// byte 2: telemetry_mode (combined: base | (loc << 2) | (env << 4))
interface ParsedOtherParams {
  multiAcks: number;
  advertLocPolicy: number;
  telemetryModeBase: number;
  telemetryModeLoc: number;
  telemetryModeEnv: number;
}

function parseReservedBytes(reserved: Uint8Array): ParsedOtherParams {
  const multiAcks = reserved[0] || 0;
  const advertLocPolicy = reserved[1] || 0;
  const telemetryMode = reserved[2] || 0;

  return {
    multiAcks,
    advertLocPolicy,
    telemetryModeBase: telemetryMode & 0b11,
    telemetryModeLoc: (telemetryMode >> 2) & 0b11,
    telemetryModeEnv: (telemetryMode >> 4) & 0b11,
  };
}

// Helper to send raw command bytes
async function sendRawCommand(conn: typeof WebSerialConnection, bytes: Uint8Array): Promise<void> {
  await conn.sendToRadioFrame(bytes);
}

// Wait for a specific response code
function waitForResponse<T>(
  conn: typeof WebSerialConnection,
  responseCode: number,
  timeoutMs: number = 5000,
): Promise<T | null> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      conn.off(responseCode, handler);
      resolve(null);
    }, timeoutMs);

    const handler = (data: T) => {
      clearTimeout(timeout);
      conn.off(responseCode, handler);
      resolve(data);
    };

    conn.on(responseCode, handler);
  });
}

// Connect to radio
async function connectToRadio(): Promise<void> {
  try {
    updateConnectionStatus('connecting');
    log('Opening serial connection...');

    connection = await WebSerialConnection.open();
    if (!connection) {
      log('Connection cancelled or failed', 'error');
      updateConnectionStatus('disconnected');
      return;
    }

    // Handle disconnection
    connection.on('disconnected', () => {
      log('Disconnected from radio', 'warn');
      updateConnectionStatus('disconnected');
      connection = null;
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Connection timeout')), 10000);
      connection.on('connected', () => {
        clearTimeout(timeout);
        log('Connected to radio', 'success');
        updateConnectionStatus('connected');
        resolve();
      });
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`Connection error: ${msg}`, 'error');
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
  log('Disconnected');
  updateConnectionStatus('disconnected');
}

// Load all values from radio
async function loadFromRadio(): Promise<void> {
  if (!connection) {
    log('Not connected', 'error');
    return;
  }

  log('Loading configuration from radio...', 'info');

  try {
    // Get self info (name, radio params, location, tx power)
    log('Requesting self info...');
    const selfInfoPromise = waitForResponse<SelfInfoResponse>(
      connection,
      Constants.ResponseCodes.SelfInfo,
      5000,
    );
    await connection.sendCommandAppStart();
    const selfInfo = await selfInfoPromise;

    if (selfInfo) {
      // Name
      radioNameInput.value = selfInfo.name || '';
      log(`Name: ${selfInfo.name || '(not set)'}`);

      // Node type
      nodeTypeSelect.value = String(selfInfo.type);
      const nodeTypes = ['None', 'Chat', 'Repeater', 'Room'];
      log(`Node type: ${nodeTypes[selfInfo.type] || selfInfo.type}`);

      // Public key (read-only)
      publicKeyInput.value = bytesToHex(selfInfo.publicKey);

      // TX Power
      txPowerInput.value = String(selfInfo.txPower);
      maxTxPowerInput.value = String(selfInfo.maxTxPower);
      log(`TX Power: ${selfInfo.txPower} dBm (max: ${selfInfo.maxTxPower})`);

      // Manual add contacts
      manualAddContactsCheckbox.checked = selfInfo.manualAddContacts === 1;
      log(`Manual add contacts: ${selfInfo.manualAddContacts === 1 ? 'Yes' : 'No'}`);

      // Parse the "reserved" bytes which contain multi_acks, advert_loc_policy, and telemetry_mode
      const otherParams = parseReservedBytes(selfInfo.reserved);

      // Multi acks
      multiAcksInput.value = String(otherParams.multiAcks);
      log(`Multi acks: ${otherParams.multiAcks}`);

      // Advert location policy
      advertLocPolicySelect.value = String(otherParams.advertLocPolicy);
      const policyNames = ['Never', 'Always', 'Contacts Only'];
      log(
        `Advert loc policy: ${policyNames[otherParams.advertLocPolicy] || otherParams.advertLocPolicy}`,
      );

      // Telemetry modes
      telemetryBaseSelect.value = String(otherParams.telemetryModeBase);
      telemetryLocSelect.value = String(otherParams.telemetryModeLoc);
      telemetryEnvSelect.value = String(otherParams.telemetryModeEnv);
      const modeNames = ['Off', 'Local', 'On Request', 'Always'];
      log(
        `Telemetry: base=${modeNames[otherParams.telemetryModeBase]}, ` +
          `loc=${modeNames[otherParams.telemetryModeLoc]}, ` +
          `env=${modeNames[otherParams.telemetryModeEnv]}`,
      );

      // Location (advLat/advLon are stored as int * 1e6)
      const lat = selfInfo.advLat / 1e6;
      const lon = selfInfo.advLon / 1e6;
      latitudeInput.value = lat !== 0 ? lat.toFixed(6) : '';
      longitudeInput.value = lon !== 0 ? lon.toFixed(6) : '';
      log(`Location: ${lat.toFixed(6)}, ${lon.toFixed(6)}`);

      // Radio params (radioFreq/radioBw are stored as Hz * 1000, so /1000 for kHz, /1000000 for MHz)
      const freqMHz = selfInfo.radioFreq / 1000; // stored as kHz
      const bwKHz = selfInfo.radioBw / 1000; // stored as Hz
      frequencyInput.value = freqMHz.toFixed(3);
      bandwidthInput.value = bwKHz.toFixed(3);
      spreadingFactorInput.value = String(selfInfo.radioSf);
      codingRateInput.value = String(selfInfo.radioCr);
      log(`Radio: ${freqMHz} MHz, BW ${bwKHz} kHz, SF${selfInfo.radioSf}, CR${selfInfo.radioCr}`);

      log('Self info loaded', 'success');
    } else {
      log('Failed to get self info (timeout)', 'error');
    }

    // Get device time
    log('Requesting device time...');
    const timePromise = waitForResponse<CurrTimeResponse>(
      connection,
      Constants.ResponseCodes.CurrTime,
      5000,
    );
    await connection.sendCommandGetDeviceTime();
    const timeResp = await timePromise;

    if (timeResp) {
      deviceTimeInput.value = String(timeResp.epochSecs);
      const date = new Date(timeResp.epochSecs * 1000);
      log(`Device time: ${timeResp.epochSecs} (${date.toISOString()})`);
      startTimeAutoIncrement();
    } else {
      log('Failed to get device time (timeout)', 'warn');
    }

    // Try to export private key
    log('Requesting private key...');

    // Listen for both PrivateKey and Disabled responses
    const keyPromise = new Promise<
      { type: 'key'; data: PrivateKeyResponse } | { type: 'disabled' } | null
    >((resolve) => {
      const timeout = setTimeout(() => {
        connection.off(Constants.ResponseCodes.PrivateKey, keyHandler);
        connection.off(Constants.ResponseCodes.Disabled, disabledHandler);
        resolve(null);
      }, 5000);

      const keyHandler = (data: PrivateKeyResponse) => {
        clearTimeout(timeout);
        connection.off(Constants.ResponseCodes.PrivateKey, keyHandler);
        connection.off(Constants.ResponseCodes.Disabled, disabledHandler);
        resolve({ type: 'key', data });
      };

      const disabledHandler = () => {
        clearTimeout(timeout);
        connection.off(Constants.ResponseCodes.PrivateKey, keyHandler);
        connection.off(Constants.ResponseCodes.Disabled, disabledHandler);
        resolve({ type: 'disabled' });
      };

      connection.on(Constants.ResponseCodes.PrivateKey, keyHandler);
      connection.on(Constants.ResponseCodes.Disabled, disabledHandler);
    });

    await connection.sendCommandExportPrivateKey();
    const keyResp = await keyPromise;

    if (keyResp?.type === 'key') {
      const keyHex = bytesToHex(keyResp.data.privateKey);
      privateKeyInput.value = keyHex;
      log(`Private key: ${keyHex.substring(0, 16)}...`);
    } else if (keyResp?.type === 'disabled') {
      privateKeyInput.value = '';
      privateKeyInput.placeholder = 'Export disabled on device';
      log('Private key export is disabled on this device', 'warn');
    } else {
      log('Failed to get private key (timeout)', 'warn');
    }

    // Get device info
    log('Requesting device info...');
    const deviceInfoPromise = waitForResponse<DeviceInfoResponse>(
      connection,
      Constants.ResponseCodes.DeviceInfo,
      5000,
    );
    await connection.sendCommandDeviceQuery(1);
    const deviceInfo = await deviceInfoPromise;

    if (deviceInfo) {
      firmwareInfoEl.textContent = `v${deviceInfo.firmwareVer} (${deviceInfo.firmware_build_date})`;
      modelInfoEl.textContent = deviceInfo.manufacturerModel || '-';
      log(`Device: ${deviceInfo.manufacturerModel}, firmware v${deviceInfo.firmwareVer}`);
    } else {
      log('Failed to get device info (timeout)', 'warn');
    }

    // Clear dirty flags since we just loaded fresh values
    clearDirtyFlags();
    log('Configuration loaded successfully', 'success');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`Error loading configuration: ${msg}`, 'error');
  }
}

// Write all values to radio
async function writeToRadio(): Promise<void> {
  if (!connection) {
    log('Not connected', 'error');
    return;
  }

  if (dirtyFields.size === 0) {
    log('No fields modified, nothing to write', 'info');
    return;
  }

  log('Writing modified configuration to radio...', 'info');

  try {
    // Wait for OK response helper
    const waitForOk = async (timeoutMs: number = 3000): Promise<boolean> => {
      const resp = await waitForResponse<unknown>(
        connection,
        Constants.ResponseCodes.Ok,
        timeoutMs,
      );
      return resp !== null;
    };

    // Set name (if modified)
    if (dirtyFields.has('name')) {
      const name = radioNameInput.value.trim();
      if (name) {
        log(`Setting name to: ${name}`);
        await connection.sendCommandSetAdvertName(name);
        if (await waitForOk()) {
          log('Name set', 'success');
        } else {
          log('Failed to set name (no response)', 'error');
        }
      }
    }

    // Set node type (if modified) - uses SendSelfAdvert command
    if (dirtyFields.has('nodeType')) {
      const nodeType = parseInt(nodeTypeSelect.value);
      const nodeTypes = ['None', 'Chat', 'Repeater', 'Room'];
      log(`Setting node type to: ${nodeTypes[nodeType]}`);
      await connection.sendCommandSendSelfAdvert(nodeType);
      if (await waitForOk()) {
        log('Node type set', 'success');
      } else {
        log('Failed to set node type (no response)', 'error');
      }
    }

    // Set other params (if modified) - combines manual_add_contacts, telemetry modes, advert_loc_policy, multi_acks
    if (dirtyFields.has('otherParams')) {
      const manualAdd = manualAddContactsCheckbox.checked ? 1 : 0;
      const multiAcks = parseInt(multiAcksInput.value) || 0;
      const advertLocPolicy = parseInt(advertLocPolicySelect.value) || 0;
      const telemetryBase = parseInt(telemetryBaseSelect.value) || 0;
      const telemetryLoc = parseInt(telemetryLocSelect.value) || 0;
      const telemetryEnv = parseInt(telemetryEnvSelect.value) || 0;

      // Combine telemetry modes into single byte: base | (loc << 2) | (env << 4)
      const telemetryMode =
        (telemetryBase & 0b11) | ((telemetryLoc & 0b11) << 2) | ((telemetryEnv & 0b11) << 4);

      log(
        `Setting other params: manual_add=${manualAdd}, multi_acks=${multiAcks}, ` +
          `advert_loc_policy=${advertLocPolicy}, telemetry=${telemetryMode}`,
      );

      // Build command: 0x26 + manual_add (1) + telemetry_mode (1) + advert_loc_policy (1) + multi_acks (1)
      const cmd = new Uint8Array(5);
      cmd[0] = CMD_SET_OTHER_PARAMS;
      cmd[1] = manualAdd;
      cmd[2] = telemetryMode;
      cmd[3] = advertLocPolicy;
      cmd[4] = multiAcks;

      await sendRawCommand(connection, cmd);
      if (await waitForOk()) {
        log('Other params set', 'success');
      } else {
        log('Failed to set other params (no response)', 'error');
      }
    }

    // Set private key (if modified and valid)
    if (dirtyFields.has('privateKey')) {
      const keyHex = privateKeyInput.value.trim().toLowerCase();
      if (keyHex) {
        if (keyHex.length !== 128) {
          log(`Private key must be 64 bytes (128 hex chars), got ${keyHex.length}`, 'error');
        } else if (!isValidHex(keyHex)) {
          log('Private key contains invalid hex characters', 'error');
        } else {
          log('Setting private key...');
          const keyBytes = hexToBytes(keyHex);
          await connection.sendCommandImportPrivateKey(keyBytes);
          if (await waitForOk()) {
            log('Private key set', 'success');
          } else {
            log('Failed to set private key (no response or error)', 'error');
          }
        }
      }
    }

    // Set radio params (if modified)
    if (dirtyFields.has('radio')) {
      const freq = parseFloat(frequencyInput.value);
      const bw = parseFloat(bandwidthInput.value);
      const sf = parseInt(spreadingFactorInput.value);
      const cr = parseInt(codingRateInput.value);

      if (!isNaN(freq) && !isNaN(bw) && !isNaN(sf) && !isNaN(cr)) {
        log(`Setting radio params: ${freq} MHz, BW ${bw} kHz, SF${sf}, CR${cr}`);
        // meshcore.js expects freq and bw in Hz*1000 units (so MHz*1000000 and kHz*1000)
        await connection.sendCommandSetRadioParams(
          Math.round(freq * 1000), // freq in kHz
          Math.round(bw * 1000), // bw in Hz
          sf,
          cr,
        );
        if (await waitForOk()) {
          log('Radio params set', 'success');
        } else {
          log('Failed to set radio params (no response)', 'error');
        }
      }
    }

    // Set TX power (if modified)
    if (dirtyFields.has('txPower')) {
      const txPower = parseInt(txPowerInput.value);
      if (!isNaN(txPower)) {
        log(`Setting TX power to: ${txPower} dBm`);
        await connection.sendCommandSetTxPower(txPower);
        if (await waitForOk()) {
          log('TX power set', 'success');
        } else {
          log('Failed to set TX power (no response)', 'error');
        }
      }
    }

    // Set coordinates (if modified)
    if (dirtyFields.has('location')) {
      const lat = parseFloat(latitudeInput.value);
      const lon = parseFloat(longitudeInput.value);

      if (!isNaN(lat) && !isNaN(lon)) {
        log(`Setting location to: ${lat.toFixed(6)}, ${lon.toFixed(6)}`);
        // meshcore.js expects lat/lon as int32 * 1e6
        await connection.sendCommandSetAdvertLatLon(Math.round(lat * 1e6), Math.round(lon * 1e6));
        if (await waitForOk()) {
          log('Location set', 'success');
        } else {
          log('Failed to set location (no response)', 'error');
        }
      }
    }

    // Set device time (if modified)
    if (dirtyFields.has('time')) {
      const deviceTime = parseInt(deviceTimeInput.value);
      if (!isNaN(deviceTime)) {
        log(`Setting device time to: ${deviceTime}`);
        await connection.sendCommandSetDeviceTime(deviceTime);
        if (await waitForOk()) {
          log('Device time set', 'success');
        } else {
          log('Failed to set device time (no response)', 'error');
        }
      }
    }

    // Set tuning params (if modified)
    if (dirtyFields.has('tuning')) {
      const rxDelay = parseInt(rxDelayInput.value);
      const advertInterval = parseInt(advertIntervalInput.value);

      if (!isNaN(rxDelay) && !isNaN(advertInterval)) {
        log(`Setting tuning: RX delay ${rxDelay}ms, advert interval ${advertInterval}s`);

        // Build command: 0x15 + rx_delay (4 bytes LE) + advert_interval (4 bytes LE) + 2 reserved bytes
        const cmd = new Uint8Array(11);
        cmd[0] = CMD_SET_TUNING_PARAMS;
        // rx_delay as little-endian uint32
        cmd[1] = rxDelay & 0xff;
        cmd[2] = (rxDelay >> 8) & 0xff;
        cmd[3] = (rxDelay >> 16) & 0xff;
        cmd[4] = (rxDelay >> 24) & 0xff;
        // advert_interval as little-endian uint32
        cmd[5] = advertInterval & 0xff;
        cmd[6] = (advertInterval >> 8) & 0xff;
        cmd[7] = (advertInterval >> 16) & 0xff;
        cmd[8] = (advertInterval >> 24) & 0xff;
        // 2 reserved bytes (already 0)

        await sendRawCommand(connection, cmd);
        if (await waitForOk()) {
          log('Tuning params set', 'success');
        } else {
          log('Failed to set tuning params (no response)', 'error');
        }
      }
    }

    // Set BLE PIN (if modified)
    if (dirtyFields.has('blePin')) {
      const pin = parseInt(blePinInput.value);
      if (!isNaN(pin) && pin >= 0 && pin <= 999999) {
        log(`Setting BLE PIN to: ${pin}`);

        // Build command: 0x25 + pin (4 bytes LE)
        const cmd = new Uint8Array(5);
        cmd[0] = CMD_SET_DEVICE_PIN;
        cmd[1] = pin & 0xff;
        cmd[2] = (pin >> 8) & 0xff;
        cmd[3] = (pin >> 16) & 0xff;
        cmd[4] = (pin >> 24) & 0xff;

        await sendRawCommand(connection, cmd);
        if (await waitForOk()) {
          log('BLE PIN set', 'success');
        } else {
          log('Failed to set BLE PIN (no response)', 'error');
        }
      } else if (blePinInput.value.trim() !== '') {
        log('Invalid BLE PIN (must be 0-999999)', 'warn');
      }
    }

    // Clear dirty flags after successful write
    clearDirtyFlags();
    log('Configuration written successfully', 'success');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`Error writing configuration: ${msg}`, 'error');
  }
}

// Reboot radio
async function rebootRadio(): Promise<void> {
  if (!connection) {
    log('Not connected', 'error');
    return;
  }

  log('Rebooting radio...', 'warn');

  try {
    await connection.sendCommandReboot();
    log('Reboot command sent. Radio will disconnect.', 'success');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`Error sending reboot command: ${msg}`, 'error');
  }
}

// Start auto-incrementing the time field
function startTimeAutoIncrement(): void {
  // Clear any existing interval
  if (timeIntervalId !== null) {
    clearInterval(timeIntervalId);
  }

  // Increment the time field every second
  timeIntervalId = window.setInterval(() => {
    const currentValue = parseInt(deviceTimeInput.value);
    if (!isNaN(currentValue)) {
      deviceTimeInput.value = String(currentValue + 1);
    }
  }, 1000);
}

// Clear all dirty flags (called after loading)
function clearDirtyFlags(): void {
  dirtyFields.clear();
}

// Mark a field as dirty
function markDirty(fieldName: string): void {
  dirtyFields.add(fieldName);
}

// Sync time button handler
function syncCurrentTime(): void {
  const now = Math.floor(Date.now() / 1000);
  deviceTimeInput.value = String(now);
  log(`Set time to current: ${now} (${new Date().toISOString()})`);
  markDirty('time');
  startTimeAutoIncrement();
}

// USA preset button handler
function applyUsaPreset(): void {
  frequencyInput.value = '910.525';
  bandwidthInput.value = '62.5';
  spreadingFactorInput.value = '7';
  codingRateInput.value = '5';
  txPowerInput.value = '22';
  markDirty('radio');
  markDirty('txPower');
  log('Applied USA preset: 910.525 MHz, BW 62.5 kHz, SF7, CR5, 22 dBm');
}

// Private key input validation - only allow hex characters
function validateHexInput(event: Event): void {
  const input = event.target as HTMLInputElement;
  const cleaned = input.value.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  if (cleaned !== input.value) {
    input.value = cleaned;
  }
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  // Get DOM elements
  connectBtn = document.getElementById('connect-btn') as HTMLButtonElement;
  disconnectBtn = document.getElementById('disconnect-btn') as HTMLButtonElement;
  connectionStatusEl = document.getElementById('connection-status')!;
  loadBtn = document.getElementById('load-btn') as HTMLButtonElement;
  writeBtn = document.getElementById('write-btn') as HTMLButtonElement;
  rebootBtn = document.getElementById('reboot-btn') as HTMLButtonElement;
  statusLog = document.getElementById('status-log')!;

  radioNameInput = document.getElementById('radio-name') as HTMLInputElement;
  nodeTypeSelect = document.getElementById('node-type') as HTMLSelectElement;
  privateKeyInput = document.getElementById('private-key') as HTMLInputElement;
  publicKeyInput = document.getElementById('public-key') as HTMLInputElement;
  latitudeInput = document.getElementById('latitude') as HTMLInputElement;
  longitudeInput = document.getElementById('longitude') as HTMLInputElement;
  frequencyInput = document.getElementById('frequency') as HTMLInputElement;
  bandwidthInput = document.getElementById('bandwidth') as HTMLInputElement;
  spreadingFactorInput = document.getElementById('spreading-factor') as HTMLInputElement;
  codingRateInput = document.getElementById('coding-rate') as HTMLInputElement;
  txPowerInput = document.getElementById('tx-power') as HTMLInputElement;
  maxTxPowerInput = document.getElementById('max-tx-power') as HTMLInputElement;
  deviceTimeInput = document.getElementById('device-time') as HTMLInputElement;
  syncTimeBtn = document.getElementById('sync-time-btn') as HTMLButtonElement;
  usaPresetBtn = document.getElementById('usa-preset-btn') as HTMLButtonElement;
  manualAddContactsCheckbox = document.getElementById('manual-add-contacts') as HTMLInputElement;
  firmwareInfoEl = document.getElementById('firmware-info')!;
  modelInfoEl = document.getElementById('model-info')!;
  rxDelayInput = document.getElementById('rx-delay') as HTMLInputElement;
  advertIntervalInput = document.getElementById('advert-interval') as HTMLInputElement;
  multiAcksInput = document.getElementById('multi-acks') as HTMLInputElement;
  advertLocPolicySelect = document.getElementById('advert-loc-policy') as HTMLSelectElement;
  telemetryBaseSelect = document.getElementById('telemetry-base') as HTMLSelectElement;
  telemetryLocSelect = document.getElementById('telemetry-loc') as HTMLSelectElement;
  telemetryEnvSelect = document.getElementById('telemetry-env') as HTMLSelectElement;
  blePinInput = document.getElementById('ble-pin') as HTMLInputElement;

  const serialNotSupported = document.getElementById('serial-not-supported')!;

  // Check for Web Serial support
  if (!navigator.serial) {
    serialNotSupported.style.display = 'block';
    connectBtn.disabled = true;
    log('Web Serial API not supported in this browser', 'error');
    return;
  }

  // Event listeners
  connectBtn.addEventListener('click', connectToRadio);
  disconnectBtn.addEventListener('click', disconnectFromRadio);
  loadBtn.addEventListener('click', loadFromRadio);
  writeBtn.addEventListener('click', writeToRadio);
  rebootBtn.addEventListener('click', rebootRadio);
  syncTimeBtn.addEventListener('click', syncCurrentTime);

  // Validate hex input for private key
  privateKeyInput.addEventListener('input', validateHexInput);

  // USA preset button
  usaPresetBtn.addEventListener('click', applyUsaPreset);

  // Mark fields as dirty when user edits them
  radioNameInput.addEventListener('input', () => markDirty('name'));
  nodeTypeSelect.addEventListener('change', () => markDirty('nodeType'));
  privateKeyInput.addEventListener('input', () => markDirty('privateKey'));
  latitudeInput.addEventListener('input', () => markDirty('location'));
  longitudeInput.addEventListener('input', () => markDirty('location'));
  frequencyInput.addEventListener('input', () => markDirty('radio'));
  bandwidthInput.addEventListener('input', () => markDirty('radio'));
  spreadingFactorInput.addEventListener('input', () => markDirty('radio'));
  codingRateInput.addEventListener('input', () => markDirty('radio'));
  txPowerInput.addEventListener('input', () => markDirty('txPower'));
  manualAddContactsCheckbox.addEventListener('change', () => markDirty('otherParams'));
  deviceTimeInput.addEventListener('input', () => markDirty('time'));
  rxDelayInput.addEventListener('input', () => markDirty('tuning'));
  advertIntervalInput.addEventListener('input', () => markDirty('tuning'));
  multiAcksInput.addEventListener('input', () => markDirty('otherParams'));
  advertLocPolicySelect.addEventListener('change', () => markDirty('otherParams'));
  telemetryBaseSelect.addEventListener('change', () => markDirty('otherParams'));
  telemetryLocSelect.addEventListener('change', () => markDirty('otherParams'));
  telemetryEnvSelect.addEventListener('change', () => markDirty('otherParams'));
  blePinInput.addEventListener('input', () => markDirty('blePin'));

  // Set initial time (don't mark as dirty - this is just initialization)
  const now = Math.floor(Date.now() / 1000);
  deviceTimeInput.value = String(now);
  startTimeAutoIncrement();

  log('Ready. Connect to a radio to begin.');
});
