use crate::{
    transport::{rpc_url, Transport},
    Result,
};
use futures::{stream, StreamExt};
use primitive_types::U256;
use serde_json::{json, Value};
use sha3::{Digest, Keccak256};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};

static NEXT_ID: AtomicU64 = AtomicU64::new(1);
#[derive(Clone)]
pub struct Rpc {
    pub transport: Arc<Transport>,
    pub url: String,
    pub proxy: String,
}
impl Rpc {
    pub fn new(transport: Arc<Transport>, url: &str, proxy: &str) -> Result<Self> {
        rpc_url(url)?;
        crate::transport::parse_proxy(proxy)?;
        Ok(Self {
            transport,
            url: url.into(),
            proxy: proxy.into(),
        })
    }
    pub async fn send(&self, method: &str, params: Value) -> Result<Value> {
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let response = self
            .transport
            .json(
                &self.url,
                Some(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params})),
                &self.proxy,
            )
            .await?;
        decode(&response, id)
    }
    pub async fn batch(&self, calls: Vec<(String, Value)>) -> Vec<Result<Value>> {
        if calls.is_empty() {
            return vec![];
        }
        let writable = calls.iter().any(|(m, _)| {
            ![
                "eth_call",
                "eth_chainId",
                "eth_gasPrice",
                "eth_getBlockByNumber",
                "eth_getBalance",
                "eth_getCode",
                "eth_getTransactionCount",
                "eth_getTransactionReceipt",
                "eth_blockNumber",
                "eth_getTransactionByHash",
                "getAccountInfo",
                "getMultipleAccounts",
                "getBalance",
                "getSlot",
                "getBlockHeight",
                "getGenesisHash",
                "getLatestBlockhash",
                "getSignatureStatuses",
                "getTokenAccountBalance",
                "getBlockTime",
                "getMinimumBalanceForRentExemption",
                "getFeeForMessage",
            ]
            .contains(&m.as_str())
        });
        if writable {
            let mut out = Vec::new();
            for (method, params) in calls {
                out.push(self.send(&method, params).await)
            }
            return out;
        }
        let chunks: Vec<_> = calls
            .chunks(16)
            .enumerate()
            .map(|(i, c)| (i, c.to_vec()))
            .collect();
        let mut results=stream::iter(chunks.into_iter().map(|(index,calls)|async move{
            let requests:Vec<_>=calls.iter().map(|(m,p)|json!({"jsonrpc":"2.0","id":NEXT_ID.fetch_add(1,Ordering::Relaxed),"method":m,"params":p})).collect();
            let result=self.transport.json(&self.url,Some(&Value::Array(requests.clone())),&self.proxy).await;
            let ordered=match result{Err(e)=>vec![Err(e);calls.len()],Ok(data)=>{
                if let Some(rows)=data.as_array(){let mut map:HashMap<u64,Vec<&Value>>=HashMap::new();for row in rows{if let Some(id)=row.get("id").and_then(Value::as_u64){map.entry(id).or_default().push(row);}}
                    requests.iter().map(|r|{let id=r["id"].as_u64().unwrap();match map.get(&id){Some(items)if items.len()==1=>decode(items[0],id),_=>Err("RPC returned missing or duplicate response IDs.".into())}}).collect()
                }else{vec![Err("RPC batch response is invalid.".into());calls.len()]}
            }};(index,ordered)
        })).buffer_unordered(4).collect::<Vec<_>>().await;
        results.sort_by_key(|(i, _)| *i);
        results.into_iter().flat_map(|(_, r)| r).collect()
    }
    pub async fn call(
        &self,
        to: &str,
        signature: &str,
        args: &[u8],
        block: Option<u64>,
    ) -> Result<Vec<u8>> {
        let data = calldata(signature, args);
        let block = block.map(|b| format!("0x{b:x}")).unwrap_or("latest".into());
        let value = self
            .send("eth_call", json!([{"to":address(to)?,"data":data},block]))
            .await?;
        decode_hex(value.as_str().ok_or("Invalid contract response.")?)
    }
}
fn decode(data: &Value, id: u64) -> Result<Value> {
    if data.get("id").and_then(Value::as_u64) != Some(id) {
        return Err("RPC response ID does not match the request.".into());
    }
    if let Some(e) = data.get("error") {
        let code = e.get("code").and_then(Value::as_i64).unwrap_or(0);
        return Err(format!(
            "RPC call failed (code {code}). Contract reverts are not retried."
        ));
    }
    data.get("result")
        .cloned()
        .ok_or("RPC result is missing.".into())
}
pub fn keccak(data: &[u8]) -> [u8; 32] {
    Keccak256::digest(data).into()
}
pub fn calldata(signature: &str, args: &[u8]) -> String {
    let mut b = keccak(signature.as_bytes())[..4].to_vec();
    b.extend_from_slice(args);
    format!("0x{}", hex::encode(b))
}
pub fn decode_hex(v: &str) -> Result<Vec<u8>> {
    if !v.starts_with("0x") || v.len() > 8_000_002 {
        return Err("Invalid hexadecimal response.".into());
    }
    hex::decode(&v[2..]).map_err(|_| "Invalid hexadecimal response.".into())
}
pub fn address(s: &str) -> Result<String> {
    if s.len() != 42
        || !s.starts_with("0x")
        || !s[2..].bytes().all(|b| b.is_ascii_hexdigit())
        || s[2..].bytes().all(|b| b == b'0')
    {
        return Err("Invalid or zero EVM address.".into());
    }
    Ok(s.to_ascii_lowercase())
}
pub fn address_word(s: &str) -> Result<Vec<u8>> {
    let mut out = vec![0; 12];
    out.extend_from_slice(&decode_hex(&address(s)?)?);
    Ok(out)
}
pub fn uint_word(n: U256) -> Vec<u8> {
    let mut b = [0; 32];
    n.to_big_endian(&mut b);
    b.to_vec()
}
pub fn word(bytes: &[u8], index: usize) -> Result<U256> {
    let start = index.checked_mul(32).ok_or("Invalid ABI offset.")?;
    Ok(U256::from_big_endian(
        bytes
            .get(start..start + 32)
            .ok_or("Contract returned truncated ABI data.")?,
    ))
}
pub fn word_address(bytes: &[u8], index: usize) -> Result<String> {
    let start = index * 32;
    let b = bytes
        .get(start..start + 32)
        .ok_or("Contract returned a truncated address.")?;
    if b[..12].iter().any(|b| *b != 0) {
        return Err("Invalid ABI address.".into());
    }
    Ok(format!("0x{}", hex::encode(&b[12..])))
}
pub fn hex_uint(v: &Value) -> Result<U256> {
    let s = v.as_str().ok_or("Expected an RPC quantity.")?;
    U256::from_str_radix(
        s.strip_prefix("0x")
            .ok_or("Expected a hexadecimal RPC quantity.")?,
        16,
    )
    .map_err(|_| "Invalid RPC quantity.".into())
}
pub fn quantity(n: U256) -> String {
    format!("0x{n:x}")
}
pub fn units(value: &str, decimals: usize) -> Result<U256> {
    if decimals > 36 || value.len() > 80 {
        return Err("Decimal amount is out of range.".into());
    }
    let parts: Vec<_> = value.split('.').collect();
    if parts.is_empty()
        || parts.len() > 2
        || parts[0].is_empty()
        || parts
            .iter()
            .any(|p| p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit()))
        || parts.get(1).is_some_and(|p| p.len() > decimals)
    {
        return Err(format!("Enter a decimal with up to {decimals} places."));
    }
    let fraction = parts.get(1).copied().unwrap_or("");
    let digits = format!(
        "{}{}{}",
        parts[0],
        fraction,
        "0".repeat(decimals - fraction.len())
    );
    U256::from_dec_str(&digits).map_err(|_| "Amount is too large.".into())
}
pub fn decimal(n: U256, decimals: usize) -> String {
    if decimals == 0 {
        return n.to_string();
    }
    let power = U256::exp10(decimals);
    let whole = n / power;
    let fraction = format!("{:0>width$}", (n % power).to_string(), width = decimals);
    let fraction = fraction.trim_end_matches('0');
    if fraction.is_empty() {
        whole.to_string()
    } else {
        format!("{whole}.{fraction}")
    }
}
pub fn difference(a: U256, b: U256, decimals: usize) -> String {
    if a >= b {
        decimal(a - b, decimals)
    } else {
        format!("-{}", decimal(b - a, decimals))
    }
}
pub fn ceil(a: U256, b: U256) -> U256 {
    a / b
        + if a % b > U256::zero() {
            U256::one()
        } else {
            U256::zero()
        }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_units_keep_large_flash_loans_and_precision() {
        assert_eq!(
            decimal(units("1000.000000001", 18).unwrap(), 18),
            "1000.000000001"
        );
        assert_eq!(units("1.0000000001", 9).is_err(), true);
        assert!(units("-1", 18).is_err());
        assert_eq!(calldata("WETH()", &[]), "0xad5c4648");
    }
    #[test]
    fn abi_address_and_ceil_are_checked() {
        let a = "0x1111111111111111111111111111111111111111";
        assert_eq!(word_address(&address_word(a).unwrap(), 0).unwrap(), a);
        assert!(word(&[], 0).is_err());
        assert_eq!(ceil(U256::from(10), U256::from(3)), U256::from(4));
    }
}
