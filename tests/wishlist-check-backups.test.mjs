// Real-Chromium test for the "Check backups now" button: visible only
// when a GitHub backup repo is configured (piggybacking on the same
// backup_source fetch as the "View backup repo" link), POSTs to
// import_from_backups on click, disables itself while in flight, and
// refetches the wishlist + shows a result message once done.
import assert from "node:assert";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "./launch.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

(async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    page.on("pageerror", (err) => console.error("[pageerror]", err));

    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: path.resolve(__dirname, "../teddycloud-card.js") });

    const result = await page.evaluate(async () => {
      const tick = () => new Promise((r) => setTimeout(r, 0));

      const calls = [];
      let releaseImport;
      const importGate = new Promise((resolve) => {
        releaseImport = resolve;
      });

      const el = document.createElement("teddycloud-card");
      document.body.appendChild(el);
      el.setConfig({
        type: "custom:teddycloud-card",
        entity_online: "binary_sensor.test_online",
        show_controls: false,
        show_nfc_assign: false,
        show_tonie_library: false,
        show_wishlist: true,
      });
      el.hass = {
        states: {},
        entities: { "binary_sensor.test_online": { device_id: "device1" } },
        fetchWithAuth: async (url, opts) => {
          const method = opts?.method || "GET";
          calls.push({ url, method });
          if (url.endsWith("/backup_source")) {
            return { ok: true, json: async () => ({ configured: true, url: "https://github.com/me/backups" }) };
          }
          if (url.endsWith("/import_from_backups")) {
            await importGate;
            return { ok: true, json: async () => ({ attempted: 2 }) };
          }
          // Plain wishlist GET.
          return { ok: true, json: async () => [{ model: "m1", title: "Found One", acquired: true }] };
        },
      };

      await tick();
      await tick();
      await tick();

      const checkBtn = el.shadowRoot.getElementById("wishlist-check-backups");
      const visibleWhenConfigured = !checkBtn.classList.contains("is-hidden");

      checkBtn.click();
      await tick();

      const disabledWhileInFlight = checkBtn.disabled;

      releaseImport();
      await tick();
      await tick();
      await tick();
      await tick();

      const resultEl = el.shadowRoot.getElementById("wishlist-result");

      return {
        visibleWhenConfigured,
        disabledWhileInFlight,
        disabledAfter: checkBtn.disabled,
        importCalls: calls.filter((c) => c.url.endsWith("/import_from_backups")),
        wishlistRefetched: calls.some((c) => c.method === "GET" && c.url.endsWith("/device1")),
        resultVisible: !resultEl.classList.contains("is-hidden"),
        resultText: resultEl.textContent,
      };
    });

    console.log("result:", JSON.stringify(result));

    assert.strictEqual(result.visibleWhenConfigured, true, "button must be visible when a repo is configured");
    assert.strictEqual(result.disabledWhileInFlight, true, "button must disable itself while the request is in flight");
    assert.strictEqual(result.disabledAfter, false, "button must re-enable once the request settles");
    assert.strictEqual(result.importCalls.length, 1, "exactly one POST to import_from_backups");
    assert.strictEqual(result.importCalls[0].method, "POST");
    assert.strictEqual(result.wishlistRefetched, true, "wishlist must be refetched after a successful check");
    assert.strictEqual(result.resultVisible, true, "a result message must be shown");
    assert.match(result.resultText, /imported 2/);

    console.log("PASS: 'Check backups now' triggers an immediate check and reports the outcome");
  } finally {
    await browser.close();
  }
})().catch((err) => {
  console.error("FAIL:", err.message);
  process.exit(1);
});
