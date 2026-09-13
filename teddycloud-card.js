/**
 * TeddyCloud Card — a Lovelace card for the ha-teddycloud-integration entities.
 *
 * No polling, no backend proxy: this card reads standard HA entity state
 * (pushed to it via the `hass` setter on every relevant state change) and
 * calls the standard switch/select services. Every field it displays is an
 * explicit entity reference in config — nothing is guessed from naming
 * conventions, so renaming entities in HA never breaks the card.
 *
 * The DOM tree is built exactly once (in _buildShell, on the first render
 * after setConfig) and every subsequent hass update only patches text
 * content/attributes in place via _updateContent — it never reassigns
 * shadowRoot.innerHTML again. This matters beyond performance: tools like
 * card_mod inject a <style> tag directly into this card's shadow root to
 * theme it, and a wholesale innerHTML replacement on every entity change
 * (e.g. every switch toggle) would silently wipe that out each time.
 * Because nothing here is built from entity-supplied strings via innerHTML
 * anymore (all dynamic values go through textContent/property assignment),
 * there's also no HTML-escaping to get right — the injection class of bug
 * that approach was prone to doesn't apply here.
 */

const CARD_TAG = "teddycloud-card";
const EDITOR_TAG = "teddycloud-card-editor";
const CARD_VERSION = "0.5.1";

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
  { key: "entity_tonie_library", label: "Tonie Library (sensor)", domain: "sensor" },
];

const SWITCH_FIELDS = [
  ["entity_cloud_enabled", "Cloud Enabled", "mdi:cloud"],
  ["entity_cache_content", "Cache Content", "mdi:cloud-download"],
  ["entity_slap_enabled", "Slap To Skip", "mdi:gesture-tap"],
  ["entity_slap_direction", "Slap Direction", "mdi:gesture-swipe"],
];

const SELECT_FIELDS = [
  ["entity_max_vol_speaker", "Max Volume Speaker"],
  ["entity_max_vol_headphones", "Max Volume Headphones"],
  ["entity_led_mode", "LED Mode"],
];

