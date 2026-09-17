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
const CARD_VERSION = "1.1.5";

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
      show_wishlist: false,
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
    this._ensureWishlistTimer();
    if (this._onDocumentClickForWishlist) {
      document.addEventListener("click", this._onDocumentClickForWishlist);
    }
  }

  disconnectedCallback() {
    clearInterval(this._relativeTimeInterval);
    this._relativeTimeInterval = null;
    clearInterval(this._wishlistInterval);
    this._wishlistInterval = null;
    if (this._onDocumentClickForWishlist) {
      document.removeEventListener("click", this._onDocumentClickForWishlist);
    }
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

  _ensureWishlistTimer() {
    if (this._wishlistInterval || !this._config?.show_wishlist) return;
    // The wishlist isn't backed by an HA entity, so nothing pushes hass
    // updates for it - a light poll is the simplest way to reflect a wish
    // getting found (cross-referenced server-side on every coordinator
    // refresh) without the user reloading the dashboard. Re-established
    // on reconnect (e.g. navigating back to this dashboard view), not
    // just on the shell's one-time initial build.
    this._wishlistInterval = setInterval(() => this._fetchWishlist(), 60000);
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
    // innerHTML. Picking a Tonie opens the integration's own standalone
    // player page in a new tab rather than playing inline here — see
    // _wireTonieLibrary() for why.
    const tonieLibraryHtml = this._config.show_tonie_library
      ? `
          <div class="tonie-library">
            <input type="search" id="library-search" class="library-search" placeholder="Search Tonies…" />
            <div class="library-grid" id="library-grid"></div>
          </div>
        `
      : "";

    // Search hits teddyCloud's own tonies.json catalog (every officially
    // released Tonie, not just owned ones) via this integration's own
    // search endpoint - see the backend's tonies_catalog.py for why that's
    // a local search over the full catalog rather than teddyCloud's own
    // (18-result-capped) search API. Picking a suggestion adds it; items
    // already found in the real library (cross-referenced server-side on
    // every coordinator refresh) show as acquired instead of needing to be
    // removed manually.
    const wishlistHtml = this._config.show_wishlist
      ? `
          <div class="wishlist">
            <input type="search" id="wishlist-search" class="wishlist-search" placeholder="Search Tonies to wish for…" autocomplete="off" />
            <div class="wishlist-suggestions is-hidden" id="wishlist-suggestions"></div>
            <div class="wishlist-items" id="wishlist-items"></div>
            <button type="button" id="wishlist-clear-acquired" class="wishlist-clear-acquired is-hidden">
              Clear found (<span id="wishlist-clear-count">0</span>)
            </button>
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
        ${wishlistHtml}
      </ha-card>
    `;

    this._wireControls();
    this._wireNfcAssign();
    this._wireTonieLibrary();
    this._wireWishlist();
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

    // Cheap to compute, and skips needlessly rebuilding the grid on every
    // poll when the library hasn't actually changed — same idea as the
    // select-options diff above.
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
      item.dataset.playerUrl = tonie.player_url || "";
      item.dataset.search = `${tonie.title || ""} ${tonie.series || ""}`.toLowerCase();

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

    // A poll can rebuild the grid out from under an in-progress search
    // (new/removed Tonie changes the signature) — keep whatever the user
    // already typed applied to the fresh set of items.
    this._applyLibrarySearch();
  }

  _applyLibrarySearch() {
    const root = this.shadowRoot;
    const searchInput = root.getElementById("library-search");
    const grid = root.getElementById("library-grid");
    const query = (searchInput?.value || "").trim().toLowerCase();

    const items = grid.querySelectorAll(".library-item");
    let visibleCount = 0;
    items.forEach((item) => {
      const matches = !query || item.dataset.search.includes(query);
      item.classList.toggle("is-hidden", !matches);
      if (matches) visibleCount++;
    });

    let noMatches = grid.querySelector(".library-no-matches");
    if (query && visibleCount === 0 && items.length) {
      if (!noMatches) {
        noMatches = document.createElement("div");
        noMatches.className = "library-empty library-no-matches";
        grid.appendChild(noMatches);
      }
      noMatches.textContent = `No Tonies match "${searchInput.value.trim()}".`;
    } else if (noMatches) {
      noMatches.remove();
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
    const searchInput = root.getElementById("library-search");

    searchInput.addEventListener("input", () => this._applyLibrarySearch());

    // Opens the integration's own standalone player page in a new tab,
    // rather than playing inline here. Tried inline playback twice more
    // after the reasoning below was first written (see git history around
    // v0.8.0–v0.9.1): even fully-local blob: playback (no network
    // dependency at all once loaded) still got wiped out after a few
    // minutes, together with the whole player UI disappearing — pointing
    // at Home Assistant's own frontend rebuilding the dashboard view (and
    // every card in it, this one included) after recovering from a
    // websocket outage, not at anything about audio or networking
    // specifically. A standalone tab isn't part of that dashboard's
    // lifecycle at all, so it can't be affected by HA rebuilding it.
    //
    // (Earlier still: a full HA dashboard is also a heavy, actively
    // networking page, and Home Assistant's own websocket was observed
    // dying at the same moment inline playback first stopped — the
    // reason a live stream alone wasn't reliable inline either.)
    grid.addEventListener("click", (ev) => {
      const item = ev.target.closest(".library-item");
      const playerUrl = item?.dataset.playerUrl;
      if (!playerUrl) return;
      window.open(playerUrl, "_blank");
    });
  }

  // Deliberately rendered in-flow (no position:absolute/fixed overlay):
  // an overlay either gets clipped/covered by whatever stacking or
  // containment context Home Assistant's dashboard layout puts around
  // each card (tried and reverted - see git history), or - if instead
  // portaled to document.body with position:fixed to escape that - ends
  // up floating at the wrong spot on iOS Safari while the on-screen
  // keyboard is open, since iOS shifts the visual viewport rather than
  // resizing the layout viewport fixed positioning is computed against.
  // Growing the card in normal flow like any other content sidesteps
  // both: it always renders exactly where it visually belongs, and
  // scrolling a focused input into view above the keyboard is standard
  // browser behavior for in-flow content, not something to fight.
  _renderWishlistSuggestions(results) {
    const box = this.shadowRoot.getElementById("wishlist-suggestions");
    box.textContent = "";
    box.classList.toggle("is-hidden", !results.length);
    for (const entry of results) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "wishlist-suggestion";
      if (entry.picture) {
        const img = document.createElement("img");
        img.src = entry.picture;
        img.alt = "";
        img.loading = "lazy";
        item.appendChild(img);
      } else {
        const icon = document.createElement("ha-icon");
        icon.setAttribute("icon", "mdi:teddy-bear");
        item.appendChild(icon);
      }
      const text = document.createElement("span");
      text.textContent = entry.title || entry.series || entry.model;
      item.appendChild(text);
      item.addEventListener("click", () => this._addToWishlist(entry));
      box.appendChild(item);
    }
  }

  _renderWishlistItems(items) {
    const root = this.shadowRoot;
    // Kept so _removeAllAcquired() can act on "whatever's currently
    // acquired" without a fresh fetch or re-deriving it from the DOM.
    this._wishlistItems = items;
    const container = root.getElementById("wishlist-items");
    container.textContent = "";

    const acquiredCount = items.filter((item) => item.acquired).length;
    const clearBtn = root.getElementById("wishlist-clear-acquired");
    if (clearBtn) {
      clearBtn.classList.toggle("is-hidden", acquiredCount === 0);
      const countEl = root.getElementById("wishlist-clear-count");
      if (countEl) countEl.textContent = String(acquiredCount);
    }

    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "wishlist-empty";
      empty.textContent = "No wishes yet — search above to add one.";
      container.appendChild(empty);
      return;
    }

    // Not-yet-found wishes first, found ones after — the list you still
    // need to look for is the one worth seeing without scrolling.
    const sorted = [...items].sort((a, b) => Number(a.acquired) - Number(b.acquired));
    for (const item of sorted) {
      const row = document.createElement("div");
      row.className = `wishlist-item${item.acquired ? " is-acquired" : ""}`;

      if (item.picture) {
        const img = document.createElement("img");
        img.src = item.picture;
        img.alt = "";
        img.loading = "lazy";
        row.appendChild(img);
      } else {
        const icon = document.createElement("ha-icon");
        icon.setAttribute("icon", "mdi:teddy-bear");
        row.appendChild(icon);
      }

      const text = document.createElement("span");
      text.className = "wishlist-item-title";
      text.textContent = item.title;
      row.appendChild(text);

      if (item.acquired) {
        const badge = document.createElement("ha-icon");
        badge.className = "wishlist-acquired-badge";
        badge.setAttribute("icon", "mdi:check-circle");
        badge.title = "Found in your library";
        row.appendChild(badge);
      }

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "wishlist-remove";
      removeBtn.setAttribute("aria-label", "Remove from wishlist");
      removeBtn.textContent = "×";
      removeBtn.addEventListener("click", () => this._removeFromWishlist(item.model));
      row.appendChild(removeBtn);

      container.appendChild(row);
    }
  }

  async _fetchWishlist() {
    const deviceId = this._resolveDeviceId();
    if (!deviceId || !this._hass) return;
    try {
      const resp = await this._hass.fetchWithAuth(`/api/teddycloud/wishlist/${deviceId}`);
      if (!resp.ok) return;
      this._renderWishlistItems(await resp.json());
    } catch (err) {
      // A transient fetch failure just leaves the last-known list on
      // screen rather than clearing it - nothing actionable for the user.
    }
  }

  async _addToWishlist(entry) {
    const deviceId = this._resolveDeviceId();
    if (!deviceId || !this._hass || !entry.model) return;
    const searchInput = this.shadowRoot.getElementById("wishlist-search");
    try {
      const resp = await this._hass.fetchWithAuth(`/api/teddycloud/wishlist/${deviceId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: entry.model,
          title: entry.title || entry.series || entry.model,
          series: entry.series || null,
          picture: entry.picture || null,
        }),
      });
      if (resp.ok) this._renderWishlistItems(await resp.json());
    } finally {
      searchInput.value = "";
      this._renderWishlistSuggestions([]);
    }
  }

  async _removeFromWishlist(model) {
    const deviceId = this._resolveDeviceId();
    if (!deviceId || !this._hass) return;
    const resp = await this._hass.fetchWithAuth(
      `/api/teddycloud/wishlist/${deviceId}/${encodeURIComponent(model)}`,
      { method: "DELETE" }
    );
    if (resp.ok) this._renderWishlistItems(await resp.json());
  }

  // Reported friction: acquired items sort to the bottom of the list (see
  // _renderWishlistItems's comment), so removing one re-sorts and shifts
  // every row after it - clicking several acquired items' own "x" buttons
  // in a row means each click lands on whatever item slid into that spot
  // next, not the one the user was actually aiming at. One button that
  // clears all of them at once sidesteps that entirely, rather than
  // trying to keep rows from moving under a still-open list.
  async _removeAllAcquired() {
    const deviceId = this._resolveDeviceId();
    if (!deviceId || !this._hass) return;
    const acquired = (this._wishlistItems || []).filter((item) => item.acquired);
    if (!acquired.length) return;

    let latest = this._wishlistItems;
    for (const item of acquired) {
      try {
        const resp = await this._hass.fetchWithAuth(
          `/api/teddycloud/wishlist/${deviceId}/${encodeURIComponent(item.model)}`,
          { method: "DELETE" }
        );
        if (resp.ok) latest = await resp.json();
      } catch (err) {
        // Best-effort - keep clearing the rest even if one request fails.
      }
    }
    this._renderWishlistItems(latest);
  }

  _wireWishlist() {
    if (!this._config.show_wishlist) return;
    const root = this.shadowRoot;
    const searchInput = root.getElementById("wishlist-search");

    // 300ms debounce matches teddyCloud's own web UI's search-as-you-type
    // for the same catalog, so results feel similarly responsive without
    // firing a search request on every single keystroke.
    let debounceHandle = null;
    searchInput.addEventListener("input", () => {
      clearTimeout(debounceHandle);
      const query = searchInput.value.trim();
      if (!query) {
        this._renderWishlistSuggestions([]);
        return;
      }
      debounceHandle = setTimeout(async () => {
        const deviceId = this._resolveDeviceId();
        if (!deviceId || !this._hass) return;
        try {
          const resp = await this._hass.fetchWithAuth(
            `/api/teddycloud/catalog_search/${deviceId}?q=${encodeURIComponent(query)}`
          );
          if (!resp.ok) return;
          // A slower-to-answer, now-stale search must not overwrite
          // suggestions from a query typed after it.
          if (searchInput.value.trim() !== query) return;
          this._renderWishlistSuggestions(await resp.json());
        } catch (err) {
          // Leave whatever suggestions (if any) are already showing.
        }
      }, 300);
    });

    const clearAcquiredBtn = root.getElementById("wishlist-clear-acquired");
    clearAcquiredBtn?.addEventListener("click", () => this._removeAllAcquired());

    // Attached to `document` (needs to see clicks anywhere on the page to
    // know when to close the dropdown), so - unlike listeners attached to
    // this card's own shadow root, which get garbage-collected with it -
    // this one must be explicitly removed on disconnect or it outlives
    // the card entirely. Stored so connectedCallback()/disconnectedCallback()
    // can re-add/remove the same reference.
    //
    // Uses composedPath() rather than ev.target: a listener on `document`
    // sees ev.target retargeted to the outermost shadow host it had to
    // cross to reach here, so for a click anywhere inside this card's
    // shadow DOM, ev.target would just be this card's host element every
    // time - never the actual search input or suggestion clicked.
    // composedPath() gives the real, un-retargeted chain of nodes instead.
    this._onDocumentClickForWishlist = (ev) => {
      const path = ev.composedPath();
      const searchInput = root.getElementById("wishlist-search");
      const suggestionsBox = root.getElementById("wishlist-suggestions");
      const withinSearch = !!searchInput && path.includes(searchInput);
      const withinSuggestions = !!suggestionsBox && path.includes(suggestionsBox);
      if (!withinSearch && !withinSuggestions) this._renderWishlistSuggestions([]);
    };
    document.addEventListener("click", this._onDocumentClickForWishlist);

    this._fetchWishlist();
    this._ensureWishlistTimer();
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
      .library-search {
        width: 100%;
        box-sizing: border-box;
        padding: 6px 10px;
        font-size: 0.85rem;
        background: var(--card-background-color);
        color: var(--primary-text-color);
        border: 1px solid var(--divider-color);
        border-radius: 6px;
      }
      .library-grid {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        max-height: 190px;
        overflow-y: auto;
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
      .wishlist {
        display: flex;
        flex-direction: column;
        gap: 8px;
        border-top: 1px solid var(--divider-color);
        padding-top: 12px;
      }
      .wishlist-search {
        width: 100%;
        box-sizing: border-box;
        padding: 6px 10px;
        font-size: 0.85rem;
        background: var(--card-background-color);
        color: var(--primary-text-color);
        border: 1px solid var(--divider-color);
        border-radius: 6px;
      }
      .wishlist-suggestions {
        display: flex;
        flex-direction: column;
        background: var(--secondary-background-color);
        border: 1px solid var(--divider-color);
        border-radius: 6px;
        max-height: 220px;
        overflow-y: auto;
      }
      .wishlist-suggestion {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        box-sizing: border-box;
        padding: 6px 10px;
        background: none;
        border: none;
        font-size: 0.85rem;
        color: var(--primary-text-color);
        text-align: left;
        cursor: pointer;
      }
      .wishlist-suggestion:hover {
        background: var(--divider-color);
      }
      .wishlist-suggestion img,
      .wishlist-suggestion ha-icon {
        width: 32px;
        height: 32px;
        border-radius: 6px;
        object-fit: cover;
        flex: 0 0 auto;
        background: var(--card-background-color);
      }
      .wishlist-suggestion span {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .wishlist-items {
        display: flex;
        flex-direction: column;
        gap: 6px;
        max-height: 260px;
        overflow-y: auto;
      }
      .wishlist-empty {
        font-size: 0.85rem;
        color: var(--secondary-text-color);
      }
      .wishlist-item {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 4px 0;
      }
      .wishlist-item img,
      .wishlist-item ha-icon:not(.wishlist-acquired-badge) {
        width: 36px;
        height: 36px;
        border-radius: 6px;
        object-fit: cover;
        flex: 0 0 auto;
        background: var(--secondary-background-color);
      }
      .wishlist-item-title {
        flex: 1;
        min-width: 0;
        font-size: 0.85rem;
        color: var(--primary-text-color);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .wishlist-item.is-acquired .wishlist-item-title {
        color: var(--secondary-text-color);
        text-decoration: line-through;
      }
      .wishlist-acquired-badge {
        --mdc-icon-size: 18px;
        color: #4caf50;
        flex: 0 0 auto;
      }
      .wishlist-remove {
        flex: 0 0 auto;
        background: none;
        border: none;
        font-size: 1.1rem;
        line-height: 1;
        color: var(--secondary-text-color);
        cursor: pointer;
        padding: 2px 6px;
      }
      .wishlist-remove:hover {
        color: var(--error-color, #db4437);
      }
      .wishlist-clear-acquired {
        align-self: flex-end;
        background: none;
        border: none;
        font-size: 0.78rem;
        color: var(--secondary-text-color);
        text-decoration: underline;
        cursor: pointer;
        padding: 2px;
      }
      .wishlist-clear-acquired:hover {
        color: var(--primary-color, #03a9f4);
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
      show_wishlist: false,
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
      <div class="row">
        <ha-formfield label="Show wishlist">
          <ha-switch id="show_wishlist" ${this._config.show_wishlist ? "checked" : ""}></ha-switch>
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

    const showWishlist = this.shadowRoot.getElementById("show_wishlist");
    showWishlist.addEventListener("change", (ev) => {
      this._config = { ...this._config, show_wishlist: ev.target.checked };
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
