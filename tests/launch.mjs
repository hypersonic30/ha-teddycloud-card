// Shared browser launcher for the real-Chromium behavioral tests. Local
// dev on this machine has no system Chrome, only the snap package at a
// fixed path; GitHub's ubuntu-latest runners have no snap but do have a
// system Chrome/Chromium on PATH. CHROME_PATH lets CI pin it explicitly;
// failing that, PATH lookup covers both Chrome and Chromium naming, and
// the snap path is the last-resort default for local dev.
import { execFileSync } from "node:child_process";
import puppeteer from "puppeteer-core";

function resolveExecutablePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  for (const bin of ["google-chrome", "google-chrome-stable", "chromium-browser", "chromium"]) {
    try {
      const resolved = execFileSync("which", [bin], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
      if (resolved) return resolved;
    } catch {
      // Not found - try the next candidate.
    }
  }
  return "/snap/bin/chromium";
}

export async function launchBrowser() {
  return puppeteer.launch({
    executablePath: resolveExecutablePath(),
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
}
