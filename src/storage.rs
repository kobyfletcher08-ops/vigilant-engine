use crate::{
    transport::{parse_proxy, rpc_url},
    Result,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub proxy: String,
    pub market_proxy: String,
    pub rpcs: BTreeMap<String, String>,
    pub watchlist: BTreeMap<String, Vec<String>>,
    pub refresh_seconds: u64,
    pub evm: BTreeMap<String, Value>,
    pub solana: Value,
    pub market: Value,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            proxy: String::new(),
            market_proxy: String::new(),
            rpcs: BTreeMap::from([
                ("bsc".into(), "https://bsc-dataseed.bnbchain.org".into()),
                ("arbitrum".into(), "https://arb1.arbitrum.io/rpc".into()),
                (
                    "solana".into(),
                    "https://api.mainnet-beta.solana.com".into(),
                ),
            ]),
            watchlist: BTreeMap::new(),
            refresh_seconds: 5,
            evm: BTreeMap::new(),
            solana: json!({"amount":"1","minProfit":"0.0001","gasBudget":"0.001","slippageBps":10,"priorityFee":25000,"lookupTables":[]}),
            market: json!({"scope":"all","mode":"gainers","timeframe":"h24","minLiquidity":25000,"minVolume":5000,"minSpread":0.5,"activeOnly":true,"page":0,"pageSize":75,"query":""}),
        }
    }
}
impl Settings {
    pub fn market_proxy(&self) -> &str {
        if self.market_proxy.trim().is_empty() {
            &self.proxy
        } else {
            &self.market_proxy
        }
    }
}
pub struct Store {
    pub directory: PathBuf,
    pub settings: Mutex<Settings>,
    history: Mutex<Vec<Value>>,
}
pub fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    let temp = path.with_extension("tmp");
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts
        .open(&temp)
        .map_err(|_| "Cannot write to the application data directory.")?;
    file.write_all(bytes)
        .map_err(|_| "Could not save application data.")?;
    file.sync_all()
        .map_err(|_| "Could not flush application data.")?;
    drop(file);
    fs::rename(temp, path).map_err(|_| "Could not replace the application data file.".into())
}
impl Store {
    pub fn open(directory: PathBuf) -> Result<Self> {
        fs::create_dir_all(&directory).map_err(|_| "Cannot create the application data folder.")?;
        let settings=match fs::read(directory.join("settings.json")){Ok(b)if b.len()<256000=>serde_json::from_slice(&b).map_err(|_|"Saved settings are damaged. Preserve the data folder and restore a configuration backup.")?,Ok(_)=>return Err("Saved settings exceed the size limit.".into()),Err(e)if e.kind()==std::io::ErrorKind::NotFound=>Settings::default(),Err(_)=>return Err("Could not read saved settings.".into())};
        let history = fs::read(directory.join("transactions.json"))
            .ok()
            .filter(|b| b.len() < 4_000_000)
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        Ok(Self {
            directory,
            settings: Mutex::new(settings),
            history: Mutex::new(history),
        })
    }
    pub fn save(&self, settings: Settings) -> Result<Settings> {
        parse_proxy(&settings.proxy)?;
        parse_proxy(&settings.market_proxy)?;
        if !(5..=3600).contains(&settings.refresh_seconds) {
            return Err("Refresh interval must be 5–3600 seconds.".into());
        }
        if settings.rpcs.len() > 150 || settings.watchlist.len() > 150 {
            return Err("Too many chain settings.".into());
        }
        for (c, url) in &settings.rpcs {
            crate::chains::validate_chain(c)?;
            rpc_url(url)?;
        }
        for (c, mints) in &settings.watchlist {
            crate::chains::validate_chain(c)?;
            if mints.len() > 30 || mints.iter().any(|m| !crate::chains::valid_token(c, m)) {
                return Err("Invalid watchlist: use up to 30 valid addresses per chain.".into());
            }
        }
        let bytes =
            serde_json::to_vec_pretty(&settings).map_err(|_| "Could not encode settings.")?;
        if bytes.len() > 256000 {
            return Err("Settings exceed the size limit.".into());
        }
        write_private(&self.directory.join("settings.json"), &bytes)?;
        *self.settings.lock().unwrap() = settings.clone();
        Ok(settings)
    }
    pub fn history(&self) -> Vec<Value> {
        self.history.lock().unwrap().clone()
    }
    pub fn record(&self, item: Value) -> Result<()> {
        let mut history = self.history.lock().unwrap();
        if let Some(old) = history
            .iter_mut()
            .find(|v| v.get("id").is_some() && v.get("id") == item.get("id"))
        {
            if let (Some(a), Some(b)) = (old.as_object_mut(), item.as_object()) {
                a.extend(b.clone());
            }
        } else {
            history.push(item);
        }
        let remove = history.len().saturating_sub(1000);
        if remove > 0 {
            history.drain(..remove);
        }
        write_private(
            &self.directory.join("transactions.json"),
            &serde_json::to_vec_pretty(&*history)
                .map_err(|_| "Could not encode transaction history.")?,
        )
    }
    pub fn backup(&self) -> Settings {
        let mut s = self.settings.lock().unwrap().clone();
        s.proxy.clear();
        s.market_proxy.clear();
        s.rpcs = Settings::default().rpcs;
        for v in s.evm.values_mut() {
            if let Some(o) = v.as_object_mut() {
                o.remove("proxy");
                o.remove("rpc");
            }
        }
        if let Some(o) = s.solana.as_object_mut() {
            o.remove("proxy");
            o.remove("rpc");
        }
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn backup_strips_rpc_keys_and_proxy_credentials() {
        let d = std::env::temp_dir().join(format!("vigilant-storage-{}", crate::now_ms()));
        let s = Store::open(d.clone()).unwrap();
        let mut config = Settings::default();
        config.proxy = "proxy.test:8080:login:password".into();
        config
            .rpcs
            .insert("bsc".into(), "https://rpc.test/secret-key".into());
        s.save(config).unwrap();
        let backup = serde_json::to_string(&s.backup()).unwrap();
        assert!(!backup.contains("password"));
        assert!(!backup.contains("secret-key"));
        fs::remove_dir_all(d).unwrap();
    }
}
