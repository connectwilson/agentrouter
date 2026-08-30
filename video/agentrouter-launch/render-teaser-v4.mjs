import { mkdir } from "node:fs/promises";
import sharp from "/Users/huazhenghao/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp/dist/index.mjs";

const W = 1920;
const H = 1080;
const FPS = 30;
const root = new URL("./", import.meta.url);
const introDir = new URL("./frames-v4-intro/", root);
const outroDir = new URL("./frames-v4-outro/", root);
await mkdir(introDir, { recursive: true });
await mkdir(outroDir, { recursive: true });

const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const smooth = (v) => { const x = clamp(v); return x * x * (3 - 2 * x); };
const ramp = (t, a, b) => smooth((t - a) / (b - a));
const fade = (t, a, b, edge = .35) => ramp(t, a, a + edge) * (1 - ramp(t, b - edge, b));
const esc = (s) => String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const text = (x, y, value, size, opts = {}) => `<text x="${x}" y="${y}" fill="${opts.fill || "#F5F3EE"}" font-family="${opts.family || "Helvetica Neue, Arial, sans-serif"}" font-size="${size}" font-weight="${opts.weight || 600}" text-anchor="${opts.anchor || "start"}" opacity="${opts.opacity ?? 1}" letter-spacing="${opts.spacing || 0}">${esc(value)}</text>`;

function background(t) {
  const drift = 55 * Math.sin(t * .7);
  return `<rect width="${W}" height="${H}" fill="#080908"/>
    <circle cx="${1520 + drift}" cy="210" r="520" fill="#26382E" opacity=".34"/>
    <circle cx="${260 - drift}" cy="960" r="430" fill="#452E26" opacity=".22"/>
    <path d="M-80 820 C420 ${510 + drift}, 980 ${930 - drift}, 2020 310" fill="none" stroke="#6E8F79" stroke-width="2" opacity=".18"/>`;
}

function intro(t) {
  const question = fade(t, 0, 2.15, .25);
  const answer = fade(t, 1.8, 4.6, .3);
  const line = ramp(t, 2.15, 3.15);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${background(t)}
    <g opacity="${question}">
      ${text(118, 142, "WHY AGENTROUTER", 24, { fill: "#9AA59C", weight: 700, spacing: 5 })}
      ${text(118, 450, "Agents can reason.", 110, { weight: 520 })}
      ${text(118, 590, "Data is still fragmented.", 110, { weight: 720 })}
    </g>
    <g opacity="${answer}">
      ${text(118, 160, "ONE REQUEST", 24, { fill: "#9AA59C", weight: 700, spacing: 5 })}
      ${text(118, 430, "Discover. Route. Verify.", 112, { weight: 680 })}
      <line x1="118" y1="530" x2="${118 + 1420 * line}" y2="530" stroke="#D9E4DC" stroke-width="3" opacity=".8"/>
      ${text(118, 650, "Composable data for any agent.", 62, { fill: "#B9C5BD", weight: 470 })}
      ${text(118, 760, "No API-by-API setup.", 38, { fill: "#7E8A82", weight: 500 })}
    </g>
  </svg>`;
}

function outro(t) {
  const p1 = fade(t, 0, 2.1, .25);
  const p2 = fade(t, 1.7, 3.2, .28);
  const pulse = .55 + .25 * Math.sin(t * 3.5);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${background(t + 5)}
    <g opacity="${p1}">
      ${text(960, 360, "Evidence in.", 110, { anchor: "middle", weight: 560 })}
      ${text(960, 500, "Feedback back.", 110, { anchor: "middle", weight: 720 })}
      ${text(960, 640, "Trust compounds.", 110, { anchor: "middle", weight: 720, fill: "#C9DDD0" })}
    </g>
    <g opacity="${p2}">
      <circle cx="960" cy="350" r="74" fill="none" stroke="#98BEA5" stroke-width="3" opacity="${pulse}"/>
      <circle cx="960" cy="350" r="13" fill="#B8D9C2"/>
      ${text(960, 535, "AgentRouter", 118, { anchor: "middle", weight: 720 })}
      ${text(960, 620, "The data layer for agents.", 48, { anchor: "middle", fill: "#A9B5AD", weight: 460 })}
      ${text(960, 760, "agentrouter.network", 32, { anchor: "middle", fill: "#7F8B83", weight: 550, spacing: 2 })}
    </g>
  </svg>`;
}

async function render(dir, seconds, scene) {
  for (let frame = 0; frame < seconds * FPS; frame++) {
    const svg = scene(frame / FPS);
    await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toFile(new URL(`frame-${String(frame).padStart(4, "0")}.jpg`, dir).pathname);
  }
}

await render(introDir, 4.6, intro);
await render(outroDir, 3.2, outro);
