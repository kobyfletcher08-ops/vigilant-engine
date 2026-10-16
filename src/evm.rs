use crate::{now_ms, rpc::*, transport::Transport, Result};
use primitive_types::U256;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::{Arc, OnceLock};

pub const DEV: &str = "0x6a3404e7fdee519aaab364e1c27db07aa99ec922";
const ZERO: &str = "0x0000000000000000000000000000000000000000";
#[derive(Clone, Serialize, Deserialize)]
pub struct Asset {
    pub symbol: String,
    pub address: String,
    #[serde(default = "yes")]
    pub enabled: bool,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Dex {
    pub name: String,
    pub address: String,
    #[serde(default = "yes")]
    pub enabled: bool,
}
fn yes() -> bool {
    true
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Config {
    pub network: u64,
    pub rpc: String,
    pub proxy: String,
    pub amount: String,
    pub max_amount: String,
    pub min_profit: String,
    pub gas_budget: String,
    pub max_gas_gwei: String,
    pub min_reserve: String,
    pub reserve_share_bps: u64,
    pub slippage_bps: u64,
    pub contract: String,
    pub tokens: Vec<Asset>,
    pub dexes: Vec<Dex>,
}
pub struct Network {
    pub id: u64,
    pub name: &'static str,
    pub native: &'static str,
    pub router: &'static str,
    pub factory: &'static str,
}
pub fn network(id: u64) -> Result<Network> {
    Ok(match id{56=>Network{id,name:"BNB Chain",native:"BNB",router:"0x10ed43c718714eb63d5aa57b78b54704e256024e",factory:"0xca143ce32fe78f1f7019d7d551a6402fc5350c73"},97=>Network{id,name:"BNB Testnet",native:"BNB",router:"0xd99d1c33f9fc3444f8101754abc46c52416550d1",factory:"0x6725f303b657a9451d8ba641348b6761a6cc7a17"},42161=>Network{id,name:"Arbitrum One",native:"ETH",router:"0x8cfe327cec66d1c090dd72bd0ff11d690c33a2eb",factory:"0x02a84c1b3bbd7401a5f7fa98a384ebc70bb5749e"},_=>return Err("Native EVM execution supports BSC, BSC testnet and Arbitrum One. Other chains support market tracking.".into())})
}
impl Default for Config {
    fn default() -> Self {
        defaults(56)
    }
}
pub fn defaults(id: u64) -> Config {
    let arb = id == 42161;
    let n = network(id).unwrap_or_else(|_| network(56).unwrap());
    let mut c = Config {
        network: n.id,
        rpc: if arb {
            "https://arb1.arbitrum.io/rpc"
        } else if id == 97 {
            "https://data-seed-prebsc-1-s1.bnbchain.org:8545"
        } else {
            "https://bsc-dataseed.bnbchain.org"
        }
        .into(),
        proxy: String::new(),
        amount: if arb { "0.01" } else { "0.1" }.into(),
        max_amount: if arb { "0.1" } else { "1" }.into(),
        min_profit: if arb { "0.00001" } else { "0.001" }.into(),
        gas_budget: if arb { "0.00005" } else { "0.002" }.into(),
        max_gas_gwei: if arb { "1" } else { "5" }.into(),
        min_reserve: if arb { "5" } else { "25" }.into(),
        reserve_share_bps: 100,
        slippage_bps: 30,
        contract: String::new(),
        tokens: vec![],
        dexes: vec![Dex {
            name: "PancakeSwap V2".into(),
            address: n.router.into(),
            enabled: true,
        }],
    };
    let assets = if arb {
        vec![
            ("USDC", "0xaf88d065e77c8cc2239327c5edb3a432268e5831"),
            ("USDT0", "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9"),
            ("ARB", "0x912ce59144191c1204e64559fe8253a0e49e6548"),
        ]
    } else {
        vec![
            ("USDT", "0x55d398326f99059ff775485246999027b3197955"),
            ("USDC", "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d"),
            ("CAKE", "0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82"),
        ]
    };
    if id != 97 {
        c.tokens = assets
            .into_iter()
            .map(|(s, a)| Asset {
                symbol: s.into(),
                address: a.into(),
                enabled: true,
            })
            .collect();
        c.dexes.push(if arb {
            Dex {
                name: "Uniswap V2".into(),
                address: "0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24".into(),
                enabled: true,
            }
        } else {
            Dex {
                name: "Biswap".into(),
                address: "0x3a6d8ca21d1cf76f653a67577fa0d27453350dd8".into(),
                enabled: true,
            }
        });
    }
    c
}
impl Config {
    pub fn validate(&self) -> Result<()> {
        network(self.network)?;
        crate::transport::rpc_url(&self.rpc)?;
        crate::transport::parse_proxy(&self.proxy)?;
        let size = units(&self.amount, 18)?;
        if size.is_zero()
            || size > units(&self.max_amount, 18)?
            || units(&self.max_amount, 18)? > units("1000000000", 18)?
        {
            return Err("Loan size must be positive and within the configured maximum (up to 1,000,000,000 native units).".into());
        }
        for a in [&self.min_profit, &self.gas_budget, &self.min_reserve] {
            units(a, 18)?;
        }
        if units(&self.gas_budget, 18)? > units("1", 18)?
            || units(&self.max_gas_gwei, 9)? > units("1000", 9)?
            || self.slippage_bps == 0
            || self.slippage_bps > 200
            || self.reserve_share_bps == 0
            || self.reserve_share_bps > 500
        {
            return Err("Trade, gas, slippage or reserve-share limits are invalid.".into());
        }
        if self.tokens.len() > 30 || self.dexes.len() > 16 {
            return Err("Use up to 30 tokens and 16 verified V2 routers per network.".into());
        }
        if !self.contract.is_empty() {
            address(&self.contract)?;
        }
        let mut seen = std::collections::HashSet::new();
        for t in &self.tokens {
            if !seen.insert(address(&t.address)?) {
                return Err("Duplicate token address.".into());
            }
        }
        seen.clear();
        for d in &self.dexes {
            if !seen.insert(address(&d.address)?) {
                return Err("Duplicate router address.".into());
            }
        }
        Ok(())
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pool {
    pub token: Asset,
    pub dex: Dex,
    pub address: String,
    pub native_reserve: String,
    pub asset_reserve: String,
    #[serde(skip)]
    native: U256,
    #[serde(skip)]
    asset: U256,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Route {
    pub id: String,
    pub symbol: String,
    pub token: String,
    pub buy_name: String,
    pub sell_name: String,
    pub buy_router: String,
    pub sell_router: String,
    pub buy_pair: String,
    pub sell_pair: String,
    pub loan_pair: String,
    pub amount: String,
    pub min_asset_out: String,
    pub output: String,
    pub net: String,
    pub gross: String,
    pub dev_fee: String,
    pub flash_fee: String,
    pub profitable: bool,
    pub min_profit: String,
    pub min_native_out: String,
    #[serde(skip)]
    sort: (bool, U256),
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub at: u64,
    pub block: u64,
    pub timestamp: u64,
    pub chain_id: u64,
    pub wrapped: String,
    pub gas_gwei: String,
    pub gas_allowed: bool,
    pub pools: Vec<Pool>,
    pub routes: Vec<Route>,
    pub notes: Vec<String>,
}
struct Connection {
    rpc: Rpc,
    block: u64,
    timestamp: u64,
    wrapped: String,
    gas: U256,
}
fn required(rows: Vec<Result<Value>>) -> Result<Vec<Value>> {
    rows.into_iter().collect()
}
async fn connection(c: &Config, t: Arc<Transport>) -> Result<Connection> {
    c.validate()?;
    let n = network(c.network)?;
    let rpc = Rpc::new(t, &c.rpc, &c.proxy)?;
    let r = required(
        rpc.batch(vec![
            ("eth_chainId".into(), json!([])),
            ("eth_getBlockByNumber".into(), json!(["latest", false])),
            ("eth_gasPrice".into(), json!([])),
        ])
        .await,
    )?;
    if hex_uint(&r[0])? != U256::from(c.network) {
        return Err("RPC is connected to another chain.".into());
    }
    let block = hex_uint(&r[1]["number"])?.as_u64();
    let timestamp = hex_uint(&r[1]["timestamp"])?.as_u64();
    if (now_ms() / 1000).abs_diff(timestamp) > 45 {
        return Err("RPC block is stale or the local clock is incorrect.".into());
    }
    let wrapped = word_address(&rpc.call(n.router, "WETH()", &[], Some(block)).await?, 0)?;
    let factory = word_address(&rpc.call(n.router, "factory()", &[], Some(block)).await?, 0)?;
    if factory != n.factory
        || word(
            &rpc.call(&wrapped, "decimals()", &[], Some(block)).await?,
            0,
        )? != U256::from(18)
    {
        return Err(
            "Reference router, factory or wrapped-native token verification failed.".into(),
        );
    }
    Ok(Connection {
        rpc,
        block,
        timestamp,
        wrapped,
        gas: hex_uint(&r[2])?,
    })
}
fn call(to: &str, sig: &str, args: Vec<u8>, block: u64) -> (String, Value) {
    (
        "eth_call".into(),
        json!([{"to":to,"data":calldata(sig,&args)},format!("0x{block:x}")]),
    )
}
async fn calls(rpc: &Rpc, values: Vec<(String, Value)>) -> Vec<Result<Vec<u8>>> {
    rpc.batch(values)
        .await
        .into_iter()
        .map(|v| v.and_then(|v| decode_hex(v.as_str().ok_or("Invalid contract response.")?)))
        .collect()
}
fn pair_args(a: &str, b: &str) -> Result<Vec<u8>> {
    let mut args = address_word(a)?;
    args.extend(address_word(b)?);
    Ok(args)
}
fn quote_args(amount: U256, a: &str, b: &str) -> Result<Vec<u8>> {
    let mut args = uint_word(amount);
    args.extend(uint_word(U256::from(64)));
    args.extend(uint_word(U256::from(2)));
    args.extend(address_word(a)?);
    args.extend(address_word(b)?);
    Ok(args)
}
fn quote_output(data: &[u8]) -> Result<U256> {
    if word(data, 0)? != U256::from(32) || word(data, 1)? != U256::from(2) {
        return Err("Invalid router quote layout.".into());
    }
    word(data, 3)
}
pub fn bounds(output: U256, borrow: U256, gas: U256, min_net: U256) -> (U256, U256, U256, bool) {
    let repay = ceil(borrow * U256::from(10000), U256::from(9975));
    let gross = output.saturating_sub(repay);
    let dev = gross * U256::from(200) / U256::from(10000);
    let min_gross = ceil((gas + min_net) * U256::from(10000), U256::from(9800));
    (
        repay,
        dev,
        repay + min_gross,
        output >= repay + min_gross && output >= repay + dev + gas + min_net,
    )
}
pub async fn scan(c: &Config, t: Arc<Transport>, discovered: Option<Vec<Asset>>) -> Result<Report> {
    let net = connection(c, t).await?;
    let n = network(c.network)?;
    let rpc = &net.rpc;
    let block = net.block;
    let native = &net.wrapped;
    let mut notes = Vec::new();
    let tokens =
        discovered.unwrap_or_else(|| c.tokens.iter().filter(|x| x.enabled).cloned().collect());
    if tokens.len() > 30 {
        return Err("Quote at most 30 tokens at once.".into());
    }
    for token in &tokens {
        address(&token.address)?;
    }
    let dexes: Vec<_> = c.dexes.iter().filter(|d| d.enabled).cloned().collect();
    if dexes.len() < 2 || tokens.is_empty() {
        return Err("Enable two verified V2 routers and at least one token.".into());
    }
    let checks = calls(
        rpc,
        dexes
            .iter()
            .flat_map(|d| {
                [
                    call(&d.address, "factory()", vec![], block),
                    call(&d.address, "WETH()", vec![], block),
                ]
            })
            .collect(),
    )
    .await;
    let mut verified = Vec::new();
    for (i, d) in dexes.iter().enumerate() {
        match (&checks[i * 2], &checks[i * 2 + 1]) {
            (Ok(factory), Ok(wrapped)) if word_address(wrapped, 0)? == *native => {
                verified.push((d.clone(), word_address(factory, 0)?))
            }
            _ => notes.push(format!("{}: router verification failed.", d.name)),
        }
    }
    let mut lookups = Vec::new();
    for (d, factory) in &verified {
        for token in &tokens {
            if address(&token.address)? != *native {
                lookups.push((
                    d.clone(),
                    token.clone(),
                    call(
                        factory,
                        "getPair(address,address)",
                        pair_args(native, &token.address)?,
                        block,
                    ),
                ))
            }
        }
    }
    let found = calls(rpc, lookups.iter().map(|x| x.2.clone()).collect()).await;
    let mut pairs = Vec::new();
    for (i, response) in found.into_iter().enumerate() {
        match response {
            Ok(bytes) => {
                let a = word_address(&bytes, 0)?;
                if a != ZERO {
                    pairs.push((lookups[i].0.clone(), lookups[i].1.clone(), a))
                }
            }
            Err(e) => return Err(e),
        }
    }
    let details = calls(
        rpc,
        pairs
            .iter()
            .flat_map(|(_, _, a)| {
                [
                    call(a, "token0()", vec![], block),
                    call(a, "token1()", vec![], block),
                    call(a, "getReserves()", vec![], block),
                ]
            })
            .collect(),
    )
    .await;
    let mut pools = Vec::new();
    for (i, (dex, token, pair)) in pairs.into_iter().enumerate() {
        let a = details[i * 3].as_ref().map_err(Clone::clone)?;
        let b = details[i * 3 + 1].as_ref().map_err(Clone::clone)?;
        let reserves = details[i * 3 + 2].as_ref().map_err(Clone::clone)?;
        let t0 = word_address(a, 0)?;
        let t1 = word_address(b, 0)?;
        let asset = address(&token.address)?;
        if !((t0 == *native && t1 == asset) || (t1 == *native && t0 == asset)) {
            continue;
        }
        let (nr, ar) = if t0 == *native {
            (word(reserves, 0)?, word(reserves, 1)?)
        } else {
            (word(reserves, 1)?, word(reserves, 0)?)
        };
        if nr < units(&c.min_reserve, 18)? || ar.is_zero() {
            notes.push(format!(
                "{} / {}: reserves below the configured limit.",
                dex.name, token.symbol
            ));
            continue;
        }
        pools.push(Pool {
            token,
            dex,
            address: pair,
            native_reserve: decimal(nr, 18),
            asset_reserve: ar.to_string(),
            native: nr,
            asset: ar,
        });
    }
    let mut lender_tokens = c.tokens.clone();
    lender_tokens.extend(tokens);
    let mut seen = std::collections::HashSet::new();
    lender_tokens.retain(|t| seen.insert(t.address.to_ascii_lowercase()));
    let loan_queries = lender_tokens
        .iter()
        .map(|a| {
            Ok(call(
                n.factory,
                "getPair(address,address)",
                pair_args(native, &a.address)?,
                block,
            ))
        })
        .collect::<Result<Vec<_>>>()?;
    let loan_addresses = calls(rpc, loan_queries)
        .await
        .into_iter()
        .map(|r| r.and_then(|b| word_address(&b, 0)))
        .collect::<Result<Vec<_>>>()?;
    let valid_loans: Vec<_> = loan_addresses
        .into_iter()
        .zip(lender_tokens)
        .filter(|(a, _)| a != ZERO)
        .collect();
    let loan_data = calls(
        rpc,
        valid_loans
            .iter()
            .flat_map(|(a, _)| {
                [
                    call(a, "token0()", vec![], block),
                    call(a, "token1()", vec![], block),
                    call(a, "getReserves()", vec![], block),
                ]
            })
            .collect(),
    )
    .await;
    let mut loans = Vec::new();
    for (i, (a, token)) in valid_loans.into_iter().enumerate() {
        let t0 = word_address(loan_data[i * 3].as_ref().map_err(Clone::clone)?, 0)?;
        let t1 = word_address(loan_data[i * 3 + 1].as_ref().map_err(Clone::clone)?, 0)?;
        let asset = address(&token.address)?;
        if !((t0 == *native && t1 == asset) || (t1 == *native && t0 == asset)) {
            continue;
        }
        let reserve = word(
            loan_data[i * 3 + 2].as_ref().map_err(Clone::clone)?,
            if t0 == *native { 0 } else { 1 },
        )?;
        loans.push((a, reserve));
    }
    let borrow = units(&c.amount, 18)?;
    let share = U256::from(c.reserve_share_bps);
    let first = calls(
        rpc,
        pools
            .iter()
            .map(|p| {
                Ok(call(
                    &p.dex.address,
                    "getAmountsOut(uint256,address[])",
                    quote_args(borrow, native, &p.token.address)?,
                    block,
                ))
            })
            .collect::<Result<Vec<_>>>()?,
    )
    .await;
    struct Candidate {
        buy: Pool,
        sell: Pool,
        loan: String,
        asset: U256,
    }
    let mut eligible = Vec::new();
    for (i, buy) in pools.iter().enumerate() {
        let out = match &first[i] {
            Ok(bytes) => quote_output(bytes)?,
            Err(_) => continue,
        };
        if borrow * U256::from(10000) > buy.native * share {
            continue;
        }
        for sell in &pools {
            if !buy.token.address.eq_ignore_ascii_case(&sell.token.address)
                || buy.dex.address.eq_ignore_ascii_case(&sell.dex.address)
                || out * U256::from(10000) > sell.asset * share
            {
                continue;
            }
            if let Some((loan, _)) = loans.iter().find(|(a, r)| {
                a != &buy.address && a != &sell.address && borrow * U256::from(10000) <= *r * share
            }) {
                eligible.push(Candidate {
                    buy: buy.clone(),
                    sell: sell.clone(),
                    loan: loan.clone(),
                    asset: out * U256::from(10000 - c.slippage_bps) / U256::from(10000),
                });
            }
        }
    }
    let second = calls(
        rpc,
        eligible
            .iter()
            .map(|x| {
                Ok(call(
                    &x.sell.dex.address,
                    "getAmountsOut(uint256,address[])",
                    quote_args(x.asset, &x.buy.token.address, native)?,
                    block,
                ))
            })
            .collect::<Result<Vec<_>>>()?,
    )
    .await;
    let gas = units(&c.gas_budget, 18)?;
    let min = units(&c.min_profit, 18)?;
    let gas_allowed = net.gas <= units(&c.max_gas_gwei, 9)?;
    let mut routes = Vec::new();
    for (i, r) in second.into_iter().enumerate() {
        let Ok(bytes) = r else { continue };
        let output = quote_output(&bytes)?;
        let x = &eligible[i];
        let (repay, dev, min_out, qualifies) = bounds(output, borrow, gas, min);
        let cost = repay + dev + gas;
        routes.push(Route {
            id: format!(
                "{}:{}:{}",
                x.buy.token.address.to_ascii_lowercase(),
                x.buy.dex.address.to_ascii_lowercase(),
                x.sell.dex.address.to_ascii_lowercase()
            ),
            symbol: x.buy.token.symbol.clone(),
            token: x.buy.token.address.clone(),
            buy_name: x.buy.dex.name.clone(),
            sell_name: x.sell.dex.name.clone(),
            buy_router: x.buy.dex.address.clone(),
            sell_router: x.sell.dex.address.clone(),
            buy_pair: x.buy.address.clone(),
            sell_pair: x.sell.address.clone(),
            loan_pair: x.loan.clone(),
            amount: borrow.to_string(),
            min_asset_out: x.asset.to_string(),
            output: decimal(output, 18),
            net: difference(output, cost, 18),
            gross: difference(output, repay, 18),
            dev_fee: decimal(dev, 18),
            flash_fee: decimal(repay - borrow, 18),
            profitable: qualifies && gas_allowed,
            min_profit: (min_out - repay).to_string(),
            min_native_out: min_out.to_string(),
            sort: (
                output >= cost,
                if output >= cost {
                    output - cost
                } else {
                    cost - output
                },
            ),
        });
    }
    routes.sort_by(|a, b| {
        b.sort.0.cmp(&a.sort.0).then_with(|| {
            if a.sort.0 {
                b.sort.1.cmp(&a.sort.1)
            } else {
                a.sort.1.cmp(&b.sort.1)
            }
        })
    });
    if eligible.is_empty() {
        notes.push("No route currently has two eligible swap pools and a separate lender within reserve limits.".into())
    }
    Ok(Report {
        at: now_ms(),
        block,
        timestamp: net.timestamp,
        chain_id: c.network,
        wrapped: native.clone(),
        gas_gwei: decimal(net.gas, 9),
        gas_allowed,
        pools,
        routes,
        notes,
    })
}
fn artifact() -> &'static Value {
    static DATA: OnceLock<Value> = OnceLock::new();
    DATA.get_or_init(|| {
        serde_json::from_str(include_str!("../artifacts/FlashArbitrageV2.json"))
            .expect("compiled executor artifact")
    })
}
pub fn canonical_runtime(code: &str) -> Result<[u8; 32]> {
    let mut bytes = decode_hex(code)?;
    if let Some(map) = artifact()["immutableReferences"].as_object() {
        for refs in map.values() {
            if let Some(refs) = refs.as_array() {
                for r in refs {
                    let start = r["start"].as_u64().ok_or("Invalid immutable reference.")? as usize;
                    let len = r["length"].as_u64().ok_or("Invalid immutable length.")? as usize;
                    bytes
                        .get_mut(start..start + len)
                        .ok_or("Executor bytecode is truncated.")?
                        .fill(0);
                }
            }
        }
    }
    Ok(keccak(&bytes))
}
pub async fn verify(c: &Config, owner: Option<&str>, t: Arc<Transport>) -> Result<Value> {
    let net = connection(c, t).await?;
    address(&c.contract)?;
    let code = net
        .rpc
        .send("eth_getCode", json!([c.contract, "latest"]))
        .await?;
    if canonical_runtime(code.as_str().ok_or("Missing executor bytecode.")?)?
        != canonical_runtime(
            artifact()["runtime"]
                .as_str()
                .ok_or("Missing reference runtime.")?,
        )?
    {
        return Err("Executor bytecode does not match the authenticated GUI v2 contract.".into());
    }
    let signatures = [
        "owner()",
        "wbnb()",
        "pancakeFactory()",
        "DEV_ADDRESS()",
        "DEV_FEE_BPS()",
        "tradesExecuted()",
        "totalProfit()",
        "totalDevFees()",
    ];
    let values = calls(
        &net.rpc,
        signatures
            .iter()
            .map(|s| call(&c.contract, s, vec![], net.block))
            .collect(),
    )
    .await
    .into_iter()
    .collect::<Result<Vec<_>>>()?;
    let actual = word_address(&values[0], 0)?;
    if owner.is_some_and(|o| !actual.eq_ignore_ascii_case(o))
        || word_address(&values[1], 0)? != net.wrapped
        || word_address(&values[2], 0)? != network(c.network)?.factory
        || word_address(&values[3], 0)? != DEV
        || word(&values[4], 0)? != U256::from(200)
    {
        return Err(
            "Executor owner or protocol parameters do not match this wallet and network.".into(),
        );
    }
    Ok(
        json!({"verified":true,"address":c.contract,"owner":actual,"trades":word(&values[5],0)?.to_string(),"profit":decimal(word(&values[6],0)?,18),"fees":decimal(word(&values[7],0)?,18)}),
    )
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub id: String,
    pub kind: String,
    pub description: String,
    pub chain_id: u64,
    pub owner: String,
    pub to: Option<String>,
    pub data: String,
    pub gas: String,
    pub gas_price: String,
    pub nonce: String,
    pub cost: String,
    pub expires: u64,
    pub predicted_address: Option<String>,
    #[serde(skip)]
    pub config: Config,
}
pub async fn prepare(
    c: &Config,
    kind: &str,
    input: &Value,
    owner: &str,
    t: Arc<Transport>,
) -> Result<Preview> {
    c.validate()?;
    let owner = address(owner)?;
    let net = connection(c, t.clone()).await?;
    let mut to = Some(c.contract.clone());
    let data;
    let description;
    if kind == "deploy" {
        to = None;
        let routers: Vec<_> = c.dexes.iter().filter(|d| d.enabled).collect();
        if routers.len() < 2 {
            return Err("Enable at least two routers before deploying.".into());
        }
        let mut args = pair_args(&net.wrapped, network(c.network)?.factory)?;
        args.extend(uint_word(U256::from(96)));
        args.extend(uint_word(U256::from(routers.len())));
        for d in routers {
            args.extend(address_word(&d.address)?);
        }
        data = artifact()["bytecode"]
            .as_str()
            .ok_or("Missing executor bytecode.")?
            .to_string()
            + &hex::encode(args);
        description="Deploy the authenticated v2 executor. Existing developer fee: 2% of positive gross profit.".into();
    } else {
        verify(c, Some(&owner), t.clone()).await?;
        match kind {
            "trade" => {
                let id = input["routeId"].as_str().ok_or("Choose a fresh route.")?;
                let token = id.split(':').next().ok_or("Invalid route identifier.")?;
                address(token)?;
                let report = scan(
                    c,
                    t,
                    Some(vec![Asset {
                        symbol: input["symbol"].as_str().unwrap_or("TOKEN").into(),
                        address: token.into(),
                        enabled: true,
                    }]),
                )
                .await?;
                let route = report
                    .routes
                    .iter()
                    .find(|r| r.id == id && r.profitable)
                    .ok_or("The refreshed route no longer meets the net-profit floor.")?;
                for router in [&route.buy_router, &route.sell_router] {
                    if word(
                        &net.rpc
                            .call(
                                &c.contract,
                                "allowedRouter(address)",
                                &address_word(router)?,
                                None,
                            )
                            .await?,
                        0,
                    )?
                    .is_zero()
                    {
                        return Err(
                            "Allow both route routers in the executor before trading.".into()
                        );
                    }
                }
                let mut args = Vec::new();
                for a in [
                    &route.loan_pair,
                    &route.token,
                    &route.buy_router,
                    &route.sell_router,
                ] {
                    args.extend(address_word(a)?);
                }
                for value in [
                    &route.amount,
                    &route.min_asset_out,
                    &route.min_native_out,
                    &route.min_profit,
                ] {
                    args.extend(uint_word(
                        U256::from_dec_str(value).map_err(|_| "Invalid route amount.")?,
                    ));
                }
                args.extend(uint_word(U256::from(report.timestamp + 90)));
                data=calldata("startArb((address,address,address,address,uint256,uint256,uint256,uint256,uint256))",&args);
                description = format!(
                    "{} → {} · {} borrowed · minimum net {} after the configured gas budget.",
                    route.buy_name, route.sell_name, c.amount, c.min_profit
                );
            }
            "router" => {
                let router = input["router"].as_str().ok_or("Enter a router address.")?;
                let mut args = address_word(router)?;
                args.extend(uint_word(U256::from(
                    input["allowed"].as_bool().unwrap_or(false) as u8,
                )));
                data = calldata("setRouter(address,bool)", &args);
                description = format!(
                    "{} executor router {router}.",
                    if input["allowed"] == true {
                        "Allow"
                    } else {
                        "Revoke"
                    }
                );
            }
            "withdraw" => {
                let token = input["token"].as_str().unwrap_or("native");
                let recipient = address(input["recipient"].as_str().ok_or("Enter a recipient.")?)?;
                if recipient.eq_ignore_ascii_case(&c.contract) {
                    return Err("Choose an external withdrawal recipient.".into());
                }
                let decimals = if token == "native" {
                    18
                } else {
                    word(&net.rpc.call(token, "decimals()", &[], None).await?, 0)?.as_usize()
                };
                if decimals > 36 {
                    return Err("Unsupported token decimals.".into());
                }
                let amount = units(
                    input["amount"]
                        .as_str()
                        .ok_or("Enter a withdrawal amount.")?,
                    decimals,
                )?;
                if amount.is_zero() {
                    return Err("Withdrawal must be positive.".into());
                }
                let mut args = if token == "native" {
                    vec![0; 32]
                } else {
                    address_word(token)?
                };
                args.extend(address_word(&recipient)?);
                args.extend(uint_word(amount));
                data = calldata("withdraw(address,address,uint256)", &args);
                description = format!(
                    "Withdraw {} to {recipient}.",
                    input["amount"].as_str().unwrap_or("")
                );
            }
            _ => return Err("Unsupported executor action.".into()),
        }
    }
    let r = required(
        net.rpc
            .batch(vec![
                ("eth_getTransactionCount".into(), json!([owner, "pending"])),
                ("eth_getTransactionCount".into(), json!([owner, "latest"])),
                ("eth_getBalance".into(), json!([owner, "latest"])),
            ])
            .await,
    )?;
    if r[0] != r[1] {
        return Err("Another wallet transaction is pending. Check it before signing again.".into());
    }
    if net.gas > units(&c.max_gas_gwei, 9)? {
        return Err("Gas price exceeds the configured cap.".into());
    }
    let mut request = json!({"from":owner,"data":data,"value":"0x0","gasPrice":quantity(net.gas)});
    if let Some(to) = &to {
        request["to"] = json!(to);
    }
    net.rpc.send("eth_call", json!([request, "latest"])).await?;
    let estimate = hex_uint(&net.rpc.send("eth_estimateGas", json!([request])).await?)?;
    let gas = ceil(estimate * U256::from(125), U256::from(100));
    let cost = gas * net.gas;
    let budget = units(&c.gas_budget, 18)? * U256::from(if kind == "deploy" { 10 } else { 1 });
    if cost > budget || cost > hex_uint(&r[2])? {
        return Err("Estimated fee exceeds the budget or available wallet balance.".into());
    }
    let nonce = hex_uint(&r[0])?;
    let predicted = if to.is_none() {
        let mut stream = rlp::RlpStream::new_list(2);
        stream.append(&decode_hex(&owner)?);
        stream.append(&nonce.as_u64());
        Some(format!("0x{}", hex::encode(&keccak(&stream.out())[12..])))
    } else {
        None
    };
    let mut random = [0; 16];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut random);
    Ok(Preview {
        id: hex::encode(random),
        kind: kind.into(),
        description,
        chain_id: c.network,
        owner,
        to,
        data,
        gas: quantity(gas),
        gas_price: quantity(net.gas),
        nonce: quantity(nonce),
        cost: decimal(cost, 18),
        expires: now_ms() + 60000,
        predicted_address: predicted,
        config: c.clone(),
    })
}
fn append_uint(s: &mut rlp::RlpStream, n: U256) {
    let bytes = uint_word(n);
    let first = bytes.iter().position(|b| *b != 0).unwrap_or(32);
    s.append(&bytes[first..].to_vec());
}
pub fn sign_transaction(p: &Preview, key: &[u8; 32]) -> Result<(String, String)> {
    if now_ms() > p.expires || crate::wallet::account_address("evm", key)? != p.owner {
        return Err("Wallet changed or transaction review expired.".into());
    }
    network(p.chain_id)?;
    let encode = |signature: Option<(U256, U256, U256)>| -> Result<Vec<u8>> {
        let mut s = rlp::RlpStream::new_list(9);
        for n in [
            U256::from_str_radix(p.nonce.trim_start_matches("0x"), 16),
            U256::from_str_radix(p.gas_price.trim_start_matches("0x"), 16),
            U256::from_str_radix(p.gas.trim_start_matches("0x"), 16),
        ] {
            append_uint(&mut s, n.map_err(|_| "Invalid transaction quantity.")?)
        }
        s.append(
            &p.to
                .as_ref()
                .map(|a| decode_hex(a))
                .transpose()?
                .unwrap_or_default(),
        );
        append_uint(&mut s, U256::zero());
        s.append(&decode_hex(&p.data)?);
        if let Some((v, r, sig)) = signature {
            append_uint(&mut s, v);
            append_uint(&mut s, r);
            append_uint(&mut s, sig);
        } else {
            append_uint(&mut s, U256::from(p.chain_id));
            append_uint(&mut s, U256::zero());
            append_uint(&mut s, U256::zero());
        }
        Ok(s.out().to_vec())
    };
    let signing = k256::ecdsa::SigningKey::from_slice(key).map_err(|_| "Invalid signing key.")?;
    let (signature, recovery) = signing
        .sign_prehash_recoverable(&keccak(&encode(None)?))
        .map_err(|_| "Local transaction signing failed.")?;
    let bytes = signature.to_bytes();
    let raw = encode(Some((
        U256::from(p.chain_id * 2 + 35 + u64::from(recovery.to_byte())),
        U256::from_big_endian(&bytes[..32]),
        U256::from_big_endian(&bytes[32..]),
    )))?;
    Ok((
        format!("0x{}", hex::encode(&raw)),
        format!("0x{}", hex::encode(keccak(&raw))),
    ))
}
pub async fn preflight(p: &Preview, t: Arc<Transport>) -> Result<Rpc> {
    if now_ms() > p.expires {
        return Err("Transaction review expired. Prepare again.".into());
    }
    let net = connection(&p.config, t.clone()).await?;
    if p.to.is_some() {
        verify(&p.config, Some(&p.owner), t).await?;
    }
    let r = required(
        net.rpc
            .batch(vec![
                (
                    "eth_getTransactionCount".into(),
                    json!([p.owner, "pending"]),
                ),
                ("eth_getTransactionCount".into(), json!([p.owner, "latest"])),
                ("eth_getBalance".into(), json!([p.owner, "latest"])),
            ])
            .await,
    )?;
    if r[0] != r[1] || r[0] != p.nonce {
        return Err("Wallet nonce changed or another transaction is pending.".into());
    }
    let gas = U256::from_str_radix(p.gas.trim_start_matches("0x"), 16)
        .map_err(|_| "Invalid gas limit.")?;
    let price = U256::from_str_radix(p.gas_price.trim_start_matches("0x"), 16)
        .map_err(|_| "Invalid gas price.")?;
    if hex_uint(&r[2])? < gas * price {
        return Err("Insufficient native funds for the transaction fee.".into());
    }
    let mut tx =
        json!({"from":p.owner,"data":p.data,"value":"0x0","gas":p.gas,"gasPrice":p.gas_price});
    if let Some(to) = &p.to {
        tx["to"] = json!(to);
    }
    net.rpc.send("eth_call", json!([tx, "latest"])).await?;
    Ok(net.rpc)
}
pub async fn diagnostics(c: &Config, owner: Option<&str>, t: Arc<Transport>) -> Result<Value> {
    let net = connection(c, t.clone()).await?;
    let balance = if let Some(owner) = owner {
        decimal(
            hex_uint(
                &net.rpc
                    .send("eth_getBalance", json!([address(owner)?, "latest"]))
                    .await?,
            )?,
            18,
        )
    } else {
        String::new()
    };
    let executor = if c.contract.is_empty() {
        Value::Null
    } else {
        verify(c, owner, t).await?
    };
    Ok(
        json!({"chainId":c.network,"block":net.block,"timestamp":net.timestamp,"wrapped":net.wrapped,"gasGwei":decimal(net.gas,9),"balance":balance,"executor":executor}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn flash_loan_profit_rounds_up_and_counts_fees() {
        let borrow = units("1000", 18).unwrap();
        let (repay, dev, floor, ok) = bounds(
            units("1010", 18).unwrap(),
            borrow,
            units("0.002", 18).unwrap(),
            units("0.001", 18).unwrap(),
        );
        assert!(repay > borrow);
        assert!(dev > U256::zero());
        assert!(floor > repay);
        assert!(ok);
        assert!(!bounds(borrow, borrow, U256::one(), U256::one()).3);
    }
    #[test]
    fn native_executor_artifact_and_immutable_mask_are_consistent() {
        let runtime = artifact()["runtime"].as_str().unwrap();
        assert_eq!(
            canonical_runtime(runtime).unwrap(),
            canonical_runtime(runtime).unwrap()
        );
        assert!(canonical_runtime("0x00").is_err());
        assert!(defaults(56).validate().is_ok());
        assert!(defaults(42161).validate().is_ok());
    }
}
