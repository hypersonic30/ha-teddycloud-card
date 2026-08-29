/**
 * TeddyCloud Card — a Lovelace card for the ha-teddycloud-integration entities.
 *
 * No polling, no backend proxy: this card reads standard HA entity state
 * (pushed to it via the `hass` setter on every relevant state change) and
 * calls the standard switch/select services. Every field it displays is an
 * explicit entity reference in config — nothing is guessed from naming
 * conventions, so renaming entities in HA never breaks the card.
 */

const CARD_TAG = "teddycloud-card";
const EDITOR_TAG = "teddycloud-card-editor";

const ENTITY_FIELDS = [
  { key: "entity_online", label: "Online (binary_sensor)", domain: "binary_sensor" },
  { key: "entity_last_connection", label: "Last Connection (sensor)", domain: "sensor" },
  { key: "entity_last_ip", label: "Last IP (sensor)", domain: "sensor" },
  { key: "entity_current_tonie", label: "Current Tonie (sensor)", domain: "sensor" },
  { key: "entity_current_tonie_series", label: "Current Tonie Series (sensor)", domain: "sensor" },
  { key: "entity_cloud_enabled", label: "Cloud Enabled (switch)", domain: "switch" },
  { key: "entity_cache_content", label: "Cache Content (switch)", domain: "switch" },
  { key: "entity_slap_enabled", label: "Slap To Skip (switch)", domain: "switch" },
  { key: "entity_slap_direction", label: "Slap Direction (switch)", domain: "switch" },
  { key: "entity_max_vol_speaker", label: "Max Volume Speaker (select)", domain: "select" },
  { key: "entity_max_vol_headphones", label: "Max Volume Headphones (select)", domain: "select" },
  { key: "entity_led_mode", label: "LED Mode (select)", domain: "select" },
];

