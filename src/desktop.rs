use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use vigilant_engine::{
    chains, evm,
    market::{Filters, MarketEngine, MarketView, Pair},
    now_ms,
    rpc::{decimal, hex_uint, Rpc},
    solana, solana_codec, solana_engine,
    storage::{Settings, Store},
    transport::Transport,
    wallet::Wallets,
    Result,
};
use zeroize::Zeroizing;

struct Core {
    transport: Arc<Transport>,
    market: MarketEngine,
    store: Arc<Store>,
    wallets: Arc<Wallets>,
    previews: Mutex<HashMap<String, evm::Preview>>,
    sol_previews: Mutex<HashMap<String, solana_engine::Preview>>,
    signing: tokio::sync::Mutex<()>,
    smoke: bool,
}
fn local(window: &WebviewWindow) -> Result<()> {
    if window.label() != "main" {
        return Err("Command is only available to the local application window.".into());
    }
    Ok(())
}
fn config(s: &Core, network: u64) -> Result<evm::Config> {
    let settings = s.store.settings.lock().unwrap();
    let mut c = settings
        .evm
        .get(&network.to_string())
        .map(|v| serde_json::from_value(v.clone()))
        .transpose()
        .map_err(|_| "Saved EVM settings are invalid.")?
        .unwrap_or_else(|| evm::defaults(network));
    c.network = network;
    let key = if network == 42161 {
        "arbitrum"
    } else if network == 97 {
        "bsc-testnet"
    } else {
        "bsc"
    };
    if let Some(rpc) = settings.rpcs.get(key) {
        c.rpc = rpc.clone();
    }
    c.proxy = settings.proxy.clone();
    Ok(c)
}
fn sol_config(s: &Core) -> Result<solana::Config> {
    let settings = s.store.settings.lock().unwrap();
    let mut c: solana::Config = serde_json::from_value(settings.solana.clone())
        .map_err(|_| "Saved Solana settings are invalid.")?;
    if let Some(rpc) = settings.rpcs.get("solana") {
        c.rpc = rpc.clone()
    }
    c.proxy = settings.proxy.clone();
    Ok(c)
}

