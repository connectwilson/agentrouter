import { mkdir, readFile } from "node:fs/promises";
import sharp from "/Users/huazhenghao/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp/dist/index.mjs";

const width = 1920;
const height = 1080;
const fps = 30;
const duration = 15;
const totalFrames = fps * duration;
const frameDir = new URL("./frames/", import.meta.url);
const homePath = new URL("./assets/homepage.png", import.meta.url);
const hubPath = new URL("./assets/agent-hub.png", import.meta.url);

await mkdir(frameDir, { recursive: true });

const home = await readFile(homePath);
const hub = await readFile(hubPath);
const homeBackground = await sharp(home).resize(width, height, { fit: "cover" }).modulate({ brightness: 0.34, saturation: 0.25 }).blur(2.2).png().toBuffer();
const hubBackground = await sharp(hub).resize(width, height, { fit: "cover" }).modulate({ brightness: 0.22, saturation: 0.2 }).blur(3).png().toBuffer();
const blackBackground = await sharp({ create: { width, height, channels: 4, background: "#000000" } }).png().toBuffer();

const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const smooth = (value) => {
  const x = clamp(value);
  return x * x * (3 - 2 * x);
};
const enter = (time, start, length = 0.45) => smooth((time - start) / length);
const leave = (time, end, length = 0.35) => 1 - smooth((time - end) / length);
const sceneOpacity = (time, start, end) => clamp(enter(time, start, 0.3) * leave(time, end, 0.3));
const esc = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const fmt = (value) => Number(value).toFixed(2);

