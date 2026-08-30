# AgentRouter launch video

This directory contains the local 15-second concept cut focused on:

- why AgentRouter exists;
- trust-aware routing that learns from completed calls;
- composable data acquisition across several service capabilities.

## Build

The current review version is `agentrouter-launch-v3.mp4`. It is a 30-second, practical Claude workflow built from a real AgentRouter call and its returned verification/feedback metadata. Critical copy uses large video-scale typography; the abstract routing animation is limited to a short bridge between the Claude tool call and the answer.

```bash
node video/agentrouter-launch/capture-site.mjs
node video/agentrouter-launch/render-teaser-v3.mjs
ffmpeg -y -framerate 30 -i video/agentrouter-launch/frames-v3/frame-%04d.png \
  -f lavfi -i "sine=frequency=55:duration=30:sample_rate=48000" \
  -f lavfi -i "anoisesrc=color=pink:duration=30:sample_rate=48000" \
  -filter_complex "[1:a]volume=0.24[a0];[2:a]lowpass=f=280,volume=0.016[a1];[a0][a1]amix=inputs=2,afade=t=in:st=0:d=0.8,afade=t=out:st=28.8:d=1.2[a]" \
  -map 0:v -map "[a]" -c:v libx264 -pix_fmt yuv420p -r 30 -c:a aac -b:a 160k -shortest \
  video/agentrouter-launch/agentrouter-launch-v3.mp4
```

Source claims and network snapshot values were checked against the public site on 2026-08-28. Refresh them before a final public export.

The cut is caption-first and has no voiceover, so it remains understandable when autoplayed muted on X. The displayed BTC values and route metrics are a real 2026-08-28 AgentRouter call snapshot and must be refreshed before a later public export if the copy says “current.”
