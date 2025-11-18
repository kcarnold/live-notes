// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

#[cfg(target_os = "macos")]
mod macos_speech;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn start_native_speech() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        macos_speech::start_recognition()
    }

    #[cfg(not(target_os = "macos"))]
    {
        Err("Native speech recognition is only available on macOS".to_string())
    }
}

#[tauri::command]
fn stop_native_speech() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        macos_speech::stop_recognition()
    }

    #[cfg(not(target_os = "macos"))]
    {
        Err("Native speech recognition is only available on macOS".to_string())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            start_native_speech,
            stop_native_speech
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
