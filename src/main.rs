#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]
#[cfg(windows)]
mod desktop;
fn main() {
    #[cfg(windows)]
    desktop::run();
    #[cfg(not(windows))]
    eprintln!("The desktop targets Windows. Run cargo test or cargo run --release --bin vigilant-bench for the native engine.");
}
