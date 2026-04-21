/**
 * Miele REST API Client
 *
 * Handles OAuth2 authentication and all communication with the
 * Miele@home API (https://api.mcs3.mcp.miele.com/v1/).
 *
 * Miele Developer Documentation:
 * https://www.miele.com/developer/swagger-ui/index.html
 */

import axios, { AxiosInstance, AxiosError } from 'axios';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIELE_BASE_URL = 'https://api.mcs3.mcp.miele.com/v1';
const MIELE_AUTH_URL = 'https://api.mcs3.mcp.miele.com/thirdparty/login';
const MIELE_TOKEN_URL = 'https://api.mcs3.mcp.miele.com/thirdparty/token';

// ---------------------------------------------------------------------------
// Enums — mirrors Miele API values
// ---------------------------------------------------------------------------

/** processAction values accepted by the Miele API */
export enum ProcessAction {
  Start = 1,
  Stop = 2,
  Pause = 3,
  StartSuperFooling = 4, // not used for vacuums
  ResetFreezer = 5,
  SendToBase = 6,
}

/** Status values returned by the Miele API for a device */
export enum DeviceStatus {
  Off = 1,
  On = 2,
  Programmed = 3,
  ProgrammedWaitingToStart = 4,
  Running = 5,
  Pause = 6,
  EndProgrammed = 7,
  Failure = 8,
  ProgramInterrupted = 9,
  Idle = 10,
  Rinsehold = 11,
  Service = 12,
  Superfreezing = 13,
  Supercooling = 14,
  Superheating = 15,
  SupercoolingSuperfreezing = 146,
  NotConnected = 255,
}

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface MieleAuthToken {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  /** Local timestamp (ms) when the token was issued */
  issued_at: number;
}

export interface MieleDeviceState {
  status: { value_raw: number; value_localized: string };
  programType: { value_raw: number; value_localized: string };
  programPhase: { value_raw: number; value_localized: string };
  remainingTime: number[];
  batteryLevel: number;
  robotCleaner?: {
    dustBoxInserted: boolean;
    lost: boolean;
    blocked: boolean;
  };
}

export interface MieleDevice {
  fabNumber: string;
  type: { value_raw: number; value_localized: string };
  deviceName: string;
  modelDesignation: string;
  state: MieleDeviceState;
}

export interface MieleConfig {
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
  country?: string;
  debug?: boolean;
}

// ---------------------------------------------------------------------------
// MieleApiClient
// ---------------------------------------------------------------------------

export class MieleApiClient {
  private readonly config: MieleConfig;
  private token: MieleAuthToken | null = null;
  private http: AxiosInstance;

  constructor(config: MieleConfig) {
    this.config = config;

    this.http = axios.create({
      baseURL: MIELE_BASE_URL,
      timeout: 15_000,
    });
  }

  // -------------------------------------------------------------------------
  // Authentication
  // -------------------------------------------------------------------------

