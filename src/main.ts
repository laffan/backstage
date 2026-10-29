import { createPlayer, type Options, type PlayerState, type Video } from "./player";

const IDLE_HIDE_MS = 6000;

const panel = document.getElementById("panel") as HTMLDivElement;
const player = await createPlayer();
let state: PlayerState = await player.state();
let hideTimer: number | undefined;

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const formatSize = (bytes: number | null) => {
  if (bytes == null) return "";
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
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
}

function update(next: PlayerState) {
  state = next;
  render();
  // Without a video there is nothing to show behind the panel, so keep it up.
  if (!state.currentId || state.error) show();
  else scheduleHide();
}

function show() {
  panel.hidden = false;
  scheduleHide();
}

function hide() {
  if (!state.currentId || state.error) return;
  panel.hidden = true;
  clearTimeout(hideTimer);
}

function scheduleHide() {
  clearTimeout(hideTimer);
  if (state.currentId && state.playing && !state.error) {
    hideTimer = window.setTimeout(hide, IDLE_HIDE_MS);
  }
}

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
