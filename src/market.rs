use crate::{
    chains::{self, Chain},
    now_ms,
    transport::Transport,
    Result,
};
use futures::{stream, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Token {
    pub address: String,
    pub symbol: String,
    pub name: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pair {
    pub chain: String,
    pub id: String,
    pub dex: String,
    pub labels: Vec<String>,
    pub base: Token,
    pub quote: Token,
    pub price: f64,
    pub price_native: f64,
    pub liquidity: f64,
    pub volume: f64,
    pub changes: BTreeMap<String, f64>,
    pub trades5m: u64,
    pub url: String,
    pub fetched_at: u64,
}
fn number(v: Option<&Value>) -> f64 {
    v.and_then(|v| {
        v.as_f64()
            .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
    })
    .filter(|n| n.is_finite())
    .unwrap_or(0.0)
}
fn text(v: Option<&Value>, limit: usize) -> String {
    v.and_then(|v| v.as_str())
        .unwrap_or("")
        .chars()
        .take(limit)
        .collect()
}
pub fn parse_pair(v: &Value) -> Option<Pair> {
    let chain = v.get("chainId")?.as_str()?;
    chains::validate_chain(chain).ok()?;
    let id = v.get("pairAddress")?.as_str()?;
    if !chains::valid_pair(chain, id) {
        return None;
    }
    let token = |key: &str| -> Option<Token> {
        let t = v.get(key)?;
        let a = t.get("address")?.as_str()?;
        if !chains::valid_token(chain, a) {
            return None;
        }
        Some(Token {
            address: a.to_string(),
            symbol: text(t.get("symbol"), 24),
            name: text(t.get("name"), 80),
        })
    };
    let price = number(v.get("priceUsd"));
    let native = number(v.get("priceNative"));
    if price <= 0.0 || native <= 0.0 {
        return None;
    }
    let mut changes = BTreeMap::new();
    for frame in ["m5", "h1", "h6", "h24"] {
        if let Some(n) = v
            .get("priceChange")
            .and_then(|m| m.get(frame))
            .and_then(Value::as_f64)
            .filter(|n| n.is_finite())
        {
            changes.insert(frame.into(), n);
        }
    }
    Some(Pair {
        chain: chain.into(),
        id: id.into(),
        dex: text(v.get("dexId"), 40),
        labels: v
            .get("labels")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .take(4)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default(),
        base: token("baseToken")?,
        quote: token("quoteToken")?,
        price,
        price_native: native,
        liquidity: number(v.pointer("/liquidity/usd")).max(0.0),
        volume: number(v.pointer("/volume/h24")).max(0.0),
        changes,
        trades5m: (number(v.pointer("/txns/m5/buys")) + number(v.pointer("/txns/m5/sells")))
            .max(0.0) as u64,
        url: format!(
            "https://dexscreener.com/{}/{}",
            chain,
            percent_encoding::utf8_percent_encode(id, percent_encoding::NON_ALPHANUMERIC)
        ),
        fetched_at: now_ms(),
    })
}
fn pair_key(p: &Pair) -> String {
    format!("{}:{}", p.chain, chains::address_key(&p.chain, &p.id))
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Spread {
    pub id: String,
    pub buy: Pair,
    pub sell: Pair,
    pub spread: f64,
    pub count: usize,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Filters {
    pub scope: String,
    pub mode: String,
    pub timeframe: String,
    pub min_liquidity: f64,
    pub min_volume: f64,
    pub min_spread: f64,
    pub active_only: bool,
    pub page: usize,
    pub page_size: usize,
    pub query: String,
}
impl Default for Filters {
    fn default() -> Self {
        Self {
            scope: "all".into(),
            mode: "gainers".into(),
            timeframe: "h24".into(),
            min_liquidity: 25000.0,
            min_volume: 5000.0,
            min_spread: 0.5,
            active_only: true,
            page: 0,
            page_size: 75,
            query: String::new(),
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketView {
    pub pairs: Vec<Pair>,
    pub total: usize,
    pub spreads: Vec<Spread>,
    pub chains: Vec<Chain>,
    pub fetched_at: u64,
    pub oldest_at: u64,
    pub token_count: usize,
    pub failures: usize,
    pub notes: Vec<String>,
    pub elapsed_ms: u64,
    pub busy: bool,
    pub dex_count: usize,
    pub scanned_chains: usize,
}
#[derive(Default)]
struct Snapshot {
    pairs: HashMap<String, Pair>,
    chains: BTreeMap<String, Chain>,
    at: u64,
    failures: usize,
    notes: Vec<String>,
    token_count: usize,
    elapsed_ms: u64,
}
pub struct MarketEngine {
    pub transport: Arc<Transport>,
    snapshot: Mutex<Snapshot>,
    scan_lock: tokio::sync::Mutex<()>,
    cursor: AtomicUsize,
}
fn component(v: &str) -> String {
    percent_encoding::utf8_percent_encode(v, percent_encoding::NON_ALPHANUMERIC).to_string()
}
fn matching(p: &Pair, f: &Filters) -> bool {
    (f.scope == "all" || p.chain == f.scope)
        && p.liquidity >= f.min_liquidity.max(0.0)
        && p.volume >= f.min_volume.max(0.0)
        && (f.query.is_empty()
            || format!(
                "{} {} {} {} {} {}",
                p.chain, p.dex, p.base.symbol, p.quote.symbol, p.base.address, p.quote.address
            )
            .to_lowercase()
            .contains(&f.query.to_lowercase()))
}
pub fn analyze(rows: &[Pair], filters: &Filters) -> (Vec<Pair>, usize, Vec<Spread>) {
    let mut unique = HashSet::new();
    let mut ranked = Vec::new();
    struct Bounds<'a> {
        buy: &'a Pair,
        sell: &'a Pair,
        count: usize,
    }
    let mut groups: HashMap<String, Bounds<'_>> = HashMap::new();
    for p in rows {
        if !unique.insert(pair_key(p)) || !matching(p, filters) {
            continue;
        }
        ranked.push(p);
        if filters.active_only && p.trades5m == 0 {
            continue;
        }
        let key = format!(
            "{}:{}:{}",
            p.chain,
            chains::address_key(&p.chain, &p.base.address),
            chains::address_key(&p.chain, &p.quote.address)
        );
        groups
            .entry(key)
            .and_modify(|g| {
                g.count += 1;
                if p.price_native < g.buy.price_native {
                    g.buy = p;
                }
                if p.price_native > g.sell.price_native {
                    g.sell = p;
                }
            })
            .or_insert(Bounds {
                buy: p,
                sell: p,
                count: 1,
            });
    }
    let score = |p: &Pair| match filters.mode.as_str() {
        "volume" => p.volume,
        "liquidity" => p.liquidity,
        _ => *p
            .changes
            .get(&filters.timeframe)
            .unwrap_or(&f64::NEG_INFINITY),
    };
    ranked.sort_unstable_by(|a, b| {
        score(b)
            .total_cmp(&score(a))
            .then_with(|| b.volume.total_cmp(&a.volume))
            .then_with(|| a.chain.cmp(&b.chain))
            .then_with(|| a.id.cmp(&b.id))
    });
    let total = ranked.len();
    let size = filters.page_size.clamp(10, 150);
    let pairs = ranked
        .into_iter()
        .skip(filters.page.saturating_mul(size))
        .take(size)
        .cloned()
        .collect();
    let mut candidates: Vec<_> = groups
        .into_iter()
        .filter_map(|(id, g)| {
            let spread = (g.sell.price_native / g.buy.price_native - 1.0) * 100.0;
            (g.count > 1
                && spread.is_finite()
                && spread > 0.0
                && spread >= filters.min_spread.max(0.0))
            .then_some((id, g, spread))
        })
        .collect();
    // Rank borrowed pool references and clone only the 100 visible comparisons.
    // Large catalogues otherwise allocate a full pair DTO for every spread.
    candidates.sort_unstable_by(|a, b| b.2.total_cmp(&a.2));
    let spreads = candidates
        .into_iter()
        .take(100)
        .map(|(id, g, spread)| Spread {
            id,
            buy: g.buy.clone(),
            sell: g.sell.clone(),
            spread,
            count: g.count,
        })
        .collect();
    (pairs, total, spreads)
}
impl MarketEngine {
    pub fn new(transport: Arc<Transport>) -> Self {
        let mut snapshot = Snapshot::default();
        for c in chains::catalogue() {
            snapshot.chains.insert(c.id.clone(), c.clone());
        }
        Self {
            transport,
            snapshot: Mutex::new(snapshot),
            scan_lock: tokio::sync::Mutex::new(()),
            cursor: AtomicUsize::new(0),
        }
    }
    pub fn view(&self, f: &Filters) -> MarketView {
        let s = self.snapshot.lock().unwrap();
        let rows: Vec<_> = s
            .pairs
            .values()
            .filter(|p| now_ms().saturating_sub(p.fetched_at) < 180000)
            .cloned()
            .collect();
        let (pairs, total, spreads) = analyze(&rows, f);
        let dex_count = rows
            .iter()
            .filter(|p| f.scope == "all" || f.scope == p.chain)
            .map(|p| format!("{}:{}", p.chain, p.dex))
            .collect::<HashSet<_>>()
            .len();
        let scanned = rows.iter().map(|p| &p.chain).collect::<HashSet<_>>().len();
        MarketView {
            oldest_at: rows
                .iter()
                .filter(|p| matching(p, f))
                .map(|p| p.fetched_at)
                .min()
                .unwrap_or(0),
            pairs,
            total,
            spreads,
            chains: s.chains.values().cloned().collect(),
            fetched_at: s.at,
            token_count: s.token_count,
            failures: s.failures,
            notes: s.notes.clone(),
            elapsed_ms: s.elapsed_ms,
            busy: self.scan_lock.try_lock().is_err(),
            dex_count,
            scanned_chains: scanned,
        }
    }
    fn merge(&self, rows: Vec<Pair>) {
        let mut s = self.snapshot.lock().unwrap();
        if !rows.is_empty() {
            s.at = now_ms();
        }
        for p in rows {
            s.chains.entry(p.chain.clone()).or_insert_with(|| Chain {
                id: p.chain.clone(),
                name: p.chain.replace('-', " "),
            });
            s.pairs.insert(pair_key(&p), p);
        }
        s.pairs
            .retain(|_, p| now_ms().saturating_sub(p.fetched_at) < 180000);
        if s.pairs.len() > 15000 {
            let mut oldest: Vec<_> = s
                .pairs
                .iter()
                .map(|(k, p)| (k.clone(), p.fetched_at))
                .collect();
            oldest.sort_unstable_by_key(|(_, t)| *t);
            for (k, _) in oldest.into_iter().take(s.pairs.len() - 15000) {
                s.pairs.remove(&k);
            }
        }
    }
    pub async fn token_pairs(&self, chain: &str, mint: &str, proxy: &str) -> Result<Vec<Pair>> {
        chains::validate_chain(chain)?;
        if !chains::valid_token(chain, mint) {
            return Err("Invalid token address for this chain.".into());
        }
        let value = self
            .transport
            .market_json(
                &format!("/token-pairs/v1/{}/{}", component(chain), component(mint)),
                Duration::from_secs(5),
                false,
                proxy,
            )
            .await?;
        let rows = value
            .as_array()
            .ok_or("Invalid pool response.")?
            .iter()
            .filter_map(parse_pair)
            .filter(|p| p.chain == chain)
            .collect::<Vec<_>>();
        self.merge(rows.clone());
        Ok(rows)
    }
    pub async fn search(&self, scope: &str, query: &str, proxy: &str) -> Result<Vec<Pair>> {
        if scope != "all" {
            chains::validate_chain(scope)?;
        }
        if query.trim().is_empty() || query.len() > 120 {
            return Err("Enter a token name, address or pair address.".into());
        }
        let value = self
            .transport
            .market_json(
                &format!("/latest/dex/search?q={}", component(query.trim())),
                Duration::from_secs(5),
                false,
                proxy,
            )
            .await?;
        let rows = value
            .get("pairs")
            .and_then(Value::as_array)
            .ok_or("Invalid market search response.")?
            .iter()
            .filter_map(parse_pair)
            .filter(|p| scope == "all" || p.chain == scope)
            .collect::<Vec<_>>();
        self.merge(rows.clone());
        Ok(rows)
    }
    pub async fn scan(
        &self,
        filters: &Filters,
        watch: &BTreeMap<String, Vec<String>>,
        proxy: &str,
    ) -> Result<MarketView> {
        if filters.scope != "all" {
            chains::validate_chain(&filters.scope)?;
        }
        if watch.len() > 150 || watch.values().map(Vec::len).sum::<usize>() > 500 {
            return Err("Watchlist exceeds the 500-token limit.".into());
        }
        for (c, mints) in watch {
            chains::validate_chain(c)?;
            if mints.len() > 30 || mints.iter().any(|m| !chains::valid_token(c, m)) {
                return Err("Watch up to 30 valid tokens per chain.".into());
            }
        }
        let Ok(_guard) = self.scan_lock.try_lock() else {
            return Ok(self.view(filters));
        };
        let start = Instant::now();
        let mut notes = Vec::new();
        let mut failures = 0;
        let sources = [
            "/token-boosts/top/v1",
            "/token-boosts/latest/v1",
            "/token-profiles/latest/v1",
            "/token-profiles/recent-updates/v1",
        ];
        let snapshots = futures::future::join_all(sources.iter().map(|p| {
            self.transport
                .market_json(p, Duration::from_secs(60), true, proxy)
        }))
        .await;
        let mut tokens: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for (c, mints) in watch {
            tokens.entry(c.clone()).or_default().extend(mints.clone());
        }
        for c in chains::catalogue() {
            let seed = chains::seeds(&c.id);
            if !seed.is_empty() {
                tokens.entry(c.id.clone()).or_default().extend(seed);
            }
        }
        for snapshot in snapshots {
            match snapshot {
                Ok(value) => {
                    if let Some(rows) = value.as_array() {
                        for v in rows {
                            let c = v.get("chainId").and_then(Value::as_str).unwrap_or("");
                            let m = v.get("tokenAddress").and_then(Value::as_str).unwrap_or("");
                            if chains::validate_chain(c).is_ok() && chains::valid_token(c, m) {
                                tokens.entry(c.into()).or_default().push(m.into());
                            }
                        }
                    }
                }
                Err(e) => {
                    failures += 1;
                    notes.push(e);
                }
            }
        }
        // Retain discovered token addresses between cycles, and visit every
        // catalogue chain even when it has no current profile/boost listing.
        {
            let snapshot = self.snapshot.lock().unwrap();
            let mut discovered: Vec<_> = snapshot.pairs.values().collect();
            discovered.sort_unstable_by(|a, b| b.liquidity.total_cmp(&a.liquidity));
            for p in discovered {
                let list = tokens.entry(p.chain.clone()).or_default();
                if list.len() < 90 {
                    list.push(p.base.address.clone());
                }
            }
        }
        let mut selected: Vec<String> = if filters.scope == "all" {
            let snapshot = self.snapshot.lock().unwrap();
            let mut all: BTreeSet<String> = snapshot.chains.keys().cloned().collect();
            all.extend(tokens.keys().cloned());
            all.into_iter().collect()
        } else {
            vec![filters.scope.clone()]
        };
        selected.sort_by_key(|c| {
            (
                ["solana", "bsc", "arbitrum", "ethereum", "base", "optimism"]
                    .iter()
                    .position(|p| p == c)
                    .unwrap_or(6),
                c.clone(),
            )
        });
        if filters.scope == "all" && !selected.is_empty() {
            let rotate = self.cursor.fetch_add(12, Ordering::Relaxed) % selected.len();
            selected.rotate_left(rotate);
            selected.truncate(12);
        }
        let mut jobs = Vec::new();
        let mut token_count = 0;
        for chain in selected {
            let mut seen = HashSet::new();
            let mints: Vec<_> = tokens
                .remove(&chain)
                .unwrap_or_default()
                .into_iter()
                .filter(|m| seen.insert(chains::address_key(&chain, m)))
                .take(if filters.scope == "all" { 30 } else { 90 })
                .collect();
            token_count += mints.len();
            if mints.is_empty() {
                let name = chains::catalogue()
                    .iter()
                    .find(|c| c.id == chain)
                    .map(|c| c.name.as_str())
                    .unwrap_or(&chain)
                    .to_string();
                jobs.push((chain, String::new(), Some(name)));
                continue;
            }
            for chunk in mints.chunks(30) {
                jobs.push((
                    chain.clone(),
                    format!(
                        "/tokens/v1/{}/{}",
                        component(&chain),
                        chunk
                            .iter()
                            .map(|m| component(m))
                            .collect::<Vec<_>>()
                            .join(",")
                    ),
                    None,
                ));
            }
        }
        let mut outcomes = stream::iter(jobs.into_iter().map(|(chain, path, search)| async move {
            if let Some(q) = search {
                return self.search(&chain, &q, proxy).await;
            }
            let value = self
                .transport
                .market_json(&path, Duration::from_secs(5), false, proxy)
                .await?;
            Ok(value
                .as_array()
                .ok_or("Invalid market response.")?
                .iter()
                .filter_map(parse_pair)
                .filter(|p| p.chain == chain)
                .collect::<Vec<_>>())
        }))
        .buffer_unordered(8);
        while let Some(result) = outcomes.next().await {
            match result {
                Ok(rows) => self.merge(rows),
                Err(e) => {
                    failures += 1;
                    notes.push(e);
                }
            }
        }
        notes.sort();
        notes.dedup();
        notes.truncate(8);
        {
            let mut s = self.snapshot.lock().unwrap();
            s.at = now_ms();
            s.failures = failures;
            s.notes = notes;
            s.token_count = token_count;
            s.elapsed_ms = start.elapsed().as_millis() as u64;
        }
        drop(_guard);
        Ok(self.view(filters))
    }
    pub fn all_pairs(&self) -> Vec<Pair> {
        self.snapshot
            .lock()
            .unwrap()
            .pairs
            .values()
            .cloned()
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn pair(chain: &str, id: &str, price: f64) -> Pair {
        let token = if chain == "solana" {
            chains::WSOL.to_string()
        } else {
            format!("0x{}", "a".repeat(40))
        };
        parse_pair(&json!({"chainId":chain,"pairAddress":id,"dexId":"test","baseToken":{"address":token,"symbol":"TOKEN"},"quoteToken":{"address":if chain=="solana"{chains::WSOL}else{chains::WBNB},"symbol":"NATIVE"},"priceUsd":"1","priceNative":price.to_string(),"liquidity":{"usd":50000},"volume":{"h24":25000},"priceChange":{"h24":10},"txns":{"m5":{"buys":2}}})).unwrap()
    }
    #[test]
    fn cross_pool_groups_never_cross_chain_or_quote_assets() {
        let a = pair("bsc", &format!("0x{}", "1".repeat(40)), 1.0);
        let b = pair("bsc", &format!("0x{}", "2".repeat(40)), 1.1);
        let mut c = b.clone();
        c.chain = "ethereum".into();
        let f = Filters {
            min_spread: 0.0,
            ..Default::default()
        };
        let (_, _, s) = analyze(&[a.clone(), b.clone(), c], &f);
        assert_eq!(s.len(), 1);
        assert!((s[0].spread - 10.0).abs() < 0.00001);
        let mut other = b;
        other.quote.address = format!("0x{}", "b".repeat(40));
        assert!(analyze(&[a, other], &f).2.is_empty());
    }
    #[test]
    fn supports_long_pool_ids_new_chain_formats_and_invalid_price_rejection() {
        let p = pair("ethereum", &format!("0x{}", "a".repeat(64)), 1.0);
        assert_eq!(p.id.len(), 66);
        let mut raw = serde_json::json!({"chainId":"sui","pairAddress":"0xabcdef","baseToken":{"address":"0x123::coin::TOKEN"},"quoteToken":{"address":"0x2::sui::SUI"},"priceUsd":"2","priceNative":"0.3"});
        assert!(parse_pair(&raw).is_some());
        raw["priceUsd"] = Value::String("Infinity".into());
        assert!(parse_pair(&raw).is_none());
    }
    #[test]
    fn paginates_and_deduplicates_without_changing_sort_order() {
        let mut rows = Vec::new();
        for i in 0..200 {
            let mut p = pair("bsc", &format!("0x{i:040x}"), 1.0);
            p.volume = i as f64 + 10000.0;
            rows.push(p);
        }
        rows.push(rows[0].clone());
        let f = Filters {
            mode: "volume".into(),
            page: 1,
            page_size: 25,
            ..Default::default()
        };
        let (p, total, _) = analyze(&rows, &f);
        assert_eq!(total, 200);
        assert_eq!(p.len(), 25);
        assert_eq!(p[0].volume, 10174.0);
    }
}
