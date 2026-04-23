/**
 * RobotVacuumAccessory
 *
 * Maps the Miele Scout RX2 robot vacuum to HomeKit services. Each service is
 * individually toggleable via the `features` object in config.json — services
 * that are disabled are NOT added to HomeKit, and any previously cached copy
 * is removed from the accessory on startup.
 *
 * Available services (all optional):
 *   • Switch "Start Cleaning"        — ON = clean, OFF = stop
 *   • Switch "Return to Dock"        — Momentary: sends robot home (SendToBase)
 *   • Switch "Pause Cleaning"        — Toggle: ON = paused, OFF = resumed
 *   • OccupancySensor "Cleaning Active"
 *   • OccupancySensor "Scout Docked"
 *   • ContactSensor "Dust Box"
 *   • MotionSensor "Scout Stuck"
 *   • Battery
 *
 * The AccessoryInformation service is always present — HomeKit requires it.
 */

import {
  PlatformAccessory,
  CharacteristicValue,
  Service,
  WithUUID,
} from 'homebridge';

import { MieleScoutPlatform } from './platform';
import {
  MieleApiClient,
  MieleDeviceState,
  ProcessAction,
  DeviceStatus,
} from './mieleApi';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOW_BATTERY_THRESHOLD = 20;       // % below which low-battery fires
const MOMENTARY_RESET_MS    = 1_500;    // ms before momentary switches reset

// Stable HAP subtype identifiers — changing these would orphan cached services
const SUBTYPE = {
  cleaning:  'cleaning-switch',
  dock:      'dock-switch',
  pause:     'pause-switch',
  cleaningS: 'cleaning-sensor',
  dockedS:   'docked-sensor',
  dustBox:   'dustbox-sensor',
  stuck:     'stuck-sensor',
} as const;

// ---------------------------------------------------------------------------
// RobotVacuumAccessory
// ---------------------------------------------------------------------------

export class RobotVacuumAccessory {
  // ----- HomeKit services (optional — present only if feature enabled) -----
  private readonly infoService:      Service;
  private readonly cleaningSwitch?:  Service;
  private readonly dockSwitch?:      Service;
  private readonly pauseSwitch?:     Service;
  private readonly cleaningSensor?:  Service;
  private readonly dockedSensor?:    Service;
  private readonly dustBoxSensor?:   Service;
  private readonly stuckSensor?:     Service;
  private readonly batteryService?:  Service;

  // ----- Cached device state -----
  private isOn        = false;
  private isPaused    = false;
  private isDocked    = false;
  private isFaulted   = false;
  private isOffline   = false;
  private dustBoxIn   = true;
  private isBlocked   = false;
  private batteryLevel  = 100;
  private isCharging    = false;
  private isLowBattery  = false;

