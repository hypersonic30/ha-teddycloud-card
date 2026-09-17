// Real-Chromium regression test (per CLAUDE.md's Testing section) for the
// wishlist "acquired" checkmark badge: `.wishlist-item ha-icon` (meant to
// size the picture-placeholder icon to a 36px box with rounded corners and
// a background) also matched the acquired badge's own `ha-icon`, and beat
// `.wishlist-acquired-badge`'s rules on specificity - so the small 18px
// checkmark got boxed into a 36px tile with a background/border-radius
// instead of rendering as a plain small icon.
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

    const result = await page.evaluate(() => {
      const el = document.createElement("teddycloud-card");
      document.body.appendChild(el);
      el.setConfig({
        type: "custom:teddycloud-card",
        show_controls: false,
        show_nfc_assign: false,
        show_tonie_library: false,
        show_wishlist: true,
      });
      el.hass = { states: {}, entities: {} };

      el._renderWishlistItems([
        { model: "m1", title: "Acquired Tonie", acquired: true },
        { model: "m2", title: "Still Wanted", acquired: false },
      ]);

      const badge = el.shadowRoot.querySelector(".wishlist-acquired-badge");
      const fallbackIcon = el.shadowRoot.querySelector(".wishlist-item:not(.is-acquired) ha-icon");
      const badgeStyle = getComputedStyle(badge);
      const fallbackStyle = getComputedStyle(fallbackIcon);

      return {
        badge: {
          width: badgeStyle.width,
          borderRadius: badgeStyle.borderRadius,
        },
        fallback: {
          width: fallbackStyle.width,
          borderRadius: fallbackStyle.borderRadius,
        },
      };
    });

    console.log("computed styles:", JSON.stringify(result, null, 2));

    assert.notStrictEqual(
      result.badge.width,
      "36px",
      "acquired badge must not be forced to the 36px picture-box size"
    );
    assert.strictEqual(
      result.badge.borderRadius,
      "0px",
      "acquired badge must not get the picture-box border-radius"
    );
    // The unrelated no-picture fallback icon must still get its intended
    // picture-box treatment - this fix must not regress that case.
    assert.strictEqual(result.fallback.width, "36px");
    assert.strictEqual(result.fallback.borderRadius, "6px");

    console.log("PASS: wishlist acquired badge renders as a plain small icon");
  } finally {
    await browser.close();
  }
})().catch((err) => {
  console.error("FAIL:", err.message);
  process.exit(1);
});
