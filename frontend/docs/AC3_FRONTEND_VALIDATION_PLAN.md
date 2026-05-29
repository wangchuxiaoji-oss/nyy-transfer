# AC-3 Frontend Playback Validation Plan

Status: implemented through Phase 0/1 lab scaffolding
Source asset: `xJlatE` (`仿生人妻子-2022_BD中英双字.mp4`, 1.67 GB, chunked MP4, H.264 + AC-3)

## Objective

Validate whether nyy.app can support AC-3 audio without any server-side transcoding or decoding.

The target architecture is:

```text
MP4 chunks from TOS
  ├─ H.264 video track -> existing mp4box + MSE path
  └─ AC-3 audio track -> browser-side WASM decoder -> PCM -> WebAudio
```

Server-side constraints:

- No audio/video transcoding on the backend.
- No server-side decode pipeline.
- Backend may only provide metadata, signed URLs, and original chunk URLs.

## Review Notes

The plan is considered rigorous enough to start because it separates the problem into falsifiable stages:

- Browser capability detection: can the runtime even host the required APIs?
- Source parsing: can we reliably locate and classify the AC-3 track in the existing chunked MP4?
- Audio-only decode: can the device decode AC-3 to PCM fast enough in-browser?
- A/V synchronization: can WebAudio follow the video element clock after play/pause/seek?
- Stress behavior: can repeated seeks and long playback recover without fatal errors?
- Human listening: does the output sound correct to the user on real devices?

Important correction from open-source review:

- hls.js and Shaka can parse/transmux AC-3 streams, but they still depend on browser support for AC-3 decode when using MSE.
- They do not solve Chrome AC-3 playback by themselves.
- Frontend-only Chrome support requires a browser-side AC-3 decoder, likely via a custom libav.js/FFmpeg WASM build, then PCM playback through WebAudio.

## Device Matrix

Required devices:

| Device | Purpose | Expected outcome |
|---|---|---|
| Windows Chrome | Primary target | Native AC-3 likely unsupported; WASM + WebAudio should be viable |
| iPhone iOS Safari | Apple ecosystem baseline | May support AC-3 natively; WASM fallback may be less necessary |
| HarmonyOS Pad | Unknown Chromium-like platform | Validate API/runtime behavior and WebAudio policy |
| Android OnePlus Chrome | Mobile Chromium performance | Validate CPU, thermals, seek recovery, and WebAudio stability |

## Falsifiable Hypotheses

Each phase must produce a pass/fail result.

1. Browser capability hypothesis:
   - At least Windows Chrome supports WebAssembly and WebAudio sufficiently for AC-3 decode output.

2. Source parsing hypothesis:
   - The current `xJlatE` source exposes one H.264 video track and one AC-3 audio track through moov parsing from the first 8 MB.

3. Decoder hypothesis:
   - A browser-side AC-3 decoder can decode audio faster than real time on Windows Chrome.

4. Synchronization hypothesis:
   - WebAudio output can remain within acceptable drift relative to `video.currentTime` during normal playback and after seek.

5. Recovery hypothesis:
   - Repeated seek and slow CDN responses do not cause permanent audio loss or fatal player state.

## Phase 0: Browser Capability Detection

Lab URL:

```text
/ac3-lab/xJlatE
```

The page must capture:

- User agent
- Secure context
- `crossOriginIsolated`
- `WebAssembly`
- `AudioContext`
- `AudioWorklet`
- `SharedArrayBuffer`
- WebCodecs `AudioDecoder`
- `MediaSource`
- `MediaSource.isTypeSupported()` for:
  - `video/mp4; codecs="avc1.640029,ac-3"`
  - `audio/mp4; codecs="ac-3"`
  - `video/mp4; codecs="avc1.640029,ec-3"`
  - `audio/mp4; codecs="ec-3"`
- `HTMLMediaElement.canPlayType()` for the same codec strings

Pass criteria:

- Windows Chrome reports WebAssembly and WebAudio support.
- If native AC-3 is not supported, this is not a failure. It confirms the WASM path is needed.

## Phase 1: Source Track Detection

The lab page must fetch signed download URLs for `xJlatE`, fetch the first 8 MB by Range request, and parse moov using mp4box.

Expected result for the current source:

```text
video: avc1.640029
audio: ac-3
duration: ~6309s
```

Pass criteria:

- moov is parsed from the first 8 MB.
- Track list identifies AC-3 audio.
- Duration is sane and close to 6309 seconds.

Failure classification:

- `MOOV_NOT_FOUND`: source is not faststart or probe window is too small.
- `SIGNED_URL_FAILED`: download URL expired or share requires password.
- `RANGE_FAILED`: CDN did not serve the requested range.
- `MP4_PARSE_FAILED`: mp4box could not parse the source.

