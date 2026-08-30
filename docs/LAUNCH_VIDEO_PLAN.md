# AgentRouter Launch Video Plan

Reference research and X examples: [`docs/LAUNCH_VIDEO_REFERENCES.md`](LAUNCH_VIDEO_REFERENCES.md)

## 1. Outcome

Create a 70-second product launch film that makes one idea immediately clear:

> AgentRouter lets an AI agent discover the right data service, pay for one call, verify the result, and improve service trust — without preinstalling every provider.

The film should feel like a product reveal, not a protocol explainer. Its proof is one real, end-to-end request. Provider Studio appears only at the end to show how the network grows.

### Primary audience

- AI agent builders who currently wire APIs and MCP servers by hand
- Data/API providers looking for agent-native distribution and monetization
- Hackathon judges, partners, and early technical investors

### Distribution package

- **Master:** 70 seconds, 16:9, 2560×1440 or 1920×1080, 30 fps
- **Social cut:** 30 seconds, 16:9 and 1:1
- **Teaser:** 15 seconds, 9:16, designed to work muted
- **Loop:** 6–8 seconds of the routing-to-verification sequence for the website hero

### Implemented concept cut

The current working artifact is `video/agentrouter-launch/agentrouter-launch-v3.mp4`: a 30-second, 16:9, caption-first practical demo. It shows Claude invoking AgentRouter, the route-selection proof, a real answer-ready result, and feedback updating trust. The earlier 15-second v1/v2 concept cuts remain available as motion studies.

## 2. Creative Direction

### Concept: “One question. The right data route.”

The viewer follows a single question through AgentRouter. The system turns a messy agent task into a visible route: capability, provider, price, payment, result, evidence, and feedback.

The central visual metaphor is the existing AgentRouter mark: an input moves through a routing point and exits as a verified result. Lines should behave like paths, not decorative circuit-board graphics.

### Tone

- Precise, fast, and credible
- Product-first rather than cinematic sci-fi
- Technical enough to prove the system, simple enough to understand without knowing x402 or ERC-8004
- Confident, but never claim “all APIs,” “the best provider,” or guaranteed truth

### Visual language

- Black-and-white backgrounds, near-black/white type, square borders, and high-contrast route lines, matching the live site's current visual system
- Use the product logo from `public/assets/brand/logo.png`
- Flat editorial motion: hard cuts, masks, route drawing, numeric counters, and crisp type
- Avoid generic blue-purple gradients, glass cards, fake terminal rain, robot imagery, and stock footage
- UI footage remains legible; key fields are enlarged or recreated as overlays rather than relying on tiny full-screen JSON

### Sound

- Restrained electronic pulse at roughly 105–115 BPM
- A short routing click for selection, a low payment confirmation tone, and a clean verification chime
- Voiceover is primary; music should remain approximately 12–16 dB below narration
- Captions are burned in for all social versions

## 3. Narrative Structure

1. **Problem:** an agent can answer only with services already wired into it.
2. **Reveal:** AgentRouter gives it one entry point to a network of data services.
3. **Proof:** a real request is routed, paid, invoked, and verified.
4. **Trust loop:** evidence and feedback make later routing better informed.
5. **Network:** providers can publish validated services through Provider Studio.
6. **Call to action:** install AgentRouter or publish a service.

## 4. 70-Second Master Script and Shot List

| Time | Picture | Voiceover | On-screen copy |
|---|---|---|---|
| 0:00–0:05 | Black screen. A cursor types: “What is BTC liquidation max pain right now?” The question stalls at a field of disconnected provider nodes. | “AI agents can reason. But their data is still trapped behind tools someone had to wire up first.” | `A smart agent is only as useful as the data it can reach.` |
| 0:05–0:10 | Disconnected nodes collapse into the AgentRouter mark. One clean route opens. | “AgentRouter gives them one route to an open network of data services.” | `One question. The right data route.` |
| 0:10–0:17 | Real client or demo UI sends the structured request. Highlight `capability`, `max_price_usdc`, and `freshness_seconds`. | “The agent describes the capability, budget, and freshness it needs.” | `Capability · Budget · Freshness` |
| 0:17–0:25 | Motion graphic fans the request out to three service manifests. Scores settle; one provider is selected. Cut to a real route response. | “AgentRouter discovers matching services, evaluates their fit and trust signals, then selects a route.” | `Discover → Evaluate → Select` |
| 0:25–0:33 | Show the HTTP 402 boundary as a price quote. A violet dot crosses the route; Arc USDC payment receipt resolves. | “If the service is paid, the agent stays inside its budget and pays for just this call.” | `0.01 USDC · Arc Testnet` and `Paid per call` |
| 0:33–0:43 | Real result arrives. Pull out the answer, source metadata, freshness, and confidence from the response; keep raw JSON in the background. | “The provider returns an agent-readable result, with freshness, confidence, sources, and limitations attached.” | `Result returned` plus actual captured values |
| 0:43–0:54 | The result folds into a compact evidence chain: manifest hash, input hash, output hash, payment transaction, verification report. A final hash lands on Arc. | “AgentRouter binds the request, result, payment, and verification into one evidence trace, with integrity anchored on Arc.” | `Request → Result → Payment → Verification` and `Evidence anchored` |
| 0:54–1:01 | Consumer feedback flows back to the selected service. Trust score and quality history update; the next route subtly reorders. | “After the answer is used, feedback becomes a signal for future routing.” | `Every call improves the trust layer.` |
| 1:01–1:06 | Brief real Provider Studio footage: import OpenAPI, inspect endpoint, validate, publish. | “And providers can turn an API into a discoverable, paid agent service.” | `Import · Validate · Publish` |
| 1:06–1:10 | Logo resolves from the route animation. Two CTAs appear. | “AgentRouter. The data network agents can use on demand.” | `Install AgentRouter` · `Publish a service` · `agentrouter.network` |

