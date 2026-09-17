// Real-Chromium test for the "View backup repo on GitHub" link: fetched
// once when the wishlist is wired up, shown with the right href when a
// GitHub backup repo is configured, hidden when it isn't.
import assert from "node:assert";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "./launch.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function renderCard(page, backupSourceResponse) {
  return page.evaluate(async (backupSource) => {
    const tick = () => new Promise((r) => setTimeout(r, 0));

    const calls = [];
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
      fetchWithAuth: async (url) => {
        calls.push(url);
        if (url.endsWith("/backup_source")) {
          return { ok: true, json: async () => backupSource };
        }
        return { ok: true, json: async () => [] };
      },
    };

    await tick();
    await tick();
    await tick();

    const link = el.shadowRoot.getElementById("wishlist-backup-link");
    return {
      hidden: link.classList.contains("is-hidden"),
      href: link.getAttribute("href"),
      backupSourceCalls: calls.filter((u) => u.endsWith("/backup_source")).length,
    };
  }, backupSourceResponse);
}

(async () => {
  const browser = await launchBrowser();
  try {
    const page1 = await browser.newPage();
    page1.on("pageerror", (err) => console.error("[pageerror]", err));
    await page1.setContent("<!doctype html><html><body></body></html>");
    await page1.addScriptTag({ path: path.resolve(__dirname, "../teddycloud-card.js") });
    const configured = await renderCard(page1, {
      configured: true,
      url: "https://github.com/me/backups/tree/master/German",
    });
    await page1.close();

    const page2 = await browser.newPage();
    page2.on("pageerror", (err) => console.error("[pageerror]", err));
    await page2.setContent("<!doctype html><html><body></body></html>");
    await page2.addScriptTag({ path: path.resolve(__dirname, "../teddycloud-card.js") });
    const notConfigured = await renderCard(page2, { configured: false });
    await page2.close();

    console.log("configured:", JSON.stringify(configured));
    console.log("not configured:", JSON.stringify(notConfigured));

    assert.strictEqual(configured.hidden, false, "link must be visible when a repo is configured");
    assert.strictEqual(configured.href, "https://github.com/me/backups/tree/master/German");
    assert.strictEqual(configured.backupSourceCalls, 1, "fetched once, not on every poll");

    assert.strictEqual(notConfigured.hidden, true, "link must stay hidden when nothing is configured");

    console.log("PASS: backup repo link reflects the configured source and fetches only once");
  } finally {
    await browser.close();
  }
})().catch((err) => {
  console.error("FAIL:", err.message);
  process.exit(1);
});
