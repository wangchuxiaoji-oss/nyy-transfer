# Chrome-only media playback status

## Current working scope

The current large-file playback path is considered Chrome-first / Chrome-only for the H.264 + AC-3 Blu-ray test file `xJlatE`.

Working path:

- `mp4box.js` parses the MP4 `moov` from the first 8MB probe.
- Video is exposed to MSE through a single `video/mp4; codecs="avc1.640029"` SourceBuffer.
- AC-3 audio is not sent to MSE. It is extracted separately and decoded in-browser through the custom `libav-ac3` wasm build.
- Phase 3A window sync works on Chrome with video as the clock and WebAudio AC-3 playback following the selected video timestamp.

Verified Chrome results:

- Init segment append succeeds with raw mp4box.js init segment.
- Video playback and seek recovery pass the current automated checks.
- AC-3 extraction, wasm decode, WebAudio playback, and 12s window sync pass.
- Observed sync drift in Chrome is below perceptual threshold in Phase 3A tests.

## Edge status

Edge is not fixed yet.

Linux Edge headless automation result:

- Installed Microsoft Edge stable on Ubuntu 24.04 via Playwright.
- Version: `Microsoft Edge 148.0.3967.96`.
- Ran `npm run test:edge-media` against `https://dev.nyy.app/ac3-lab/xJlatE`.
- Result: **pass**.
- Real player reached `readyState=4`, `duration=6309.47`, no player error text.
- `raw` init matrix passed in Linux Edge.

Native Range POC result on Linux Edge headless:

- Service Worker virtual media URL path passed.
- Native `<video>` playback reached `canplay` and `readyState=4`.
- Result URL shape: `/__nyy_virtual_media__/<id>/<file_name>`.

Interpretation: the Service Worker + native Range playback route is technically viable and should be the next Windows Edge validation target.

Interpretation: Linux Edge does not reproduce the user's Windows Edge failure. The remaining Edge bug is likely Windows-specific, most likely tied to Windows Edge's media pipeline / Windows Media Foundation behavior or headed Windows lifecycle differences.

Observed real-player failure:

```text
[MediaPlayer] init segment append failed: SourceBuffer error (updating=false, buffered=0ranges, dataSize=680) readyState: ended
视频初始化失败（浏览器关闭了媒体源，建议使用 Chrome）
```

Important finding: the Edge init matrix disproved the earlier assumption that the raw init segment is intrinsically rejected by Edge.

Edge matrix result from `/ac3-lab/xJlatE`:

```text
raw · ok
size=680 bytes · readyState=open

ftyp-hdlr-only · ok
size=696 bytes · readyState=open

sample-entry · ok
size=696 bytes · readyState=open

ffmpeg-like · ok
size=696 bytes · readyState=open

keep-ctts · error
size=712 bytes
SourceBuffer error (updating=false, buffered=0ranges, dataSize=712)

no-pasp · ok
size=680 bytes · readyState=open
```

Interpretation:

- Edge can append the raw 680B init segment in an isolated MSE matrix test.
- The real-player failure is therefore likely caused by player lifecycle / append timing / React development lifecycle / media element state, not by the init segment bytes alone.
- `keep-ctts` failing confirms that Edge/WMF can be strict about some init variants, but it is not the real-player root cause because `raw` passes in isolation.

## Things already tried

These did not fix the real Edge player path:

- Disabling React StrictMode temporarily.
- Changing `ftyp` brands.
- Stripping `ftyp` and appending bare `moov`.
- Replacing `btrt` / `ctts` with `free`.
- Stripping SPS VUI timing info.
- Adding `pasp`.
- Aligning `hdlr`, `tkhd`, `trex`, and bitrate hints closer to ffmpeg-generated fMP4.
- Defaulting the player back to raw init segment.
- Keeping the media element mounted instead of `display:none` during loading.
- Deferring Plyr initialization until after buffered data exists.
- Reworking `sbAppend` listener order to match the matrix test.

## Current recommendation

Do not spend more time guessing MP4 box patches without Windows Edge reproduction.

Linux Edge automation is available and should stay as a regression check, but it cannot prove the Windows Edge issue is fixed. The next useful step is to run the same test under Windows Edge automation and capture event ordering for:

- `MediaSource sourceopen`
- `MediaSource sourceended`
- `MediaSource sourceclose`
- `SourceBuffer updateend`
- `SourceBuffer error`
- `SourceBuffer abort`

Since Linux Edge does not reproduce it, local Windows automation or manual Windows Edge testing remains required.

## Current user-facing stance

For now, show a clear compatibility hint when the MSE path fails:

```text
视频初始化失败（浏览器关闭了媒体源，建议使用 Chrome）
```

The Chrome path remains the supported path for the current AC-3 frontend playback POC.
