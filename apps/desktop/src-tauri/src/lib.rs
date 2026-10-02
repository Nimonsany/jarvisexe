// JARVIS desktop shell. The Rust layer is only the window host + core sidecar
// supervisor; all orchestration lives in JARVIS Core reached via its local API.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::{Child, Command};
use std::sync::{Arc, Mutex};
use tauri::Manager;

/// Core endpoint discovery — owned by the desktop/runtime layer (BLOCKER 1).
/// The sidecar inherits JARVIS_PORT from this process, so the UI must talk to
/// the same port it spawned. React never hardcodes a Core URL.
#[tauri::command]
fn jarvis_core_endpoint() -> Result<String, String> {
    match std::env::var("JARVIS_PORT") {
        Ok(v) => {
            let port: u16 = v
                .trim()
                .parse()
                .map_err(|_| format!("invalid JARVIS_PORT: {v}"))?;
            Ok(format!("http://127.0.0.1:{port}"))
        }
        Err(_) => Ok("http://127.0.0.1:7788".to_string()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let core_child: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(None));

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![jarvis_core_endpoint])
        .setup({
            let core_child = core_child.clone();
            move |app| {
                // M9: updater + process (relaunch after update) plugins.
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())
                    .expect("updater plugin init");
                app.handle()
                    .plugin(tauri_plugin_process::init())
                    .expect("process plugin init");
                // E2E driver bridge (M8): env-gated ONLY — when JARVIS_E2E carries
                // the harness URL, inject it for the in-page driver. Production
                // runs never set the env, so no bridge object ever exists there.
                // Eval repeats for ~30s: an eval that lands before the document
                // loads would be wiped by navigation, so keep re-injecting until
                // the frontend's driver observes the URL.
                if let Ok(url) = std::env::var("JARVIS_E2E") {
                    if !url.is_empty() {
                        if let Ok(json) = serde_json::to_string(&url) {
                            let js = format!("window.__JARVIS_E2E__ = {json}");
                            let handle = app.handle().clone();
                            std::thread::spawn(move || {
                                for _ in 0..75 {
                                    if let Some(win) = handle.get_webview_window("main") {
                                        let _ = win.eval(&js);
                                    }
                                    std::thread::sleep(std::time::Duration::from_millis(400));
                                }
                            });
                        }
                    }
                }
                // spawn the JARVIS core sidecar (launcher script next to the exe;
                // the launcher locates node + the core runtime itself)
                if let Some(exe_dir) = std::env::current_exe().ok().and_then(|p| p.parent().map(|p| p.to_path_buf())) {
                    // M10: on Windows the installed sidecar is `jarvis-core.exe` —
                    // a literal `jarvis-core` (no extension) never exists() and the
                    // spawn was silently skipped (Windows clean-machine E2E evidence).
                    let sidecar = ["jarvis-core.exe", "jarvis-core"]
                        .iter()
                        .map(|n| exe_dir.join(n))
                        .find(|p| p.exists())
                        .unwrap_or_else(|| exe_dir.join("jarvis-core"));
                    if sidecar.exists() {
                        // process_group(0): sidecar leads its OWN group → on app
                        // exit one group kill sweeps core + every task process
                        // it spawned (no orphaned opencode/browser children).
                        #[cfg(unix)]
                        use std::os::unix::process::CommandExt;
                        let mut cmd = Command::new(&sidecar);
                        #[cfg(unix)]
                        let cmd = cmd.process_group(0);
                        match cmd.spawn() {
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
                    // Graceful first: SIGTERM the sidecar's group so the core can
                    // sweep its own ownership registry (opencode/browser/…), then
                    // force-kill the group for anything left.
                    if let Some(mut child) = core_child.lock().unwrap().take() {
                        let pid = child.id() as i32;
                        #[cfg(unix)]
                        unsafe {
                            libc::kill(-pid, libc::SIGTERM);
                        }
                        std::thread::sleep(std::time::Duration::from_millis(1200));
                        #[cfg(unix)]
                        unsafe {
                            libc::kill(-pid, libc::SIGKILL);
                        }
                        let _ = child.kill();
                        eprintln!("[jarvis] core sidecar stopped (group {})", pid);
                    }
                }
            }
        });
}
