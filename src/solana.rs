use crate::{now_ms, rpc::Rpc, transport::Transport, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;

pub const TOKEN: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
pub const ATA: &str = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
pub const KAMINO: &str = "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD";
pub const MARKET: &str = "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF";
pub const PUMP: &str = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
pub const GENESIS: &str = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
pub type Pubkey = [u8; 32];
pub fn key(s: &str) -> Result<Pubkey> {
    bs58::decode(s)
        .into_vec()
        .map_err(|_| "Invalid Solana public key.")?
        .try_into()
        .map_err(|_| "Solana public keys must have 32 bytes.".into())
}
pub fn pubkey(k: &Pubkey) -> String {
    bs58::encode(k).into_string()
}
pub fn pda(seeds: &[&[u8]], program: &Pubkey) -> Result<Pubkey> {
    use sha2::{Digest, Sha256};
    if seeds.len() > 15 || seeds.iter().any(|s| s.len() > 32) {
        return Err("Invalid PDA seeds.".into());
    }
    for bump in (0..=255u8).rev() {
        let mut h = Sha256::new();
        for seed in seeds {
            h.update(seed)
        }
        h.update([bump]);
        h.update(program);
        h.update(b"ProgramDerivedAddress");
        let out: Pubkey = h.finalize().into();
        if curve25519_dalek::edwards::CompressedEdwardsY(out)
            .decompress()
            .is_none()
        {
            return Ok(out);
        }
    }
    Err("Could not derive a program address.".into())
}
pub fn associated(owner: &Pubkey, mint: &Pubkey) -> Result<Pubkey> {
    pda(&[owner, &key(TOKEN)?, mint], &key(ATA)?)
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Config {
    pub rpc: String,
    pub proxy: String,
    pub amount: String,
    pub min_profit: String,
    pub gas_budget: String,
    pub slippage_bps: u64,
    pub priority_fee: u64,
    pub lookup_tables: Vec<String>,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            rpc: "https://api.mainnet-beta.solana.com".into(),
            proxy: String::new(),
            amount: "1".into(),
            min_profit: "0.0001".into(),
            gas_budget: "0.001".into(),
            slippage_bps: 10,
            priority_fee: 25000,
            lookup_tables: vec![],
        }
    }
}
impl Config {
    pub fn validate(&self) -> Result<()> {
        crate::transport::rpc_url(&self.rpc)?;
        crate::transport::parse_proxy(&self.proxy)?;
        for s in [&self.amount, &self.min_profit, &self.gas_budget] {
            let n = crate::rpc::units(s, 9)?;
            if n > primitive_types::U256::from(u64::MAX) {
                return Err("Solana amount exceeds u64 capacity.".into());
            }
        }
        if crate::rpc::units(&self.amount, 9)?.is_zero()
            || crate::rpc::units(&self.gas_budget, 9)? > crate::rpc::units("1", 9)?
            || self.slippage_bps == 0
            || self.slippage_bps > 200
            || self.priority_fee > 1000000
            || self.lookup_tables.len() > 6
        {
            return Err("Invalid Solana loan, slippage or network fee limits.".into());
        }
        for t in &self.lookup_tables {
            key(t)?;
        }
        Ok(())
    }
}
pub async fn rpc(c: &Config, t: Arc<Transport>) -> Result<Rpc> {
    c.validate()?;
    let rpc = Rpc::new(t, &c.rpc, &c.proxy)?;
    if rpc.send("getGenesisHash", json!([])).await? != GENESIS {
        return Err("RPC is not Solana mainnet.".into());
    }
    let slot = rpc
        .send("getSlot", json!([{"commitment":"confirmed"}]))
        .await?
        .as_u64()
        .ok_or("Invalid Solana slot.")?;
    let at = rpc
        .send("getBlockTime", json!([slot]))
        .await?
        .as_u64()
        .ok_or("Solana block time is unavailable.")?;
    if (now_ms() / 1000).abs_diff(at) > 60 {
        return Err("Solana RPC is stale.".into());
    }
    Ok(rpc)
}
pub async fn check(c: &Config, owner: Option<&str>, t: Arc<Transport>) -> Result<Value> {
    let r = rpc(c, t).await?;
    let slot = r
        .send("getSlot", json!([{"commitment":"confirmed"}]))
        .await?;
    let balance = if let Some(owner) = owner {
        key(owner)?;
        let b = r
            .send("getBalance", json!([owner,{"commitment":"confirmed"}]))
            .await?;
        crate::rpc::decimal(
            primitive_types::U256::from(b["value"].as_u64().ok_or("Invalid wallet balance.")?),
            9,
        )
    } else {
        String::new()
    };
    Ok(json!({"slot":slot,"balance":balance}))
}
pub async fn account(r: &Rpc, address: &Pubkey) -> Result<(Pubkey, Vec<u8>)> {
    let a = r
        .send(
            "getAccountInfo",
            json!([pubkey(address),{"encoding":"base64","commitment":"confirmed"}]),
        )
        .await?;
    let value = a
        .get("value")
        .filter(|v| !v.is_null())
        .ok_or("Solana account is unavailable.")?;
    let owner = key(value["owner"].as_str().ok_or("Invalid account owner.")?)?;
    let data = B64
        .decode(value["data"][0].as_str().ok_or("Invalid account data.")?)
        .map_err(|_| "Invalid Solana account encoding.")?;
    Ok((owner, data))
}
pub fn read_u64(data: &[u8], offset: usize) -> Result<u64> {
    Ok(u64::from_le_bytes(
        data.get(offset..offset + 8)
            .ok_or("Truncated program account.")?
            .try_into()
            .unwrap(),
    ))
}
pub fn read_key(data: &[u8], offset: usize) -> Result<Pubkey> {
    data.get(offset..offset + 32)
        .ok_or("Truncated account public key.")?
        .try_into()
        .map_err(|_| "Invalid public key size.".into())
}
#[derive(Clone, Debug)]
pub struct Meta {
    pub key: Pubkey,
    pub signer: bool,
    pub writable: bool,
}
#[derive(Clone, Debug)]
pub struct Instruction {
    pub program: Pubkey,
    pub accounts: Vec<Meta>,
    pub data: Vec<u8>,
}
pub fn meta(key: Pubkey, writable: bool) -> Meta {
    Meta {
        key,
        signer: false,
        writable,
    }
}
pub fn discriminator(name: &str) -> [u8; 8] {
    use sha2::{Digest, Sha256};
    Sha256::digest(format!("global:{name}").as_bytes())[..8]
        .try_into()
        .unwrap()
}
pub fn short(out: &mut Vec<u8>, mut n: usize) {
    loop {
        let mut b = (n & 0x7f) as u8;
        n >>= 7;
        if n > 0 {
            b |= 0x80;
        }
        out.push(b);
        if n == 0 {
            break;
        }
    }
}
pub fn take_short(data: &[u8], cursor: &mut usize) -> Result<usize> {
    let mut n = 0;
    for shift in [0, 7, 14] {
        let b = *data.get(*cursor).ok_or("Truncated Solana transaction.")?;
        *cursor += 1;
        n |= ((b & 127) as usize) << shift;
        if b & 128 == 0 {
            return Ok(n);
        }
    }
    Err("Invalid Solana compact length.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pda_and_compact_lengths_are_stable() {
        let owner = key("HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk").unwrap();
        let ata = associated(&owner, &key(crate::chains::WSOL).unwrap()).unwrap();
        assert!(curve25519_dalek::edwards::CompressedEdwardsY(ata)
            .decompress()
            .is_none());
        for n in [0, 127, 128, 1232, 65535] {
            let mut b = Vec::new();
            short(&mut b, n);
            assert_eq!(take_short(&b, &mut 0).unwrap(), n);
        }
    }
}
