import { mkdir } from "node:fs/promises";
import sharp from "/Users/huazhenghao/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp/dist/index.mjs";

const width = 1920;
const height = 1080;
const fps = 30;
const duration = 15;
const totalFrames = fps * duration;
const frameDir = new URL("./frames-v2/", import.meta.url);

await mkdir(frameDir, { recursive: true });

const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const smooth = (value) => {
  const x = clamp(value);
  return x * x * (3 - 2 * x);
};
const ramp = (time, start, end) => smooth((time - start) / (end - start));
const windowOpacity = (time, start, end, fade = 0.35) => clamp(ramp(time, start, start + fade) * (1 - ramp(time, end - fade, end)));
const esc = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

function text(x, y, value, size, options = {}) {
  const {
    fill = "#f6f6f2",
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

function routeLine(x1, y1, x2, y2, progress, opacity = 1, strokeWidth = 2) {
  const length = Math.hypot(x2 - x1, y2 - y1);
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#f6f6f2" stroke-width="${strokeWidth}" opacity="${opacity}" stroke-dasharray="${length}" stroke-dashoffset="${length * (1 - clamp(progress))}" />`;
}

function pulse(x, y, time, start, label) {
  const age = clamp((time - start) / 0.8);
  const opacity = (1 - age) * 0.75;
  const radius = 18 + 62 * age;
  return `<g opacity="${clamp((time - start) / 0.18) * clamp((start + 1.1 - time) / 0.2)}"><circle cx="${x}" cy="${y}" r="10" fill="#f6f6f2" filter="url(#softGlow)"/><circle cx="${x}" cy="${y}" r="${radius}" fill="none" stroke="#f6f6f2" stroke-width="2" opacity="${opacity}"/>${mono(x, y + 58, label, 14, { anchor: "middle", fill: "#a2a2a0", letterSpacing: 2 })}</g>`;
}

function sourceNode(x, y, label, detail, time, start) {
  const p = ramp(time, start, start + 0.45);
  const ring = 20 + p * 22;
  return `<g opacity="${p}"><circle cx="${x}" cy="${y}" r="${ring}" fill="#080808" stroke="#f6f6f2" stroke-width="2"/><circle cx="${x}" cy="${y}" r="8" fill="#f6f6f2"/>${mono(x + 70, y - 5, label, 18, { weight: 700, letterSpacing: 2 })}${mono(x + 70, y + 25, detail, 13, { fill: "#858585" })}</g>`;
}

function renderSvg(time) {
  const packetProgress = ramp(time, 1.25, 13.45);
  const packetX = 620 + 5380 * packetProgress;
  const cameraTarget = clamp(packetX - 950, 0, 5100);
  const camera = cameraTarget;
  const gridOffset = -(camera * 0.14) % 48;
  const routeDraw = clamp((packetX - 620) / 5380);

  let body = `<defs>
    <pattern id="dots" width="48" height="48" patternUnits="userSpaceOnUse" patternTransform="translate(${gridOffset} 0)"><circle cx="1" cy="1" r="1" fill="#ffffff" opacity="0.10"/></pattern>
    <filter id="softGlow" x="-300%" y="-300%" width="700%" height="700%"><feGaussianBlur stdDeviation="9" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="trail" x1="0" x2="1"><stop offset="0" stop-color="#f6f6f2" stop-opacity="0"/><stop offset="0.72" stop-color="#f6f6f2" stop-opacity="0.18"/><stop offset="1" stop-color="#f6f6f2" stop-opacity="1"/></linearGradient>
  </defs>
  <rect width="1920" height="1080" fill="#050505"/>
  <rect width="1920" height="1080" fill="url(#dots)"/>
  <rect x="0" y="0" width="1920" height="1080" fill="none" stroke="#1f1f1f" stroke-width="2"/>`;

  body += `<g transform="translate(${-camera} 0)">`;

  const problemOpacity = windowOpacity(time, 0.05, 3.0, 0.5);
  body += `<g opacity="${problemOpacity}">
    ${mono(155, 454, "FIXED TOOLS  ·  MANUAL KEYS  ·  UNKNOWN QUALITY", 16, { fill: "#777774", letterSpacing: 2 })}
  </g>`;

  const taskOpacity = windowOpacity(time, 0.8, 3.8, 0.35);
  body += `<g opacity="${taskOpacity}">
    <circle cx="620" cy="590" r="56" fill="#0d0d0d" stroke="#f6f6f2" stroke-width="2"/>
    ${mono(620, 596, "TASK", 15, { anchor: "middle", weight: 700, letterSpacing: 2 })}
    ${mono(620, 695, "Assess BTC risk", 15, { anchor: "middle", fill: "#8d8d89" })}
    ${routeLine(676, 590, 1695, 590, clamp((packetX - 620) / 1075), 0.55, 2)}
    ${routeLine(1020, 590, 1240, 485, ramp(time, 1.3, 1.85), 0.22)}
    ${routeLine(1020, 590, 1240, 695, ramp(time, 1.45, 2.0), 0.22)}
    ${mono(1270, 490, "API KEY?", 13, { fill: "#666" })}
    ${mono(1270, 700, "TOOL INSTALLED?", 13, { fill: "#666" })}
  </g>`;

  const routerP = ramp(time, 2.25, 3.15);
  const routerPulse = 94 + Math.sin(time * 4.4) * 4;
  body += `<g opacity="${routerP}">
    <circle cx="1800" cy="590" r="${routerPulse}" fill="#090909" stroke="#3a3a38" stroke-width="1"/>
    <circle cx="1800" cy="590" r="64" fill="#f6f6f2" filter="url(#softGlow)"/>
    ${mono(1800, 584, "AR", 25, { anchor: "middle", fill: "#050505", weight: 800 })}
    ${mono(1800, 612, "ROUTER", 11, { anchor: "middle", fill: "#50504d", weight: 700, letterSpacing: 2 })}
    ${mono(1800, 760, "ONE INSTALL", 16, { anchor: "middle", letterSpacing: 3 })}
    ${mono(1800, 793, "ROUTE ON DEMAND", 13, { anchor: "middle", fill: "#858581", letterSpacing: 2 })}
  </g>`;

  const compositionOpacity = windowOpacity(time, 3.0, 8.25, 0.5);
  body += `<g opacity="${compositionOpacity}">
    ${routeLine(1864, 590, 3820, 590, clamp((packetX - 1800) / 2020), 0.5, 2)}
    ${routeLine(2480, 590, 2800, 355, ramp(time, 3.55, 4.4), 0.42)}
    ${routeLine(2480, 590, 2800, 590, ramp(time, 3.75, 4.6), 0.42)}
    ${routeLine(2480, 590, 2800, 825, ramp(time, 3.95, 4.8), 0.42)}
    ${sourceNode(2920, 355, "MARKET", "price · ETF flows", time, 4.0)}
    ${sourceNode(2920, 590, "ON-CHAIN", "wallets · netflow", time, 4.25)}
    ${sourceNode(2920, 825, "DERIVATIVES", "funding · liquidations", time, 4.5)}
    ${routeLine(2962, 355, 3440, 590, ramp(time, 5.1, 6.05), 0.42)}
    ${routeLine(2962, 590, 3440, 590, ramp(time, 5.25, 6.2), 0.42)}
    ${routeLine(2962, 825, 3440, 590, ramp(time, 5.4, 6.35), 0.42)}
    <g opacity="${ramp(time, 5.9, 6.65)}"><circle cx="3500" cy="590" r="64" fill="#f6f6f2"/><circle cx="3500" cy="590" r="92" fill="none" stroke="#f6f6f2" stroke-width="1" opacity="0.35"/>${mono(3500, 586, "ONE", 14, { anchor: "middle", fill: "#050505", weight: 700 })}${mono(3500, 610, "ANSWER", 14, { anchor: "middle", fill: "#050505", weight: 700 })}${mono(3500, 755, "COMPOSED, NOT SILOED", 14, { anchor: "middle", fill: "#91918d", letterSpacing: 2 })}</g>
  </g>`;

  const trustOpacity = windowOpacity(time, 6.7, 12.15, 0.5);
  const trustP = ramp(time, 7.5, 10.25);
  const trustScore = (0.7 + 0.29 * trustP).toFixed(2);
  const ringLength = 2 * Math.PI * 154;
  body += `<g opacity="${trustOpacity}">
    ${routeLine(3564, 590, 4890, 590, clamp((packetX - 3500) / 1390), 0.5, 2)}
    <circle cx="4320" cy="590" r="154" fill="#080808" stroke="#242424" stroke-width="12"/>
    <circle cx="4320" cy="590" r="154" fill="none" stroke="#f6f6f2" stroke-width="12" stroke-linecap="round" transform="rotate(-90 4320 590)" stroke-dasharray="${ringLength}" stroke-dashoffset="${ringLength * (1 - (0.7 + 0.29 * trustP))}"/>
    ${mono(4320, 575, trustScore, 80, { anchor: "middle", weight: 700 })}
    ${mono(4320, 625, "TRUST SCORE", 14, { anchor: "middle", fill: "#888884", letterSpacing: 2 })}
    ${pulse(4020, 795, time, 7.65, "VALID")}
    ${pulse(4220, 855, time, 8.25, "FRESH")}
    ${pulse(4420, 855, time, 8.85, "USEFUL")}
    ${pulse(4620, 795, time, 9.45, "FEEDBACK")}
    ${mono(4320, 985, "EVERY RESULT UPDATES THE NEXT ROUTE", 15, { anchor: "middle", fill: "#a0a09c", letterSpacing: 3, opacity: ramp(time, 9.6, 10.3) })}
  </g>`;

  const loopP = ramp(time, 10.25, 12.6);
  body += `<g opacity="${windowOpacity(time, 10.0, 13.6, 0.4)}">
    <path d="M 4890 590 C 5140 590 5180 340 5360 340 C 5580 340 5580 840 5250 840 C 5050 840 5010 690 4890 690" fill="none" stroke="#343432" stroke-width="2"/>
    <path d="M 4890 590 C 5140 590 5180 340 5360 340 C 5580 340 5580 840 5250 840 C 5050 840 5010 690 4890 690" fill="none" stroke="#f6f6f2" stroke-width="3" pathLength="1" stroke-dasharray="1" stroke-dashoffset="${1 - loopP}"/>
    ${mono(5240, 280, "DISCOVER  →  ROUTE  →  CALL", 15, { anchor: "middle", fill: "#8a8a87", letterSpacing: 2 })}
    ${mono(5240, 915, "VERIFY  →  FEEDBACK  →  ROUTE AGAIN", 15, { anchor: "middle", fill: "#8a8a87", letterSpacing: 2 })}
  </g>`;

  const finalP = ramp(time, 12.6, 13.5);
  body += `<g opacity="${finalP}">
    <circle cx="6000" cy="590" r="270" fill="#f6f6f2"/>
    ${mono(6000, 548, "AgentRouter >_", 60, { anchor: "middle", fill: "#050505", weight: 700 })}
    ${text(6000, 625, "One install. All your agent needs.", 29, { anchor: "middle", fill: "#222220", weight: 450 })}
    ${mono(6000, 705, "AGENTROUTER.NETWORK", 15, { anchor: "middle", fill: "#555550", letterSpacing: 3 })}
  </g>`;

  body += `<circle cx="${packetX}" cy="590" r="10" fill="#f6f6f2" filter="url(#softGlow)"/><rect x="${packetX - 210}" y="586" width="190" height="8" fill="url(#trail)" opacity="0.75"/>`;
  body += `</g>`;

  const problemTitle = windowOpacity(time, 0.05, 2.72, 0.36);
  const composeTitle = windowOpacity(time, 2.78, 7.12, 0.34);
  const trustTitle = windowOpacity(time, 7.18, 10.82, 0.34);
  const learnTitle = windowOpacity(time, 10.9, 12.9, 0.3);
  body += `<g opacity="${problemTitle}">
    ${mono(96, 145, "WHY AGENTROUTER", 15, { fill: "#7e7e7b", letterSpacing: 4 })}
    ${text(96, 265, "Agents can reason.", 76, { weight: 520 })}
    ${text(96, 360, "Data access still breaks.", 76, { weight: 520 })}
  </g>`;
  body += `<g opacity="${composeTitle}">
    ${mono(96, 145, "COMPOSABLE DATA ACQUISITION", 15, { fill: "#7e7e7b", letterSpacing: 4 })}
    ${text(96, 245, "One request.", 62, { weight: 520 })}
    ${text(96, 322, "Multiple capabilities.", 62, { weight: 520 })}
  </g>`;
  body += `<g opacity="${trustTitle}">
    ${mono(1120, 145, "POST-CALL TRUST", 15, { fill: "#7e7e7b", letterSpacing: 4 })}
    ${text(1120, 245, "Trust is earned", 62, { weight: 520 })}
    ${text(1120, 322, "after the call.", 62, { weight: 520 })}
  </g>`;
  body += `<g opacity="${learnTitle}">
    ${mono(1120, 145, "THE TRUST LOOP", 15, { fill: "#7e7e7b", letterSpacing: 4 })}
    ${text(1120, 245, "Every call improves", 56, { weight: 520 })}
    ${text(1120, 315, "the next route.", 56, { weight: 520 })}
  </g>`;

  const stage = time < 3 ? "WHY" : time < 7 ? "COMPOSE" : time < 11.5 ? "TRUST" : time < 13.2 ? "LEARN" : "LAUNCH";
  body += `${mono(72, 70, "AGENTROUTER", 13, { fill: "#6f6f6c", letterSpacing: 3 })}${mono(1848, 70, stage, 13, { fill: "#8c8c88", anchor: "end", letterSpacing: 3 })}`;
  body += `<rect x="72" y="1012" width="1776" height="2" fill="#252525"/><rect x="72" y="1012" width="${1776 * clamp(time / duration)}" height="2" fill="#f6f6f2"/>`;

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