const UNAVAILABLE_STATES = new Set(["unknown", "unavailable"]);
function hasState(entity) {
  return !!entity && !UNAVAILABLE_STATES.has(entity.state);
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
    <svg id="box-fallback" class="box-graphic" viewBox="0 0 200 200" preserveAspectRatio="xMidYMax meet" aria-hidden="true">
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
    this._config = {
      show_controls: true,
      show_nfc_assign: false,
      show_tonie_library: false,
      ...config,
    };
    this._configEntityIds = ENTITY_FIELDS.map(({ key }) => config[key]).filter(Boolean);
    // Which controls exist depends only on config, so only a config change
    // (not a routine hass update) needs to rebuild the DOM shell.
    this._built = false;
    this._render();
    this._ensureRelativeTimeTimer();
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
    this._ensureRelativeTimeTimer();
  }

  disconnectedCallback() {
    clearInterval(this._relativeTimeInterval);
    this._relativeTimeInterval = null;
  }

  _ensureRelativeTimeTimer() {
    if (this._relativeTimeInterval || !this._config?.entity_last_connection) return;
    // Nothing else re-renders "Last Connection" while the box stays
    // continuously connected (that timestamp doesn't change), so give it its
    // own timer — updating just the text node directly rather than calling
    // the full _render(), so it can't interrupt an open dropdown or a
    // switch the user is mid-click on.
    this._relativeTimeInterval = setInterval(() => this._updateRelativeTime(), 30000);
  }

  _updateRelativeTime() {
    const el = this.shadowRoot?.getElementById("last-connection-text");
    if (!el) return;
    const lastConnection = this._entity("entity_last_connection");
    if (!hasState(lastConnection)) return;
    el.textContent = fmtRelative(lastConnection.state) || lastConnection.state;
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
    if (!this._config || !this._hass) return;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    if (!this._built) {
      this._buildShell();
      this._built = true;
    }
    this._updateContent();
  }

  _buildShell() {
    this._switchFields = SWITCH_FIELDS.filter(([key]) => this._config[key]);
    this._selectFields = SELECT_FIELDS.filter(([key]) => this._config[key]);

    const switchRows = this._switchFields
      .map(
        ([key, label, icon]) => `
          <div class="control-row" data-row="${key}">
            <ha-icon icon="${icon}"></ha-icon>
            <span class="control-label">${label}</span>
            <ha-switch id="ctrl-${key}"></ha-switch>
          </div>
        `
      )
      .join("");
    const selectRows = this._selectFields
      .map(
        ([key, label]) => `
          <div class="control-row" data-row="${key}">
            <span class="control-label">${label}</span>
            <select id="ctrl-${key}" class="option-select"></select>
          </div>
        `
      )
      .join("");
    const controlsHtml =
      this._config.show_controls && (switchRows || selectRows)
        ? `<div class="controls">${switchRows}${selectRows}</div>`
        : "";

    // Uploads a .nfc dump via HA's file_upload API and calls the
    // teddycloud.assign_nfc_tag service (device-targeted) — requires the
    // teddycloud-nfc-bridge sidecar to be configured on the integration
    // side; errors from a missing sidecar surface in .nfc-result as-is.
    const nfcAssignHtml = this._config.show_nfc_assign
      ? `
          <div class="nfc-assign">
            <div class="nfc-assign-row">
              <input type="file" id="nfc-file" accept=".nfc" multiple />
              <button id="nfc-submit" type="button">Assign</button>
            </div>
            <div class="nfc-result is-hidden" id="nfc-result"></div>
          </div>
        `
      : "";

    // Cover art + titles come straight from teddyCloud's own tag database —
    // built via DOM APIs below (never innerHTML) for the same reason as the
    // rest of this file: entity-supplied strings must never pass through
    // innerHTML. Audio plays directly from teddyCloud's own stream URL
    // (already absolute, ?skip_header=true) via a plain <audio controls>,
    // right in whatever browser has this dashboard open — there's no HA
    // "device" to cast to here.
    const tonieLibraryHtml = this._config.show_tonie_library
      ? `
          <div class="tonie-library">
            <div class="library-grid" id="library-grid"></div>
            <audio id="library-audio" class="is-hidden" controls></audio>
            <div class="library-message is-hidden" id="library-message"></div>
          </div>
        `
      : "";

    // Every row that can appear/disappear at runtime (not just at config
    // time) is always present in the shell and toggled via .is-hidden —
    // the shell itself is only ever built once per setConfig(), so nothing
    // here is entity-supplied data (icons/labels are our own fixed strings).
    this.shadowRoot.innerHTML = `
      <style>${this._styles()}</style>
      <ha-card>
        <div class="header">
          <span class="title" id="title-text"></span>
          <span class="pill" id="online-pill"></span>
        </div>

        <div class="hero">
          ${svgBox()}
          <img class="box-photo is-hidden" id="box-photo" alt="" />
          <img class="cover is-hidden" id="cover-img" alt="" />
        </div>

        <div class="tonie-info">
          <div class="tonie-title" id="tonie-title"></div>
          <div class="tonie-series is-hidden" id="tonie-series"></div>
        </div>

        <div class="status-row">
          <div class="status-item is-hidden" id="last-connection-row">
            <ha-icon icon="mdi:clock-outline"></ha-icon><span id="last-connection-text"></span>
          </div>
          <div class="status-item is-hidden" id="last-ip-row">
            <ha-icon icon="mdi:ip-network"></ha-icon><span id="last-ip-text"></span>
          </div>
        </div>

        ${controlsHtml}
        ${nfcAssignHtml}
        ${tonieLibraryHtml}
      </ha-card>
    `;

    this._wireControls();
    this._wireNfcAssign();
    this._wireTonieLibrary();
  }

  _updateContent() {
    const root = this.shadowRoot;
    const online = this._entity("entity_online");
    const lastConnection = this._entity("entity_last_connection");
    const lastIp = this._entity("entity_last_ip");
    const tonie = this._entity("entity_current_tonie");
    const series = this._entity("entity_current_tonie_series");

    const isOnline = hasState(online) ? online.state === "on" : null;
    const title = this._config.title || online?.attributes?.friendly_name?.replace(/\s*Online\s*$/, "") || "TeddyCloud";

    root.getElementById("title-text").textContent = title;

    const pill = root.getElementById("online-pill");
    pill.classList.toggle("is-hidden", isOnline === null);
    if (isOnline !== null) {
      pill.textContent = isOnline ? "Online" : "Offline";
      pill.className = `pill ${isOnline ? "on" : "off"}`;
    }

    // Same approach teddyCloud's own web UI uses: a real product photo from
    // Tonies' CDN, keyed by box model, with the Tonie figure's own (already
    // transparent) cutout image absolutely positioned over it — no filled
    // background behind either image.
    const boxModel = hasState(online) ? online.attributes?.box_model : null;
    const boxPhotoUrl = boxModel ? `https://cdn.tonies.de/thumbnails/${boxModel}-i.png` : null;
    const boxPhotoImg = root.getElementById("box-photo");
    const boxFallback = root.getElementById("box-fallback");
    boxPhotoImg.classList.toggle("is-hidden", !boxPhotoUrl);
    boxFallback.classList.toggle("is-hidden", !!boxPhotoUrl);
    if (boxPhotoUrl) {
      boxPhotoImg.src = boxPhotoUrl;
    } else {
      boxPhotoImg.removeAttribute("src");
    }

    const cover = hasState(tonie) ? tonie.attributes?.entity_picture : null;
    const coverImg = root.getElementById("cover-img");
    coverImg.classList.toggle("is-hidden", !cover);
    if (cover) {
      coverImg.src = cover;
    } else {
      coverImg.removeAttribute("src");
    }

    root.getElementById("tonie-title").textContent = hasState(tonie) ? tonie.state : "No Tonie recorded yet";

    const seriesEl = root.getElementById("tonie-series");
    seriesEl.classList.toggle("is-hidden", !hasState(series));
    if (hasState(series)) seriesEl.textContent = series.state;

    const lastConnRow = root.getElementById("last-connection-row");
    lastConnRow.classList.toggle("is-hidden", !hasState(lastConnection));
    if (hasState(lastConnection)) {
      root.getElementById("last-connection-text").textContent =
        fmtRelative(lastConnection.state) || lastConnection.state;
    }

    const lastIpRow = root.getElementById("last-ip-row");
    lastIpRow.classList.toggle("is-hidden", !hasState(lastIp));
    if (hasState(lastIp)) root.getElementById("last-ip-text").textContent = lastIp.state;

    if (this._config.show_controls) this._updateControls();
    if (this._config.show_tonie_library) this._updateTonieLibrary();
  }

  _updateTonieLibrary() {
    const root = this.shadowRoot;
    const library = this._entity("entity_tonie_library");
    const tonies = hasState(library) ? library.attributes?.tonies || [] : [];

    // Cheap to compute, and skips rebuilding the grid (losing the current
    // "is-playing" highlight) on every poll when the library hasn't
    // actually changed — same idea as the select-options diff above.
    const signature = tonies.map((tonie) => tonie.ruid).join(",");
    if (this._libraryGridSignature === signature) return;
    this._libraryGridSignature = signature;

    const grid = root.getElementById("library-grid");
    grid.textContent = "";

    if (!tonies.length) {
      const empty = document.createElement("div");
      empty.className = "library-empty";
      empty.textContent = "No Tonies cached yet.";
      grid.appendChild(empty);
      return;
    }

    for (const tonie of tonies) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "library-item";
      item.title = tonie.title || tonie.ruid || "";
      item.dataset.audioUrl = tonie.audio_url || "";

      if (tonie.picture) {
        const img = document.createElement("img");
        img.src = tonie.picture;
        img.alt = "";
        img.loading = "lazy";
        item.appendChild(img);
      } else {
        const icon = document.createElement("ha-icon");
        icon.setAttribute("icon", "mdi:teddy-bear");
        item.appendChild(icon);
      }

      const label = document.createElement("span");
      label.textContent = tonie.title || tonie.ruid || "";
      item.appendChild(label);

      grid.appendChild(item);
    }
  }

  _updateControls() {
    const root = this.shadowRoot;
    for (const [key] of this._switchFields) {
      const state = this._entity(key);
      const row = root.querySelector(`[data-row="${key}"]`);
      row.classList.toggle("is-hidden", !state);
      if (!state) continue;
      const el = root.getElementById(`ctrl-${key}`);
      el.checked = state.state === "on";
      el.dataset.entity = this._config[key];
    }
    for (const [key] of this._selectFields) {
      const state = this._entity(key);
      const row = root.querySelector(`[data-row="${key}"]`);
      row.classList.toggle("is-hidden", !state);
      if (!state) continue;
      const el = root.getElementById(`ctrl-${key}`);
      const options = state.attributes?.options || [];
      const current = Array.from(el.options).map((o) => o.value);
      if (current.join("") !== options.join("")) {
        el.textContent = "";
        for (const opt of options) {
          const optionEl = document.createElement("option");
          optionEl.value = opt;
          optionEl.textContent = opt;
          el.appendChild(optionEl);
        }
      }
      el.value = state.state;
      el.dataset.entity = this._config[key];
    }
  }

  _wireControls() {
    const root = this.shadowRoot;
    for (const [key] of this._switchFields) {
      root.getElementById(`ctrl-${key}`).addEventListener("change", (ev) => {
        const entityId = ev.target.dataset.entity;
        const state = this._hass.states[entityId];
        this._toggleSwitch(entityId, state?.state === "on");
      });
    }
    for (const [key] of this._selectFields) {
      root.getElementById(`ctrl-${key}`).addEventListener("change", (ev) => {
        this._selectOption(ev.target.dataset.entity, ev.target.value);
      });
    }
  }

  // Any one of the configured entities resolves to the same HA device, so
  // the first configured field that the entity registry recognizes wins —
  // there's no separate "device" config option to keep in sync.
  _resolveDeviceId() {
    const hass = this._hass;
    if (!hass?.entities) return null;
    for (const { key } of ENTITY_FIELDS) {
      const entityId = this._config[key];
      if (!entityId) continue;
      const deviceId = hass.entities[entityId]?.device_id;
      if (deviceId) return deviceId;
    }
    return null;
  }

  _showNfcResult(el, kind, text) {
    el.classList.remove("is-hidden");
    el.className = `nfc-result ${kind}`.trim();
    el.textContent = text;
  }

  _wireNfcAssign() {
    if (!this._config.show_nfc_assign) return;
    const root = this.shadowRoot;
    const button = root.getElementById("nfc-submit");
    const fileInput = root.getElementById("nfc-file");
    const result = root.getElementById("nfc-result");

    button.addEventListener("click", async () => {
      const files = Array.from(fileInput.files);
      if (!files.length) return;

      const deviceId = this._resolveDeviceId();
      if (!deviceId) {
        this._showNfcResult(
          result,
          "err",
          "Could not determine the box device — configure at least one entity above."
        );
        return;
      }

      // The bridge/service handle one .nfc file per call, so a multi-file
      // selection is just this loop client-side — sequential, so the
      // progress text and per-file errors stay meaningful.
      button.disabled = true;
      let assigned = 0;
      const failures = [];
      for (const [index, file] of files.entries()) {
        this._showNfcResult(
          result,
          "",
          files.length > 1 ? `Uploading ${index + 1}/${files.length}: ${file.name}…` : "Uploading…"
        );
        try {
          const formData = new FormData();
          formData.append("file", file);
          const uploadResp = await this._hass.fetchWithAuth("/api/file_upload", {
            method: "POST",
            body: formData,
          });
          if (!uploadResp.ok) throw new Error(`Upload failed (HTTP ${uploadResp.status})`);
          const { file_id } = await uploadResp.json();

          await this._hass.callService(
            "teddycloud",
            "assign_nfc_tag",
            { file: file_id },
            { device_id: [deviceId] }
          );
          assigned++;
        } catch (err) {
          failures.push(`${file.name}: ${err?.message || String(err)}`);
        }
      }

      if (!failures.length) {
        this._showNfcResult(
          result,
          "ok",
          assigned === 1
            ? "Tonie assigned — refreshing shortly."
            : `${assigned} Tonies assigned — refreshing shortly.`
        );
        fileInput.value = "";
      } else {
        this._showNfcResult(
          result,
          "err",
          `${assigned}/${files.length} assigned. Failed: ${failures.join("; ")}`
        );
      }
      button.disabled = false;
    });
  }

  _wireTonieLibrary() {
    if (!this._config.show_tonie_library) return;
    const root = this.shadowRoot;
    const grid = root.getElementById("library-grid");
    const audio = root.getElementById("library-audio");
    const message = root.getElementById("library-message");

    const showMessage = (text) => {
      message.textContent = text;
      message.classList.remove("is-hidden");
    };

    // Safari/WebKit (incl. the HA iOS app's in-app browser) has never
    // supported Ogg/Opus — the exact format teddyCloud streams, with no
    // server-side transcoding option to fall back to. teddyCloud's own web
    // UI has the same limitation and just tells Apple users up front rather
    // than attempting playback, so we do the same instead of a confusing
    // native media error.
    const supportsOggOpus = !!audio.canPlayType('audio/ogg; codecs="opus"');

    grid.addEventListener("click", (ev) => {
      const item = ev.target.closest(".library-item");
      const audioUrl = item?.dataset.audioUrl;
      if (!audioUrl) return;

      if (!supportsOggOpus) {
        showMessage(
          "This browser can't play teddyCloud's audio format (Ogg/Opus) — a known Safari/iOS " +
            "limitation. Try a different browser."
        );
        return;
      }
      message.classList.add("is-hidden");

      grid.querySelectorAll(".library-item.is-playing").forEach((el) => {
        el.classList.remove("is-playing");
      });
      item.classList.add("is-playing");

      audio.classList.remove("is-hidden");
      if (audio.src !== audioUrl) audio.src = audioUrl;
      audio.play();
    });

    // Belt and braces in case canPlayType is overly optimistic somewhere,
    // or playback fails for an unrelated reason (e.g. the stream 404s).
    audio.addEventListener("error", () => {
      showMessage(
        "Playback failed — this browser may not support teddyCloud's Ogg/Opus audio (a known " +
          "Safari/iOS limitation)."
      );
    });
    audio.addEventListener("playing", () => message.classList.add("is-hidden"));
  }

  _styles() {
    return `
      .is-hidden {
        display: none !important;
      }
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
        align-items: center;
        height: 180px;
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
      .box-photo {
        width: 100%;
        height: 100%;
        object-fit: contain;
      }
      /* Matches teddyCloud's own web UI: the Tonie's own (transparent)
         cutout image sits over the box photo's bottom-right corner, at a
         fraction of its height — no background/shadow behind it, since
         that's what made it read as a plain square covering the box. */
      .cover {
        position: absolute;
        bottom: 0;
        right: 0;
        height: 55%;
        padding: 8px;
        object-fit: contain;
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
      .nfc-assign {
        display: flex;
        flex-direction: column;
        gap: 8px;
        border-top: 1px solid var(--divider-color);
        padding-top: 12px;
      }
      .nfc-assign-row {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .nfc-assign-row input[type="file"] {
        flex: 1;
        min-width: 0;
        font-size: 0.85rem;
        color: var(--primary-text-color);
      }
      .nfc-assign-row button {
        background: var(--primary-color);
        color: var(--text-primary-color, #fff);
        border: none;
        border-radius: 6px;
        padding: 6px 14px;
        font-size: 0.85rem;
        cursor: pointer;
      }
      .nfc-assign-row button:disabled {
        opacity: 0.6;
        cursor: default;
      }
      .nfc-result {
        font-size: 0.85rem;
      }
      .nfc-result.ok {
        color: #4caf50;
      }
      .nfc-result.err {
        color: var(--error-color, #db4437);
      }
      .tonie-library {
        display: flex;
        flex-direction: column;
        gap: 8px;
        border-top: 1px solid var(--divider-color);
        padding-top: 12px;
      }
      .library-grid {
        display: flex;
        gap: 10px;
        overflow-x: auto;
        padding-bottom: 4px;
      }
      .library-empty {
        font-size: 0.85rem;
        color: var(--secondary-text-color);
      }
      .library-item {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 4px;
        width: 64px;
        flex: 0 0 auto;
        background: none;
        border: none;
        padding: 0;
        cursor: pointer;
        color: var(--secondary-text-color);
      }
      .library-item img,
      .library-item ha-icon {
        width: 56px;
        height: 56px;
        border-radius: 8px;
        object-fit: cover;
        background: var(--secondary-background-color);
      }
      .library-item ha-icon {
        --mdc-icon-size: 28px;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .library-item span {
        font-size: 0.7rem;
        max-width: 64px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .library-item.is-playing {
        color: var(--primary-color);
      }
      .library-item.is-playing img,
      .library-item.is-playing ha-icon {
        outline: 2px solid var(--primary-color);
      }
      #library-audio {
        width: 100%;
        height: 32px;
      }
      .library-message {
        font-size: 0.8rem;
        color: var(--error-color, #db4437);
      }
    `;
  }
}

class TeddyCloudCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = {
      show_controls: true,
      show_nfc_assign: false,
      show_tonie_library: false,
      ...config,
    };
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
      <div class="row">
        <ha-formfield label="Show 'Assign Tonie' button">
          <ha-switch id="show_nfc_assign" ${this._config.show_nfc_assign ? "checked" : ""}></ha-switch>
        </ha-formfield>
      </div>
      <div class="row">
        <ha-formfield label="Show Tonie Library player">
          <ha-switch id="show_tonie_library" ${this._config.show_tonie_library ? "checked" : ""}></ha-switch>
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

    const showNfcAssign = this.shadowRoot.getElementById("show_nfc_assign");
    showNfcAssign.addEventListener("change", (ev) => {
      this._config = { ...this._config, show_nfc_assign: ev.target.checked };
      this._emitChange();
    });

    const showTonieLibrary = this.shadowRoot.getElementById("show_tonie_library");
    showTonieLibrary.addEventListener("change", (ev) => {
      this._config = { ...this._config, show_tonie_library: ev.target.checked };
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

// Printed on load so it's obvious in devtools which build is actually
// active — useful since browsers cache this file aggressively and a HACS
// update alone doesn't guarantee the new file is what's running.
console.info(
  `%c TEDDYCLOUD-CARD %c v${CARD_VERSION} `,
  "color: white; background: #039be5; font-weight: 700;",
  "color: #039be5; background: white; font-weight: 700;"
);
