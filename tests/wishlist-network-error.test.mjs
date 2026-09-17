// Real-Chromium test for the silent-failure bug: a network error during
// _removeFromWishlist()/_addToWishlist() used to reject with nothing
// catching it (unhandled promise rejection) - the button just looked
// like it did nothing, with no sign anything had failed. Simulates
// fetchWithAuth throwing (e.g. a dropped VPN tunnel mid-request) and
// checks a visible error appears instead of silence.
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

      const items = [{ model: "m1", title: "Acquired One", acquired: true }];
      let unhandledRejections = 0;
      window.addEventListener("unhandledrejection", () => unhandledRejections++);

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
          if (method === "DELETE") {
            // Simulate a dropped connection mid-request.
            throw new TypeError("Failed to fetch");
          }
          return { ok: true, json: async () => items };
        },
      };

      await tick();
      await tick();

      el.shadowRoot.querySelector(".wishlist-remove").click();
      await tick();
      await tick();
      await tick();

      const resultEl = el.shadowRoot.getElementById("wishlist-result");

      return {
        resultVisible: !resultEl.classList.contains("is-hidden"),
        resultText: resultEl.textContent,
        resultKind: resultEl.className,
        rowStillPresent: !!el.shadowRoot.querySelector(".wishlist-remove"),
        unhandledRejections,
      };
    });

    console.log("result:", JSON.stringify(result));

    assert.strictEqual(result.resultVisible, true, "a failed request must show something, not vanish silently");
    assert.ok(result.resultText.length > 0);
    assert.ok(result.resultKind.includes("err"));
    // The item wasn't actually removed (the request never succeeded) -
    // it should still be in the list, not silently dropped client-side.
    assert.strictEqual(result.rowStillPresent, true);
    assert.strictEqual(result.unhandledRejections, 0, "the failure must be caught, not an unhandled rejection");

    console.log("PASS: a network failure shows a visible error instead of silently doing nothing");
  } finally {
    await browser.close();
  }
})().catch((err) => {
  console.error("FAIL:", err.message);
  process.exit(1);
});
