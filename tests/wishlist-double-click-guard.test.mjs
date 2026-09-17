// Real-Chromium test for the double-tap guard: a remove button disables
// itself immediately on click, so a second tap while the first request
// is still in flight (e.g. a user unsure whether their first tap
// registered, or a genuine accidental double-tap on a touchscreen) can't
// fire a second overlapping DELETE for the same item.
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

      let items = [{ model: "m1", title: "Acquired One", acquired: true }];
      const deleteCalls = [];
      let releaseDelete;
      const deleteGate = new Promise((resolve) => {
        releaseDelete = resolve;
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
          if (method === "DELETE") {
            deleteCalls.push(decodeURIComponent(url.split("/").pop()));
            await deleteGate; // stay "in flight" until the test releases it
            items = [];
          }
          return { ok: true, json: async () => items };
        },
      };

      await tick();
      await tick();

      const removeBtn = el.shadowRoot.querySelector(".wishlist-remove");
      removeBtn.click();
      const disabledRightAfterFirstClick = removeBtn.disabled;
      removeBtn.click(); // second tap while the first DELETE is still pending
      removeBtn.click(); // and a third, for good measure

      releaseDelete();
      await tick();
      await tick();
      await tick();

      return { deleteCalls, disabledRightAfterFirstClick };
    });

    console.log("result:", JSON.stringify(result));

    assert.strictEqual(result.disabledRightAfterFirstClick, true, "button must disable synchronously on click");
    assert.deepStrictEqual(result.deleteCalls, ["m1"], "only one DELETE should fire despite three clicks");

    console.log("PASS: a disabled remove button blocks overlapping double-taps");
  } finally {
    await browser.close();
  }
})().catch((err) => {
  console.error("FAIL:", err.message);
  process.exit(1);
});