  // ----- Timers -----
  private dockResetTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly platform: MieleScoutPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly api: MieleApiClient,
    private readonly deviceId: string,
  ) {
    const { Service: Svc, Characteristic } = platform;
    const device = accessory.context.device;
    const name   = accessory.displayName;
    const feat   = platform.features;

    // -------------------------------------------------------------------------
    // AccessoryInformation (always present — required by HomeKit)
    // -------------------------------------------------------------------------
    this.infoService =
      accessory.getService(Svc.AccessoryInformation) ||
      accessory.addService(Svc.AccessoryInformation);

    this.infoService
      .setCharacteristic(Characteristic.Manufacturer, 'Miele')
      .setCharacteristic(Characteristic.Model, device?.ident?.modelDesignation ?? 'Scout RX2')
      .setCharacteristic(Characteristic.SerialNumber, device?.ident?.fabNumber ?? deviceId)
      .setCharacteristic(Characteristic.FirmwareRevision, '1.3.1');

    // -------------------------------------------------------------------------
    // Conditional services — each one created only if enabled in config
    // -------------------------------------------------------------------------

    this.cleaningSwitch = this.enableService(
      feat.startCleaningSwitch,
      Svc.Switch,
      SUBTYPE.cleaning,
      `${name} Start Cleaning`,
      (svc) => {
        svc.getCharacteristic(Characteristic.On)
          .onGet(this.handleCleaningGet.bind(this))
          .onSet(this.handleCleaningSet.bind(this));
      },
    );

    this.dockSwitch = this.enableService(
      feat.returnToDockSwitch,
      Svc.Switch,
      SUBTYPE.dock,
      `${name} Return to Dock`,
      (svc) => {
        svc.getCharacteristic(Characteristic.On)
          .onGet(async () => false)
          .onSet(this.handleDockSet.bind(this));
      },
    );

    this.pauseSwitch = this.enableService(
      feat.pauseSwitch,
      Svc.Switch,
      SUBTYPE.pause,
      `${name} Pause Cleaning`,
      (svc) => {
        svc.getCharacteristic(Characteristic.On)
          .onGet(this.handlePauseGet.bind(this))
          .onSet(this.handlePauseSet.bind(this));
      },
    );

    this.cleaningSensor = this.enableService(
      feat.cleaningActiveSensor,
      Svc.OccupancySensor,
      SUBTYPE.cleaningS,
      `${name} Cleaning Active`,
      (svc) => {
        svc.getCharacteristic(Characteristic.OccupancyDetected)
          .onGet(this.handleCleaningSensorGet.bind(this));
        svc.getCharacteristic(Characteristic.StatusFault)
          .onGet(this.handleFaultGet.bind(this));
        svc.getCharacteristic(Characteristic.StatusActive)
          .onGet(this.handleActiveGet.bind(this));
      },
    );

    this.dockedSensor = this.enableService(
      feat.dockedSensor,
      Svc.OccupancySensor,
      SUBTYPE.dockedS,
      `${name} Docked`,
      (svc) => {
        svc.getCharacteristic(Characteristic.OccupancyDetected)
          .onGet(this.handleDockedSensorGet.bind(this));
        svc.getCharacteristic(Characteristic.StatusActive)
          .onGet(this.handleActiveGet.bind(this));
      },
    );

    this.dustBoxSensor = this.enableService(
      feat.dustBoxSensor,
      Svc.ContactSensor,
      SUBTYPE.dustBox,
      `${name} Dust Box`,
      (svc) => {
        svc.getCharacteristic(Characteristic.ContactSensorState)
          .onGet(this.handleDustBoxGet.bind(this));
        svc.getCharacteristic(Characteristic.StatusActive)
          .onGet(this.handleActiveGet.bind(this));
      },
    );

    this.stuckSensor = this.enableService(
      feat.stuckSensor,
      Svc.MotionSensor,
      SUBTYPE.stuck,
      `${name} Stuck`,
      (svc) => {
        svc.getCharacteristic(Characteristic.MotionDetected)
          .onGet(this.handleStuckGet.bind(this));
        svc.getCharacteristic(Characteristic.StatusActive)
          .onGet(this.handleActiveGet.bind(this));
      },
    );

    // Battery service has no subtype (there's only ever one per accessory)
    this.batteryService = this.enableServiceNoSubtype(
      feat.batteryService,
      Svc.Battery,
      (svc) => {
        svc.getCharacteristic(Characteristic.BatteryLevel)
          .onGet(() => this.batteryLevel);
        svc.getCharacteristic(Characteristic.ChargingState)
          .onGet(this.handleChargingStateGet.bind(this));
        svc.getCharacteristic(Characteristic.StatusLowBattery)
          .onGet(this.handleLowBatteryGet.bind(this));
      },
    );

    platform.log.debug(`[${name}] RobotVacuumAccessory ready (${deviceId})`);
  }

  // ===========================================================================
  // Service enable / remove helper
  // ===========================================================================

  /**
   * Creates the service (or restores the cached copy) when `enabled` is true,
   * OR removes any previously cached copy when `enabled` is false.
   * Returns the live Service reference, or undefined when disabled.
   *
   * Services with multiple instances per accessory (e.g. multiple Switches)
   * require a stable subtype string.
   */
  private enableService(
    enabled: boolean,
    serviceType: WithUUID<typeof Service>,
    subtype: string,
    displayName: string,
    configure: (svc: Service) => void,
  ): Service | undefined {
    const existing = this.accessory.getServiceById(serviceType, subtype);

    if (enabled) {
      const svc = existing ?? this.accessory.addService(serviceType, displayName, subtype);
      // Update display name if user renamed the accessory
      svc.setCharacteristic(this.platform.Characteristic.Name, displayName);
      configure(svc);
      return svc;
    }

    if (existing) {
      this.platform.log.info(`[${this.accessory.displayName}] Removing disabled service: ${displayName}`);
      this.accessory.removeService(existing);
    }
    return undefined;
  }

  /** Variant for singleton services (Battery, AccessoryInformation) that have no subtype. */
  private enableServiceNoSubtype(
    enabled: boolean,
    serviceType: WithUUID<typeof Service>,
    configure: (svc: Service) => void,
  ): Service | undefined {
    const existing = this.accessory.getService(serviceType);

    if (enabled) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const svc = existing ?? this.accessory.addService(serviceType as any);
      configure(svc);
      return svc;
    }

    if (existing) {
      this.platform.log.info(
        `[${this.accessory.displayName}] Removing disabled service: ${serviceType.name}`,
      );
      this.accessory.removeService(existing);
    }
    return undefined;
  }

  // ===========================================================================
  // Command handlers — Switch "Start Cleaning"
  // ===========================================================================

  private async handleCleaningGet(): Promise<CharacteristicValue> {
    return this.isOn;
  }

  private async handleCleaningSet(value: CharacteristicValue): Promise<void> {
    if (this.isOffline) {
      this.platform.log.warn(`[${this.accessory.displayName}] Cannot send command — robot is offline.`);
      this.throwHapError();
    }

    const start = value as boolean;
    const prevIsOn = this.isOn;

    this.platform.log.info(
      `[${this.accessory.displayName}] SET Cleaning → ${start ? 'START' : 'STOP'}`,
    );

    try {
      await this.api.sendProcessAction(
        this.deviceId,
        start ? ProcessAction.Start : ProcessAction.Stop,
      );
      this.isOn = start;
      if (!start) {
        this.isPaused = false;
        this.pauseSwitch?.updateCharacteristic(this.platform.Characteristic.On, false);
      }
    } catch (err) {
      this.platform.log.error(`[${this.accessory.displayName}] Cleaning action failed:`, String(err));
      this.cleaningSwitch?.updateCharacteristic(this.platform.Characteristic.On, prevIsOn);
      this.throwHapError();
    }
  }

  // ===========================================================================
  // Command handlers — Switch "Return to Dock"
  // ===========================================================================

  private async handleDockSet(value: CharacteristicValue): Promise<void> {
    if (!(value as boolean)) {
      return;
    }

    if (this.isOffline) {
      this.platform.log.warn(`[${this.accessory.displayName}] Cannot dock — robot is offline.`);
      this.scheduleMomentaryReset();
      this.throwHapError();
    }

    this.platform.log.info(`[${this.accessory.displayName}] Sending to dock (SendToBase).`);
    const prevIsOn     = this.isOn;
    const prevIsPaused = this.isPaused;

    try {
      await this.api.sendProcessAction(this.deviceId, ProcessAction.SendToBase);
      this.isOn     = false;
      this.isPaused = false;

      this.cleaningSwitch?.updateCharacteristic(this.platform.Characteristic.On, false);
      this.pauseSwitch?.updateCharacteristic(this.platform.Characteristic.On, false);
    } catch (err) {
      this.platform.log.error(`[${this.accessory.displayName}] Return-to-dock failed:`, String(err));
      this.isOn     = prevIsOn;
      this.isPaused = prevIsPaused;
      this.throwHapError();
    } finally {
      this.scheduleMomentaryReset();
    }
  }

  // ===========================================================================
  // Command handlers — Switch "Pause Cleaning"
  // ===========================================================================

  private async handlePauseGet(): Promise<CharacteristicValue> {
    return this.isPaused;
  }

  private async handlePauseSet(value: CharacteristicValue): Promise<void> {
    if (this.isOffline) {
      this.platform.log.warn(`[${this.accessory.displayName}] Cannot pause — robot is offline.`);
      this.throwHapError();
    }

    const pause = value as boolean;
    const prevIsPaused = this.isPaused;

    if (pause && !this.isOn) {
      this.platform.log.warn(`[${this.accessory.displayName}] Pause ignored — robot is not cleaning.`);
      this.pauseSwitch?.updateCharacteristic(this.platform.Characteristic.On, false);
      return;
    }
    if (!pause && !this.isPaused) {
      this.platform.log.warn(`[${this.accessory.displayName}] Resume ignored — robot is not paused.`);
      return;
    }

    this.platform.log.info(
      `[${this.accessory.displayName}] SET Pause → ${pause ? 'PAUSE' : 'RESUME'}`,
    );

    try {
      await this.api.sendProcessAction(
        this.deviceId,
        pause ? ProcessAction.Pause : ProcessAction.Start,
      );
      this.isPaused = pause;
    } catch (err) {
      this.platform.log.error(`[${this.accessory.displayName}] Pause action failed:`, String(err));
      this.pauseSwitch?.updateCharacteristic(this.platform.Characteristic.On, prevIsPaused);
      this.throwHapError();
    }
  }

  // ===========================================================================
  // Sensor GET handlers
  // ===========================================================================

  private async handleCleaningSensorGet(): Promise<CharacteristicValue> {
    const { Characteristic } = this.platform;
    return this.isOn
      ? Characteristic.OccupancyDetected.OCCUPANCY_DETECTED
      : Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED;
  }

  private async handleDockedSensorGet(): Promise<CharacteristicValue> {
    const { Characteristic } = this.platform;
    return this.isDocked
      ? Characteristic.OccupancyDetected.OCCUPANCY_DETECTED
      : Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED;
  }

  private async handleDustBoxGet(): Promise<CharacteristicValue> {
    const { Characteristic } = this.platform;
    return this.dustBoxIn
      ? Characteristic.ContactSensorState.CONTACT_DETECTED
      : Characteristic.ContactSensorState.CONTACT_NOT_DETECTED;
  }

  private async handleStuckGet(): Promise<CharacteristicValue> {
    return this.isBlocked;
  }

  private async handleFaultGet(): Promise<CharacteristicValue> {
    const { Characteristic } = this.platform;
    return this.isFaulted
      ? Characteristic.StatusFault.GENERAL_FAULT
      : Characteristic.StatusFault.NO_FAULT;
  }

  private async handleActiveGet(): Promise<CharacteristicValue> {
    return !this.isOffline;
  }

  private async handleChargingStateGet(): Promise<CharacteristicValue> {
    const { Characteristic } = this.platform;
    return this.isCharging
      ? Characteristic.ChargingState.CHARGING
      : Characteristic.ChargingState.NOT_CHARGING;
  }

  private async handleLowBatteryGet(): Promise<CharacteristicValue> {
    const { Characteristic } = this.platform;
    return this.isLowBattery
      ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
      : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
  }

  // ===========================================================================
  // State update — called on every SSE event or poll tick
  // ===========================================================================

  updateState(state: MieleDeviceState): void {
    const statusRaw: number = state.status?.value_raw ?? DeviceStatus.Off;
    const rc = state.robotCleaner;

    this.platform.log.debug(
      `[${this.accessory.displayName}] updateState` +
        ` status=${statusRaw} battery=${state.batteryLevel}%` +
        ` dustBox=${rc?.dustBoxInserted ?? '?'}` +
        ` blocked=${rc?.blocked ?? '?'} lost=${rc?.lost ?? '?'}`,
    );

    // Snapshot previous values
    const prev = {
      isOn:       this.isOn,
      isPaused:   this.isPaused,
      isDocked:   this.isDocked,
      isFaulted:  this.isFaulted,
      isOffline:  this.isOffline,
      dustBoxIn:  this.dustBoxIn,
      isBlocked:  this.isBlocked,
    };

    // Derive new state
    this.isOffline = MieleApiClient.isOffline(statusRaw);
    this.isOn      = !this.isOffline && MieleApiClient.isRunning(statusRaw);
    this.isPaused  = !this.isOffline && MieleApiClient.isPaused(statusRaw);
    this.isDocked  = !this.isOffline && MieleApiClient.isDocked(statusRaw);
    this.isFaulted = !this.isOffline && MieleApiClient.isFaulted(statusRaw);

    if (rc !== undefined) {
      this.dustBoxIn = rc.dustBoxInserted ?? true;
      this.isBlocked = (rc.blocked ?? false) || (rc.lost ?? false);
    }

    if (typeof state.batteryLevel === 'number') {
      this.batteryLevel = Math.max(0, Math.min(100, state.batteryLevel));
    }
    this.isCharging   = !this.isOffline && this.isDocked && this.batteryLevel < 100;
    this.isLowBattery = this.batteryLevel < LOW_BATTERY_THRESHOLD;

    // ------------------------------------------------------------------
    // Push only changed values to HomeKit (all guarded by optional-chain)
    // ------------------------------------------------------------------
    const { Characteristic } = this.platform;

    // Start Cleaning switch
    if (prev.isOn !== this.isOn) {
      this.cleaningSwitch?.updateCharacteristic(Characteristic.On, this.isOn);
    }

    // Pause switch
    if (prev.isPaused !== this.isPaused) {
      this.pauseSwitch?.updateCharacteristic(Characteristic.On, this.isPaused);
    }

    // Cleaning Active sensor
    this.cleaningSensor?.updateCharacteristic(
      Characteristic.OccupancyDetected,
      this.isOn
        ? Characteristic.OccupancyDetected.OCCUPANCY_DETECTED
        : Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED,
    );
    this.cleaningSensor?.updateCharacteristic(
      Characteristic.StatusFault,
      this.isFaulted
        ? Characteristic.StatusFault.GENERAL_FAULT
        : Characteristic.StatusFault.NO_FAULT,
    );

    // Docked sensor
    if (prev.isDocked !== this.isDocked) {
      this.dockedSensor?.updateCharacteristic(
        Characteristic.OccupancyDetected,
        this.isDocked
          ? Characteristic.OccupancyDetected.OCCUPANCY_DETECTED
          : Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED,
      );
    }

    // Dust box contact sensor
    if (prev.dustBoxIn !== this.dustBoxIn) {
      this.dustBoxSensor?.updateCharacteristic(
        Characteristic.ContactSensorState,
        this.dustBoxIn
          ? Characteristic.ContactSensorState.CONTACT_DETECTED
          : Characteristic.ContactSensorState.CONTACT_NOT_DETECTED,
      );
      if (!this.dustBoxIn) {
        this.platform.log.warn(`[${this.accessory.displayName}] Dust box has been removed!`);
      }
    }

    // Stuck motion sensor
    if (prev.isBlocked !== this.isBlocked) {
      this.stuckSensor?.updateCharacteristic(Characteristic.MotionDetected, this.isBlocked);
      if (this.isBlocked) {
        this.platform.log.warn(`[${this.accessory.displayName}] Robot is stuck or lost!`);
      }
    }

    // StatusActive on all sensors when offline flag changes
    if (prev.isOffline !== this.isOffline) {
      const active = !this.isOffline;
      this.cleaningSensor?.updateCharacteristic(Characteristic.StatusActive, active);
      this.dockedSensor?.updateCharacteristic(Characteristic.StatusActive, active);
      this.dustBoxSensor?.updateCharacteristic(Characteristic.StatusActive, active);
      this.stuckSensor?.updateCharacteristic(Characteristic.StatusActive, active);

      if (this.isOffline) {
        this.platform.log.warn(`[${this.accessory.displayName}] Robot went offline (NotConnected).`);
      } else {
        this.platform.log.info(`[${this.accessory.displayName}] Robot is back online.`);
      }
    }

    // Battery
    this.batteryService?.updateCharacteristic(Characteristic.BatteryLevel, this.batteryLevel);
    this.batteryService?.updateCharacteristic(
      Characteristic.ChargingState,
      this.isCharging
        ? Characteristic.ChargingState.CHARGING
        : Characteristic.ChargingState.NOT_CHARGING,
    );
    this.batteryService?.updateCharacteristic(
      Characteristic.StatusLowBattery,
      this.isLowBattery
        ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
        : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
    );
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  /** Auto-reset the dock momentary switch to OFF after MOMENTARY_RESET_MS. */
  private scheduleMomentaryReset(): void {
    if (!this.dockSwitch) {
      return;
    }
    if (this.dockResetTimer) {
      clearTimeout(this.dockResetTimer);
    }
    this.dockResetTimer = setTimeout(() => {
      this.dockResetTimer = null;
      this.dockSwitch?.updateCharacteristic(this.platform.Characteristic.On, false);
    }, MOMENTARY_RESET_MS);
  }

  private throwHapError(): never {
    throw new this.platform.hbApi.hap.HapStatusError(
      this.platform.hbApi.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
    );
  }

  /** Cleanup on shutdown / accessory removal. */
  destroy(): void {
    if (this.dockResetTimer) {
      clearTimeout(this.dockResetTimer);
      this.dockResetTimer = null;
    }
  }
}
