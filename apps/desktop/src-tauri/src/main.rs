// JARVIS desktop shell. The Rust layer is only the window host;
// all orchestration lives in JARVIS Core (Node) reached via its local API.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    jarvis_desktop_lib::run();
}
