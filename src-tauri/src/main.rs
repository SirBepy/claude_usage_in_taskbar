#![windows_subsystem = "windows"]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--mcp-permission") {
        claude_usage_tauri_lib::mcp::server::run_stdio();
        return;
    }
    claude_usage_tauri_lib::run();
}
