# TeddyCloud Card

[![HACS Custom](https://img.shields.io/badge/HACS-Custom-orange.svg)](https://github.com/hacs/integration)
[![Home Assistant](https://img.shields.io/badge/Home%20Assistant-2024.8%2B-brightgreen.svg)](https://www.home-assistant.io)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A Lovelace card that displays a Toniebox — online status, the currently/last
placed Tonie figure and its cover art, last connection, last IP — and gives
you switches/selects for teddyCloud's box settings.

> [!IMPORTANT]
> This project consists of **two components** — both are required:
> - **[TeddyCloud Integration](https://github.com/hypersonic30/ha-teddycloud-integration)** — creates the entities (install first)
> - **TeddyCloud Card** (this repo) — the Lovelace frontend card
>
> Optionally, a third, standalone component —
> **[teddycloud-nfc-bridge](https://github.com/hypersonic30/teddycloud-nfc-bridge)** — enables the
> "Assign Tonie" button described below.

## Quick setup

1. Install and configure the [TeddyCloud Integration](https://github.com/hypersonic30/ha-teddycloud-integration) first.
2. Install this card via HACS → Frontend (see [Installation](#installation) below).
3. Add it to a dashboard and point it at the entities the integration created for one box:
   ```yaml
   type: custom:teddycloud-card
   entity_online: binary_sensor.teddycloud_box_4827e2f62714_online
   entity_last_connection: sensor.teddycloud_box_4827e2f62714_last_connection
   entity_last_ip: sensor.teddycloud_box_4827e2f62714_last_ip
   entity_current_tonie: sensor.teddycloud_box_4827e2f62714_current_tonie
   entity_current_tonie_series: sensor.teddycloud_box_4827e2f62714_current_tonie_series
   entity_cloud_enabled: switch.teddycloud_box_4827e2f62714_cloud_enabled
   entity_cache_content: switch.teddycloud_box_4827e2f62714_cache_content
   entity_slap_enabled: switch.teddycloud_box_4827e2f62714_slap_to_skip
   entity_slap_direction: switch.teddycloud_box_4827e2f62714_slap_direction_forward_on_left
   entity_max_vol_speaker: select.teddycloud_box_4827e2f62714_max_volume_speaker
   entity_max_vol_headphones: select.teddycloud_box_4827e2f62714_max_volume_headphones
   entity_led_mode: select.teddycloud_box_4827e2f62714_led_mode
   ```

The visual card editor (pencil icon) has an entity picker for every field above — you don't
need to hand-write the YAML. Every field is optional: leave one blank and that row/control is
simply omitted, so the card still renders cleanly with a partial setup.

**Why explicit entity IDs, and not just "pick a device"?** So that renaming entities in Home
Assistant — which the integration is deliberately built to let you do freely — never breaks the
card. You wire each field once; after that it doesn't matter what you call anything.

## Installation

### HACS (recommended)

1. HACS → Frontend → ⋮ → Custom repositories → add this repo's URL, category "Dashboard".
2. Install "TeddyCloud Card".

### Manual

Copy `teddycloud-card.js` into your `config/www/` directory and add it as a dashboard resource:

```yaml
resources:
  - url: /local/teddycloud-card.js
    type: module
```

## Configuration

| Option | Description |
|---|---|
| `title` | Card header title. Defaults to the online sensor's device name, else "TeddyCloud". |
| `show_controls` | Show the switches/selects section. Default `true`. |
| `show_nfc_assign` | Show an "Assign Tonie" file upload + button (see below). Default `false`. |
| `entity_*` | See the table below — every one is optional. |

| Option | Expected domain | What it drives |
|---|---|---|
| `entity_online` | `binary_sensor` | Online/offline pill in the header |
| `entity_last_connection` | `sensor` (timestamp) | "X ago" in the status row |
| `entity_last_ip` | `sensor` | IP address in the status row |
| `entity_current_tonie` | `sensor` | Title + cover art (via its `entity_picture` attribute) |
| `entity_current_tonie_series` | `sensor` | Series name under the title |
| `entity_cloud_enabled` | `switch` | Cloud Enabled toggle |
| `entity_cache_content` | `switch` | Cache Content toggle |
| `entity_slap_enabled` | `switch` | Slap To Skip toggle |
| `entity_slap_direction` | `switch` | Slap Direction toggle |
| `entity_max_vol_speaker` | `select` | Speaker volume limit dropdown |
| `entity_max_vol_headphones` | `select` | Headphone volume limit dropdown |
| `entity_led_mode` | `select` | LED mode dropdown |

## Assigning a Tonie via NFC dump

With `show_nfc_assign: true`, the card shows a small file picker and an "Assign" button. Pick one
or several `.nfc` dumps (Flipper Zero format) of Tonie figures and click Assign: the card uploads
each through Home Assistant's own file upload API and calls the integration's
`teddycloud.assign_nfc_tag` service once per file, targeting whichever box device your configured
entities belong to.

This requires:
1. A [teddycloud-nfc-bridge](https://github.com/hypersonic30/teddycloud-nfc-bridge) instance
   running with access to your teddyCloud server's content volume.
2. Its URL configured on the TeddyCloud integration's config entry (reconfigure flow).

Without both, the button still appears but the service call fails with an error shown inline —
nothing in the card itself needs the sidecar to render.

## Design notes

This card is a single, hand-written file with no build step and no runtime dependencies. It
reads standard Home Assistant entity state — pushed to it automatically whenever those entities
change — and calls the standard `switch`/`select` services. There's no polling and no backend
proxy involved, unlike dashboard cards for services that don't expose their state as HA entities.

No telemetry or analytics of any kind are collected by this card.

## License

MIT