#[tauri::command]
fn bootstrap(window: WebviewWindow, s: State<'_, Arc<Core>>) -> Result<Value> {
    local(&window)?;
    Ok(
        json!({"version":"0.3.0","runtime":"Rust / Tokio","nodeRuntime":false,"chains":chains::catalogue(),"settings":s.store.settings.lock().unwrap().clone(),"accounts":s.wallets.accounts(),"stats":s.transport.stats(),"smoke":s.smoke}),
    )
}
#[tauri::command]
fn settings_save(
    window: WebviewWindow,
    s: State<'_, Arc<Core>>,
    settings: Settings,
) -> Result<Settings> {
    local(&window)?;
    s.previews.lock().unwrap().clear();
    s.sol_previews.lock().unwrap().clear();
    s.store.save(settings)
}
#[tauri::command]
fn settings_backup(window: WebviewWindow, s: State<'_, Arc<Core>>) -> Result<Settings> {
    local(&window)?;
    Ok(s.store.backup())
}
#[tauri::command]
async fn market_scan(
    window: WebviewWindow,
    s: State<'_, Arc<Core>>,
    filters: Filters,
) -> Result<MarketView> {
    local(&window)?;
    let settings = s.store.settings.lock().unwrap().clone();
    s.market
        .scan(&filters, &settings.watchlist, settings.market_proxy())
        .await
}
#[tauri::command]
fn market_view(
    window: WebviewWindow,
    s: State<'_, Arc<Core>>,
    filters: Filters,
) -> Result<MarketView> {
    local(&window)?;
    Ok(s.market.view(&filters))
}
#[tauri::command]
async fn market_search(
    window: WebviewWindow,
    s: State<'_, Arc<Core>>,
    scope: String,
    query: String,
) -> Result<Vec<Pair>> {
    local(&window)?;
    let proxy = s.store.settings.lock().unwrap().market_proxy().to_string();
    s.market.search(&scope, &query, &proxy).await
}
#[tauri::command]
async fn market_token(
    window: WebviewWindow,
    s: State<'_, Arc<Core>>,
    chain: String,
    mint: String,
) -> Result<Vec<Pair>> {
    local(&window)?;
    let proxy = s.store.settings.lock().unwrap().market_proxy().to_string();
    s.market.token_pairs(&chain, &mint, &proxy).await
}
#[tauri::command]
async fn market_proxy_check(window: WebviewWindow, s: State<'_, Arc<Core>>) -> Result<Value> {
    local(&window)?;
    let proxy = s.store.settings.lock().unwrap().market_proxy().to_string();
    let started = std::time::Instant::now();
    let v = s
        .transport
        .market_json("/token-boosts/top/v1", Duration::ZERO, true, &proxy)
        .await?;
    if !v.is_array() {
        return Err("Unexpected DEX Screener response.".into());
    }
    Ok(
        json!({"ok":true,"proxied":!proxy.trim().is_empty(),"elapsedMs":started.elapsed().as_millis()}),
    )
}
#[tauri::command]
fn network_stats(window: WebviewWindow, s: State<'_, Arc<Core>>) -> Result<Value> {
    local(&window)?;
    Ok(serde_json::to_value(s.transport.stats()).unwrap())
}
#[tauri::command]
fn wallet_accounts(window: WebviewWindow, s: State<'_, Arc<Core>>) -> Result<Value> {
    local(&window)?;
    Ok(json!(s.wallets.accounts()))
}
#[tauri::command]
fn wallet_lock(window: WebviewWindow, s: State<'_, Arc<Core>>) -> Result<()> {
    local(&window)?;
    s.wallets.lock();
    s.previews.lock().unwrap().clear();
    s.sol_previews.lock().unwrap().clear();
    Ok(())
}
#[tauri::command]
async fn wallet_import(
    window: WebviewWindow,
    s: State<'_, Arc<Core>>,
    kind: String,
    phrase: String,
    passphrase: String,
    path: String,
    password: String,
) -> Result<Value> {
    local(&window)?;
    let wallets = s.wallets.clone();
    let phrase = Zeroizing::new(phrase);
    let passphrase = Zeroizing::new(passphrase);
    let password = Zeroizing::new(password);
    tauri::async_runtime::spawn_blocking(move || {
        wallets
            .import(&kind, &phrase, &passphrase, &path, &password)
            .map(|a| json!(a))
    })
    .await
    .map_err(|_| "Wallet import could not complete.")?
}
#[tauri::command]
async fn wallet_unlock(
    window: WebviewWindow,
    s: State<'_, Arc<Core>>,
    kind: String,
    password: String,
) -> Result<Value> {
    local(&window)?;
    let wallets = s.wallets.clone();
    let password = Zeroizing::new(password);
    tauri::async_runtime::spawn_blocking(move || wallets.unlock(&kind, &password).map(|a| json!(a)))
        .await
        .map_err(|_| "Wallet unlock could not complete.")?
}
#[tauri::command]
async fn wallet_restore(
    window: WebviewWindow,
    s: State<'_, Arc<Core>>,
    backup: String,
    password: String,
) -> Result<Value> {
    local(&window)?;
    let wallets = s.wallets.clone();
    let password = Zeroizing::new(password);
    tauri::async_runtime::spawn_blocking(move || {
        wallets.import_backup(&backup, &password).map(|a| json!(a))
    })
    .await
    .map_err(|_| "Encrypted backup import could not complete.")?
}
#[tauri::command]
fn wallet_backup(window: WebviewWindow, s: State<'_, Arc<Core>>, kind: String) -> Result<Value> {
    local(&window)?;
    Ok(json!(s.wallets.backup(&kind)?))
}
#[tauri::command]
fn evm_settings(
    window: WebviewWindow,
    s: State<'_, Arc<Core>>,
    network: u64,
) -> Result<evm::Config> {
    local(&window)?;
    config(&s, network)
}
#[tauri::command]
async fn evm_check(window: WebviewWindow, s: State<'_, Arc<Core>>, network: u64) -> Result<Value> {
    local(&window)?;
    let c = config(&s, network)?;
    let owner = s.wallets.address("evm").ok();
    evm::diagnostics(&c, owner.as_deref(), s.transport.clone()).await
}
#[tauri::command]
async fn evm_scan(
    window: WebviewWindow,
    s: State<'_, Arc<Core>>,
    network: u64,
    token: Option<String>,
    symbol: Option<String>,
) -> Result<evm::Report> {
    local(&window)?;
    let c = config(&s, network)?;
    let discovered = token.map(|address| {
        vec![evm::Asset {
            symbol: symbol.unwrap_or("TOKEN".into()),
            address,
            enabled: true,
        }]
    });
    evm::scan(&c, s.transport.clone(), discovered).await
}
#[tauri::command]
async fn evm_prepare(
    window: WebviewWindow,
    s: State<'_, Arc<Core>>,
    network: u64,
    action: String,
    input: Value,
) -> Result<evm::Preview> {
    local(&window)?;
    let owner = s.wallets.address("evm")?;
    let c = config(&s, network)?;
    let preview = evm::prepare(&c, &action, &input, &owner, s.transport.clone()).await?;
    let mut saved = s.previews.lock().unwrap();
    saved.retain(|_, p| p.expires > now_ms());
    if saved.len() >= 8 {
        saved.clear();
    }
    saved.insert(preview.id.clone(), preview.clone());
    Ok(preview)
}
#[tauri::command]
async fn evm_submit(
    window: WebviewWindow,
    s: State<'_, Arc<Core>>,
    id: String,
    confirmed: bool,
) -> Result<Value> {
    local(&window)?;
    if !confirmed {
        return Err("Explicit transaction confirmation is required.".into());
    }
    let _guard = s
        .signing
        .try_lock()
        .map_err(|_| "Another signing operation is in progress.")?;
    let p = s
        .previews
        .lock()
        .unwrap()
        .remove(&id)
        .ok_or("Review expired or was already consumed. Prepare again.")?;
    if s.wallets.address("evm")? != p.owner {
        return Err("Wallet changed since the review.".into());
    }
    let rpc = evm::preflight(&p, s.transport.clone()).await?;
    let key = s.wallets.key("evm")?;
    let (raw, hash) = evm::sign_transaction(&p, &key)?;
    if s.wallets.address("evm")? != p.owner {
        return Err("Wallet was locked before submission.".into());
    }
    let record = json!({"id":format!("evm:{}:{hash}",p.chain_id),"kind":"evm","network":p.chain_id,"owner":p.owner,"action":p.kind,"description":p.description,"hash":hash,"at":now_ms(),"status":"unknown","cost":p.cost,"nonce":p.nonce});
    s.store.record(record.clone())?;
    let response = rpc.send("eth_sendRawTransaction", json!([raw])).await;
    let status = match response {
        Ok(v) if v.as_str().is_some_and(|v| v.eq_ignore_ascii_case(&hash)) => "pending",
        _ => "unknown",
    };
    let mut record = record;
    record["status"] = json!(status);
    s.store.record(record)?;
    Ok(
        json!({"hash":hash,"status":status,"note":if status=="unknown"{"Submission result is uncertain. The intended hash is saved; check confirmations before any further action."}else{"Submitted once. Check confirmations; no automatic resubmission."}}),
    )
}
#[tauri::command]
async fn solana_check(window: WebviewWindow, s: State<'_, Arc<Core>>) -> Result<Value> {
    local(&window)?;
    let c = sol_config(&s)?;
    let owner = s.wallets.address("solana").ok();
    solana::check(&c, owner.as_deref(), s.transport.clone()).await
}
#[tauri::command]
async fn solana_quote(
    window: WebviewWindow,
    s: State<'_, Arc<Core>>,
    token: String,
    symbol: String,
) -> Result<solana_engine::Report> {
    local(&window)?;
    let c = sol_config(&s)?;
    let proxy = s.store.settings.lock().unwrap().market_proxy().to_string();
    solana_engine::quotes(&c, &token, &symbol, s.transport.clone(), &proxy).await
}
#[tauri::command]
async fn solana_prepare(
    window: WebviewWindow,
    s: State<'_, Arc<Core>>,
    token: String,
    symbol: String,
    route_id: String,
) -> Result<solana_engine::Preview> {
    local(&window)?;
    let c = sol_config(&s)?;
    let owner = s.wallets.address("solana")?;
    let proxy = s.store.settings.lock().unwrap().market_proxy().to_string();
    let p = solana_engine::prepare(
        &c,
        &token,
        &symbol,
        &route_id,
        &owner,
        s.transport.clone(),
        &proxy,
    )
    .await?;
    let mut previews = s.sol_previews.lock().unwrap();
    previews.retain(|_, p| p.expires > now_ms());
    if previews.len() >= 8 {
        previews.clear();
    }
    previews.insert(p.id.clone(), p.clone());
    Ok(p)
}
#[tauri::command]
async fn solana_submit(
    window: WebviewWindow,
    s: State<'_, Arc<Core>>,
    id: String,
    confirmed: bool,
) -> Result<Value> {
    use base64::{engine::general_purpose::STANDARD as B64, Engine};
    local(&window)?;
    if !confirmed {
        return Err("Explicit transaction confirmation is required.".into());
    }
    let _guard = s
        .signing
        .try_lock()
        .map_err(|_| "Another signing operation is in progress.")?;
    let p = s
        .sol_previews
        .lock()
        .unwrap()
        .remove(&id)
        .ok_or("Review expired or was already used. Prepare again.")?;
    if s.wallets.address("solana")? != p.owner {
        return Err("Signing wallet changed.".into());
    }
    let r = solana_engine::preflight(&p, s.transport.clone()).await?;
    let seed = s.wallets.key("solana")?;
    let (raw, signature, sigbytes) = solana_engine::sign(&p, &seed)?;
    drop(seed);
    solana_codec::simulate(&r, &p.message, Some(&sigbytes)).await?;
    if now_ms() > p.expires || s.wallets.address("solana")? != p.owner {
        return Err("Review expired or wallet locked before submission.".into());
    }
    let record = json!({"id":format!("solana:{signature}"),"kind":"solana","owner":p.owner,"action":"flash trade","signature":signature,"at":now_ms(),"status":"unknown","cost":p.fee,"lastValidBlockHeight":p.last_valid_block_height});
    s.store.record(record.clone())?;
    let response=r.send("sendTransaction",json!([B64.encode(raw),{"encoding":"base64","skipPreflight":false,"preflightCommitment":"confirmed","maxRetries":0}])).await;
    let status = match response {
        Ok(v) if v.as_str() == Some(&signature) => "pending",
        _ => "unknown",
    };
    let mut record = record;
    record["status"] = json!(status);
    s.store.record(record)?;
    Ok(
        json!({"signature":signature,"status":status,"note":if status=="unknown"{"Submission result is uncertain. Check the saved signature before any further action."}else{"Submitted once. Check confirmations; no automatic resubmission."}}),
    )
}
#[tauri::command]
fn transaction_history(window: WebviewWindow, s: State<'_, Arc<Core>>) -> Result<Vec<Value>> {
    local(&window)?;
    Ok(s.store.history())
}
#[tauri::command]
async fn transaction_check(window: WebviewWindow, s: State<'_, Arc<Core>>) -> Result<Vec<Value>> {
    local(&window)?;
    let items = s.store.history();
    for network in [56, 97, 42161] {
        let pending: Vec<_> = items
            .iter()
            .filter(|v| {
                v["kind"] == "evm"
                    && v["network"] == network
                    && ["pending", "unknown", "confirming"]
                        .contains(&v["status"].as_str().unwrap_or(""))
            })
            .take(30)
            .collect();
        if pending.is_empty() {
            continue;
        }
        let c = config(&s, network)?;
        let r = Rpc::new(s.transport.clone(), &c.rpc, &c.proxy)?;
        if hex_uint(&r.send("eth_chainId", json!([])).await?)?
            != primitive_types::U256::from(network)
        {
            return Err("Receipt RPC chain mismatch.".into());
        }
        let tip = hex_uint(&r.send("eth_blockNumber", json!([])).await?)?;
        let responses = r
            .batch(
                pending
                    .iter()
                    .map(|v| ("eth_getTransactionReceipt".into(), json!([v["hash"]])))
                    .collect(),
            )
            .await;
        for (item, result) in pending.into_iter().zip(responses) {
            if let Ok(value) = result {
                if !value.is_null() {
                    let block = hex_uint(&value["blockNumber"])?;
                    let confirmations = tip.saturating_sub(block) + primitive_types::U256::one();
                    let status = if confirmations < primitive_types::U256::from(2) {
                        "confirming"
                    } else if hex_uint(&value["status"])? == primitive_types::U256::one() {
                        "confirmed"
                    } else {
                        "reverted"
                    };
                    let cost =
                        hex_uint(&value["gasUsed"])? * hex_uint(&value["effectiveGasPrice"])?;
                    s.store.record(json!({"id":item["id"],"status":status,"confirmations":confirmations.as_u64(),"block":block.as_u64(),"actualCost":decimal(cost,18),"contractAddress":value["contractAddress"]}))?;
                }
            }
        }
    }
    let pending: Vec<_> = items
        .iter()
        .filter(|v| {
            v["kind"] == "solana"
                && ["pending", "unknown"].contains(&v["status"].as_str().unwrap_or(""))
        })
        .take(20)
        .collect();
    if !pending.is_empty() {
        let c = sol_config(&s)?;
        let r = solana::rpc(&c, s.transport.clone()).await?;
        let signatures: Vec<_> = pending.iter().map(|v| v["signature"].clone()).collect();
        let status = r
            .send(
                "getSignatureStatuses",
                json!([signatures,{"searchTransactionHistory":true}]),
            )
            .await?;
        let height = r
            .send("getBlockHeight", json!([{"commitment":"confirmed"}]))
            .await?
            .as_u64()
            .ok_or("Invalid Solana block height.")?;
        let rows = status["value"]
            .as_array()
            .filter(|v| v.len() == pending.len())
            .ok_or("Invalid signature status response.")?;
        for (item, v) in pending.into_iter().zip(rows) {
            let state = if !v.is_null() {
                if !v["err"].is_null() {
                    "failed"
                } else if ["confirmed", "finalized"]
                    .contains(&v["confirmationStatus"].as_str().unwrap_or(""))
                {
                    "confirmed"
                } else {
                    "pending"
                }
            } else if height > item["lastValidBlockHeight"].as_u64().unwrap_or(u64::MAX) {
                "expired"
            } else {
                "unknown"
            };
            s.store
                .record(json!({"id":item["id"],"status":state,"slot":v["slot"]}))?;
        }
    }
    Ok(s.store.history())
}
#[tauri::command]
fn open_chart(window: WebviewWindow, url: String) -> Result<()> {
    local(&window)?;
    let u = url::Url::parse(&url).map_err(|_| "Invalid chart URL.")?;
    if u.scheme() != "https"
        || u.host_str() != Some("dexscreener.com")
        || !u.username().is_empty()
        || u.password().is_some()
    {
        return Err("Only DEX Screener chart links are allowed.".into());
    }
    std::process::Command::new("explorer.exe")
        .arg(u.as_str())
        .spawn()
        .map_err(|_| "Could not open the chart in your browser.")?;
    Ok(())
}
#[tauri::command]
fn smoke_report(
    window: WebviewWindow,
    s: State<'_, Arc<Core>>,
    app: tauri::AppHandle,
    report: Value,
) -> Result<()> {
    local(&window)?;
    if !s.smoke {
        return Err("Test command is unavailable in normal operation.".into());
    }
    let ok = report["ui"] == true
        && report["ipc"] == true
        && report["nodeAbsent"] == true
        && report["chains"].as_u64().unwrap_or(0) >= 64;
    println!(
        "NATIVE_DESKTOP_SMOKE {} {}",
        if ok { "PASS" } else { "FAIL" },
        report
    );
    app.exit(if ok { 0 } else { 1 });
    Ok(())
}

