# Backstage

A video desktop for iPad. Backstage plays a local video (10 GB+ is fine) full screen, looping, with the status bar and home indicator hidden. Later versions will add shader backgrounds.

Built with Tauri 2. On iPad the video is not played by the webview. It plays in a native `AVPlayerLayer` behind a transparent webview, which keeps resource use low:

- Decoding runs on the hardware decoder through AVFoundation. File reads stream from disk on demand, so file size doesn't matter. The bytes never pass through the webview, IPC or a custom URL scheme.
- Files picked in Files are opened in place through security-scoped bookmarks. Nothing is copied into the app, and the library survives relaunches.
- Only about 5 s of video is buffered ahead (`preferredForwardBufferDuration`), and `AVPlayerLooper` loops without a gap.
- The audio session is `.ambient` and starts muted, so your music keeps playing.
- The control panel is plain HTML. While it's hidden, the webview has nothing to paint.

## Using it

- **Add videos…** opens the Files picker. iCloud Drive files are downloaded on demand; for 10 GB files, keep them on the iPad or an external drive.
- You can also copy files into **Files › On My iPad › Backstage**, or into the app's folder in Finder (iPad › Files) over USB. They show up in the library automatically.
- Tap anywhere to show or hide the panel. It hides by itself after 6 s while playing.
- Options: Fill / Fit / Stretch, loop one video or play the whole library, sound on/off, keep the screen awake. Options and the last video are remembered, so the app resumes playing when it launches.
- To lock the iPad into display mode, use **Guided Access** (Settings › Accessibility). It also blocks the edge swipes.

### Formats

AVFoundation plays MP4, MOV and M4V containers with H.264, HEVC (including HDR) or ProRes. **MKV and WebM are not supported.** Remuxing to MP4 is lossless and fast (no re-encode):

```bash
ffmpeg -i input.mkv -map 0:v:0 -map 0:a? -c copy -tag:v hvc1 output.mp4
```

(`-tag:v hvc1` is for HEVC video. Drop it for H.264.)

## Building

The iOS build needs a Mac with Xcode, Rust and Node.

```bash
rustup target add aarch64-apple-ios aarch64-apple-ios-sim
```

```bash
npm install
```

```bash
npm run ios:init
```

`ios:init` generates the Xcode project in `src-tauri/gen/apple`. Commit it if you later customise it in Xcode. Signing needs your team ID, either in `tauri.conf.json` → `bundle.iOS.developmentTeam` or in the `APPLE_DEVELOPMENT_TEAM` environment variable.

```bash
npm run ios:dev -- --open
```

`--open` opens Xcode so you can run on a connected iPad. Without it, the CLI asks which device or simulator to use. For a release build:

```bash
npm run ios:build
```

`npm run tauri dev` on a desktop, or `npm run dev` in a browser, runs the same UI against an HTML `<video>` fallback. This is meant for UI work only. Nothing is saved there.

## Layout

| Path | What it is |
| --- | --- |
| `src/` | Control panel (vanilla TS + Vite). `player.ts` wraps the native plugin and the desktop fallback behind one interface. |
| `src-tauri/` | Tauri app. `Info.ios.plist` is merged into the generated iOS Info.plist (hides the status bar at launch, exposes the Documents folder to Files and Finder). |
| `plugins/player/` | Local Tauri plugin. All iOS logic is in `ios/Sources/PlayerPlugin.swift`. The Rust side only registers it: Tauri forwards plugin commands that Rust doesn't handle to Swift. |

### How the overlays are hidden

At runtime the plugin sets `prefersStatusBarHidden`, `prefersHomeIndicatorAutoHidden` and `preferredScreenEdgesDeferringSystemGestures` on Tauri's root view controller. With deferred edges, the first swipe from an edge only reveals the grabber; a second swipe performs the system action. In a resizable Stage Manager window, iPadOS controls the window chrome itself.

### Adding shaders later

The page is transparent over the video layer. A WebGL/WebGPU canvas can be drawn above the video, or replace it, without touching the native side. To process the video itself in a shader, the Swift side would read frames with `AVPlayerItemVideoOutput` into a Metal view.
