// JARVIS desktop binary entry — the Rust layer is only the window host;
// all orchestration lives in JARVIS Core (sidecar) reached via its local API.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    jarvis_desktop_lib::run();
}
