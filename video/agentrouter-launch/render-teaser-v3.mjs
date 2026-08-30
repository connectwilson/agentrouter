import { mkdir } from "node:fs/promises";
import sharp from "/Users/huazhenghao/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp/dist/index.mjs";

const width = 1920;
const height = 1080;
const fps = 30;
const duration = 30;
const totalFrames = fps * duration;
const frameDir = new URL("./frames-v3/", import.meta.url);

await mkdir(frameDir, { recursive: true });

const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const smooth = (value) => {
  const x = clamp(value);
  return x * x * (3 - 2 * x);
};
const ramp = (time, start, end) => smooth((time - start) / (end - start));
const scene = (time, start, end, fade = 0.4) => clamp(ramp(time, start, start + fade) * (1 - ramp(time, end - fade, end)));
const esc = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

function text(x, y, value, size, options = {}) {
  const {
    fill = "#292927",
    weight = 500,
    family = "Helvetica Neue, Arial, sans-serif",
    anchor = "start",
    opacity = 1,
    letterSpacing = 0
  } = options;
  return `<text x="${x}" y="${y}" fill="${fill}" font-family="${family}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}" opacity="${opacity}" letter-spacing="${letterSpacing}">${esc(value)}</text>`;
}

function mono(x, y, value, size, options = {}) {
  return text(x, y, value, size, {
    family: "Menlo, Monaco, DejaVu Sans Mono, monospace",
    letterSpacing: options.letterSpacing ?? 1,
    ...options
  });
}

function claudeShell(content, options = {}) {
  const { active = "New chat", footer = "AgentRouter connected" } = options;
  return `<rect width="1920" height="1080" fill="#F7F5F2"/>
    <rect width="286" height="1080" fill="#ECE9E4"/>
    <line x1="286" y1="0" x2="286" y2="1080" stroke="#D8D4CE" stroke-width="2"/>
    <circle cx="66" cy="67" r="25" fill="#D97757"/>
    ${text(108, 78, "Claude", 34, { weight: 650 })}
    <rect x="28" y="128" width="230" height="64" rx="12" fill="#E1DDD7"/>
    ${text(58, 170, active, 26, { weight: 550 })}
    ${text(42, 265, "Recents", 22, { fill: "#77736E", weight: 600 })}
    ${text(42, 316, "BTC risk analysis", 23, { fill: "#4A4845" })}
    ${text(42, 1015, footer, 20, { fill: "#6E6A65" })}
    <circle cx="220" cy="1007" r="8" fill="#4B9C68"/>
    <line x1="286" y1="104" x2="1920" y2="104" stroke="#DEDAD4" stroke-width="2"/>
    ${text(346, 69, "BTC risk analysis", 24, { fill: "#5F5B56", weight: 550 })}
    ${content}`;
}

function checkChip(x, y, label, opacity = 1) {
  return `<g opacity="${opacity}"><rect x="${x}" y="${y}" width="250" height="58" rx="29" fill="#EEF4EC" stroke="#BFD1BB" stroke-width="2"/><circle cx="${x + 32}" cy="${y + 29}" r="13" fill="#43865A"/>${text(x + 59, y + 39, label, 27, { fill: "#355D42", weight: 620 })}</g>`;
}

function hookScene(time) {
  const opacity = scene(time, 0, 2.74, 0.18);
  const line1 = ramp(time, 0.2, 0.9);
  const line2 = ramp(time, 0.75, 1.55);
  const line3 = ramp(time, 1.5, 2.35);
  return `<g opacity="${opacity}"><rect width="1920" height="1080" fill="#050505"/>
    ${mono(100, 100, "WHY AGENTROUTER", 20, { fill: "#878783", letterSpacing: 4 })}
    ${text(100, 330, "Claude can reason.", 100, { fill: "#F7F5F2", weight: 540, opacity: line1 })}
    ${text(100, 465, "But it still needs", 100, { fill: "#F7F5F2", weight: 540, opacity: line2 })}
    ${text(100, 600, "the right data.", 100, { fill: "#F7F5F2", weight: 700, opacity: line3 })}
    <line x1="100" y1="755" x2="${100 + 1110 * line3}" y2="755" stroke="#F7F5F2" stroke-width="4"/>
    ${mono(100, 830, "ONE QUESTION  →  THE RIGHT ROUTE  →  A VERIFIABLE ANSWER", 25, { fill: "#A0A09B", letterSpacing: 2, opacity: line3 })}
  </g>`;
}

