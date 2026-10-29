//! Native video layer for Backstage.
//!
//! On iOS the player is an `AVPlayerLayer` placed behind the (transparent)
//! webview, so decoding is done by the hardware decoder and file I/O never
//! passes through the webview or an IPC/custom-protocol bridge. All commands
//! are implemented in Swift (`ios/Sources/PlayerPlugin.swift`).
//!
//! Desktop builds only answer `get_state` with `native: false`, which tells the
//! frontend to fall back to an HTML `<video>` element for UI development.

use tauri::{
  Runtime,
  plugin::{Builder, TauriPlugin},
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_player);

#[cfg(desktop)]
#[derive(serde::Serialize)]
struct DesktopState {
  native: bool,
}

#[cfg(desktop)]
#[tauri::command]
fn get_state() -> DesktopState {
  DesktopState { native: false }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
  let builder = Builder::new("player");

  #[cfg(desktop)]
  let builder = builder.invoke_handler(tauri::generate_handler![get_state]);

  builder
    .setup(|_app, _api| {
      #[cfg(target_os = "ios")]
      _api.register_ios_plugin(init_plugin_player)?;
      Ok(())
    })
    .build()
}
