//! Native, explicitly reviewed atomic Solana flash-loan execution.
use crate::{
    now_ms, pump,
    rpc::Rpc,
    solana::*,
    solana_codec::{self, Table},
    transport::Transport,
    Result,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use ed25519_dalek::Signer;
use primitive_types::U256;
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    sync::{Arc, OnceLock},
    time::Duration,
};
const COMPUTE: &str = "ComputeBudget111111111111111111111111111111";
const SYSVAR: &str = "Sysvar1nstructions1111111111111111111111111";
const RAY: [&str; 5] = [
    "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
    "5quBtoiQqxF9Jv6KYKctB59NT3gtJD2Y65kdnB1Uev3h",
    "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
    "routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS",
    "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
];
#[cfg(test)]
const QUOTE_OWNER: &str = "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk";
#[derive(Clone, Debug)]
pub struct Loan {
    pub address: Pubkey,
    pub supply: Pubkey,
    pub fee_vault: Pubkey,
    pub fee_sf: u64,
    pub available: u64,
}
fn amount(s: &str) -> Result<u64> {
    let n = crate::rpc::units(s, 9)?;
    if n > u64::MAX.into() {
        return Err("Amount exceeds SPL capacity.".into());
    }
    Ok(n.as_u64())
}
fn decimal(n: u64) -> String {
    crate::rpc::decimal(n.into(), 9)
}
fn add(values: &[u64]) -> Result<u64> {
    values.iter().try_fold(0u64, |a, b| {
        a.checked_add(*b).ok_or("Solana amount overflow.".into())
    })
}
fn mul_floor(n: u64, numerator: u64, denominator: u64) -> u64 {
    ((n as u128 * numerator as u128) / denominator as u128) as u64
}
pub fn loan_fee(borrow: u64, sf: u64) -> Result<u64> {
    if sf == u64::MAX {
        return Err("Flash loans are disabled.".into());
    }
    let n = crate::rpc::ceil(U256::from(borrow) * U256::from(sf), U256::one() << 60);
    if n > u64::MAX.into() {
        return Err("Flash fee exceeds SPL capacity.".into());
    }
    Ok(n.as_u64())
}
fn decode_loan(address: Pubkey, d: &[u8]) -> Result<Loan> {
    use sha2::{Digest, Sha256};
    let disc = Sha256::digest(b"account:Reserve");
    if d.get(..8) != Some(&disc[..8])
        || read_key(d, 32)? != key(MARKET)?
        || read_key(d, 128)? != key(crate::chains::WSOL)?
        || read_key(d, 408)? != key(TOKEN)?
        || *d.get(4856).ok_or("Reserve layout changed.")? != 0
        || *d.get(4864).ok_or("Missing reserve state.")? != 0
    {
        return Err("Unsupported or inactive SOL reserve.".into());
    }
    let loan = Loan {
        address,
        supply: read_key(d, 160)?,
        fee_vault: read_key(d, 192)?,
        available: read_u64(d, 224)?,
        fee_sf: read_u64(d, 4904)?,
    };
    loan_fee(1, loan.fee_sf)?;
    Ok(loan)
}
pub async fn lender(r: &Rpc, t: &Transport, proxy: &str, borrow: u64) -> Result<Loan> {
    static ADDRESS: OnceLock<Pubkey> = OnceLock::new();
    let address = if let Some(a) = ADDRESS.get() {
        *a
    } else {
        let v=t.json(&format!("https://api.kamino.finance/kamino-market/reserves/account-data?markets={MARKET}"),None,proxy).await?;
        let mut found = None;
        for market in v
            .as_array()
            .ok_or("Unexpected reserve discovery response.")?
        {
            for reserve in market["reserves"].as_array().into_iter().flatten() {
                if let (Some(a), Some(d)) = (reserve["pubkey"].as_str(), reserve["data"].as_str()) {
                    if let (Ok(a), Ok(d)) = (key(a), B64.decode(d)) {
                        if decode_loan(a, &d).is_ok() {
                            found = Some(a);
                            break;
                        }
                    }
                }
            }
        }
        let a = found.ok_or("SOL flash-loan reserve could not be discovered.")?;
        let _ = ADDRESS.set(a);
        a
    };
    let (owner, data) = account(r, &address).await?;
    if owner != key(KAMINO)? {
        return Err("Unexpected flash-loan program owner.".into());
    }
    let mut loan = decode_loan(address, &data)?;
    let (owner, vault) = account(r, &loan.supply).await?;
    if owner != key(TOKEN)? || read_key(&vault, 0)? != key(crate::chains::WSOL)? {
        return Err("Unexpected flash-loan vault mint or owner.".into());
    }
    loan.available = loan.available.min(read_u64(&vault, 64)?);
    if borrow == 0 || borrow > loan.available {
        return Err("Loan exceeds available SOL flash liquidity.".into());
    }
    Ok(loan)
}
pub fn flash(
    owner: Pubkey,
    loan: &Loan,
    borrow: u64,
    index: usize,
) -> Result<(Instruction, Instruction)> {
    if index > 255 || borrow == 0 || borrow > loan.available {
        return Err("Invalid flash-loan size or position.".into());
    }
    loan_fee(borrow, loan.fee_sf)?;
    let program = key(KAMINO)?;
    let market = key(MARKET)?;
    let wsol = key(crate::chains::WSOL)?;
    let accounts = vec![
        Meta {
            key: owner,
            signer: true,
            writable: false,
        },
        meta(pda(&[b"lma", &market], &program)?, false),
        meta(market, false),
        meta(loan.address, true),
        meta(wsol, false),
        meta(loan.supply, true),
        meta(associated(&owner, &wsol)?, true),
        meta(loan.fee_vault, true),
        meta(program, false),
        meta(program, false),
        meta(key(SYSVAR)?, false),
        meta(key(TOKEN)?, false),
    ];
    let mut b = discriminator("flash_borrow_reserve_liquidity").to_vec();
    b.extend_from_slice(&borrow.to_le_bytes());
    let mut p = discriminator("flash_repay_reserve_liquidity").to_vec();
    p.extend_from_slice(&borrow.to_le_bytes());
    p.push(index as u8);
    Ok((
        Instruction {
            program,
            accounts: accounts.clone(),
            data: b,
        },
        Instruction {
            program,
            accounts,
            data: p,
        },
    ))
}
#[derive(Clone)]
enum Venue {
    Ray,
    Pump(Box<pump::Pool>),
}
impl Venue {
    fn name(&self) -> &str {
        match self {
            Self::Ray => "Raydium",
            Self::Pump(_) => "PumpSwap",
        }
    }
    fn id(&self) -> String {
        match self {
            Self::Ray => "raydium".into(),
            Self::Pump(p) => pubkey(&p.address),
        }
    }
}
#[derive(Clone)]
struct Quote {
    output: u64,
    pool: Pubkey,
    response: Value,
}
async fn quote(
    venue: &Venue,
    buy: bool,
    input: u64,
    token: Pubkey,
    c: &Config,
    t: &Transport,
) -> Result<Quote> {
    if input == 0 {
        return Err("Swap input rounds to zero.".into());
    }
    match venue {
        Venue::Pump(p) => Ok(Quote {
            output: p.quote(buy, input)?,
            pool: p.address,
            response: Value::Null,
        }),
        Venue::Ray => {
            let wsol = crate::chains::WSOL;
            let mint = pubkey(&token);
            let (from, to) = if buy { (wsol, &*mint) } else { (&*mint, wsol) };
            let url=format!("https://transaction-v1.raydium.io/compute/swap-base-in?inputMint={from}&outputMint={to}&amount={input}&slippageBps=0&txVersion=V0");
            let q = t.json(&url, None, &c.proxy).await?;
            if q["success"] != true
                || q["data"]["inputMint"] != from
                || q["data"]["outputMint"] != to
                || q["data"]["inputAmount"]
                    .as_str()
                    .and_then(|v| v.parse::<u64>().ok())
                    != Some(input)
                || q["data"]["routePlan"].as_array().map(Vec::len) != Some(1)
            {
                return Err("No supported direct Raydium quote at this size.".into());
            }
            let output = q["data"]["outputAmount"]
                .as_str()
                .and_then(|v| v.parse::<u64>().ok())
                .filter(|n| *n > 0)
                .ok_or("Invalid Raydium output.")?;
            let pool = key(q["data"]["routePlan"][0]["poolId"]
                .as_str()
                .ok_or("Missing Raydium pool.")?)?;
            Ok(Quote {
                output,
                pool,
                response: q,
            })
        }
    }
}
/// Validate amount, wallet and both associated accounts before accepting an API-built swap.
fn verify_swap(
    ix: &Instruction,
    owner: Pubkey,
    input_mint: Pubkey,
    output_mint: Pubkey,
    amount: u64,
    minimum: u64,
    pool: Pubkey,
) -> Result<()> {
    let pid = pubkey(&ix.program);
    let a = &ix.accounts;
    let d = &ix.data;
    let matches = |at: usize, k: Pubkey| a.get(at).is_some_and(|m| m.key == k);
    let input = associated(&owner, &input_mint)?;
    let output = associated(&owner, &output_mint)?;
    let (in_offset, out_offset, valid) = if pid == PUMP {
        if output_mint == key(crate::chains::WSOL)? {
            (
                8,
                16,
                d.len() == 24
                    && d[..8] == discriminator("sell")
                    && matches(1, owner)
                    && matches(5, input)
                    && matches(6, output)
                    && matches(0, pool)
                    && matches(4, output_mint),
            )
        } else {
            (
                16,
                8,
                d.len() == 25
                    && d[..8] == discriminator("buy")
                    && matches(1, owner)
                    && matches(6, input)
                    && matches(5, output)
                    && matches(0, pool)
                    && matches(3, output_mint),
            )
        }
    } else if pid == RAY[3] {
        (
            1,
            9,
            d.len() >= 17
                && (d.len() - 17).is_multiple_of(16)
                && d[0] == 0
                && matches(4, owner)
                && matches(5, input)
                && matches(6, output),
        )
    } else if pid == RAY[0] || pid == RAY[1] {
        (
            1,
            9,
            d.len() == 17
                && (d[0] == 9 || pid == RAY[0] && d[0] == 16)
                && a.len() >= 3
                && matches(a.len() - 1, owner)
                && matches(a.len() - 3, input)
                && matches(a.len() - 2, output),
        )
    } else if pid == RAY[2] {
        (
            8,
            16,
            d.len() == 41
                && (d[..8] == discriminator("swap") || d[..8] == discriminator("swap_v2"))
                && d[40] == 1
                && matches(0, owner)
                && matches(3, input)
                && matches(4, output),
        )
    } else if pid == RAY[4] {
        (
            8,
            16,
            d.len() == 24
                && d[..8] == discriminator("swap_base_input")
                && matches(0, owner)
                && matches(4, input)
                && matches(5, output),
        )
    } else {
        return Err("Unsupported swap program.".into());
    };
    if !valid
        || read_u64(d, in_offset)? != amount
        || read_u64(d, out_offset)? < minimum
        || !a.iter().any(|m| m.key == pool)
        || a.iter().any(|m| m.signer && m.key != owner)
    {
        return Err("Swap amount, profit floor, pool or wallet binding is invalid.".into());
    }
    Ok(())
}
#[derive(Clone, Copy)]
struct SwapBuild<'a> {
    owner: Pubkey,
    token: Pubkey,
    c: &'a Config,
    r: &'a Rpc,
    t: &'a Transport,
}
async fn build(
    venue: &Venue,
    buy: bool,
    input: u64,
    minimum: u64,
    q: &Quote,
    ctx: &SwapBuild<'_>,
) -> Result<(Instruction, Vec<Table>)> {
    let SwapBuild {
        owner,
        token,
        c,
        r,
        t,
    } = *ctx;
    let wsol = key(crate::chains::WSOL)?;
    let (from, to) = if buy { (wsol, token) } else { (token, wsol) };
    let (ix, tables) = match venue {
        Venue::Pump(p) => (p.instruction(buy, input, minimum, owner)?, vec![]),
        Venue::Ray => {
            let mut response = q.response.clone();
            response["data"]["otherAmountThreshold"] = json!(minimum.to_string());
            let body = json!({"wallet":pubkey(&owner),"swapResponse":response,"txVersion":"V0","computeUnitPriceMicroLamports":"0","wrapSol":false,"unwrapSol":false,"inputAccount":pubkey(&associated(&owner,&from)?),"outputAccount":pubkey(&associated(&owner,&to)?)});
            let built = t
                .json(
                    "https://transaction-v1.raydium.io/transaction/swap-base-in",
                    Some(&body),
                    &c.proxy,
                )
                .await?;
            if built["success"] != true || built["data"].as_array().map(Vec::len) != Some(1) {
                return Err("Raydium did not build one atomic route.".into());
            }
            let (instructions, tables) = solana_codec::decompile_transaction(
                r,
                built["data"][0]["transaction"]
                    .as_str()
                    .ok_or("Missing Raydium transaction.")?,
                owner,
            )
            .await?;
            let mut swaps = Vec::new();
            for ix in instructions {
                let p = pubkey(&ix.program);
                if RAY.contains(&p.as_str()) {
                    swaps.push(ix);
                } else if p == ATA {
                    // Setup is rebuilt locally. Accept only this wallet's exact SPL ATA.
                    if ix.accounts.len() != 6
                        || ix.accounts[0].key != owner
                        || ix.accounts[2].key != owner
                        || ![from, to].contains(&ix.accounts[3].key)
                        || ix.accounts[1].key != associated(&owner, &ix.accounts[3].key)?
                        || ix.accounts[4].key != [0; 32]
                        || ix.accounts[5].key != key(TOKEN)?
                        || !(ix.data.is_empty() || ix.data == [1])
                    {
                        return Err("Route builder requested unexpected account setup.".into());
                    }
                } else if p != COMPUTE {
                    return Err("Route builder included an unexpected program.".into());
                }
            }
            if swaps.len() != 1 {
                return Err("Only a single direct swap is supported per leg.".into());
            }
            (swaps.remove(0), tables)
        }
    };
    verify_swap(&ix, owner, from, to, input, minimum, q.pool)?;
    Ok((ix, tables))
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Route {
    pub id: String,
    pub token: String,
    pub symbol: String,
    pub buy: String,
    pub sell: String,
    pub buy_pool: String,
    pub sell_pool: String,
    pub amount: String,
    pub min_asset_out: String,
    pub output: String,
    pub repayment: String,
    pub fee: String,
    pub net: String,
    pub profitable: bool,
    pub slot: u64,
    pub at: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub routes: Vec<Route>,
    pub notes: Vec<String>,
    pub slot: u64,
    pub at: u64,
    pub loan_available: String,
}
struct Detail {
    route: Route,
    buy: Venue,
    sell: Venue,
    bq: Quote,
    sq: Quote,
    output: u64,
    asset: u64,
}
struct Loaded {
    r: Rpc,
    loan: Loan,
    report: Report,
    details: Vec<Detail>,
    token: Pubkey,
}
async fn load(
    c: &Config,
    token: &str,
    symbol: &str,
    t: Arc<Transport>,
    market_proxy: &str,
) -> Result<Loaded> {
    let at = now_ms();
    let r = rpc(c, t.clone()).await?;
    let token = key(token)?;
    if token == key(crate::chains::WSOL)? {
        return Err("Choose an intermediate token rather than WSOL.".into());
    }
    let borrow = amount(&c.amount)?;
    let loan = lender(&r, &t, &c.proxy, borrow).await?;
    let (owner, mint) = account(&r, &token).await?;
    if owner != key(TOKEN)? || mint.len() != 82 || mint[45] != 1 {
        return Err("Execution currently supports initialized standard SPL tokens. Other pools remain trackable.".into());
    }
    let slot = r
        .send("getSlot", json!([{"commitment":"confirmed"}]))
        .await?
        .as_u64()
        .ok_or("Invalid Solana slot.")?;
    let pairs = t
        .market_json(
            &format!("/token-pairs/v1/solana/{}", pubkey(&token)),
            Duration::from_secs(5),
            false,
            market_proxy,
        )
        .await?;
    let pairs: Vec<_> = pairs
        .as_array()
        .ok_or("Unexpected token-pair response.")?
        .iter()
        .filter(|p| {
            p["baseToken"]["address"] == pubkey(&token)
                && p["quoteToken"]["address"] == crate::chains::WSOL
                && p["liquidity"]["usd"].as_f64().unwrap_or(0.0) >= 1000.0
        })
        .collect();
    let mut venues = Vec::new();
    let mut notes = Vec::new();
    if pairs.iter().any(|p| p["dexId"] == "raydium") {
        venues.push(Venue::Ray);
    }
    for p in pairs.iter().filter(|p| p["dexId"] == "pumpswap").take(2) {
        if let Some(s) = p["pairAddress"].as_str() {
            if let Ok(address) = key(s) {
                match pump::load(&r, address, token).await {
                    Ok(p) => venues.push(Venue::Pump(Box::new(p))),
                    Err(_) => notes
                        .push("A PumpSwap pool could not be verified for native execution.".into()),
                }
            }
        }
    }
    let mut details = Vec::new();
    let slip = 10000 - c.slippage_bps;
    for buy in &venues {
        let bq = match quote(buy, true, borrow, token, c, &t).await {
            Ok(q) => q,
            Err(_) => {
                notes.push(format!(
                    "{}: buy quote unavailable at this size.",
                    buy.name()
                ));
                continue;
            }
        };
        let asset = mul_floor(bq.output, slip, 10000);
        if asset == 0 {
            continue;
        }
        for sell in &venues {
            if buy.id() == sell.id() {
                continue;
            }
            let sq = match quote(sell, false, asset, token, c, &t).await {
                Ok(q) => q,
                Err(_) => {
                    notes.push(format!(
                        "{}: sell quote unavailable at this size.",
                        sell.name()
                    ));
                    continue;
                }
            };
            if bq.pool == sq.pool {
                continue;
            }
            let output = mul_floor(sq.output, slip, 10000);
            let fee = loan_fee(borrow, loan.fee_sf)?;
            let repayment = add(&[borrow, fee])?;
            let costs = add(&[repayment, amount(&c.gas_budget)?])?;
            let route = Route {
                id: format!("{}|{}", pubkey(&bq.pool), pubkey(&sq.pool)),
                token: pubkey(&token),
                symbol: symbol
                    .chars()
                    .filter(|c| c.is_ascii_alphanumeric() || "_.-".contains(*c))
                    .take(16)
                    .collect(),
                buy: buy.name().into(),
                sell: sell.name().into(),
                buy_pool: pubkey(&bq.pool),
                sell_pool: pubkey(&sq.pool),
                amount: c.amount.clone(),
                min_asset_out: asset.to_string(),
                output: decimal(output),
                repayment: decimal(repayment),
                fee: decimal(fee),
                net: crate::rpc::difference(output.into(), costs.into(), 9),
                profitable: output >= add(&[costs, amount(&c.min_profit)?])?,
                slot,
                at,
            };
            details.push(Detail {
                route,
                buy: buy.clone(),
                sell: sell.clone(),
                bq: bq.clone(),
                sq,
                asset,
                output,
            });
        }
    }
    if now_ms() - at > 45000 {
        return Err("Quotes took over 45 seconds. Choose a faster RPC and retry.".into());
    }
    details.sort_by_key(|d| std::cmp::Reverse(d.output));
    notes.sort();
    notes.dedup();
    notes.push("Direct standard-SPL Raydium / PumpSwap routes only, using different pools. Quotes include Kamino fees, slippage and your network budget. Preparation also covers new token-account rent.".into());
    if venues.len() < 2 {
        notes.push("At least two supported pools are required for an atomic round trip.".into());
    }
    let report = Report {
        routes: details.iter().map(|d| d.route.clone()).collect(),
        notes,
        slot,
        at,
        loan_available: decimal(loan.available),
    };
    Ok(Loaded {
        r,
        loan,
        report,
        details,
        token,
    })
}
pub async fn quotes(
    c: &Config,
    token: &str,
    symbol: &str,
    t: Arc<Transport>,
    market_proxy: &str,
) -> Result<Report> {
    Ok(load(c, token, symbol, t, market_proxy).await?.report)
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub id: String,
    pub owner: String,
    pub expires: u64,
    pub route: Route,
    pub fee: String,
    pub rent: String,
    pub minimum_net: String,
    pub last_valid_block_height: u64,
    pub units: u64,
    #[serde(skip)]
    pub message: Vec<u8>,
    #[serde(skip)]
    pub config: Config,
    #[serde(skip)]
    pub loan: Loan,
    #[serde(skip)]
    pub instructions: Vec<Instruction>,
    #[serde(skip)]
    pub minimum: u64,
    #[serde(skip)]
    pub cash: u64,
}
fn create_ata(owner: Pubkey, mint: Pubkey) -> Result<Instruction> {
    Ok(Instruction {
        program: key(ATA)?,
        accounts: vec![
            Meta {
                key: owner,
                signer: true,
                writable: true,
            },
            meta(associated(&owner, &mint)?, true),
            meta(owner, false),
            meta(mint, false),
            meta([0; 32], false),
            meta(key(TOKEN)?, false),
        ],
        data: vec![1],
    })
}
async fn token_accounts(r: &Rpc, owner: Pubkey, mints: &[Pubkey]) -> Result<Vec<bool>> {
    let addresses: Vec<_> = mints
        .iter()
        .map(|m| associated(&owner, m).map(|a| pubkey(&a)))
        .collect::<Result<_>>()?;
    let v = r
        .send(
            "getMultipleAccounts",
            json!([addresses,{"encoding":"base64","commitment":"confirmed"}]),
        )
        .await?;
    let rows = v["value"]
        .as_array()
        .filter(|v| v.len() == mints.len())
        .ok_or("Invalid token-account lookup.")?;
    let mut exists = Vec::new();
    for (mint, v) in mints.iter().zip(rows) {
        if v.is_null() {
            exists.push(false);
            continue;
        }
        let d = B64
            .decode(v["data"][0].as_str().ok_or("Missing token account data.")?)
            .map_err(|_| "Invalid token account encoding.")?;
        if v["owner"] != TOKEN
            || read_key(&d, 0)? != *mint
            || read_key(&d, 32)? != owner
            || *d.get(108).ok_or("Truncated token account.")? != 1
        {
            return Err("Unexpected or frozen wallet token account.".into());
        }
        exists.push(true);
    }
    Ok(exists)
}
fn verify_plan(p: &Preview) -> Result<()> {
    let owner = key(&p.owner)?;
    let borrow = amount(&p.config.amount)?;
    let wsol = key(crate::chains::WSOL)?;
    let token = key(&p.route.token)?;
    let loan_indices: Vec<_> = p
        .instructions
        .iter()
        .enumerate()
        .filter(|(_, i)| pubkey(&i.program) == KAMINO)
        .collect();
    if loan_indices.len() != 2 {
        return Err("Exactly one flash borrow and repayment are required.".into());
    }
    let (bi, b) = loan_indices[0];
    let (ri, r) = loan_indices[1];
    let (expected_b, expected_r) = flash(owner, &p.loan, borrow, bi)?;
    if ri != bi + 3
        || b.data != expected_b.data
        || r.data != expected_r.data
        || b.accounts.iter().map(|m| m.key).collect::<Vec<_>>()
            != expected_b
                .accounts
                .iter()
                .map(|m| m.key)
                .collect::<Vec<_>>()
        || r.accounts.iter().map(|m| m.key).collect::<Vec<_>>()
            != expected_r
                .accounts
                .iter()
                .map(|m| m.key)
                .collect::<Vec<_>>()
    {
        return Err("Flash-loan instructions or accounts changed.".into());
    }
    let asset = p
        .route
        .min_asset_out
        .parse::<u64>()
        .map_err(|_| "Invalid intermediate amount.")?;
    verify_swap(
        &p.instructions[bi + 1],
        owner,
        wsol,
        token,
        borrow,
        asset,
        key(&p.route.buy_pool)?,
    )?;
    verify_swap(
        &p.instructions[bi + 2],
        owner,
        token,
        wsol,
        asset,
        p.minimum,
        key(&p.route.sell_pool)?,
    )?;
    if p.route.buy_pool == p.route.sell_pool {
        return Err("Flash trade cannot reuse a pool.".into());
    }
    for (i, ix) in p.instructions.iter().enumerate() {
        if (bi..=ri).contains(&i) {
            continue;
        }
        let pid = pubkey(&ix.program);
        if pid == COMPUTE {
            if i > 1
                || !(ix.data.first() == Some(&2) && ix.data.len() == 5
                    || ix.data.first() == Some(&3) && ix.data.len() == 9)
            {
                return Err("Unexpected compute-budget instruction.".into());
            }
        } else if pid == ATA {
            if i >= bi
                || ix.data != [1]
                || ix.accounts.len() != 6
                || ix.accounts[0].key != owner
                || ix.accounts[2].key != owner
                || ix.accounts[5].key != key(TOKEN)?
                || ix.accounts[1].key != associated(&owner, &ix.accounts[3].key)?
                || ![wsol, token].contains(&ix.accounts[3].key)
            {
                return Err("Unexpected associated-account setup.".into());
            }
        } else if pid == TOKEN {
            if i != p.instructions.len() - 1
                || i <= ri
                || ix.data != [9]
                || ix.accounts.len() != 3
                || ix.accounts[0].key != associated(&owner, &wsol)?
                || ix.accounts[1].key != owner
                || ix.accounts[2].key != owner
            {
                return Err("Unexpected token transfer or authority instruction.".into());
            }
        } else {
            return Err("Unexpected transaction program.".into());
        }
    }
    Ok(())
}
pub async fn prepare(
    c: &Config,
    token: &str,
    symbol: &str,
    route_id: &str,
    owner: &str,
    t: Arc<Transport>,
    market_proxy: &str,
) -> Result<Preview> {
    let wallet = key(owner)?;
    if curve25519_dalek::edwards::CompressedEdwardsY(wallet)
        .decompress()
        .is_none()
    {
        return Err("Wallet must be an Ed25519 signing account.".into());
    }
    let l = load(c, token, symbol, t.clone(), market_proxy).await?;
    let d = l
        .details
        .iter()
        .find(|d| d.route.id == route_id && d.route.profitable)
        .ok_or("Refreshed route is below the configured profit floor.")?;
    let wsol = key(crate::chains::WSOL)?;
    let exists = token_accounts(&l.r, wallet, &[wsol, l.token]).await?;
    let rent_one =
        l.r.send("getMinimumBalanceForRentExemption", json!([165]))
            .await?
            .as_u64()
            .ok_or("Invalid account rent quote.")?;
    let rent = if exists[1] { 0 } else { rent_one };
    let cash = rent_one
        .checked_mul(exists.iter().filter(|v| !**v).count() as u64)
        .ok_or("Rent amount overflow.")?;
    let borrow = amount(&c.amount)?;
    let minimum = add(&[
        borrow,
        loan_fee(borrow, l.loan.fee_sf)?,
        amount(&c.gas_budget)?,
        amount(&c.min_profit)?,
        rent,
    ])?;
    if d.output < minimum {
        return Err("Refreshed quote cannot cover account rent and minimum profit.".into());
    }
    let ctx = SwapBuild {
        owner: wallet,
        token: l.token,
        c,
        r: &l.r,
        t: &t,
    };
    let ((buy, bt), (sell, st)) = tokio::try_join!(
        build(&d.buy, true, borrow, d.asset, &d.bq, &ctx),
        build(&d.sell, false, d.asset, minimum, &d.sq, &ctx)
    )?;
    let mut limit = vec![2];
    limit.extend_from_slice(&1_000_000u32.to_le_bytes());
    let mut priority = vec![3];
    priority.extend_from_slice(&c.priority_fee.to_le_bytes());
    let mut instructions = vec![
        Instruction {
            program: key(COMPUTE)?,
            accounts: vec![],
            data: limit,
        },
        Instruction {
            program: key(COMPUTE)?,
            accounts: vec![],
            data: priority,
        },
    ];
    for (mint, exists) in [wsol, l.token].into_iter().zip(&exists) {
        if !exists {
            instructions.push(create_ata(wallet, mint)?);
        }
    }
    let (b, p) = flash(wallet, &l.loan, borrow, instructions.len())?;
    instructions.extend([b, buy, sell, p]);
    if !exists[0] {
        instructions.push(Instruction {
            program: key(TOKEN)?,
            accounts: vec![
                meta(associated(&wallet, &wsol)?, true),
                meta(wallet, true),
                Meta {
                    key: wallet,
                    signer: true,
                    writable: false,
                },
            ],
            data: vec![9],
        });
    }
    let configured = solana_codec::tables(
        &l.r,
        &c.lookup_tables
            .iter()
            .map(|s| key(s))
            .collect::<Result<Vec<_>>>()?,
    )
    .await?;
    let mut seen = HashSet::new();
    let tables: Vec<_> = configured
        .into_iter()
        .chain(bt)
        .chain(st)
        .filter(|t| seen.insert(t.address))
        .collect();
    let latest =
        l.r.send("getLatestBlockhash", json!([{"commitment":"confirmed"}]))
            .await?;
    let hash = key(latest["value"]["blockhash"]
        .as_str()
        .ok_or("Missing blockhash.")?)?;
    let last_valid_block_height = latest["value"]["lastValidBlockHeight"]
        .as_u64()
        .ok_or("Missing block lifetime.")?;
    let message = solana_codec::compile(wallet, hash, &instructions, &tables)?;
    let fee =
        l.r.send(
            "getFeeForMessage",
            json!([B64.encode(&message),{"commitment":"confirmed"}]),
        )
        .await?["value"]
            .as_u64()
            .filter(|f| *f <= amount(&c.gas_budget).unwrap_or(0))
            .ok_or("Network fee exceeds the configured budget.")?;
    let balance =
        l.r.send("getBalance", json!([owner,{"commitment":"confirmed"}]))
            .await?["value"]
            .as_u64()
            .ok_or("Missing native SOL balance.")?;
    if balance < add(&[fee, cash])? {
        return Err("Wallet needs native SOL for network fees and new token-account rent.".into());
    }
    let mut random = [0u8; 16];
    use rand::RngCore;
    rand::thread_rng().fill_bytes(&mut random);
    let mut preview = Preview {
        id: hex::encode(random),
        owner: owner.into(),
        expires: now_ms() + 30000,
        route: d.route.clone(),
        fee: decimal(fee),
        rent: decimal(rent),
        minimum_net: c.min_profit.clone(),
        last_valid_block_height,
        units: 0,
        message,
        config: c.clone(),
        loan: l.loan.clone(),
        instructions,
        minimum,
        cash,
    };
    verify_plan(&preview)?;
    preview.units = solana_codec::simulate(&l.r, &preview.message, None).await?;
    Ok(preview)
}
pub async fn preflight(p: &Preview, t: Arc<Transport>) -> Result<Rpc> {
    if now_ms() > p.expires {
        return Err("Review expired. Prepare a fresh transaction.".into());
    }
    verify_plan(p)?;
    let r = rpc(&p.config, t.clone()).await?;
    let height = r
        .send("getBlockHeight", json!([{"commitment":"confirmed"}]))
        .await?
        .as_u64()
        .ok_or("Invalid block height.")?;
    if height > p.last_valid_block_height {
        return Err("Transaction blockhash expired.".into());
    }
    let loan = lender(&r, &t, &p.config.proxy, amount(&p.config.amount)?).await?;
    if loan.address != p.loan.address
        || loan.supply != p.loan.supply
        || loan.fee_vault != p.loan.fee_vault
        || loan.fee_sf != p.loan.fee_sf
    {
        return Err("Lender state changed. Prepare again.".into());
    }
    let fee = r
        .send(
            "getFeeForMessage",
            json!([B64.encode(&p.message),{"commitment":"confirmed"}]),
        )
        .await?["value"]
        .as_u64()
        .filter(|f| *f <= amount(&p.config.gas_budget).unwrap_or(0))
        .ok_or("Network fee exceeds the configured budget.")?;
    let balance = r
        .send("getBalance", json!([p.owner,{"commitment":"confirmed"}]))
        .await?["value"]
        .as_u64()
        .ok_or("Missing wallet balance.")?;
    if balance < add(&[fee, p.cash])? {
        return Err("Insufficient native SOL for fees and rent.".into());
    }
    Ok(r)
}
pub fn sign(p: &Preview, seed: &[u8; 32]) -> Result<(Vec<u8>, String, [u8; 64])> {
    if now_ms() > p.expires {
        return Err("Review expired before signing.".into());
    }
    verify_plan(p)?;
    let signing = ed25519_dalek::SigningKey::from_bytes(seed);
    if pubkey(signing.verifying_key().as_bytes()) != p.owner {
        return Err("Signing wallet changed.".into());
    }
    let signature = signing.sign(&p.message).to_bytes();
    Ok((
        solana_codec::transaction(&p.message, &signature)?,
        bs58::encode(signature).into_string(),
        signature,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn flash_fee_rounds_up_and_disabled_loans_fail() {
        assert_eq!(loan_fee(1000, 1 << 59).unwrap(), 500);
        assert_eq!(loan_fee(1, 1).unwrap(), 1);
        assert_eq!(loan_fee(1000, 0).unwrap(), 0);
        assert!(loan_fee(1, u64::MAX).is_err());
    }
    #[test]
    fn flash_instructions_bind_wallet_and_borrow_index() {
        let l = Loan {
            address: [1; 32],
            supply: [2; 32],
            fee_vault: [3; 32],
            fee_sf: 1,
            available: 2000,
        };
        let (b, r) = flash(key(QUOTE_OWNER).unwrap(), &l, 1000, 4).unwrap();
        assert_eq!(&b.data[..8], &[135, 231, 52, 167, 7, 52, 212, 193]);
        assert_eq!(&r.data[..8], &[185, 117, 0, 203, 96, 245, 180, 186]);
        assert_eq!(r.data[16], 4);
        assert_eq!(b.accounts.len(), 12);
        assert!(flash([4; 32], &l, 2001, 4).is_err());
        assert!(flash([4; 32], &l, 1000, 256).is_err());
    }
    #[test]
    fn swap_floor_cannot_be_removed_or_redirected() {
        let owner = key(QUOTE_OWNER).unwrap();
        let token = [2; 32];
        let wsol = key(crate::chains::WSOL).unwrap();
        let mut accounts = vec![meta([0; 32], false); 6];
        accounts[0] = Meta {
            key: owner,
            signer: true,
            writable: true,
        };
        accounts[1] = meta([3; 32], true);
        accounts[4] = meta(associated(&owner, &token).unwrap(), true);
        accounts[5] = meta(associated(&owner, &wsol).unwrap(), true);
        let mut data = discriminator("swap_base_input").to_vec();
        data.extend(100u64.to_le_bytes());
        data.extend(110u64.to_le_bytes());
        let mut ix = Instruction {
            program: key(RAY[4]).unwrap(),
            accounts,
            data,
        };
        assert!(verify_swap(&ix, owner, token, wsol, 100, 110, [3; 32]).is_ok());
        assert!(verify_swap(&ix, owner, token, wsol, 100, 111, [3; 32]).is_err());
        ix.accounts[5].key = [9; 32];
        assert!(verify_swap(&ix, owner, token, wsol, 100, 110, [3; 32]).is_err());
    }
}
