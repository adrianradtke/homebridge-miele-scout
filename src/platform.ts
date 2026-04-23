/**
 * MieleScoutPlatform
 *
 * Main HomeBridge platform class.  On startup it:
 *   1. Authenticates with the Miele API
 *   2. Discovers all registered Miele robot vacuum devices
 *   3. Registers each device as a HomeBridge / HomeKit accessory
 *   4. Opens an SSE stream for real-time state updates
 *   5. Falls back to REST polling if SSE cannot connect after
 *      SSE_FALLBACK_TIMEOUT_MS milliseconds
 *
 * HomeBridge Platform lifecycle:
 *   configureAccessory  → called for each cached accessory on restart
 *   discoverDevices     → called once HomeBridge has finished launching
 */

import {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
} from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './index';
import { MieleApiClient, MieleDevice, MieleDeviceState } from './mieleApi';
import { MieleSSEClient } from './mieleSSE';
import { RobotVacuumAccessory } from './robotVacuumAccessory';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Miele device type ID for robot vacuum cleaners */
const ROBOT_VACUUM_TYPE_ID = 74;

/**
 * How long (ms) we wait for an SSE 'connected' event before giving up and
 * enabling the polling fallback instead.
 */
const SSE_FALLBACK_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Config interface
// ---------------------------------------------------------------------------

/**
 * Per-service enable flags. Any feature set to false will not be exposed in
 * HomeKit — and if it was previously exposed, it is removed from the cached
 * accessory on the next HomeBridge restart.
 */
export interface MieleFeatures {
  startCleaningSwitch: boolean;
  returnToDockSwitch:  boolean;
  pauseSwitch:         boolean;
  cleaningActiveSensor: boolean;
  dockedSensor:        boolean;
  dustBoxSensor:       boolean;
  stuckSensor:         boolean;
  batteryService:      boolean;
}

/** Defaults — everything ON for backward compatibility with v1.2.0 installs. */
export const DEFAULT_FEATURES: MieleFeatures = {
  startCleaningSwitch:  true,
  returnToDockSwitch:   true,
  pauseSwitch:          true,
  cleaningActiveSensor: true,
  dockedSensor:         true,
  dustBoxSensor:        true,
  stuckSensor:          true,
  batteryService:       true,
};

export interface MielePlatformConfig extends PlatformConfig {
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
  country?: string;
  pollingInterval?: number;
  debug?: boolean;
  features?: Partial<MieleFeatures>;
}

// ---------------------------------------------------------------------------
// Platform
// ---------------------------------------------------------------------------

