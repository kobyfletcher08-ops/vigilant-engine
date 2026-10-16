//! Standard SPL / WSOL PumpSwap adapter, ported from the protocol's published IDL.
use crate::{rpc::Rpc, solana::*, Result};
use primitive_types::U256;
const FEE: &str = "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ";
const BONDING: &str = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
#[derive(Clone)]
pub struct Pool {
    pub address: Pubkey,
    pub base: Pubkey,
    pub base_vault: Pubkey,
    pub quote_vault: Pubkey,
    pub coin_creator: Pubkey,
    pub cashback: bool,
    pub protocol: Pubkey,
    pub buyback: Pubkey,
    pub base_reserve: u64,
    pub real_quote: u64,
    pub effective_quote: U256,
    pub fees: [u64; 3],
}
fn account_discriminator(data: &[u8], expected: &[u8; 8]) -> Result<()> {
    if data.get(..8) != Some(expected) {
        return Err("Unexpected PumpSwap account layout.".into());
    }
    Ok(())
}
fn u128_at(data: &[u8], offset: usize) -> Result<u128> {
    Ok(u128::from_le_bytes(
        data.get(offset..offset + 16)
            .ok_or("Truncated fee configuration.")?
            .try_into()
            .unwrap(),
    ))
}
fn fees(data: &[u8], offset: usize) -> Result<[u64; 3]> {
    Ok([
        read_u64(data, offset)?,
        read_u64(data, offset + 8)?,
        read_u64(data, offset + 16)?,
    ])
}
fn first_recipient(data: &[u8], offset: usize, count: usize) -> Result<Pubkey> {
    for i in 0..count {
        let k = read_key(data, offset + 32 * i)?;
        if k != [0; 32] {
            return Ok(k);
        }
    }
    Err("No protocol fee recipient is configured.".into())
}
pub async fn load(r: &Rpc, address: Pubkey, base: Pubkey) -> Result<Pool> {
    let program = key(PUMP)?;
    let fee_program = key(FEE)?;
    let global = pda(&[b"global_config"], &program)?;
    let fee = pda(&[b"fee_config", &program], &fee_program)?;
    let ((pool_owner, pool), (global_owner, g), (fee_owner, f)) =
        tokio::try_join!(account(r, &address), account(r, &global), account(r, &fee))?;
    if pool_owner != program
        || global_owner != program
        || fee_owner != fee_program
        || pool.len() < 270
        || g.len() < 949
    {
        return Err("Unsupported PumpSwap program or account version.".into());
    }
    account_discriminator(&pool, &[241, 154, 109, 4, 17, 177, 109, 188])?;
    account_discriminator(&g, &[149, 8, 156, 202, 160, 252, 176, 217])?;
    account_discriminator(&f, &[143, 52, 146, 187, 219, 123, 76, 155])?;
    let wsol = key(crate::chains::WSOL)?;
    if read_key(&pool, 43)? != base || read_key(&pool, 75)? != wsol {
        return Err("PumpSwap route mints do not match.".into());
    }
    let base_vault = read_key(&pool, 139)?;
    let quote_vault = read_key(&pool, 171)?;
    let ((bo, b), (qo, q), (mo, m)) = tokio::try_join!(
        account(r, &base_vault),
        account(r, &quote_vault),
        account(r, &base)
    )?;
    if bo != key(TOKEN)?
        || qo != key(TOKEN)?
        || mo != key(TOKEN)?
        || read_key(&b, 0)? != base
        || read_key(&q, 0)? != wsol
        || m.len() != 82
        || m[45] != 1
    {
        return Err("PumpSwap requires initialized standard SPL mints and vaults.".into());
    }
    let base_reserve = read_u64(&b, 64)?;
    let real_quote = read_u64(&q, 64)?;
    if base_reserve == 0 || real_quote == 0 {
        return Err("PumpSwap reserves are empty.".into());
    }
    let virtual_quote = i128::from_le_bytes(pool[245..261].try_into().unwrap());
    let effective = (real_quote as i128)
        .checked_add(virtual_quote)
        .filter(|v| *v > 0)
        .ok_or("Invalid virtual quote reserves.")?;
    let effective_quote = U256::from(effective as u128);
    let mayhem = pool[243] != 0;
    let coin_creator = read_key(&pool, 211)?;
    let supply = if mayhem {
        1_000_000_000_000_000
    } else {
        read_u64(&m, 36)?
    };
    let canonical = pda(&[b"pool-authority", &base], &key(BONDING)?)? == read_key(&pool, 11)?;
    let mut selected = fees(&f, 41)?;
    if canonical {
        let count = u32::from_le_bytes(
            f.get(65..69)
                .ok_or("Invalid fee tiers.")?
                .try_into()
                .unwrap(),
        ) as usize;
        if count == 0 || count > 128 || f.len() < 69 + count * 40 {
            return Err("Unsupported PumpSwap fee tiers.".into());
        }
        let cap = U256::from(supply) * effective_quote / U256::from(base_reserve);
        selected = fees(&f, 85)?;
        let mut last = U256::zero();
        for i in 0..count {
            let at = 69 + i * 40;
            let threshold = U256::from(u128_at(&f, at)?);
            if i > 0 && threshold < last {
                return Err("Unsorted PumpSwap fee tiers.".into());
            }
            last = threshold;
            if cap >= threshold {
                selected = fees(&f, at + 16)?;
            }
        }
    }
    if g[940] != 0 && read_u64(&pool, 261)? > 0 {
        selected[2] = read_u64(&pool, 261)?;
    }
    if coin_creator == [0; 32] {
        selected[2] = 0;
    }
    if selected.iter().any(|n| *n > 10000) || selected.iter().sum::<u64>() >= 10000 {
        return Err("PumpSwap fee schedule is outside supported limits.".into());
    }
    let protocol = if mayhem {
        first_recipient(&g, 418, 7)?
    } else {
        first_recipient(&g, 57, 8)?
    };
    let buyback = first_recipient(&g, 643, 8)?;
    Ok(Pool {
        address,
        base,
        base_vault,
        quote_vault,
        coin_creator,
        cashback: pool[244] != 0,
        protocol,
        buyback,
        base_reserve,
        real_quote,
        effective_quote,
        fees: selected,
    })
}
fn ceil_fee(n: U256, bps: u64) -> U256 {
    crate::rpc::ceil(n * U256::from(bps), U256::from(10000))
}
fn as_u64(n: U256) -> Result<u64> {
    if n > U256::from(u64::MAX) {
        return Err("Swap result exceeds SPL amount capacity.".into());
    }
    Ok(n.as_u64())
}
impl Pool {
    pub fn quote(&self, buy: bool, amount: u64) -> Result<u64> {
        let amount = U256::from(amount);
        let base = U256::from(self.base_reserve);
        let out = if buy {
            let mut effective =
                amount * U256::from(10000) / U256::from(10000 + self.fees.iter().sum::<u64>());
            let total = effective
                + self
                    .fees
                    .iter()
                    .map(|b| ceil_fee(effective, *b))
                    .fold(U256::zero(), |a, b| a + b);
            if total > amount {
                effective = effective
                    .checked_sub(total - amount)
                    .ok_or("Quote is too small for fees.")?;
            }
            let input = effective
                .checked_sub(U256::one())
                .ok_or("Quote amount rounds to zero.")?;
            base * input / (self.effective_quote + input)
        } else {
            let raw = self.effective_quote * amount / (base + amount);
            let lp = ceil_fee(raw, self.fees[0]);
            if U256::from(self.real_quote) < raw.saturating_sub(lp) {
                return Err("Insufficient real SOL reserves for the sell.".into());
            }
            raw.checked_sub(
                self.fees
                    .iter()
                    .map(|b| ceil_fee(raw, *b))
                    .fold(U256::zero(), |a, b| a + b),
            )
            .ok_or("Output is too small for fees.")?
        };
        let out = as_u64(out)?;
        if out == 0 {
            return Err("Swap output rounds to zero.".into());
        }
        Ok(out)
    }
    pub fn instruction(
        &self,
        buy: bool,
        amount: u64,
        min_out: u64,
        owner: Pubkey,
    ) -> Result<Instruction> {
        let program = key(PUMP)?;
        let wsol = key(crate::chains::WSOL)?;
        let global = pda(&[b"global_config"], &program)?;
        let event = pda(&[b"__event_authority"], &program)?;
        let creator = pda(&[b"creator_vault", &self.coin_creator], &program)?;
        let user_volume = pda(&[b"user_volume_accumulator", &owner], &program)?;
        let fee_program = key(FEE)?;
        let fee = pda(&[b"fee_config", &program], &fee_program)?;
        let mut accounts = vec![
            meta(self.address, true),
            Meta {
                key: owner,
                signer: true,
                writable: true,
            },
            meta(global, false),
            meta(self.base, false),
            meta(wsol, false),
            meta(associated(&owner, &self.base)?, true),
            meta(associated(&owner, &wsol)?, true),
            meta(self.base_vault, true),
            meta(self.quote_vault, true),
            meta(self.protocol, false),
            meta(associated(&self.protocol, &wsol)?, true),
            meta(key(TOKEN)?, false),
            meta(key(TOKEN)?, false),
            meta([0; 32], false),
            meta(key(ATA)?, false),
            meta(event, false),
            meta(program, false),
            meta(associated(&creator, &wsol)?, true),
            meta(creator, false),
        ];
        if buy {
            accounts.push(meta(pda(&[b"global_volume_accumulator"], &program)?, false));
            accounts.push(meta(user_volume, true));
        }
        accounts.push(meta(fee, false));
        accounts.push(meta(fee_program, false));
        if self.cashback {
            accounts.push(meta(associated(&user_volume, &wsol)?, true));
            if !buy {
                accounts.push(meta(user_volume, true));
            }
        }
        if self.coin_creator != [0; 32] {
            accounts.push(meta(pda(&[b"pool-v2", &self.base], &program)?, false));
        }
        accounts.push(meta(self.buyback, false));
        accounts.push(meta(associated(&self.buyback, &wsol)?, true));
        let mut data = discriminator(if buy { "buy" } else { "sell" }).to_vec();
        data.extend_from_slice(&if buy { min_out } else { amount }.to_le_bytes());
        data.extend_from_slice(&if buy { amount } else { min_out }.to_le_bytes());
        if buy {
            data.push(1);
        }
        Ok(Instruction {
            program,
            accounts,
            data,
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn pool() -> Pool {
        Pool {
            address: [1; 32],
            base: [2; 32],
            base_vault: [3; 32],
            quote_vault: [4; 32],
            coin_creator: [5; 32],
            cashback: false,
            protocol: [6; 32],
            buyback: [7; 32],
            base_reserve: 1_000_000_000,
            real_quote: 10_000_000_000,
            effective_quote: 10_000_000_000u64.into(),
            fees: [20, 5, 5],
        }
    }
    #[test]
    fn integer_quotes_include_fees_and_price_impact() {
        let p = pool();
        let bought = p.quote(true, 100_000_000).unwrap();
        assert!(bought > 9_000_000 && bought < 10_000_000);
        let sold = p.quote(false, bought).unwrap();
        assert!(sold < 100_000_000);
        assert!(p.quote(true, 1).is_err());
        let mut q = p;
        q.effective_quote = U256::from(u64::MAX);
        assert!(q.quote(false, 1_000_000_000).is_err());
    }
    #[test]
    fn pump_idl_discriminators_and_final_floor_match() {
        let p = pool();
        let owner = [9; 32];
        let buy = p.instruction(true, 100, 50, owner).unwrap();
        let sell = p.instruction(false, 50, 110, owner).unwrap();
        assert_eq!(&buy.data[..8], &[102, 6, 61, 18, 1, 218, 235, 234]);
        assert_eq!(&sell.data[..8], &[51, 230, 133, 164, 1, 127, 131, 173]);
        assert_eq!(read_u64(&sell.data, 16).unwrap(), 110);
        assert_eq!(sell.accounts[1].key, owner);
        assert_eq!(
            sell.accounts[6].key,
            associated(&owner, &key(crate::chains::WSOL).unwrap()).unwrap()
        );
    }
}
