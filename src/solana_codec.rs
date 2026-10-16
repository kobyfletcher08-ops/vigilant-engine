//! Bounded Solana v0 message encoding. No JavaScript SDK is involved in signing.
use crate::{rpc::Rpc, solana::*, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde_json::json;
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug)]
pub struct Table {
    pub address: Pubkey,
    pub keys: Vec<Pubkey>,
}

pub async fn tables(r: &Rpc, addresses: &[Pubkey]) -> Result<Vec<Table>> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    if addresses.len() > 10 {
        return Err("Too many address lookup tables.".into());
    }
    for address in addresses {
        if !seen.insert(*address) {
            continue;
        }
        let (owner, data) = account(r, address).await?;
        if owner != key("AddressLookupTab1e1111111111111111111111111")?
            || data.len() < 56
            || (data.len() - 56) % 32 != 0
            || data.len() > 56 + 256 * 32
            || data[..4] != [1, 0, 0, 0]
            || read_u64(&data, 4)? != u64::MAX
        {
            return Err("An address lookup table is invalid or inactive.".into());
        }
        out.push(Table {
            address: *address,
            keys: data[56..]
                .chunks_exact(32)
                .map(|k| k.try_into().unwrap())
                .collect(),
        });
    }
    Ok(out)
}

pub fn compile(
    owner: Pubkey,
    blockhash: Pubkey,
    instructions: &[Instruction],
    tables: &[Table],
) -> Result<Vec<u8>> {
    if instructions.is_empty() || instructions.len() > 32 {
        return Err("Invalid instruction count.".into());
    }
    let programs: HashSet<_> = instructions.iter().map(|i| i.program).collect();
    let mut order = vec![Meta {
        key: owner,
        signer: true,
        writable: true,
    }];
    let mut positions = HashMap::from([(owner, 0)]);
    for ix in instructions {
        for m in ix
            .accounts
            .iter()
            .cloned()
            .chain(std::iter::once(meta(ix.program, false)))
        {
            if m.signer && m.key != owner {
                return Err("An unexpected Solana signer was requested.".into());
            }
            if let Some(i) = positions.get(&m.key).copied() {
                order[i].signer |= m.signer;
                order[i].writable |= m.writable;
            } else {
                positions.insert(m.key, order.len());
                order.push(m);
            }
        }
    }
    if order.len() > 256 {
        return Err("Solana account count exceeds 256.".into());
    }
    let mut extracted = HashSet::new();
    let mut lookups = Vec::new();
    let mut loaded_w = Vec::new();
    let mut loaded_r = Vec::new();
    for t in tables {
        let mut w = Vec::new();
        let mut ro = Vec::new();
        for m in &order {
            if m.signer || programs.contains(&m.key) || extracted.contains(&m.key) {
                continue;
            }
            if let Some(index) = t.keys.iter().position(|k| *k == m.key) {
                if index > 255 {
                    return Err("Invalid lookup table index.".into());
                }
                extracted.insert(m.key);
                if m.writable {
                    w.push(index as u8);
                    loaded_w.push(m.key);
                } else {
                    ro.push(index as u8);
                    loaded_r.push(m.key);
                }
            }
        }
        if !w.is_empty() || !ro.is_empty() {
            lookups.push((t.address, w, ro));
        }
    }
    let mut fixed: Vec<_> = order
        .into_iter()
        .filter(|m| !extracted.contains(&m.key))
        .collect();
    fixed.sort_by_key(|m| {
        if m.key == owner {
            0
        } else if m.writable {
            1
        } else {
            2
        }
    });
    let readonly = fixed.iter().filter(|m| !m.writable).count();
    let keys: Vec<_> = fixed
        .iter()
        .map(|m| m.key)
        .chain(loaded_w)
        .chain(loaded_r)
        .collect();
    let index: HashMap<_, _> = keys
        .iter()
        .enumerate()
        .map(|(i, k)| (*k, i as u8))
        .collect();
    let mut out = vec![0x80, 1, 0, readonly as u8];
    short(&mut out, fixed.len());
    for m in fixed {
        out.extend_from_slice(&m.key);
    }
    out.extend_from_slice(&blockhash);
    short(&mut out, instructions.len());
    for ix in instructions {
        out.push(index[&ix.program]);
        short(&mut out, ix.accounts.len());
        for m in &ix.accounts {
            out.push(index[&m.key]);
        }
        short(&mut out, ix.data.len());
        out.extend_from_slice(&ix.data);
    }
    short(&mut out, lookups.len());
    for (address, w, r) in lookups {
        out.extend_from_slice(&address);
        short(&mut out, w.len());
        out.extend(w);
        short(&mut out, r.len());
        out.extend(r);
    }
    if out.len() + 65 > 1232 {
        return Err(
            "Atomic transaction exceeds Solana's 1232-byte limit. Add route lookup tables.".into(),
        );
    }
    Ok(out)
}