export class MieleScoutPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  /** Cached accessories restored from disk by HomeBridge on restart */
  public readonly accessories: PlatformAccessory[] = [];

  /** Live accessory handler instances keyed by Miele device ID */
  private readonly handlers = new Map<string, RobotVacuumAccessory>();

  /** Resolved feature flags (defaults merged with user config) */
  public readonly features: MieleFeatures;

  private readonly apiClient: MieleApiClient;
  private sseClient: MieleSSEClient | null = null;

  /** REST polling timer — only active when SSE is unavailable */
  private pollingTimer: ReturnType<typeof setInterval> | null = null;

  /** Whether SSE connected successfully */
  private sseConnected = false;

  constructor(
    public readonly log: Logger,
    public readonly config: MielePlatformConfig,
    public readonly hbApi: API,
  ) {
    this.Service = hbApi.hap.Service;
    this.Characteristic = hbApi.hap.Characteristic;

    if (!config.clientId || !config.clientSecret || !config.username || !config.password) {
      this.log.error(
        'Missing required configuration. Provide clientId, clientSecret, username, and password.',
      );
    }

    // Merge user-supplied feature flags with defaults
    this.features = { ...DEFAULT_FEATURES, ...(config.features ?? {}) };

    const disabled = Object.entries(this.features)
      .filter(([, enabled]) => !enabled)
      .map(([name]) => name);
    if (disabled.length) {
      this.log.info(`Disabled features: ${disabled.join(', ')}`);
    }

    this.apiClient = new MieleApiClient({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      username: config.username,
      password: config.password,
      country: config.country ?? 'en-GB',
      debug: config.debug ?? false,
    });

    this.log.debug('MieleScoutPlatform initialised — waiting for HomeBridge didFinishLaunching.');

    hbApi.on('didFinishLaunching', () => {
      this.log.debug('didFinishLaunching — starting device discovery.');
      this.discoverDevices();
    });
  }

  // ---------------------------------------------------------------------------
  // HomeBridge lifecycle callbacks
  // ---------------------------------------------------------------------------

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info('Restoring cached accessory from disk:', accessory.displayName);
    this.accessories.push(accessory);
  }

  // ---------------------------------------------------------------------------
  // Device discovery
  // ---------------------------------------------------------------------------

  private async discoverDevices(): Promise<void> {
    // Step 1 — authenticate
    try {
      await this.apiClient.authenticate();
    } catch (err) {
      this.log.error('Miele authentication failed:', String(err));
      this.log.error('Plugin disabled until credentials are corrected.');
      return;
    }

    // Step 2 — fetch device list
    let devices: Record<string, MieleDevice>;
    try {
      devices = await this.apiClient.getDevices();
    } catch (err) {
      this.log.error('Failed to fetch Miele devices:', String(err));
      return;
    }

    const deviceEntries = Object.entries(devices);
    this.log.info(`Found ${deviceEntries.length} Miele device(s) on account.`);

    const activeUUIDs = new Set<string>();

    for (const [deviceId, device] of deviceEntries) {
      if (device.ident.type.value_raw !== ROBOT_VACUUM_TYPE_ID) {
        this.log.info(
          `Skipping device ${deviceId} — type_raw=${device.ident.type.value_raw} (${device.ident.type.value_localized})`,
        );
        continue;
      }

      const uuid = this.hbApi.hap.uuid.generate(deviceId);
      activeUUIDs.add(uuid);

      const displayName =
        device.ident.deviceName ||
        device.ident.modelDesignation ||
        `Miele Scout (${deviceId.slice(-4)})`;

      const existing = this.accessories.find((a) => a.UUID === uuid);

      if (existing) {
        this.log.info('Restoring accessory:', displayName);
        existing.context.device = device;
        existing.context.deviceId = deviceId;
        this.hbApi.updatePlatformAccessories([existing]);
        this.handlers.set(
          deviceId,
          new RobotVacuumAccessory(this, existing, this.apiClient, deviceId),
        );
      } else {
        this.log.info('Registering new accessory:', displayName);
        const acc = new this.hbApi.platformAccessory(displayName, uuid);
        acc.context.device = device;
        acc.context.deviceId = deviceId;
        this.handlers.set(
          deviceId,
          new RobotVacuumAccessory(this, acc, this.apiClient, deviceId),
        );
        this.hbApi.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
      }
    }

    // Remove stale accessories
    const stale = this.accessories.filter((a) => !activeUUIDs.has(a.UUID));
    if (stale.length) {
      this.log.info(`Removing ${stale.length} stale accessory(ies).`);
      this.hbApi.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    }

    if (this.handlers.size === 0) {
      this.log.warn('No robot vacuum devices found on this Miele account.');
      return;
    }

    // Step 3 — start SSE, with polling fallback
    this.startSSE();
  }

  // ---------------------------------------------------------------------------
  // SSE — real-time updates
  // ---------------------------------------------------------------------------

  private startSSE(): void {
    this.log.info('Starting Miele real-time event stream (SSE)…');

    this.sseClient = new MieleSSEClient(
      () => this.apiClient.getAccessToken(),
      this.log,
    );

    // When a device state event arrives, route it to the correct handler
    this.sseClient.on('deviceUpdate', (deviceId: string, state: MieleDeviceState) => {
      const handler = this.handlers.get(deviceId);
      if (handler) {
        handler.updateState(state);
      } else {
        this.log.debug(`[SSE] Received update for unknown device ${deviceId} — ignoring.`);
      }
    });

    // Mark SSE as connected and cancel fallback polling timer
    this.sseClient.on('connected', () => {
      this.sseConnected = true;
      if (this.pollingTimer) {
        this.log.info('SSE connected — disabling polling fallback.');
        clearInterval(this.pollingTimer);
        this.pollingTimer = null;
      }
    });

    // If SSE disconnects, start polling as fallback until it reconnects
    this.sseClient.on('disconnected', (reason: string) => {
      this.log.warn(`[SSE] Disconnected (${reason}) — activating polling fallback.`);
      this.sseConnected = false;
      this.startPollingFallback();
    });

    this.sseClient.on('error', (err: Error) => {
      this.log.debug('[SSE] Error:', err.message);
    });

    this.sseClient.start();

    // Give SSE a window to connect; start polling as fallback if it doesn't
    setTimeout(() => {
      if (!this.sseConnected) {
        this.log.warn(
          `SSE did not connect within ${SSE_FALLBACK_TIMEOUT_MS / 1000}s — ` +
            'falling back to REST polling.',
        );
        this.startPollingFallback();
      }
    }, SSE_FALLBACK_TIMEOUT_MS);
  }

  // ---------------------------------------------------------------------------
  // REST polling fallback
  // ---------------------------------------------------------------------------

  private startPollingFallback(): void {
    if (this.pollingTimer) {
      return; // already running
    }

    const intervalMs = (this.config.pollingInterval ?? 30) * 1_000;
    this.log.info(`Polling Miele API every ${intervalMs / 1000}s (fallback mode).`);

    // Run immediately, then on interval
    void this.pollAllDevices();
    this.pollingTimer = setInterval(() => void this.pollAllDevices(), intervalMs);
  }

  private async pollAllDevices(): Promise<void> {
    // Stop polling if SSE has since reconnected
    if (this.sseConnected && this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
      return;
    }

    for (const [deviceId, handler] of this.handlers) {
      try {
        const state = await this.apiClient.getDeviceState(deviceId);
        handler.updateState(state);
      } catch (err) {
        this.log.warn(`Poll failed for device ${deviceId}:`, String(err));
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Shutdown
  // ---------------------------------------------------------------------------

  /** Called by HomeBridge on shutdown — clean up timers and connections. */
  shutdown(): void {
    this.log.debug('Platform shutting down.');

    if (this.sseClient) {
      this.sseClient.stop();
      this.sseClient = null;
    }

    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }

    for (const handler of this.handlers.values()) {
      handler.destroy();
    }
  }
}