pub fn run() {
    let smoke = std::env::args().any(|a| a == "--smoke-test");
    let base = if smoke {
        std::env::temp_dir().join(format!("vigilant-native-smoke-{}", std::process::id()))
    } else {
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|p| p.join("VigilantEngine-Rust-Data")))
            .expect("executable directory")
    };
    let store = match Store::open(base.clone()) {
        Ok(s) => Arc::new(s),
        Err(e) => {
            eprintln!("{e}");
            return;
        }
    };
    let wallets = Arc::new(Wallets::open(&base).expect("encrypted wallet storage"));
    let transport = Arc::new(Transport::new());
    let core = Arc::new(Core {
        market: MarketEngine::new(transport.clone()),
        transport,
        store,
        wallets,
        previews: Mutex::new(HashMap::new()),
        sol_previews: Mutex::new(HashMap::new()),
        signing: tokio::sync::Mutex::new(()),
        smoke,
    });
    let shutdown = core.wallets.clone();
    let timer = core.wallets.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(15)).await;
            let _ = timer.accounts();
        }
    });
    tauri::Builder::default().manage(core)
        .invoke_handler(tauri::generate_handler![bootstrap,settings_save,settings_backup,market_scan,market_view,market_search,market_token,market_proxy_check,network_stats,wallet_accounts,wallet_lock,wallet_import,wallet_unlock,wallet_restore,wallet_backup,evm_settings,evm_check,evm_scan,evm_prepare,evm_submit,solana_check,solana_quote,solana_prepare,solana_submit,transaction_history,transaction_check,open_chart,smoke_report])
        .setup(move|app|{let window=WebviewWindowBuilder::new(app,"main",WebviewUrl::App("index.html".into())).title("Vigilant Engine Native").inner_size(1440.0,960.0).min_inner_size(920.0,640.0).data_directory(base.join("webview")).on_navigation(|u|u.scheme()=="tauri"||u.host_str()==Some("tauri.localhost")).build()?;
            if smoke{let handle=app.handle().clone();tauri::async_runtime::spawn(async move{tokio::time::sleep(Duration::from_secs(3)).await;let _=window.eval("window.runNativeSmokeTest && window.runNativeSmokeTest()");tokio::time::sleep(Duration::from_secs(30)).await;handle.exit(1);});}Ok(())})
        .on_window_event(move|_,event|{if matches!(event,tauri::WindowEvent::CloseRequested{..}){shutdown.lock();}})
        .run(tauri::generate_context!()).expect("Vigilant Engine Native could not start. Ensure Microsoft Edge WebView2 Runtime is installed.");
}
