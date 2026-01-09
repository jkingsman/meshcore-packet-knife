/**
 * Pure rendering utilities for queue item display.
 * Extracted for testability - no DOM or module state dependencies.
 */

import { escapeHtml, formatTime } from './utils';

/**
 * Minimal queue item shape needed for rendering.
 */
export interface RenderableQueueItem {
  id: number;
  packetHex: string;
  status: 'pending' | 'processing' | 'found' | 'failed';
  roomName?: string;
  sender?: string;
  message?: string;
  maxLength: number;
  progressPercent?: number;
  phase?: 'public-key' | 'wordlist' | 'bruteforce';
  testedUpTo?: string;
  testedUpToLength?: number;
  totalCandidates?: number;
  checkedCount?: number;
}

/**
 * Status display information returned by getStatusDisplay.
 */
export interface StatusDisplay {
  statusClass: string;
  statusText: string;
  resultText: string;
  actionsHtml: string;
}

/**
 * Compute status display info for a queue item.
 * Pure function - no side effects.
 *
 * @param item - The queue item to render
 * @param currentRate - Current cracking rate (keys/sec) for ETA calculation
 */
export function getStatusDisplay(
  item: RenderableQueueItem,
  currentRate: number = 0,
): StatusDisplay {
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

  return { statusClass, statusText, resultText, actionsHtml };
}

/**
 * Truncate packet hex for preview display.
 *
 * @param packetHex - Full packet hex string
 * @param maxLength - Maximum characters to show (default 32)
 */
export function truncatePacketHex(packetHex: string, maxLength: number = 32): string {
  return packetHex.substring(0, maxLength) + (packetHex.length > maxLength ? '...' : '');
}

/**
 * Render a complete table row for a queue item.
 * Pure function - returns HTML string.
 *
 * @param item - The queue item to render
 * @param currentRate - Current cracking rate for ETA calculation
 */
export function renderQueueItemRow(item: RenderableQueueItem, currentRate: number = 0): string {
  const { statusClass, statusText, resultText, actionsHtml } = getStatusDisplay(item, currentRate);
  const packetPreview = truncatePacketHex(item.packetHex);

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