function text(x, y, value, size, options = {}) {
  const {
    fill = "#ffffff",
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

function line(x1, y1, x2, y2, progress, opacity = 1, widthValue = 2) {
  const length = Math.hypot(x2 - x1, y2 - y1);
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#ffffff" stroke-width="${widthValue}" opacity="${opacity}" stroke-dasharray="${length}" stroke-dashoffset="${length * (1 - clamp(progress))}" />`;
}

function dotGrid(opacity = 0.14) {
  return `<defs><pattern id="grid" width="32" height="32" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="#ffffff" opacity="${opacity}" /></pattern></defs><rect width="1920" height="1080" fill="url(#grid)" />`;
}

function node(x, y, label, detail, active, opacity = 1, w = 290) {
  const stroke = active ? "#ffffff" : "#4b4b4b";
  const bg = active ? "#171717" : "#0c0c0c";
  return `<g opacity="${opacity}"><rect x="${x}" y="${y}" width="${w}" height="116" fill="${bg}" stroke="${stroke}" stroke-width="${active ? 2 : 1}"/><rect x="${x}" y="${y}" width="6" height="116" fill="${active ? "#ffffff" : "#343434"}"/>${mono(x + 28, y + 44, label, 20, { weight: 600 })}${mono(x + 28, y + 78, detail, 14, { fill: "#929292" })}</g>`;
}

function routePacket(x1, y1, x2, y2, progress, opacity = 1) {
  const p = clamp(progress);
  const x = x1 + (x2 - x1) * p;
  const y = y1 + (y2 - y1) * p;
  return `<circle cx="${x}" cy="${y}" r="7" fill="#ffffff" opacity="${opacity}" />`;
}

function renderSvg(time) {
  let body = `<rect width="1920" height="1080" fill="#000000"/>${dotGrid()}`;

  const s0 = sceneOpacity(time, 0, 3.35);
  if (s0 > 0) {
    const a = enter(time, 0.15, 0.5) * s0;
    const b = enter(time, 0.9, 0.5) * s0;
    const c = enter(time, 1.9, 0.5) * s0;
    body += `<g opacity="${s0}"><rect x="0" y="0" width="1920" height="1080" fill="#000" opacity="0.28"/>${mono(96, 92, "WHY AGENTROUTER", 15, { fill: "#8a8a8a", letterSpacing: 3 })}${text(96, 302 - 26 * a, "Agents can reason.", 82, { weight: 500, opacity: a })}${text(96, 405 - 26 * b, "Their data access still breaks.", 82, { weight: 500, opacity: b })}${mono(100, 520, "MANUAL KEYS  /  FIXED TOOLS  /  NO SHARED TRUST", 20, { fill: "#8a8a8a", opacity: b })}${line(100, 646, 1640, 646, c, c, 2)}${mono(100, 725, "1200+ APIs", 48, { weight: 600, opacity: c })}${mono(100, 775, "THROUGH ONE ROUTER", 18, { fill: "#9a9a9a", opacity: c, letterSpacing: 3 })}${mono(1490, 725, "ONE INSTALL", 30, { weight: 600, anchor: "end", opacity: c })}${mono(1490, 770, "ROUTE ON DEMAND", 16, { fill: "#9a9a9a", anchor: "end", opacity: c, letterSpacing: 2 })}</g>`;
  }

  const s1 = sceneOpacity(time, 3.15, 7.25);
  if (s1 > 0) {
    const branch = enter(time, 3.65, 0.8);
    const packet = (time - 4.2) / 1.4;
    const converge = enter(time, 5.45, 0.75);
    body += `<g opacity="${s1}">${mono(96, 92, "COMPOSABLE DATA ACQUISITION", 15, { fill: "#8a8a8a", letterSpacing: 3 })}${text(96, 190, "One request. Multiple capabilities.", 58, { weight: 500 })}${node(96, 405, "AGENT TASK", "Assess BTC market risk", true, 1, 330)}${node(785, 294, "MARKET DATA", "price · ETF flows", branch, 310)}${node(785, 438, "ON-CHAIN", "wallets · netflow", branch, 310)}${node(785, 582, "DERIVATIVES", "funding · liquidations", branch, 310)}${line(426, 463, 680, 463, branch, 0.8)}${line(680, 463, 680, 352, branch, 0.55)}${line(680, 352, 785, 352, branch, 0.55)}${line(680, 463, 785, 496, branch, 0.55)}${line(680, 463, 680, 640, branch, 0.55)}${line(680, 640, 785, 640, branch, 0.55)}${routePacket(426, 463, 785, 352, packet, branch)}${routePacket(426, 463, 785, 496, packet - 0.12, branch)}${routePacket(426, 463, 785, 640, packet - 0.24, branch)}${node(1450, 438, "COMPOSED RESULT", "one agent-readable answer", true, converge, 350)}${line(1095, 352, 1340, 496, converge, 0.65)}${line(1095, 496, 1450, 496, converge, 0.65)}${line(1095, 640, 1340, 496, converge, 0.65)}${routePacket(1095, 352, 1450, 496, (time - 5.8) / 0.8, converge)}${routePacket(1095, 496, 1450, 496, (time - 5.9) / 0.8, converge)}${routePacket(1095, 640, 1450, 496, (time - 6.0) / 0.8, converge)}${mono(96, 930, "DISCOVER BY TASK  →  CALL  →  COMPOSE", 20, { fill: "#b4b4b4", letterSpacing: 2 })}</g>`;
  }

  const s2 = sceneOpacity(time, 7.05, 11.25);
  if (s2 > 0) {
    const scoreP = enter(time, 7.7, 1.0);
    const selected = enter(time, 8.8, 0.45);
    const trust = 0.7 + (0.99 - 0.7) * scoreP;
    const bar = 660 * trust;
    body += `<g opacity="${s2}">${mono(96, 92, "TRUST-AWARE ROUTING", 15, { fill: "#8a8a8a", letterSpacing: 3 })}${text(96, 190, "Trust is earned after the call.", 58, { weight: 500 })}${mono(96, 245, "FIT × PRICE × QUALITY × FEEDBACK", 18, { fill: "#8a8a8a", letterSpacing: 2 })}<rect x="96" y="350" width="760" height="28" fill="#161616"/><rect x="96" y="350" width="${bar}" height="28" fill="#ffffff"/>${mono(96, 430, "ROUTING TRUST SCORE", 17, { fill: "#929292", letterSpacing: 2 })}${mono(856, 420, fmt(trust), 86, { weight: 600, anchor: "end" })}${mono(96, 535, "SUCCESS RATE", 14, { fill: "#777" })}${mono(96, 582, `${Math.round(70 + 30 * scoreP)}%`, 44, { weight: 600 })}${mono(365, 535, "CONFIDENCE", 14, { fill: "#777" })}${mono(365, 582, fmt(0.83 * scoreP), 44, { weight: 600 })}${mono(634, 535, "LATENCY", 14, { fill: "#777" })}${mono(634, 582, "886ms", 44, { weight: 600 })}<rect x="1020" y="330" width="760" height="360" fill="#0d0d0d" stroke="#303030"/><rect x="1020" y="330" width="760" height="62" fill="#161616"/>${mono(1050, 370, "EVIDENCE FROM EVERY CALL", 16, { letterSpacing: 2 })}${mono(1060, 445, "✓  schema valid", 22, { opacity: enter(time, 8.0, 0.3) })}${mono(1060, 500, "✓  fresh data", 22, { opacity: enter(time, 8.3, 0.3) })}${mono(1060, 555, "✓  useful answer", 22, { opacity: enter(time, 8.6, 0.3) })}${mono(1060, 610, "✓  consumer feedback", 22, { opacity: enter(time, 8.9, 0.3) })}<rect x="1480" y="444" width="250" height="96" fill="${selected ? "#ffffff" : "#161616"}" stroke="#ffffff" opacity="${selected}"/>${mono(1605, 485, "SELECTED", 15, { anchor: "middle", fill: "#000", opacity: selected, letterSpacing: 2 })}${mono(1605, 520, "0.99", 30, { anchor: "middle", fill: "#000", opacity: selected, weight: 700 })}${mono(96, 930, "EVERY RESULT UPDATES THE NEXT ROUTE", 20, { fill: "#b4b4b4", letterSpacing: 2 })}</g>`;
  }

  const s3 = sceneOpacity(time, 11.05, 13.55);
  if (s3 > 0) {
    const steps = ["DISCOVER", "ROUTE", "CALL", "VERIFY", "FEEDBACK"];
    body += `<g opacity="${s3}">${mono(96, 92, "THE AGENT DATA LOOP", 15, { fill: "#8a8a8a", letterSpacing: 3 })}${text(96, 200, "Data access that gets better with use.", 58, { weight: 500 })}`;
    steps.forEach((label, index) => {
      const p = enter(time, 11.35 + index * 0.18, 0.35);
      const x = 96 + index * 350;
      body += `<g opacity="${p}"><rect x="${x}" y="430" width="280" height="150" fill="${index === 4 ? "#ffffff" : "#111111"}" stroke="#4a4a4a"/>${mono(x + 22, 472, `0${index + 1}`, 14, { fill: index === 4 ? "#555" : "#777" })}${mono(x + 22, 535, label, 20, { fill: index === 4 ? "#000" : "#fff", weight: 600, letterSpacing: 2 })}</g>`;
      if (index < steps.length - 1) body += line(x + 280, 505, x + 350, 505, p, p, 2);
    });
    const loop = enter(time, 12.25, 0.55);
    body += `${line(1630, 640, 260, 640, loop, 0.6, 2)}${line(260, 640, 260, 580, loop, 0.6, 2)}${routePacket(1630, 640, 260, 640, (time - 12.45) / 0.8, loop)}${mono(96, 830, "227 VERIFIED SERVICES  /  128 OBSERVED CALLS", 20, { fill: "#b4b4b4", letterSpacing: 2 })}${mono(96, 930, "ONE REQUEST  →  MULTIPLE SERVICES  →  ONE VERIFIED ANSWER", 20, { letterSpacing: 2 })}</g>`;
  }

  const s4 = sceneOpacity(time, 13.35, 15.2);
  if (s4 > 0) {
    const a = enter(time, 13.45, 0.4);
    const caret = Math.floor(time * 2) % 2 === 0 ? 1 : 0.25;
    body += `<g opacity="${s4}">${mono(960, 372, "AgentRouter >_", 88, { anchor: "middle", weight: 500, opacity: a })}${text(960, 482, "One install. All your agent needs.", 42, { anchor: "middle", weight: 400, opacity: a })}<rect x="525" y="585" width="870" height="88" fill="#0d0d0d" stroke="#3a3a3a"/>${mono(565, 642, "$ npx @agentrouternetwork/agentrouter", 22, { opacity: a })}<rect x="1330" y="613" width="8" height="30" fill="#ffffff" opacity="${caret}"/>${mono(960, 785, "AGENTROUTER.NETWORK", 18, { anchor: "middle", fill: "#9a9a9a", letterSpacing: 4, opacity: a })}</g>`;
  }

  body += `${mono(96, 1032, "AGENTROUTER · CONCEPT CUT 01", 12, { fill: "#555", letterSpacing: 2 })}${mono(1824, 1032, "15 SEC", 12, { fill: "#555", anchor: "end", letterSpacing: 2 })}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`;
}

async function renderFrame(index) {
  const time = index / fps;
  let background;
  if (time < 3.35) {
    background = homeBackground;
  } else if (time >= 13.35) {
    background = hubBackground;
  } else {
    background = blackBackground;
  }

  const svg = Buffer.from(renderSvg(time));
  const output = new URL(`frame-${String(index).padStart(4, "0")}.png`, frameDir);
  await sharp(background).composite([{ input: svg }]).png({ compressionLevel: 4 }).toFile(output.pathname);
}

const concurrency = 8;
let cursor = 0;
await Promise.all(Array.from({ length: concurrency }, async () => {
  while (true) {
    const index = cursor++;
    if (index >= totalFrames) return;
    await renderFrame(index);
  }
}));
