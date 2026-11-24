import { createPlayer, type Options, type PlayerState, type Position, type Video } from "./player";

const IDLE_HIDE_MS = 6000;
// The seek bar only follows playback while the panel is open.
const POSITION_POLL_MS = 250;

const panel = document.getElementById("panel") as HTMLDivElement;
const player = await createPlayer();
let state: PlayerState = await player.state();
let hideTimer: number | undefined;
let position: Position = { time: 0, duration: null };
let pollTimer: number | undefined;
/** Fraction of the video under the finger while dragging the seek bar. */
let scrubbing: number | null = null;
let renderPending = false;
let seekInFlight = false;
let queuedSeek: { time: number; exact: boolean } | null = null;

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const formatSize = (bytes: number | null) => {
  if (bytes == null) return "";
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
};

const formatTime = (seconds: number) => {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
};

function segmented<K extends keyof Options>(key: K, label: string, choices: [Options[K], string][]) {
  const buttons = choices
    .map(
      ([value, text]) =>
        `<button data-option="${key}" data-value="${value}" aria-pressed="${state.options[key] === value}">${text}</button>`,
    )
    .join("");
  return `<div class="option"><span>${label}</span><div class="segmented">${buttons}</div></div>`;
}

function videoRow(v: Video) {
  const current = v.id === state.currentId;
  const meta = [v.source === "documents" ? "On iPad" : v.source === "picked" ? "Files" : "", formatSize(v.size)]
    .filter(Boolean)
    .join(" · ");
  const removable = v.source !== "documents";
  return `
    <li class="${current ? "current" : ""}${v.available ? "" : " missing"}">
      <button class="video" data-action="play" data-id="${escape(v.id)}" ${v.available ? "" : "disabled"}>
        <span class="name">${escape(v.name)}</span>
        <span class="meta">${v.available ? meta : "Unavailable"}</span>
      </button>
      ${removable ? `<button class="icon" data-action="remove" data-id="${escape(v.id)}" aria-label="Remove ${escape(v.name)}">×</button>` : ""}
    </li>`;
}

function render() {
  // Rebuilding the panel mid-drag would drop the finger's pointer capture.
  if (scrubbing != null) {
    renderPending = true;
    return;
  }
  renderPending = false;
  const current = state.library.find((v) => v.id === state.currentId);
  panel.innerHTML = `
    <header>
      <div class="title">
        <strong>Backstage</strong>
        <span>${current ? escape(current.name) : "Nothing playing"}</span>
      </div>
      <div class="transport">
        ${
          current
            ? `<button data-action="${state.playing ? "pause" : "resume"}">${state.playing ? "Pause" : "Play"}</button>
               <button data-action="next">Next</button>
               <button data-action="stop">Stop</button>`
            : ""
        }
      </div>
    </header>
    ${
      current
        ? `<div class="seek">
             <div class="seek-track" role="slider" aria-label="Playback position" aria-valuemin="0">
               <div class="seek-rail"><div class="seek-fill"></div><div class="seek-knob"></div></div>
             </div>
             <div class="seek-times"><span class="seek-elapsed"></span><span class="seek-duration"></span></div>
           </div>`
        : ""
    }
    ${state.error ? `<p class="error">${escape(state.error)}</p>` : ""}
    <ul class="library">${state.library.map(videoRow).join("")}</ul>
    <button class="primary" data-action="pick">Add videos…</button>
    <section class="options">
      ${segmented("gravity", "Scale", [["fill", "Fill"], ["fit", "Fit"], ["stretch", "Stretch"]])}
      ${segmented("repeatMode", "Repeat", [["one", "Loop video"], ["all", "Play all"]])}
      ${segmented("muted", "Sound", [[true, "Off"], [false, "On"]])}
      ${state.native ? segmented("keepAwake", "Screen", [[true, "Stay awake"], [false, "Auto-lock"]]) : ""}
    </section>
    ${
      state.native
        ? `<p class="hint">Videos can also be copied to <em>On My iPad › Backstage</em> in Files, or via Finder over USB.</p>`
        : `<p class="hint">Desktop preview: HTML video, nothing is saved. Run on iPad for the native player.</p>`
    }`;
  paintSeek();
}

/** Updates the seek bar in place, without re-rendering the panel. */
function paintSeek() {
  const track = panel.querySelector<HTMLElement>(".seek-track");
  if (!track) return;
  const duration = position.duration ?? 0;
  const fraction = scrubbing ?? (duration ? position.time / duration : 0);
  const clamped = Math.min(1, Math.max(0, fraction));
  const time = scrubbing != null ? scrubbing * duration : position.time;
  track.style.setProperty("--progress", String(clamped));
  panel.querySelector(".seek-elapsed")!.textContent = formatTime(time);
  panel.querySelector(".seek-duration")!.textContent = duration ? formatTime(duration) : "--:--";
  track.classList.toggle("disabled", !duration);
  track.setAttribute("aria-valuemax", String(Math.round(duration)));
  track.setAttribute("aria-valuenow", String(Math.round(time)));
  track.setAttribute("aria-valuetext", formatTime(time));
}