const ESCAPE_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function esc(value) {
  return String(value).replace(/[&<>"']/g, (c) => ESCAPE_MAP[c]);
}

function fmtRelative(dateStr) {
  if (!dateStr) return null;
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return null;
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 5) return "just now";
  const units = [
    ["year", 31536000],
    ["month", 2592000],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [name, secs] of units) {
    const value = Math.floor(seconds / secs);
    if (value >= 1) return `${value} ${name}${value > 1 ? "s" : ""} ago`;
  }
  return "seconds ago";
}

function svgBox() {
  return `
    <svg class="box-graphic" viewBox="0 0 200 200" preserveAspectRatio="xMidYMax meet" aria-hidden="true">
      <rect x="30" y="70" width="140" height="110" rx="18" class="box-body" />
      <rect x="30" y="70" width="140" height="28" rx="14" class="box-lid" />
      <circle cx="75" cy="135" r="9" class="box-eye" />
      <circle cx="125" cy="135" r="9" class="box-eye" />
      <path d="M 78 158 Q 100 172 122 158" class="box-mouth" fill="none" stroke-width="4" stroke-linecap="round" />
      <circle cx="100" cy="60" r="10" class="box-knob" />
      <rect x="95" y="15" width="10" height="45" rx="5" class="box-antenna" />
    </svg>
  `;
}

class TeddyCloudCard extends HTMLElement {
  static getConfigElement() {
    return document.createElement(EDITOR_TAG);
  }

  static getStubConfig(hass) {
    const guess = Object.keys(hass?.states || {}).find(
      (id) =>
        id.startsWith("binary_sensor.") &&
        hass.states[id].attributes?.device_class === "connectivity" &&
        id.toLowerCase().includes("tonie")
    );
    return guess ? { type: `custom:${CARD_TAG}`, entity_online: guess } : { type: `custom:${CARD_TAG}` };
  }

  setConfig(config) {
    if (!config) throw new Error("Invalid configuration");
    this._config = { show_controls: true, ...config };
    this._configEntityIds = ENTITY_FIELDS.map(({ key }) => config[key]).filter(Boolean);
    this._render();
  }

  set hass(hass) {
    const prevHass = this._hass;
    this._hass = hass;
    // hass is pushed down to every card on essentially any state change
    // system-wide, not just ours — skip the (destructive, full-innerHTML)
    // re-render unless one of our own configured entities actually changed.
    if (
      prevHass &&
      this._configEntityIds &&
      this._configEntityIds.every((id) => hass.states[id] === prevHass.states[id])
    ) {
      return;
    }
    this._render();
  }

  connectedCallback() {
    // Nothing else re-renders "Last Connection" while the box stays
    // continuously connected (that timestamp doesn't change), so give it
    // its own timer independent of entity state changes.
    if (!this._relativeTimeInterval) {
      this._relativeTimeInterval = setInterval(() => this._render(), 30000);
    }
  }

  disconnectedCallback() {
    clearInterval(this._relativeTimeInterval);
    this._relativeTimeInterval = null;
  }

  getCardSize() {
    return 6;
  }

  _entity(key) {
    const entityId = this._config?.[key];
    if (!entityId || !this._hass) return null;
    return this._hass.states[entityId] || null;
  }

  _callService(domain, service, entityId, extra) {
    if (!this._hass || !entityId) return;
    this._hass.callService(domain, service, { entity_id: entityId, ...extra });
  }

  _toggleSwitch(entityId, isOn) {
    this._callService("switch", isOn ? "turn_off" : "turn_on", entityId);
  }

  _selectOption(entityId, option) {
    this._callService("select", "select_option", entityId, { option });
  }

  _render() {
    if (!this._config) return;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    if (!this._hass) return;

    const online = this._entity("entity_online");
    const lastConnection = this._entity("entity_last_connection");
    const lastIp = this._entity("entity_last_ip");
    const tonie = this._entity("entity_current_tonie");
    const series = this._entity("entity_current_tonie_series");

    const isOnline = online ? online.state === "on" : null;
    const cover = tonie?.attributes?.entity_picture;
    const title = this._config.title || online?.attributes?.friendly_name?.replace(/\s*Online\s*$/, "") || "TeddyCloud";

    this.shadowRoot.innerHTML = `
      <style>${this._styles()}</style>
      <ha-card>
        <div class="header">
          <span class="title">${esc(title)}</span>
          ${
            isOnline === null
              ? ""
              : `<span class="pill ${isOnline ? "on" : "off"}">${isOnline ? "Online" : "Offline"}</span>`
          }
        </div>

        <div class="hero">
          ${svgBox()}
          ${cover ? `<img class="cover" src="${esc(cover)}" alt="" />` : ""}
        </div>

        <div class="tonie-info">
          <div class="tonie-title">${tonie?.state && tonie.state !== "unknown" ? esc(tonie.state) : "No Tonie recorded yet"}</div>
          ${series?.state && series.state !== "unknown" ? `<div class="tonie-series">${esc(series.state)}</div>` : ""}
        </div>

        <div class="status-row">
          ${
            lastConnection?.state && lastConnection.state !== "unknown"
              ? `<div class="status-item"><ha-icon icon="mdi:clock-outline"></ha-icon><span>${esc(fmtRelative(lastConnection.state) || lastConnection.state)}</span></div>`
              : ""
          }
          ${
            lastIp?.state && lastIp.state !== "unknown"
              ? `<div class="status-item"><ha-icon icon="mdi:ip-network"></ha-icon><span>${esc(lastIp.state)}</span></div>`
              : ""
          }
        </div>

        ${this._config.show_controls ? this._renderControls() : ""}
      </ha-card>
    `;

    this._wireControls();
  }

  _renderControls() {
    const switches = [
      ["entity_cloud_enabled", "Cloud Enabled", "mdi:cloud"],
      ["entity_cache_content", "Cache Content", "mdi:cloud-download"],
      ["entity_slap_enabled", "Slap To Skip", "mdi:gesture-tap"],
      ["entity_slap_direction", "Slap Direction", "mdi:gesture-swipe"],
    ];
    const selects = [
      ["entity_max_vol_speaker", "Max Volume Speaker"],
      ["entity_max_vol_headphones", "Max Volume Headphones"],
      ["entity_led_mode", "LED Mode"],
    ];

    const switchRows = switches
      .map(([key, label, icon]) => {
        const state = this._entity(key);
        if (!state) return "";
        const isOn = state.state === "on";
        return `
          <div class="control-row">
            <ha-icon icon="${icon}"></ha-icon>
            <span class="control-label">${label}</span>
            <ha-switch data-key="${key}" data-entity="${this._config[key]}" ${isOn ? "checked" : ""}></ha-switch>
          </div>
        `;
      })
      .join("");

    const selectRows = selects
      .map(([key, label]) => {
        const state = this._entity(key);
        if (!state) return "";
        const options = state.attributes?.options || [];
        return `
          <div class="control-row">
            <span class="control-label">${label}</span>
            <select data-key="${key}" data-entity="${this._config[key]}" class="option-select">
              ${options.map((opt) => `<option value="${opt}" ${opt === state.state ? "selected" : ""}>${opt}</option>`).join("")}
            </select>
          </div>
        `;
      })
      .join("");

    if (!switchRows && !selectRows) return "";
    return `<div class="controls">${switchRows}${selectRows}</div>`;
  }

  _wireControls() {
    this.shadowRoot.querySelectorAll("ha-switch[data-entity]").forEach((el) => {
      el.addEventListener("change", () => {
        const entityId = el.getAttribute("data-entity");
        const state = this._hass.states[entityId];
        this._toggleSwitch(entityId, state?.state === "on");
      });
    });
    this.shadowRoot.querySelectorAll("select.option-select[data-entity]").forEach((el) => {
      el.addEventListener("change", () => {
        this._selectOption(el.getAttribute("data-entity"), el.value);
      });
    });
  }

  _styles() {
    return `
      ha-card {
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .title {
        font-size: 1.2rem;
        font-weight: 500;
        color: var(--primary-text-color);
      }
      .pill {
        font-size: 0.75rem;
        font-weight: 600;
        padding: 2px 10px;
        border-radius: 12px;
        text-transform: uppercase;
        letter-spacing: 0.02em;
      }
      .pill.on {
        background: rgba(76, 175, 80, 0.18);
        color: #4caf50;
      }
      .pill.off {
        background: var(--secondary-background-color);
        color: var(--secondary-text-color);
      }
      .hero {
        position: relative;
        display: flex;
        justify-content: center;
        align-items: flex-end;
        height: 160px;
      }
      .box-graphic {
        height: 100%;
        max-width: 220px;
      }
      .box-body { fill: var(--secondary-background-color); }
      .box-lid { fill: var(--divider-color, #444); }
      .box-eye { fill: var(--primary-text-color); opacity: 0.6; }
      .box-mouth { stroke: var(--primary-text-color); opacity: 0.6; }
      .box-knob { fill: var(--primary-color); }
      .box-antenna { fill: var(--primary-color); }
      .cover {
        position: absolute;
        bottom: 18px;
        width: 92px;
        height: 92px;
        object-fit: cover;
        border-radius: 12px;
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
        background: var(--card-background-color);
      }
      .tonie-info {
        text-align: center;
      }
      .tonie-title {
        font-size: 1rem;
        font-weight: 500;
        color: var(--primary-text-color);
      }
      .tonie-series {
        font-size: 0.85rem;
        color: var(--secondary-text-color);
      }
      .status-row {
        display: flex;
        justify-content: center;
        gap: 20px;
        color: var(--secondary-text-color);
        font-size: 0.85rem;
      }
      .status-item {
        display: flex;
        align-items: center;
        gap: 4px;
      }
      .status-item ha-icon {
        --mdc-icon-size: 16px;
      }
      .controls {
        display: flex;
        flex-direction: column;
        gap: 8px;
        border-top: 1px solid var(--divider-color);
        padding-top: 12px;
      }
      .control-row {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .control-label {
        flex: 1;
        font-size: 0.9rem;
        color: var(--primary-text-color);
      }
      .option-select {
        background: var(--card-background-color);
        color: var(--primary-text-color);
        border: 1px solid var(--divider-color);
        border-radius: 6px;
        padding: 4px 8px;
      }
    `;
  }
}

class TeddyCloudCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = { show_controls: true, ...config };
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (this.shadowRoot) {
      this.shadowRoot.querySelectorAll("ha-entity-picker").forEach((el) => {
        el.hass = hass;
      });
    } else {
      this._render();
    }
  }

  _emitChange() {
    this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: this._config } }));
  }

  _render() {
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    if (!this._config) return;

    this.shadowRoot.innerHTML = `
      <style>
        .row { margin-bottom: 12px; }
        ha-textfield, ha-entity-picker { width: 100%; }
        ha-formfield { display: block; margin: 8px 0; }
      </style>
      <div class="row">
        <ha-textfield id="title" label="Title (optional)"></ha-textfield>
      </div>
      <div class="row">
        <ha-formfield label="Show controls">
          <ha-switch id="show_controls" ${this._config.show_controls ? "checked" : ""}></ha-switch>
        </ha-formfield>
      </div>
      ${ENTITY_FIELDS.map(({ key }) => `<div class="row" data-field="${key}"></div>`).join("")}
    `;

    const titleField = this.shadowRoot.getElementById("title");
    titleField.value = this._config.title || "";
    titleField.addEventListener("input", (ev) => {
      this._config = { ...this._config, title: ev.target.value };
      this._emitChange();
    });

    const showControls = this.shadowRoot.getElementById("show_controls");
    showControls.addEventListener("change", (ev) => {
      this._config = { ...this._config, show_controls: ev.target.checked };
      this._emitChange();
    });

    ENTITY_FIELDS.forEach(({ key, label, domain }) => {
      const container = this.shadowRoot.querySelector(`[data-field="${key}"]`);
      const picker = document.createElement("ha-entity-picker");
      picker.hass = this._hass;
      picker.label = label;
      picker.value = this._config[key] || "";
      picker.includeDomains = [domain];
      picker.allowCustomEntity = true;
      picker.addEventListener("value-changed", (ev) => {
        ev.stopPropagation();
        const value = ev.detail.value;
        this._config = { ...this._config, [key]: value || undefined };
        this._emitChange();
      });
      container.appendChild(picker);
    });
  }
}

if (!customElements.get(CARD_TAG)) {
  customElements.define(CARD_TAG, TeddyCloudCard);
}
if (!customElements.get(EDITOR_TAG)) {
  customElements.define(EDITOR_TAG, TeddyCloudCardEditor);
}

window.customCards = window.customCards || [];
window.customCards.push({
  type: CARD_TAG,
  name: "TeddyCloud Card",
  description: "Shows a Toniebox's online status, current Tonie, and teddyCloud controls.",
  preview: false,
});
