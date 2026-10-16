#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]
#[cfg(all(windows, feature = "desktop"))]
mod desktop;
fn main() {
    #[cfg(all(windows, feature = "desktop"))]
    desktop::run();
    #[cfg(not(all(windows, feature = "desktop")))]
    eprintln!("The desktop targets Windows. Run cargo test or cargo run --release --bin vigilant-bench for the native engine.");
}