fn take<'a>(data: &'a [u8], at: &mut usize, n: usize) -> Result<&'a [u8]> {
    let end = at.checked_add(n).ok_or("Invalid transaction length.")?;
    let b = data.get(*at..end).ok_or("Truncated Solana message.")?;
    *at = end;
    Ok(b)
}
struct Compiled {
    program: usize,
    accounts: Vec<u8>,
    data: Vec<u8>,
}
pub async fn decompile_transaction(
    r: &Rpc,
    encoded: &str,
    owner: Pubkey,
) -> Result<(Vec<Instruction>, Vec<Table>)> {
    if encoded.len() > 2000 {
        return Err("Route transaction exceeds the size limit.".into());
    }
    let raw = B64
        .decode(encoded)
        .map_err(|_| "Invalid route transaction encoding.")?;
    let mut at = 0;
    if take_short(&raw, &mut at)? != 1 {
        return Err("Route requests additional signers.".into());
    }
    take(&raw, &mut at, 64)?;
    let version = take(&raw, &mut at, 1)?[0];
    if version != 0x80 {
        return Err("Only version-0 route messages are supported.".into());
    }
    let header = take(&raw, &mut at, 3)?;
    if header[0] != 1 || header[1] != 0 {
        return Err("Invalid route signer header.".into());
    }
    let count = take_short(&raw, &mut at)?;
    if count == 0 || count > 256 || header[2] as usize >= count {
        return Err("Invalid static account count.".into());
    }
    let mut keys = Vec::with_capacity(count);
    for _ in 0..count {
        keys.push(take(&raw, &mut at, 32)?.try_into().unwrap());
    }
    if keys[0] != owner {
        return Err("Route fee payer does not match the local wallet.".into());
    }
    take(&raw, &mut at, 32)?;
    let n = take_short(&raw, &mut at)?;
    if n > 32 {
        return Err("Too many route instructions.".into());
    }
    let mut instructions = Vec::new();
    for _ in 0..n {
        let program = take(&raw, &mut at, 1)?[0] as usize;
        let count = take_short(&raw, &mut at)?;
        let accounts = take(&raw, &mut at, count)?.to_vec();
        let size = take_short(&raw, &mut at)?;
        let data = take(&raw, &mut at, size)?.to_vec();
        instructions.push(Compiled {
            program,
            accounts,
            data,
        });
    }
    let n = take_short(&raw, &mut at)?;
    if n > 10 {
        return Err("Too many route lookup tables.".into());
    }
    let mut lookups = Vec::new();
    for _ in 0..n {
        let address = take(&raw, &mut at, 32)?.try_into().unwrap();
        let nw = take_short(&raw, &mut at)?;
        let w = take(&raw, &mut at, nw)?.to_vec();
        let nr = take_short(&raw, &mut at)?;
        let ro = take(&raw, &mut at, nr)?.to_vec();
        lookups.push((address, w, ro));
    }
    if at != raw.len() {
        return Err("Trailing route transaction data.".into());
    }
    let tables = tables(r, &lookups.iter().map(|t| t.0).collect::<Vec<_>>()).await?;
    let mut writable_loaded = 0;
    for writable in [true, false] {
        for (address, w, ro) in &lookups {
            let t = tables
                .iter()
                .find(|t| t.address == *address)
                .ok_or("Missing lookup table.")?;
            for i in if writable { w } else { ro } {
                keys.push(
                    *t.keys
                        .get(*i as usize)
                        .ok_or("Lookup table index is unavailable.")?,
                );
                if writable {
                    writable_loaded += 1;
                }
            }
        }
    }
    if keys.len() > 256 || keys.iter().collect::<HashSet<_>>().len() != keys.len() {
        return Err("Duplicate or excessive route accounts.".into());
    }
    let get = |index: usize| -> Result<Pubkey> {
        keys.get(index)
            .copied()
            .ok_or("Invalid compiled account index.".into())
    };
    let mut decoded = Vec::new();
    for i in instructions {
        let mut accounts = Vec::new();
        for index in i.accounts {
            let index = index as usize;
            accounts.push(Meta {
                key: get(index)?,
                signer: index == 0,
                writable: if index < count {
                    index < count - header[2] as usize
                } else {
                    index < count + writable_loaded
                },
            });
        }
        decoded.push(Instruction {
            program: get(i.program)?,
            accounts,
            data: i.data,
        });
    }
    Ok((decoded, tables))
}