async function refreshPosition() {
  if (scrubbing != null || seekInFlight || queuedSeek) return;
  const id = state.currentId;
  const next = await player.position().catch(() => null);
  // Ignore answers that arrive after a drag started or the video changed.
  if (!next || scrubbing != null || seekInFlight || id !== state.currentId) return;
  position = next;
  paintSeek();
}

function syncPositionPolling() {
  const wanted = !panel.hidden && !!state.currentId && !state.error;
  if (wanted && pollTimer === undefined) {
    void refreshPosition();
    pollTimer = window.setInterval(refreshPosition, POSITION_POLL_MS);
  } else if (!wanted && pollTimer !== undefined) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
}

/** One seek at a time; while one runs, only the latest request is kept. */
async function seekTo(time: number, exact: boolean) {
  if (seekInFlight) {
    queuedSeek = { time, exact };
    return;
  }
  seekInFlight = true;
  try {
    const landed = await player.seek(time, exact);
    if (scrubbing == null) position = landed;
  } catch {
    // The next poll shows where playback really is.
  } finally {
    seekInFlight = false;
  }
  const queued = queuedSeek;
  queuedSeek = null;
  if (queued) await seekTo(queued.time, queued.exact);
  else if (scrubbing == null) paintSeek();
}

function fractionAt(track: HTMLElement, clientX: number) {
  const rect = track.getBoundingClientRect();
  return rect.width ? Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) : 0;
}

function update(next: PlayerState) {
  if (next.currentId !== state.currentId) position = { time: 0, duration: null };
  state = next;
  render();
  syncPositionPolling();
  // Without a video there is nothing to show behind the panel, so keep it up.
  if (!state.currentId || state.error) show();
  else scheduleHide();
}

// The system status bar follows the panel: visible with the menu (so the
// window can be dragged in Stage Manager), hidden while just playing.
function setPanelVisible(visible: boolean) {
  if (panel.hidden === !visible) return;
  panel.hidden = !visible;
  syncPositionPolling();
  void player.setSystemOverlays(!visible).catch(() => {});
}

function show() {
  setPanelVisible(true);
  scheduleHide();
}

function hide() {
  if (!state.currentId || state.error || scrubbing != null) return;
  setPanelVisible(false);
  clearTimeout(hideTimer);
}

function scheduleHide() {
  clearTimeout(hideTimer);
  if (state.currentId && state.playing && !state.error) {
    hideTimer = window.setTimeout(hide, IDLE_HIDE_MS);
  }
}

// Seek bar: tap to jump, or drag to scrub. Keyframe seeks follow the finger;
// lifting it does one exact seek to where it stopped.
panel.addEventListener("pointerdown", (e) => {
  const track = (e.target as HTMLElement).closest<HTMLElement>(".seek-track");
  const duration = position.duration;
  if (!track || !duration) return;
  track.setPointerCapture(e.pointerId);
  clearTimeout(hideTimer);
  scrubbing = fractionAt(track, e.clientX);
  paintSeek();
  void seekTo(scrubbing * duration, false);
});
panel.addEventListener("pointermove", (e) => {
  const track = (e.target as HTMLElement).closest<HTMLElement>(".seek-track");
  const duration = position.duration;
  if (scrubbing == null || !track || !duration || !track.hasPointerCapture(e.pointerId)) return;
  scrubbing = fractionAt(track, e.clientX);
  paintSeek();
  void seekTo(scrubbing * duration, false);
});
const endScrub = (e: PointerEvent) => {
  const track = (e.target as HTMLElement).closest<HTMLElement>(".seek-track");
  const duration = position.duration;
  if (scrubbing == null) return;
  const fraction = track && e.type === "pointerup" ? fractionAt(track, e.clientX) : scrubbing;
  scrubbing = null;
  if (duration) {
    position = { time: fraction * duration, duration };
    void seekTo(position.time, true);
  }
  if (renderPending) render();
  else paintSeek();
  scheduleHide();
};
panel.addEventListener("pointerup", endScrub);
panel.addEventListener("pointercancel", endScrub);

// Taps inside the panel must not reach the document's show/hide toggle below.
panel.addEventListener("pointerup", (e) => e.stopPropagation());
panel.addEventListener("click", async (e) => {
  scheduleHide();
  const target = (e.target as HTMLElement).closest("button");
  if (!target) return;
  const { action, id, option, value } = target.dataset;
  try {
    if (option) {
      const parsed = value === "true" ? true : value === "false" ? false : value;
      update(await player.setOptions({ [option]: parsed } as Partial<Options>));
    } else if (action === "play" && id) update(await player.play(id));
    else if (action === "remove" && id) update(await player.remove(id));
    else if (action === "pick") update(await player.pick());
    else if (action === "pause") update(await player.pause());
    else if (action === "resume") update(await player.resume());
    else if (action === "next") update(await player.next());
    else if (action === "stop") update(await player.stop());
  } catch (err) {
    update({ ...state, error: String(err) });
  }
});

// Any tap on the video toggles the panel. pointerup rather than click: WebKit on
// iOS does not dispatch click for taps on non-interactive elements like <body>.
document.addEventListener("pointerup", () => (panel.hidden ? show() : hide()));
// Re-read the library when returning to the app (files may have been added in Files/Finder).
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "visible") update(await player.state());
});
player.onChange(update);

update(state);
