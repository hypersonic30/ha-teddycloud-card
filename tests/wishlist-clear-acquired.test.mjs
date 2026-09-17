// Real-Chromium test for the new "Clear found" bulk-remove button, added
// to address the reported multi-item-removal friction directly: instead
// of clicking each acquired item's own "x" while the list re-sorts under
// you, one button removes everything already acquired in one action.
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

      const clearBtn = el.shadowRoot.getElementById("wishlist-clear-acquired");
      const countEl = el.shadowRoot.getElementById("wishlist-clear-count");
      const visibleBefore = !clearBtn.classList.contains("is-hidden");
      const countBefore = countEl.textContent;

      clearBtn.click();
      await tick();
      await tick();
      await tick();

      const visibleAfter = !clearBtn.classList.contains("is-hidden");
      const remainingButtons = el.shadowRoot.querySelectorAll(".wishlist-remove").length;

      return {
        visibleBefore,
        countBefore,
        visibleAfter,
        deleteCalls,
        remainingModels: items.map((i) => i.model),
        remainingButtons,
      };
    });

    console.log("result:", JSON.stringify(result));

    assert.strictEqual(result.visibleBefore, true, "clear button should be visible when items are acquired");
    assert.strictEqual(result.countBefore, "3");
    assert.deepStrictEqual(new Set(result.deleteCalls), new Set(["m1", "m2", "m3"]));
    assert.deepStrictEqual(result.remainingModels, ["m4"]);
    assert.strictEqual(result.visibleAfter, false, "clear button should hide once nothing is acquired");
    assert.strictEqual(result.remainingButtons, 1, "only the still-wanted item's row should remain");

    console.log("PASS: 'Clear found' removes every acquired item in one action");
  } finally {
    await browser.close();
  }
})().catch((err) => {
  console.error("FAIL:", err.message);
  process.exit(1);
});
