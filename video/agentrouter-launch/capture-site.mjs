import { mkdir } from "node:fs/promises";
import { chromium } from "/Users/huazhenghao/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";

const outputDir = new URL("./assets/", import.meta.url);
await mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
});
const page = await browser.newPage({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
  colorScheme: "dark"
});

async function capture(path, filename, waitFor = "body") {
  await page.goto(`https://agentrouter.network${path}`, {
    waitUntil: "networkidle",
    timeout: 45_000
  });
  await page.locator(waitFor).first().waitFor({ state: "visible", timeout: 15_000 });
  await page.screenshot({ path: new URL(filename, outputDir).pathname, fullPage: false });
}

await capture("/", "homepage.png", "h1");
await capture("/agent", "agent-hub.png", "h2");

await browser.close();