## Phase 2: Audio-Only WASM Decode

Goal:

- Decode AC-3 audio samples to PCM in the browser.
- Play 10-second samples through WebAudio without video synchronization.

Test points:

```text
00:00:30
00:05:00
00:20:00
00:40:00
01:10:00
01:38:00
01:44:30
```

Metrics:

- WASM decoder load time
- Decoder init time
- Time to first PCM
- Decode speed ratio
- PCM buffer peak estimate
- Audio underrun count
- JS errors

Pass criteria on Windows Chrome:

- First sound after sample selection within 5 seconds.
- Decode speed ratio > 1.5x real time.
- 10-second sample plays to completion.
- No fatal JS error.
- No obvious crackle, clipping, or channel corruption by human listening.

Implementation note:

- Prefer a custom minimal libav.js/FFmpeg WASM build with AC-3 decode and resampling only.
- Avoid full `ffmpeg.wasm` file-system style whole-file transcoding for 1GB+ playback.

## Phase 3: Video + WASM AC-3 Synchronization

Video remains the master clock:

```text
video.currentTime is authoritative
WebAudio follows video.currentTime
```

Synchronization policy:

- Drift < 50 ms: ignore.
- Drift 50-150 ms: gentle correction.
- Drift > 200 ms: drop PCM, insert silence, or rebuild the audio queue.
- On seek: clear PCM queue, reposition audio sample extraction, restart decode near target time.

Pass criteria:

- Normal playback drift p95 < 150 ms.
- Seek recovery with sound < 3 seconds on Windows Chrome.
- No old audio after seek.
- No obvious lip-sync error by human listening.

## Phase 4: 30-Point Seek Automation

Divide duration into 30 points.

For each point:

- Seek to target.
- Wait 8 seconds on desktop, 12 seconds on mobile.
- Confirm video playable.
- Confirm audio PCM buffer exists.
- Record A/V drift and underruns.

Desktop pass criteria:

- 30/30 video recovery.
- >= 28/30 audio recovery within 8 seconds.
- Failed points recover within 15 seconds.
- No fatal errors.

Mobile pass criteria:

- 15-point reduced seek test passes >= 13/15.
- Failed points recover within 20 seconds.

## Phase 5: Rapid Seek Stress

Use fixed random-like seek sequence:

```text
10%, 80%, 20%, 95%, 50%, 33%, 72%, 12%, 90%, 60%, 40%, 99%
```

Interval: 300-500 ms.

Pass criteria:

- Final target recovers video and audio.
- No stale audio from previous seek.
- No fatal JS error.
- Audio drift stabilizes within 15 seconds.

## Phase 6: Long Playback

Manual long-play smoke test:

```text
Start at 00:05:00 and play for 10 minutes.
```

Pass criteria:

- No continuous drift growth.
- No persistent audio loss.
- Audio underruns <= 3 per 10 minutes on Windows Chrome.
- Device does not kill the page.

## Human Listening Protocol

For each device, the lab page records:

- Device type
- Browser
- Test mode
- Test point
- Has sound: yes/no
- Sync rating: good/slight/bad
- Artifacts: none/clicks/crackle/dropouts/distortion
- Seek recovery: `<1s`, `1-3s`, `3-8s`, `>8s`, failed
- Heat/performance observation
- Subjective score: 1-5
- Notes

Human listening is required because technical drift alone does not catch all perceptual problems.

## Report JSON Schema

The lab page exports a JSON report with:

```json
{
  "source": "xJlatE",
  "timestamp": "ISO-8601",
  "capabilities": {},
  "media": {},
  "automatedTests": [],
  "manualResults": [],
  "errors": []
}
```

Reports from all four devices are compared before deciding whether to productize.

## Go / No-Go

P0, required to continue:

- Windows Chrome passes Phase 0 and Phase 1.
- Windows Chrome can decode and play AC-3 audio-only samples in Phase 2.
- Windows Chrome video + audio sync is acceptable in Phase 3.

P1, required before public release:

- Windows Chrome passes 30-point seek and rapid seek stress.
- Android OnePlus passes reduced seek and 10-minute smoke test.
- iPhone Safari path is determined: native AC-3 or WASM fallback.
- HarmonyOS Pad path is determined: WASM, native, or unsupported.

No-Go conditions:

- Browser-side AC-3 decode speed < 1.0x on Windows Chrome.
- Persistent A/V drift > 300 ms in normal playback.
- Repeated seek causes unrecoverable audio loss.
- WASM package size or licensing constraints are unacceptable.
- Mobile devices consistently overheat or crash.

