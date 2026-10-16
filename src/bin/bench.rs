use std::{collections::BTreeMap, time::Instant};
use vigilant_engine::{
    chains::WBNB,
    market::{analyze, Filters, Pair, Token},
};
fn main() {
    let count = 100000;
    let rows: Vec<_> = (0..count)
        .map(|i| Pair {
            chain: if i % 2 == 0 { "bsc" } else { "arbitrum" }.into(),
            id: format!("0x{i:040x}"),
            dex: format!("dex{}", i % 4),
            labels: vec![],
            base: Token {
                address: format!("0x{:040x}", i / 4),
                symbol: "TOKEN".into(),
                name: String::new(),
            },
            quote: Token {
                address: WBNB.into(),
                symbol: "BNB".into(),
                name: String::new(),
            },
            price: 1.0,
            price_native: 1.0 + (i % 3) as f64 / 1000.0,
            liquidity: 100000.0,
            volume: 10000.0 + i as f64,
            changes: BTreeMap::from([("h24".into(), (i % 1000) as f64)]),
            trades5m: 10,
            url: String::new(),
            fetched_at: 0,
        })
        .collect();
    let start = Instant::now();
    let (p, total, spreads) = analyze(&rows, &Filters::default());
    println!("{{\"engine\":\"Rust\",\"pairs\":{count},\"matched\":{total},\"returned\":{},\"spreadGroups\":{},\"elapsedMs\":{:.3}}}",p.len(),spreads.len(),start.elapsed().as_secs_f64()*1000.0);
}
