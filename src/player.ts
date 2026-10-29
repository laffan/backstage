import { addPluginListener, invoke } from "@tauri-apps/api/core";

export type RepeatMode = "one" | "all";
export type Gravity = "fill" | "fit" | "stretch";

export interface Options {
  muted: boolean;
  repeatMode: RepeatMode;
  gravity: Gravity;
  keepAwake: boolean;
}

export interface Video {
  id: string;
  name: string;
  /** picked: opened in place from Files; documents: in the app's own folder; session: desktop preview only */
  source: "picked" | "documents" | "session";
  size: number | null;
  available: boolean;
}

export interface PlayerState {
  native: boolean;
  currentId: string | null;
  playing: boolean;
  options: Options;
  library: Video[];
  error: string | null;
}

export interface Player {
  state(): Promise<PlayerState>;
  pick(): Promise<PlayerState>;
  play(id: string): Promise<PlayerState>;
  next(): Promise<PlayerState>;
  pause(): Promise<PlayerState>;
  resume(): Promise<PlayerState>;
  stop(): Promise<PlayerState>;
  remove(id: string): Promise<PlayerState>;
  setOptions(patch: Partial<Options>): Promise<PlayerState>;
  /** State changes the UI did not ask for (end of a video, playback errors). */
  onChange(cb: (state: PlayerState) => void): void;
}

export async function createPlayer(): Promise<Player> {
  const probe = await invoke<{ native: boolean }>("plugin:player|get_state").catch(() => ({
    native: false,
  }));
  return probe.native ? nativePlayer() : webPlayer();
}

/** iPadOS: everything happens in the Swift plugin; the video is a native layer behind this page. */
function nativePlayer(): Player {
  const call = (cmd: string, args?: Record<string, unknown>) =>
    invoke<PlayerState>(`plugin:player|${cmd}`, args);
  return {
    state: () => call("get_state"),
    pick: () => call("pick_videos"),
    play: (id) => call("play", { id }),
    next: () => call("next"),
    pause: () => call("pause"),
    resume: () => call("resume"),
    stop: () => call("stop"),
    remove: (id) => call("remove", { id }),
    setOptions: (patch) => call("set_options", { ...patch }),
    onChange: (cb) => void addPluginListener<PlayerState>("player", "state", cb),
  };
}

/**
 * Desktop / browser preview: an HTML <video> fed from blob URLs of picked
 * files (read from disk on demand, never loaded into memory). Nothing is
 * persisted; it exists so the UI can be worked on without an iPad.
 */
function webPlayer(): Player {
  const video = document.createElement("video");
  video.className = "fallback-video";
  video.muted = true;
  video.playsInline = true;
  document.body.prepend(video);

  const urls = new Map<string, string>();
  const st: PlayerState = {
    native: false,
    currentId: null,
    playing: false,
    options: { muted: true, repeatMode: "one", gravity: "fill", keepAwake: true },
    library: [],
    error: null,
  };
  let listener: (s: PlayerState) => void = () => {};
  const snapshot = () => structuredClone(st);
  const fits: Record<Gravity, string> = { fill: "cover", fit: "contain", stretch: "fill" };

  const apply = () => {
    video.muted = st.options.muted;
    video.loop = st.options.repeatMode === "one";
    video.style.objectFit = fits[st.options.gravity];
  };

  const play = async (id: string) => {
    const url = urls.get(id);
    if (!url) return snapshot();
    st.currentId = id;
    st.error = null;
    video.src = url;
    st.playing = true;
    await video.play().catch(() => {});
    return snapshot();
  };

  const next = async () => {
    const ids = st.library.map((v) => v.id);
    if (!ids.length) return snapshot();
    const i = st.currentId ? ids.indexOf(st.currentId) : -1;
    return play(ids[(i + 1) % ids.length]);
  };

  video.addEventListener("ended", () => {
    if (st.options.repeatMode === "all") void next().then(listener);
  });
  video.addEventListener("error", () => {
    st.error = "This file can't be played by the webview's video decoder.";
    st.playing = false;
    listener(snapshot());
  });
  apply();

  return {
    state: async () => snapshot(),
    pick: () =>
      new Promise((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "video/*";
        input.multiple = true;
        input.addEventListener("change", async () => {
          let first: string | null = null;
          for (const file of input.files ?? []) {
            const id = crypto.randomUUID();
            urls.set(id, URL.createObjectURL(file));
            st.library.push({ id, name: file.name, source: "session", size: file.size, available: true });
            first ??= id;
          }
          resolve(first && !st.currentId ? await play(first) : snapshot());
        });
        input.addEventListener("cancel", () => resolve(snapshot()));
        input.click();
      }),
    play,
    next,
    pause: async () => {
      video.pause();
      st.playing = false;
      return snapshot();
    },
    resume: async () => {
      if (st.currentId) {
        st.playing = true;
        await video.play().catch(() => {});
      }
      return snapshot();
    },
    stop: async () => {
      video.pause();
      video.removeAttribute("src");
      video.load();
      st.currentId = null;
      st.playing = false;
      return snapshot();
    },
    remove: async (id) => {
      if (id === st.currentId) {
        video.pause();
        video.removeAttribute("src");
        st.currentId = null;
        st.playing = false;
      }
      const url = urls.get(id);
      if (url) URL.revokeObjectURL(url);
      urls.delete(id);
      st.library = st.library.filter((v) => v.id !== id);
      return snapshot();
    },
    setOptions: async (patch) => {
      Object.assign(st.options, patch);
      apply();
      return snapshot();
    },
    onChange: (cb) => {
      listener = cb;
    },
  };
}
