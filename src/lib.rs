pub mod chains;
pub mod evm;
pub mod market;
pub mod pump;
pub mod rpc;
pub mod solana;
pub mod solana_codec;
pub mod solana_engine;
pub mod storage;
pub mod transport;
pub mod wallet;

pub type Result<T> = std::result::Result<T, String>;
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