### Voiceover script, continuous

> AI agents can reason. But their data is still trapped behind tools someone had to wire up first. AgentRouter gives them one route to an open network of data services. The agent describes the capability, budget, and freshness it needs. AgentRouter discovers matching services, evaluates their fit and trust signals, then selects a route. If the service is paid, the agent stays inside its budget and pays for just this call. The provider returns an agent-readable result, with freshness, confidence, sources, and limitations attached. AgentRouter binds the request, result, payment, and verification into one evidence trace, with integrity anchored on Arc. After the answer is used, feedback becomes a signal for future routing. And providers can turn an API into a discoverable, paid agent service. AgentRouter. The data network agents can use on demand.

This is approximately 132 words. At 118–125 words per minute, it leaves enough room for the product moments to breathe.

## 5. What Must Be Real On Screen

The launch film should record one successful request from the same run so the identifiers and amounts remain consistent.

### Required proof fields

- User task or structured capability request
- Selected service and candidates considered
- Actual price and payment status
- Result data with timestamp/freshness and confidence where available
- `request_id`
- `manifest_hash`, `input_hash`, `output_hash`, and `trace_hash`
- Payment transaction hash
- Verification status/report
- Arc anchor transaction or explicit mock label if the demo is not using the live testnet path
- Consumer feedback acknowledgment and corresponding trust/quality view

### Truthfulness rules

- Use **Arc Testnet** anywhere testnet funds or contracts are shown.
- If a capture uses `ADN_ARC_ANCHOR_MODE=mock` or another mock payment mode, label it `Demo simulation`; do not show it as a live onchain transaction.
- Say “selects a route” or “evaluates fit and trust signals,” not “always finds the best API.”
- Say “integrity anchored on Arc,” not “all data is stored onchain.” Full evidence remains offchain.
- Use one provider that is stable during the capture. Do not base launch-day recording on the optional Matrixport upstream unless it has been verified immediately before capture.

## 6. Capture Plan

### A. Prepare the demo state

1. Choose one stable, repeatable capability and freeze its input/output fixture for rehearsal.
2. For the final proof take, switch to the real Arc Testnet payment and evidence path if it is operational.
3. Clear unrelated demo records or use a dedicated launch-video account/state.
4. Set browser zoom so UI text remains readable at 1440p.
5. Use a fixed request amount and keep every displayed identifier from the same request.

### B. Capture these takes separately

- **Take 1 — Demand-side UI:** `/demo`, from request entry through route result
- **Take 2 — Evidence:** `/agent-router/evidence?request_id=...`
- **Take 3 — Trust:** `/agent-router/trust` and/or the service detail/quality view
- **Take 4 — Provider Studio:** `/studio`, showing import, endpoint selection, validation, and published status
- **Take 5 — Optional client context:** the request invoked from an MCP-capable agent client

Record each take for 8–15 seconds longer than needed, with two seconds of stillness before and after every interaction. Hide bookmarks, personal accounts, wallet balances, API tokens, local file paths, and unrelated browser tabs.

### C. Capture settings

- 2560×1440 preferred; 1920×1080 minimum
- 30 fps, constant frame rate
- Pointer size 125–150%; disable notification banners
- Record clean system audio only when the UI has meaningful sounds; otherwise add sound in post
- Save lossless or high-bitrate source captures before compression

## 7. Editing Implementation

The recommended implementation is an editable ChatCut timeline built from original screen recordings, narration, music, and hand-authored Motion Graphics.

### Timeline structure