function promptScene(time) {
  const opacity = scene(time, 2.7, 11.35, 0.18);
  const promptP = ramp(time, 3.1, 4.0);
  const toolP = ramp(time, 6.25, 7.15);
  const statusP = ramp(time, 8.2, 9.0);
  const cursor = Math.floor(time * 2) % 2 === 0 ? 1 : 0.2;
  const content = `<g opacity="${promptP}">
      <circle cx="414" cy="224" r="34" fill="#2D2C2A"/>
      ${text(414, 235, "H", 28, { fill: "#FFFFFF", anchor: "middle", weight: 700 })}
      ${text(478, 215, "Analyze BTC liquidation risk right now.", 50, { weight: 580 })}
      ${text(478, 278, "Use live data and show what can be verified.", 43, { fill: "#5E5B57", weight: 430 })}
    </g>
    <g opacity="${toolP}" transform="translate(0 ${28 * (1 - toolP)})">
      <circle cx="414" cy="424" r="34" fill="#D97757"/>
      ${text(414, 434, "✦", 30, { fill: "#FFFFFF", anchor: "middle", weight: 700 })}
      ${text(478, 420, "I’ll use AgentRouter to route this request.", 41, { weight: 520 })}
      <rect x="478" y="468" width="1260" height="382" rx="20" fill="#FFFFFF" stroke="#D6D1CB" stroke-width="2"/>
      <rect x="478" y="468" width="10" height="382" rx="5" fill="#D97757"/>
      ${mono(526, 528, "AGENTROUTER", 24, { fill: "#8A5D4F", weight: 700, letterSpacing: 3 })}
      ${mono(526, 585, "agentrouter_fetch", 39, { fill: "#2D2C2A", weight: 700 })}
      ${text(526, 656, "Capability", 30, { fill: "#77736E", weight: 600 })}
      ${mono(760, 656, "perp_liquidation_max_pain", 34, { fill: "#2D2C2A", weight: 650 })}
      ${text(526, 715, "Asset", 30, { fill: "#77736E", weight: 600 })}
      ${mono(760, 715, "BTC", 34, { fill: "#2D2C2A", weight: 700 })}
      ${text(526, 774, "Max budget", 30, { fill: "#77736E", weight: 600 })}
      ${mono(760, 774, "0.05 credits", 34, { fill: "#2D2C2A", weight: 700 })}
      <circle cx="1575" cy="782" r="12" fill="#D97757" opacity="${cursor}"/>
      ${text(1605, 792, statusP > 0.6 ? "Route selected" : "Routing…", 27, { fill: "#8A5D4F", weight: 650 })}
    </g>`;
  return `<g opacity="${opacity}">${claudeShell(content)}</g>`;
}

