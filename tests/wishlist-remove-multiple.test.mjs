// Real-Chromium reproduction of a reported bug: with several acquired
// (checked-off) wishlist items in the list, clicking the remove ("x")
// button only actually removes one of them. Root cause turned out to be
// UX, not a broken click handler: _renderWishlistItems() sorts
// not-yet-acquired items first, acquired ones last - so removing one
// acquired item re-sorts and shifts every row after it, meaning a
// second click at "the same spot" lands on a different item than the
// user was aiming at. This test drives clicks specifically at the
// acquired subset (by class, re-queried after each render, the way a
// user re-aiming at the actually-still-acquired rows would) and checks
// that each one really does remove its own, correct item - not a
// left/right-neighbor caught by the reflow.
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

      let items = [
        { model: "m1", title: "Acquired One", acquired: true },
        { model: "m2", title: "Acquired Two", acquired: true },
        { model: "m3", title: "Acquired Three", acquired: true },
        { model: "m4", title: "Still Wanted", acquired: false },
      ];
      const deleteCalls = [];

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
            const model = decodeURIComponent(url.split("/").pop());
            deleteCalls.push(model);
            items = items.filter((i) => i.model !== model);
          }
          return { ok: true, json: async () => items };
        },
      };

      await tick();
      await tick();

      const acquiredRemoveButtons = () =>
        Array.from(el.shadowRoot.querySelectorAll(".wishlist-item.is-acquired .wishlist-remove"));

      const acquiredCounts = [acquiredRemoveButtons().length];
      while (acquiredRemoveButtons().length > 0) {
        acquiredRemoveButtons()[0].click();
        await tick();
        await tick();
        acquiredCounts.push(acquiredRemoveButtons().length);
      }

      return { acquiredCounts, deleteCalls, remainingModels: items.map((i) => i.model) };
    });

    console.log("result:", JSON.stringify(result));

    assert.deepStrictEqual(result.acquiredCounts, [3, 2, 1, 0]);
    assert.deepStrictEqual(new Set(result.deleteCalls), new Set(["m1", "m2", "m3"]));
    assert.deepStrictEqual(result.remainingModels, ["m4"]);

    console.log("PASS: clicking through acquired items removes each of them exactly once");
  } finally {
    await browser.close();
  }
})().catch((err) => {
  console.error("FAIL:", err.message);
  process.exit(1);
});
