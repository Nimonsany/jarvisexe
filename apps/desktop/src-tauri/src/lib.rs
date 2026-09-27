// JARVIS desktop shell. The Rust layer is only the window host + core sidecar
// supervisor; all orchestration lives in JARVIS Core reached via its local API.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::{Child, Command};
use std::sync::{Arc, Mutex};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let core_child: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(None));

    tauri::Builder::default()
        .setup({
            let core_child = core_child.clone();
            move |_app| {
                // spawn the JARVIS core sidecar (launcher script next to the exe;
                // the launcher locates node + the core runtime itself)
                if let Some(exe_dir) = std::env::current_exe().ok().and_then(|p| p.parent().map(|p| p.to_path_buf())) {
                    let sidecar = exe_dir.join("jarvis-core");
                    if sidecar.exists() {
                        match Command::new(&sidecar).spawn() {
                            Ok(child) => {
                                eprintln!("[jarvis] core sidecar spawned (pid {})", child.id());
                                *core_child.lock().unwrap() = Some(child);
                            }
                            Err(e) => eprintln!("[jarvis] sidecar spawn failed: {}", e),
                        }
                    } else {
                        eprintln!("[jarvis] sidecar not found at {:?} — core must run separately", sidecar);
                    }
                }
                Ok(())
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building JARVIS")
        .run({
            let core_child = core_child.clone();
            move |_app, event| {
                if let tauri::RunEvent::ExitRequested { .. } = event {
                    // stop the core sidecar when the app exits
                    if let Some(mut child) = core_child.lock().unwrap().take() {
                        let _ = child.kill();
                        eprintln!("[jarvis] core sidecar stopped");
                    }
                }
            }
        });
}