function routeScene(time) {
  const opacity = scene(time, 10.9, 14.5, 0.45);
  const draw = ramp(time, 11.1, 12.8);
  const selectP = ramp(time, 12.15, 13.1);
  const packetX = 240 + 1260 * draw;
  return `<g opacity="${opacity}"><rect width="1920" height="1080" fill="#050505"/>
    ${mono(96, 100, "AGENTROUTER · LIVE ROUTE", 18, { fill: "#858581", letterSpacing: 4 })}
    ${text(96, 225, "15 matching services.", 72, { fill: "#F7F5F2", weight: 560 })}
    ${text(96, 310, "One route selected.", 72, { fill: "#F7F5F2", weight: 720 })}
    <line x1="240" y1="580" x2="1500" y2="580" stroke="#323230" stroke-width="4"/>
    <line x1="240" y1="580" x2="${packetX}" y2="580" stroke="#F7F5F2" stroke-width="4"/>
    <circle cx="240" cy="580" r="42" fill="#F7F5F2"/>
    ${mono(240, 588, "Q", 25, { fill: "#050505", anchor: "middle", weight: 800 })}
    <circle cx="${packetX}" cy="580" r="15" fill="#F7F5F2"/>
    <circle cx="1500" cy="580" r="${52 + selectP * 28}" fill="${selectP > 0.6 ? "#F7F5F2" : "#111111"}" stroke="#F7F5F2" stroke-width="3"/>
    ${mono(1500, 588, "DATA", 19, { fill: selectP > 0.6 ? "#050505" : "#F7F5F2", anchor: "middle", weight: 800 })}
    <g opacity="${selectP}">
      ${text(180, 790, "0.91", 72, { fill: "#F7F5F2", weight: 750 })}
      ${mono(180, 842, "ROUTE SCORE", 18, { fill: "#858581", letterSpacing: 3 })}
      ${text(725, 790, "0.78", 72, { fill: "#F7F5F2", weight: 750 })}
      ${mono(725, 842, "TRUST BEFORE CALL", 18, { fill: "#858581", letterSpacing: 3 })}
      ${text(1290, 790, "0.01", 72, { fill: "#F7F5F2", weight: 750 })}
      ${mono(1290, 842, "CREDITS · WITHIN BUDGET", 18, { fill: "#858581", letterSpacing: 3 })}
    </g>
  </g>`;
}

function resultScene(time) {
  const opacity = scene(time, 14.05, 22.25, 0.5);
  const resultP = ramp(time, 14.55, 15.35);
  const chipsP = ramp(time, 18.3, 19.2);
  const content = `<g opacity="${resultP}">
      <circle cx="414" cy="205" r="34" fill="#D97757"/>
      ${text(414, 216, "✦", 30, { fill: "#FFFFFF", anchor: "middle", weight: 700 })}
      ${text(478, 215, "BTC liquidation risk", 40, { fill: "#5D5955", weight: 600 })}
      ${text(478, 345, "$77,968.80", 94, { weight: 720 })}
      ${text(478, 410, "max-pain level", 38, { fill: "#6C6863", weight: 520 })}
      <rect x="478" y="467" width="1140" height="4" fill="#D7D2CC"/>
      ${text(478, 560, "Long liquidations are at risk", 53, { fill: "#B5533B", weight: 680 })}
      ${text(478, 630, "0.95% below the current price of $78,713.", 42, { weight: 460 })}
      ${text(478, 710, "24,542 heatmap points", 37, { weight: 660 })}
      ${text(915, 710, "→", 40, { fill: "#8C8882" })}
      ${text(1000, 710, "one answer-ready result", 37, { weight: 660 })}
      ${checkChip(478, 790, "Schema valid", chipsP)}
      ${checkChip(754, 790, "Fresh data", chipsP)}
      ${checkChip(1030, 790, "Non-empty", chipsP)}
      ${checkChip(1306, 790, "Quality 1.00", chipsP)}
      ${mono(478, 930, "RESULT RETURNED VIA AGENTROUTER", 20, { fill: "#8A8580", letterSpacing: 3, opacity: chipsP })}
    </g>`;
  return `<g opacity="${opacity}">${claudeShell(content)}</g>`;
}

