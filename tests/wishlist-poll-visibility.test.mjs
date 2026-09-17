// Real-Chromium test for visibility-gated wishlist polling: the 60s poll
// must not fire while the tab/app is backgrounded (document.hidden) -
// exactly the window where a VPN tunnel is most likely mid-reconnect
// with a stale auth token, which a real report traced to Home Assistant
// banning the device's IP after several such polls logged as invalid
// auth. Captures the interval's callback directly (rather than waiting
// 60 real seconds) and drives document.visibilityState manually.
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

      let fetchCount = 0;
      let pollCallback = null;
      const realSetInterval = window.setInterval;
      window.setInterval = (fn, ms) => {
        if (ms === 60000) {
          pollCallback = fn;
          return 999999; // fake id - never actually scheduled, so it's a no-op to "clear" later
        }
        return realSetInterval(fn, ms);
      };

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
        fetchWithAuth: async () => {
          fetchCount++;
          return { ok: true, json: async () => [] };
        },
      };

      window.setInterval = realSetInterval;

      await tick();
      await tick();
      const countAfterInitialLoad = fetchCount;

      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      pollCallback(); // as if the real 60s timer just fired while backgrounded
      await tick();
      const countWhileHidden = fetchCount;

      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
      await tick();
      await tick();
      const countAfterReturning = fetchCount;

      return { countAfterInitialLoad, countWhileHidden, countAfterReturning, hasPollCallback: !!pollCallback };
    });

    console.log("result:", JSON.stringify(result));

    assert.strictEqual(result.hasPollCallback, true);
    assert.strictEqual(
      result.countWhileHidden,
      result.countAfterInitialLoad,
      "the poll must not fetch while document.visibilityState is 'hidden'"
    );
    assert.ok(
      result.countAfterReturning > result.countWhileHidden,
      "becoming visible again must trigger an immediate refresh"
    );

    console.log("PASS: wishlist polling pauses while backgrounded and catches up on return");
  } finally {
    await browser.close();
  }
})().catch((err) => {
  console.error("FAIL:", err.message);
  process.exit(1);
});