  /**
   * Obtain a new access token using Resource Owner Password Credentials flow.
   * Miele's developer API supports this for registered dev applications.
   */
  async authenticate(): Promise<void> {
    const params = new URLSearchParams({
      grant_type: 'password',
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      username: this.config.username,
      password: this.config.password,
      vg: this.config.country ?? 'en-GB',
    });

    try {
      const response = await axios.post<MieleAuthToken>(
        MIELE_TOKEN_URL,
        params.toString(),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 15_000,
        },
      );

      this.token = {
        ...response.data,
        issued_at: Date.now(),
      };

      this.debug('Authentication successful.');
    } catch (err) {
      throw new Error(`Miele authentication failed: ${this.formatError(err)}`);
    }
  }

  /**
   * Refresh the access token using the stored refresh token.
   */
  async refreshToken(): Promise<void> {
    if (!this.token?.refresh_token) {
      return this.authenticate();
    }

    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      refresh_token: this.token.refresh_token,
    });

    try {
      const response = await axios.post<MieleAuthToken>(
        MIELE_TOKEN_URL,
        params.toString(),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 15_000,
        },
      );

      this.token = {
        ...response.data,
        issued_at: Date.now(),
      };

      this.debug('Token refreshed successfully.');
    } catch {
      // Refresh failed — fall back to full re-authentication
      this.debug('Token refresh failed — re-authenticating.');
      await this.authenticate();
    }
  }

  /**
   * Ensure we have a valid, non-expired token before each API call.
   */
  private async ensureAuthenticated(): Promise<void> {
    if (!this.token) {
      await this.authenticate();
      return;
    }

    // Refresh 60 seconds before actual expiry
    const expiresAt = this.token.issued_at + (this.token.expires_in - 60) * 1000;
    if (Date.now() >= expiresAt) {
      await this.refreshToken();
    }
  }

  // -------------------------------------------------------------------------
  // Devices
  // -------------------------------------------------------------------------

  /**
   * Fetch all devices registered on the Miele account.
   * Returns a map of deviceId → MieleDevice.
   */
  async getDevices(): Promise<Record<string, MieleDevice>> {
    await this.ensureAuthenticated();

    try {
      const response = await this.http.get<Record<string, MieleDevice>>(
        '/devices',
        {
          params: { language: this.config.country ?? 'en-GB' },
          headers: this.authHeaders(),
        },
      );
      return response.data;
    } catch (err) {
      throw new Error(`Failed to fetch Miele devices: ${this.formatError(err)}`);
    }
  }

  /**
   * Fetch the live state for a single device.
   */
  async getDeviceState(deviceId: string): Promise<MieleDeviceState> {
    await this.ensureAuthenticated();

    try {
      const response = await this.http.get<MieleDeviceState>(
        `/devices/${deviceId}/state`,
        {
          params: { language: this.config.country ?? 'en-GB' },
          headers: this.authHeaders(),
        },
      );
      return response.data;
    } catch (err) {
      throw new Error(
        `Failed to fetch state for device ${deviceId}: ${this.formatError(err)}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  /**
   * Send a processAction command to a device.
   *
   * @param deviceId  Miele device fabrication number
   * @param action    One of the ProcessAction enum values
   */
  async sendProcessAction(deviceId: string, action: ProcessAction): Promise<void> {
    await this.ensureAuthenticated();

    const body = { processAction: action };

    try {
      await this.http.put(`/devices/${deviceId}/actions`, body, {
        headers: {
          ...this.authHeaders(),
          'Content-Type': 'application/json',
        },
      });
      this.debug(`Action ${action} sent to device ${deviceId}.`);
    } catch (err) {
      throw new Error(
        `Failed to send action ${action} to device ${deviceId}: ${this.formatError(err)}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // SSE support
  // -------------------------------------------------------------------------

  /**
   * Returns a fresh, valid access token string.
   * Used by MieleSSEClient as its TokenProvider callback so that the SSE
   * connection always authenticates with an up-to-date token (including
   * after automatic token refreshes).
   */
  async getAccessToken(): Promise<string> {
    await this.ensureAuthenticated();
    return this.token!.access_token;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Returns true when the device status represents an active cleaning run. */
  static isRunning(status: number): boolean {
    return status === DeviceStatus.Running || status === DeviceStatus.Pause;
  }

  /** Returns true when the device is docked / charging (on base, not cleaning). */
  static isDocked(status: number): boolean {
    return (
      status === DeviceStatus.Off ||
      status === DeviceStatus.On ||
      status === DeviceStatus.Idle ||
      status === DeviceStatus.EndProgrammed
    );
  }

  /** Returns true when the device has reported a fault. */
  static isFaulted(status: number): boolean {
    return (
      status === DeviceStatus.Failure ||
      status === DeviceStatus.ProgramInterrupted
    );
  }

  /** Returns true when the device is offline / not reachable via Wi-Fi. */
  static isOffline(status: number): boolean {
    return status === DeviceStatus.NotConnected;
  }

  /**
   * Returns true when the device is mid-clean but paused by the user.
   * Note: isRunning() also returns true for Pause — this helper lets callers
   * distinguish "actively cleaning" from "paused mid-run".
   */
  static isPaused(status: number): boolean {
    return status === DeviceStatus.Pause;
  }

  private authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token!.access_token}`,
      Accept: 'application/json; charset=utf-8',
    };
  }

  private formatError(err: unknown): string {
    if (err instanceof AxiosError) {
      const status = err.response?.status ?? 'no response';
      const data = err.response?.data
        ? JSON.stringify(err.response.data)
        : err.message;
      return `HTTP ${status} — ${data}`;
    }
    if (err instanceof Error) {
      return err.message;
    }
    return String(err);
  }

  private debug(message: string): void {
    if (this.config.debug) {
      // eslint-disable-next-line no-console
      console.debug(`[MieleAPI] ${message}`);
    }
  }

  // Expose auth URL constants for external use (e.g. in future OAuth flow)
  static readonly AUTH_URL = MIELE_AUTH_URL;
  static readonly TOKEN_URL = MIELE_TOKEN_URL;
}