| Track | Contents |
|---|---|
| V4 | Captions and final CTA |
| V3 | Labels, callouts, hashes, route/evidence Motion Graphics |
| V2 | Punch-ins, masks, and UI detail crops |
| V1 | Primary screen recordings and full-frame backgrounds |
| A3 | UI clicks, route, payment, and verification sound effects |
| A2 | Music bed |
| A1 | Voiceover |

### Edit order

1. Record and lock the voiceover.
2. Build the 70-second radio edit and adjust pauses to the actual UI actions.
3. Place only the real screen recordings needed to prove each beat.
4. Add punch-ins so every important UI value is readable on a phone-sized player.
5. Create one representative route Motion Graphic and approve its style before building the remaining graphic system.
6. Build the evidence-chain and trust-loop graphics in the same visual language, varying form by purpose.
7. Add sound design, music, captions, and final mix.
8. Verify the composed timeline at the actual output resolution, then export the master and cutdowns.

### Motion Graphic components

- **Route graph:** input dot fans out to candidate manifests, scores settle, selected path thickens
- **402/payment bridge:** quoted amount becomes a payment receipt without showing a fake wallet approval flow
- **Evidence chain:** the five actual hashes/records bind into a single trace hash
- **Trust loop:** feedback returns to the service and influences the next ordering
- **CTA lockup:** existing logo, URL, and two audience-specific actions

All visible labels, colors, numerical values, URLs, service names, and hashes should be editable properties. Use supported cloud-renderer fonts rather than local system fonts.

### Transition logic

- Use match cuts based on the violet routing dot: cursor point → route node → payment indicator → evidence anchor
- Keep most cuts hard and motivated by an action
- Reserve the single longest camera move for the 0:43 evidence reveal
- Do not use transitions to conceal slow UI; trim pauses and rebuild only the necessary emphasis as overlays

## 8. 30-Second and 15-Second Versions

### 30-second social cut

- 0:00–0:04: “Your agent should not need every API preinstalled.”
- 0:04–0:09: one AgentRouter entry point
- 0:09–0:17: discover, select, pay
- 0:17–0:24: result plus evidence
- 0:24–0:27: feedback improves trust
- 0:27–0:30: logo and CTA

Suggested narration:

> Your agent should not need every API preinstalled. AgentRouter discovers the right data service, selects a route, and pays for one call within budget. The result arrives with verification and an evidence trail anchored on Arc. Feedback improves the trust layer for the next agent. One question. The right data route.

### 15-second vertical teaser

Use three large, caption-first beats:

1. `One agent. Thousands of possible data services.`
2. `Discover → Pay → Verify`
3. `AgentRouter — one question, the right data route.`

The 9:16 version should recompose the UI as two or three readable detail crops, not shrink the 16:9 frame.

## 9. Production Schedule

### Day 1 — Lock story and proof path

- Confirm the capability, provider, and live-versus-demo chain mode
- Run the full flow twice and capture all proof fields
- Approve final narration and visual direction

### Day 2 — Record

- Record voiceover
- Capture demand-side, evidence, trust, and Provider Studio takes
- Organize files by scene and preserve one text record of the request IDs/hashes used

### Day 3 — First cut

- Build radio edit and screen-recording assembly
- Create the representative route graphic
- Produce a reviewable rough cut with temporary music

### Day 4 — Motion and finish

- Complete evidence, payment, trust, captions, CTA, and sound design
- Run factual and visual QA

### Day 5 — Delivery

- Export master, social, vertical, and web loop
- Watch every deliverable end-to-end after export
- Publish only after product owner approves the exact claims and URLs

## 10. Acceptance Checklist

- A new viewer can explain AgentRouter in one sentence after watching once
- The first product interaction occurs within 10 seconds
- One request remains internally consistent across route, payment, result, evidence, and feedback
- Every critical value is legible on a laptop and a phone-sized playback window
- The video distinguishes testnet, mock, and production behavior accurately
- “Offchain evidence, onchain integrity anchor” is represented correctly
- The film shows both demand and provider value without splitting into two separate stories
- Captions match narration and stay inside 9:16 safe areas for the teaser
- Music never masks speech; no clipped peaks; final master loudness is suitable for web/social delivery
- All four exported versions have been watched after rendering, not only previewed in the editor

## 11. Inputs Needed Before Production Starts

- Final public CTA URL and install command
- Whether the launch is primarily for a hackathon, public product launch, or fundraising/demo use
- Approved pronunciation for “x402,” “Arc,” and “ERC-8004” if any appear in narration
- A stable demo provider and confirmation of live Arc Testnet readiness
- Brand font or approval to select a cloud-render-safe alternative
- Voice choice: founder voice, professional narrator, or synthetic voice
- Music licensing preference

If these inputs are not decided, production can still begin with the assumptions in this document, but the CTA, voice, font, and chain labels must be locked before the final motion pass.
