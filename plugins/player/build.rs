// Every command the webview may call. On iOS these are not handled in Rust:
// Tauri forwards unhandled plugin commands to the Swift plugin
// (snake_case -> lowerCamelCase), after the ACL check these entries generate.
const COMMANDS: &[&str] = &[
  "get_state",
  "pick_videos",
  "play",
  "next",
  "pause",
  "resume",
  "stop",
  "remove",
  "set_options",
  "set_system_overlays",
  "register_listener",
  "remove_listener",
];

fn main() {
  tauri_plugin::Builder::new(COMMANDS).ios_path("ios").build();
}
