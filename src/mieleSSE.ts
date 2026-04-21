/**
 * MieleSSEClient
 *
 * Connects to the Miele@home Server-Sent Events (SSE) endpoint:
 *   GET https://api.mcs3.mcp.miele.com/v1/devices/all/events
 *
 * The SSE stream pushes real-time device state changes so we don't
 * need to poll the REST API on a fixed interval.  Polling remains
 * as a fallback if the SSE connection cannot be established.
 *
 * SSE event format from Miele:
 *   event: devices
 *   data: { "<fabricNumber>": { "ident": {...}, "state": {...} } }
 *
 *   event: actions
 *   data: { "<fabricNumber>": { ... available actions ... } }
 *
 * Emitted Node.js events:
 *   'deviceUpdate'  (deviceId: string, state: MieleDeviceState)
 *   'connected'     ()
 *   'disconnected'  (reason: string)
 *   'error'         (err: Error)
 */

import { EventEmitter } from 'events';
import https from 'https';
import http from 'http';
import { Logger } from 'homebridge';
import { MieleDeviceState } from './mieleApi';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SSE_HOST = 'api.mcs3.mcp.miele.com';
const SSE_PATH = '/v1/devices/all/events';

/** Minimum ms before first reconnect attempt */
const RECONNECT_BASE_MS = 2_000;
/** Maximum ms between reconnect attempts */
const RECONNECT_MAX_MS = 60_000;
/** Multiply delay by this factor each failed attempt */
const RECONNECT_BACKOFF = 2;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Callback used by the platform to supply a fresh access token */
export type TokenProvider = () => Promise<string>;

interface SSEEvent {
  event: string;
  data: string;
}

// ---------------------------------------------------------------------------
// MieleSSEClient
// ---------------------------------------------------------------------------

export class MieleSSEClient extends EventEmitter {
  private readonly tokenProvider: TokenProvider;
  private readonly log: Logger;

  private request: http.ClientRequest | null = null;
  private running = false;
  private reconnectDelay = RECONNECT_BASE_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(tokenProvider: TokenProvider, log: Logger) {
    super();
    this.tokenProvider = tokenProvider;
    this.log = log;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Open the SSE stream.  Call once after authentication. */
  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.connect();
  }

  /** Close the stream permanently (e.g. on HomeBridge shutdown). */
  stop(): void {
    this.running = false;
    this.clearReconnectTimer();
    if (this.request) {
      this.request.destroy();
      this.request = null;
    }
    this.log.debug('[SSE] Stopped.');
  }

  // ---------------------------------------------------------------------------
  // Connection management
  // ---------------------------------------------------------------------------

  private async connect(): Promise<void> {
    if (!this.running) {
      return;
    }

    let token: string;
    try {
      token = await this.tokenProvider();
    } catch (err) {
      this.log.error('[SSE] Failed to obtain access token:', String(err));
      this.scheduleReconnect();
      return;
    }

    this.log.debug('[SSE] Connecting to Miele event stream…');

    const options: https.RequestOptions = {
      hostname: SSE_HOST,
      path: SSE_PATH,
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'text/event-stream',
        'Cache-Control': 'no-cache',
      },
    };

    this.request = https.request(options, (res) => {
      if (res.statusCode === 401 || res.statusCode === 403) {
        this.log.warn(`[SSE] Auth error (${res.statusCode}) — will re-authenticate on next attempt.`);
        res.resume();
        this.scheduleReconnect();
        return;
      }

      if (res.statusCode !== 200) {
        this.log.warn(`[SSE] Unexpected status ${res.statusCode} — reconnecting.`);
        res.resume();
        this.scheduleReconnect();
        return;
      }

      this.log.info('[SSE] Connected to Miele real-time event stream.');
      this.reconnectDelay = RECONNECT_BASE_MS; // reset backoff on success
      this.emit('connected');

      // SSE data arrives as a text stream; buffer it and split on blank lines
      let buffer = '';

      res.setEncoding('utf8');

      res.on('data', (chunk: string) => {
        buffer += chunk;
        // SSE events are separated by a blank line (\n\n)
        const events = buffer.split(/\n\n/);
        // The last element may be incomplete — keep it in the buffer
        buffer = events.pop() ?? '';
        for (const raw of events) {
          if (raw.trim()) {
            this.parseAndEmit(raw);
          }
        }
      });

      res.on('end', () => {
        this.log.warn('[SSE] Stream ended — reconnecting.');
        this.emit('disconnected', 'stream ended');
        this.scheduleReconnect();
      });

      res.on('error', (err) => {
        this.log.warn('[SSE] Stream error:', err.message);
        this.emit('error', err);
        this.scheduleReconnect();
      });
    });

    this.request.on('error', (err) => {
      this.log.warn('[SSE] Request error:', err.message);
      this.emit('error', err);
      this.scheduleReconnect();
    });

    // SSE is a long-lived GET — no body to send, just end the request headers
    this.request.end();
  }

  // ---------------------------------------------------------------------------
  // SSE parsing
  // ---------------------------------------------------------------------------

  /**
   * Parse a single SSE message block (multiple "field: value" lines)
   * and emit a 'deviceUpdate' event for each device found in the data.
   */
  private parseAndEmit(raw: string): void {
    const sseEvent: SSEEvent = { event: 'message', data: '' };
    const dataLines: string[] = [];

    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) {
        sseEvent.event = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trim());
      }
      // 'id:' and 'retry:' fields are ignored for now
    }

    sseEvent.data = dataLines.join('');

    if (!sseEvent.data) {
      return; // heartbeat / keep-alive with no payload
    }

    // We only care about device-state events
    if (sseEvent.event !== 'devices') {
      this.log.debug(`[SSE] Ignoring event type: ${sseEvent.event}`);
      return;
    }

    let payload: Record<string, { state: MieleDeviceState }>;
    try {
      payload = JSON.parse(sseEvent.data);
    } catch {
      this.log.warn('[SSE] Failed to parse event data:', sseEvent.data.slice(0, 120));
      return;
    }

    for (const [deviceId, deviceData] of Object.entries(payload)) {
      if (deviceData?.state) {
        this.log.debug(`[SSE] Received state update for device ${deviceId}.`);
        this.emit('deviceUpdate', deviceId, deviceData.state);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Reconnection with exponential backoff
  // ---------------------------------------------------------------------------

  private scheduleReconnect(): void {
    if (!this.running) {
      return;
    }

    this.clearReconnectTimer();
    this.log.info(`[SSE] Reconnecting in ${this.reconnectDelay / 1000}s…`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);

    // Exponential backoff
    this.reconnectDelay = Math.min(
      this.reconnectDelay * RECONNECT_BACKOFF,
      RECONNECT_MAX_MS,
    );
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