pub fn transaction(message: &[u8], signature: &[u8; 64]) -> Result<Vec<u8>> {
    let mut raw = vec![1];
    raw.extend_from_slice(signature);
    raw.extend_from_slice(message);
    if raw.len() > 1232 {
        return Err("Signed transaction exceeds the Solana packet limit.".into());
    }
    Ok(raw)
}
pub async fn simulate(r: &Rpc, message: &[u8], signature: Option<&[u8; 64]>) -> Result<u64> {
    let raw = transaction(message, signature.unwrap_or(&[0; 64]))?;
    let result=r.send("simulateTransaction",json!([B64.encode(raw),{"encoding":"base64","sigVerify":signature.is_some(),"commitment":"confirmed"}])).await?;
    if !result["value"]["err"].is_null() {
        return Err("Atomic transaction simulation failed. No transaction was submitted.".into());
    }
    if result.get("value").is_none() {
        return Err("Missing simulation result.".into());
    }
    Ok(result["value"]["unitsConsumed"].as_u64().unwrap_or(0))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_message_bounds_and_signer_are_enforced() {
        let owner = [1; 32];
        let ix = Instruction {
            program: [2; 32],
            accounts: vec![
                Meta {
                    key: owner,
                    signer: true,
                    writable: true,
                },
                meta([3; 32], true),
            ],
            data: vec![9, 8, 7],
        };
        let m = compile(owner, [4; 32], &[ix.clone()], &[]).unwrap();
        assert_eq!(&m[..4], &[0x80, 1, 0, 1]);
        assert_eq!(&m[5..37], &owner);
        assert!(transaction(&m, &[0; 64]).unwrap().len() < 1232);
        let mut bad = ix.clone();
        bad.accounts[1].signer = true;
        assert!(compile(owner, [4; 32], &[bad], &[]).is_err());
        let mut big = ix;
        big.data = vec![0; 1200];
        assert!(compile(owner, [4; 32], &[big], &[]).is_err());
    }
    #[test]
    fn lookup_table_reduces_message_size() {
        let owner = [1; 32];
        let ix = Instruction {
            program: [2; 32],
            accounts: (3..30).map(|v| meta([v; 32], v % 2 == 0)).collect(),
            data: vec![1],
        };
        let t = Table {
            address: [100; 32],
            keys: (3..30).map(|v| [v; 32]).collect(),
        };
        let no = compile(owner, [4; 32], &[ix.clone()], &[]).unwrap();
        let yes = compile(owner, [4; 32], &[ix], &[t]).unwrap();
        assert!(yes.len() + 700 < no.len());
    }
}