function feedbackScene(time) {
  const opacity = scene(time, 21.8, 26.25, 0.45);
  const p = ramp(time, 22.15, 22.95);
  const scoreP = ramp(time, 23.0, 24.6);
  const score = (0.78 + 0.16 * scoreP).toFixed(2);
  const content = `<g opacity="${p}">
      ${mono(420, 190, "CLAUDE → AGENTROUTER", 20, { fill: "#8A5D4F", letterSpacing: 3 })}
      ${text(420, 285, "Was this result useful?", 58, { weight: 620 })}
      <rect x="420" y="360" width="650" height="330" rx="20" fill="#FFFFFF" stroke="#D6D1CB" stroke-width="2"/>
      <rect x="420" y="360" width="10" height="330" rx="5" fill="#D97757"/>
      ${mono(468, 430, "agentrouter_feedback", 31, { weight: 700 })}
      ${checkChip(468, 480, "Intent fit", ramp(time, 22.5, 23.0))}
      ${checkChip(744, 480, "Useful", ramp(time, 22.75, 23.25))}
      ${text(468, 626, "Consumer feedback recorded", 32, { fill: "#43865A", weight: 650, opacity: ramp(time, 23.2, 23.7) })}
      <rect x="1160" y="360" width="560" height="330" rx="20" fill="#2B2A28"/>
      ${mono(1210, 428, "ROUTING TRUST SCORE", 18, { fill: "#AAA7A1", letterSpacing: 3 })}
      ${text(1210, 575, score, 104, { fill: "#FFFFFF", weight: 720 })}
      ${text(1465, 568, "↑", 64, { fill: "#7CC08C", weight: 700, opacity: scoreP })}
      ${mono(1210, 630, "FEEDBACK IMPROVES THE NEXT ROUTE", 17, { fill: "#AAA7A1", letterSpacing: 2, opacity: scoreP })}
      ${text(420, 815, "The network learns after the answer—not before it.", 45, { weight: 520, opacity: scoreP })}
    </g>`;
  return `<g opacity="${opacity}">${claudeShell(content, { footer: "AgentRouter · feedback recorded" })}</g>`;
}

function finalScene(time) {
  const opacity = ramp(time, 25.7, 26.45);
  const commandP = ramp(time, 27.0, 27.8);
  return `<g opacity="${opacity}"><rect width="1920" height="1080" fill="#050505"/>
    ${mono(960, 310, "AgentRouter >_", 104, { fill: "#F7F5F2", anchor: "middle", weight: 700 })}
    ${text(960, 425, "Ask Claude. Get the right data.", 54, { fill: "#F7F5F2", anchor: "middle", weight: 500 })}
    ${text(960, 495, "Trust every call can improve.", 54, { fill: "#A3A39E", anchor: "middle", weight: 500 })}
    <rect x="420" y="610" width="1080" height="104" rx="14" fill="#111111" stroke="#3A3A38" stroke-width="2" opacity="${commandP}"/>
    ${mono(960, 676, "$ npx @agentrouternetwork/agentrouter", 38, { fill: "#F7F5F2", anchor: "middle", weight: 650, opacity: commandP })}
    ${mono(960, 820, "AGENTROUTER.NETWORK", 22, { fill: "#8D8D88", anchor: "middle", letterSpacing: 4 })}
  </g>`;
}

function renderSvg(time) {
  const body = `<rect width="1920" height="1080" fill="#050505"/>
    ${hookScene(time)}
    ${promptScene(time)}
    ${routeScene(time)}
    ${resultScene(time)}
    ${feedbackScene(time)}
    ${finalScene(time)}
    <rect x="48" y="1030" width="1824" height="3" fill="#CFCBC5" opacity="0.18"/>
    <rect x="48" y="1030" width="${1824 * clamp(time / duration)}" height="3" fill="${time > 2.6 && time < 26 ? "#D97757" : "#F7F5F2"}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`;
}

async function renderFrame(index) {
  const svg = Buffer.from(renderSvg(index / fps));
  const output = new URL(`frame-${String(index).padStart(4, "0")}.png`, frameDir);
  await sharp(svg).png({ compressionLevel: 4 }).toFile(output.pathname);
}

const concurrency = 3;
let cursor = 0;
await Promise.all(Array.from({ length: concurrency }, async () => {
  while (true) {
    const index = cursor++;
    if (index >= totalFrames) return;
    await renderFrame(index);
  }
}));
