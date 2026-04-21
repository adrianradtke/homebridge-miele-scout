# homebridge-miele-scout

A [HomeBridge](https://homebridge.io/) plugin for the **Miele Scout RX2** robot vacuum cleaner.

Integrates your Miele Scout RX2 into Apple HomeKit via the [Miele@home Developer API](https://www.miele.com/developer/), allowing you to start/stop cleaning and monitor battery levels through the Home app and Siri.

---

## Features

Every service below can be individually toggled in the HomeBridge UI — disable the ones you don't need and they're removed from HomeKit automatically.

| HomeKit Service | Details |
|---|---|
| **Start Cleaning Switch** | ON = start a cleaning run / OFF = stop |
| **Return to Dock Button** | Momentary switch — sends the robot home (`SendToBase`) |
| **Pause / Resume Switch** | Toggle — ON pauses mid-clean, OFF resumes |
| **Cleaning Active Sensor** | Occupancy sensor for HomeKit automations ("when cleaning finishes…") |
| **Docked Sensor** | Occupancy sensor for HomeKit automations ("when Scout returns home…") |
| **Dust Box Sensor** | Contact sensor — alerts when the dust box is removed |
| **Stuck / Blocked Sensor** | Motion sensor — alerts when the robot is stuck or lost |
| **Battery** | Live battery percentage, charging state, low-battery warning |
| **Accessory Info** | Manufacturer, model and serial number from Miele |

Real-time updates are delivered via **Server-Sent Events (SSE)** from the Miele cloud, with REST polling as an automatic fallback if the stream drops.

---

## Requirements

- [Node.js](https://nodejs.org/) 18 or later
- [HomeBridge](https://homebridge.io/) 1.6 or later
- A **Miele@home** account with your Scout RX2 registered
- A **Miele Developer** application (Client ID + Client Secret)

---

## Getting Your API Credentials

1. Visit [developer.miele.com](https://developer.miele.com/) and sign up / log in with your Miele account.
2. Create a new application — choose **"Third Party Developer"** as the type.
3. Copy the generated **Client ID** and **Client Secret**.

---

## Installation

```bash
npm install -g homebridge-miele-scout
```

Or install via the **HomeBridge UI** plugin search.

---

## Configuration

Add the following platform block to your `config.json`:

```json
{
  "platforms": [
    {
      "platform": "MieleScout",
      "name": "Miele Scout",
      "clientId": "YOUR_CLIENT_ID",
      "clientSecret": "YOUR_CLIENT_SECRET",
      "username": "your@email.com",
      "password": "your_miele_password",
      "country": "en-GB",
      "pollingInterval": 30,
      "debug": false,
      "features": {
        "startCleaningSwitch": true,
        "returnToDockSwitch": true,
        "pauseSwitch": true,
        "cleaningActiveSensor": true,
        "dockedSensor": true,
        "dustBoxSensor": true,
        "stuckSensor": true,
        "batteryService": true
      }
    }
  ]
}
```

### Core Config Options

| Option | Type | Default | Description |
|---|---|---|---|
| `clientId` | string | **required** | Miele Developer app Client ID |
| `clientSecret` | string | **required** | Miele Developer app Client Secret |
| `username` | string | **required** | Your Miele@home account email |
| `password` | string | **required** | Your Miele@home account password |
| `country` | string | `en-GB` | Locale/country code for API responses |
| `pollingInterval` | number | `30` | Seconds between status polls (SSE fallback mode only, 10–300) |
| `debug` | boolean | `false` | Enable verbose API logging |

### Feature Toggles

All feature flags default to `true`. Omit the `features` object entirely to get every service, or set any individual flag to `false` to hide it from HomeKit.

| Feature | Default | What it creates |
|---|---|---|
| `features.startCleaningSwitch` | `true` | Main Start/Stop switch |
| `features.returnToDockSwitch` | `true` | Momentary "Return to Dock" button |
| `features.pauseSwitch` | `true` | Pause/Resume toggle switch |
| `features.cleaningActiveSensor` | `true` | Occupancy sensor for "is the robot cleaning?" automations |
| `features.dockedSensor` | `true` | Occupancy sensor for "is the robot home?" automations |
| `features.dustBoxSensor` | `true` | Contact sensor — alerts when dust box is removed |
| `features.stuckSensor` | `true` | Motion sensor — alerts when robot is stuck/lost |
| `features.batteryService` | `true` | Battery level + low-battery warning |

> **Note:** When you disable a feature that was previously enabled, its HomeKit service is automatically removed from the accessory on the next HomeBridge restart — no manual cleanup needed.

---

## Building from Source

```bash
git clone https://github.com/adrianradtke/homebridge-miele-scout.git
cd homebridge-miele-scout
npm install
npm run build
```

---

## License

MIT