## Current Implementation State

Implemented:

- `/ac3-lab/[code]` Phase 0 capability detection.
- Signed URL retrieval through existing share download API.
- First-8MB Range fetch and mp4box moov parsing.
- Codec/native support matrix.
- Phase 2A AC-3 compressed sample extraction from arbitrary timestamps.
- Batch extraction for fixed audio test points.
- Custom libav.js `ac3` variant build pipeline.
- Phase 2B libav-ac3 wasm load + decoder initialization validation.
- Phase 2C AC-3 compressed samples decoded to PCM frames in-browser.
- Phase 2C decoded sample playback through WebAudio.
- Manual listening form scaffold.
- JSON report export.

Not implemented yet:

- AC-3 WASM decoder.
- A/V sync loop.
- Automated audio-aware seek tests.

## Phase 2B Result

Date: 2026-05-28
Result: passed.

We built a custom libav.js `ac3` variant with browser-usable decoder support. The first build only exposed low-level helpers; after adding the JS components (`avformat`, `avcodec`, `avframe`, `avfilter`) the browser-side factory exposed `ff_init_decoder` and related helpers correctly.

Validation result in Chrome:

- `libav-ac3.js` loaded from frontend static assets.
- non-thread wasm target initialized successfully.
- `ff_init_decoder("ac3")` succeeded.

Important runtime constraint:

- The current site is not `crossOriginIsolated`, so threaded wasm builds are not usable yet.
- The current working path uses the non-thread wasm target only.

## Phase 2C Result

Date: 2026-05-28
Result: passed.

We validated the full browser-side decode path for extracted AC-3 samples:

```text
MP4 chunks -> Range fetch -> mp4box sample extraction -> temporary raw .ac3 payload ->
libav-ac3 demux + decode -> PCM frames -> WebAudio sample playback
```

Validation sample:

- Target time: `00:05:00`
- Decoded frames: `353`
- Sample rate: `48000`
- Channels: `2`
- Decoded duration: `11.296s`
- Decoder elapsed: about `267ms`

This establishes that browser-side AC-3 decode is technically viable on desktop Chrome for the current source asset.

Open note:

- FFmpeg reported `Estimating duration from bitrate, this may be inaccurate` when demuxing raw AC-3. This is acceptable for Phase 2C because the payload is short and only used for local decode verification.
- For full playback integration, timing must still be driven by the original MP4 timeline, not raw AC-3 duration guesses.

## Phase 2A Result

Date: 2026-05-28
Browser: Headless Chrome 148 on Linux
Source: `xJlatE`

Result: passed.

The lab successfully extracted AC-3 compressed samples at all fixed test points without downloading the full 1.67 GB file. This proves that the current chunk URL + Range + mp4box path can provide decoder-ready AC-3 frames to a future browser-side decoder.

Batch extraction results:

| Target | Samples | Sample duration | Sample bytes | Fetched bytes | Elapsed |
|---:|---:|---:|---:|---:|---:|
| 00:00:30 | 471 | 15.07s | 482 KB | 6 MB | 1.5s |
| 00:05:00 | 353 | 11.30s | 361 KB | 6 MB | 1.6s |
| 00:20:00 | 388 | 12.42s | 397 KB | 4 MB | 1.2s |
| 00:40:00 | 392 | 12.54s | 401 KB | 4 MB | 11.8s |
| 01:10:00 | 334 | 10.69s | 342 KB | 6 MB | 7.1s |
| 01:38:00 | 314 | 10.05s | 322 KB | 4 MB | 3.0s |
| 01:44:30 | 927 | 29.66s | 949 KB | 4 MB | 0.5s |

Interpretation:

- AC-3 frames are accessible at arbitrary seek points.
- Fetch volume is small enough for frontend-side decode validation.
- Some points have higher latency due to CDN/network variability; this must be accounted for in user-facing buffering UI.
- The next blocker is decoder availability, not sample extraction.

## Decoder Availability Gate

Open-source review and npm registry search show no ready-made `@libav.js/variant-ac3` package.

The next implementation step is to create a custom libav.js variant containing at minimum:

```json
["parser-ac3", "decoder-ac3", "audio-filters"]
```

If using libav.js demux instead of mp4box in a later iteration, add:

```json
["demuxer-mp4", "parser-h264"]
```

For the current architecture, mp4box already demuxes MP4 and extracts AC-3 samples, so the smallest useful WASM target only needs AC-3 decode plus resampling/output format conversion support.

Licensing note:

- libav.js is LGPL-oriented. Any distributed custom build must include/offer corresponding source as required by its license.
- AC-3 decoder availability in FFmpeg/libav should be verified during the custom build step.
