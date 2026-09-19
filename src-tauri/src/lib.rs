#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // ref chip click → 系统默认浏览器打开 URL（spec/requirements/ref-chip-external-open.md）。
        // shell 插件提供 open() 给前端；capability 已加 shell:allow-open（限定 https / http / mailto）。
        .plugin(tauri_plugin_shell::init())
        .run(tauri::generate_context!())
        .expect("error while running MonoDesk");
}
