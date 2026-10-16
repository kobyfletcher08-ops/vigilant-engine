use crate::Result;
use futures::StreamExt;
use reqwest::{redirect::Policy, Client, Proxy};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tokio::sync::{OnceCell, Semaphore};
use url::Url;

const MAX_RESPONSE: usize = 4 * 1024 * 1024;
#[derive(Clone)]
pub struct ProxyConfig {
    pub uri: String,
    pub user: String,
    pub password: String,
}
pub fn parse_proxy(input: &str) -> Result<Option<ProxyConfig>> {
    let input = input.trim();
    if input.is_empty() {
        return Ok(None);
    }
    let (scheme, rest) = input.split_once("://").unwrap_or(("http", input));
    if !["http", "https"].contains(&scheme) {
        return Err("Proxy must use HTTP or HTTPS.".into());
    }
    let tuple = rest
        .split(':')
        .nth(1)
        .is_some_and(|p| p.parse::<u16>().is_ok());
    let (uri, user, password) = if input.contains("://") && !tuple {
        let u = Url::parse(input).map_err(|_| "Invalid proxy URL.")?;
        if u.path() != "/" || u.query().is_some() || u.fragment().is_some() {
            return Err("Proxy URL must not include a path, query or fragment.".into());
        }
        let host = u.host_str().ok_or("Proxy hostname is required.")?;
        let port = u.port().unwrap_or(if scheme == "https" { 443 } else { 80 });
        (
            format!(
                "{scheme}://{}:{port}",
                if host.contains(':') {
                    format!("[{host}]")
                } else {
                    host.into()
                }
            ),
            percent_encoding::percent_decode_str(u.username())
                .decode_utf8_lossy()
                .into_owned(),
            percent_encoding::percent_decode_str(u.password().unwrap_or(""))
                .decode_utf8_lossy()
                .into_owned(),
        )
    } else {
        let parts: Vec<_> = rest.splitn(4, ':').collect();
        if parts.len() != 2 && parts.len() != 4 {
            return Err("Use hostname:port:login:password or an HTTP(S) proxy URL.".into());
        }
        let port: u16 = parts[1].parse().map_err(|_| "Invalid proxy port.")?;
        if port == 0
            || parts[0].is_empty()
            || parts[0]
                .chars()
                .any(|c| c.is_whitespace() || "/@?#".contains(c))
        {
            return Err("Invalid proxy host or port.".into());
        }
        (
            format!("{scheme}://{}:{port}", parts[0]),
            parts.get(2).unwrap_or(&"").to_string(),
            parts.get(3).unwrap_or(&"").to_string(),
        )
    };
    Url::parse(&uri).map_err(|_| "Invalid proxy endpoint.")?;
    Ok(Some(ProxyConfig {
        uri,
        user,
        password,
    }))
}
pub fn rpc_url(input: &str) -> Result<Url> {
    let u = Url::parse(input).map_err(|_| "Enter a valid RPC URL.")?;
    if !["http", "https"].contains(&u.scheme())
        || u.host_str().is_none()
        || !u.username().is_empty()
        || u.password().is_some()
        || u.fragment().is_some()
    {
        return Err("RPC must be HTTP(S), without credentials or fragments.".into());
    }
    Ok(u)
}

struct Window {
    starts: VecDeque<Instant>,
    limit: usize,
    blocked: Option<Instant>,
}
impl Window {
    fn remaining(&self) -> usize {
        self.limit.saturating_sub(
            self.starts
                .iter()
                .filter(|t| t.elapsed() < Duration::from_secs(60))
                .count(),
        )
    }
    fn take(&mut self, now: Instant) -> Result<()> {
        if let Some(until) = self.blocked {
            if until > now {
                return Err(format!(
                    "DEX Screener cooldown: retry in {} seconds.",
                    (until - now).as_secs() + 1
                ));
            }
        }
        while self
            .starts
            .front()
            .is_some_and(|t| now.duration_since(*t) >= Duration::from_secs(60))
        {
            self.starts.pop_front();
        }
        if self.starts.len() >= self.limit {
            return Err(
                "Market request budget reached. Cached results are retained; retry shortly.".into(),
            );
        }
        self.starts.push_back(now);
        Ok(())
    }
}
#[derive(Clone)]
struct Cached {
    value: Arc<Value>,
    expires: Instant,
    bytes: usize,
}
type Flight = Arc<OnceCell<Result<Arc<Value>>>>;
#[derive(Default)]
struct Metrics {
    requests: AtomicU64,
    hits: AtomicU64,
    active: AtomicUsize,
    peak: AtomicUsize,
    elapsed: AtomicU64,
    errors: AtomicU64,
}
struct Active<'a>(&'a Metrics);
impl Drop for Active<'_> {
    fn drop(&mut self) {
        self.0.active.fetch_sub(1, Ordering::Relaxed);
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub requests: u64,
    pub cache_hits: u64,
    pub active: usize,
    pub peak_concurrency: usize,
    pub average_ms: u64,
    pub errors: u64,
    pub cached_entries: usize,
    pub cache_bytes: usize,
    pub cooldown_seconds: u64,
    pub market_remaining: usize,
    pub metadata_remaining: usize,
}
pub struct Transport {
    clients: Mutex<HashMap<String, Client>>,
    permits: Semaphore,
    market_permits: Semaphore,
    market: Mutex<Window>,
    metadata: Mutex<Window>,
    cache: Mutex<HashMap<String, Cached>>,
    flights: Mutex<HashMap<String, Flight>>,
    metrics: Metrics,
}
impl Default for Transport {
    fn default() -> Self {
        Self::new()
    }
}
impl Transport {
    pub fn new() -> Self {
        Self {
            clients: Mutex::new(HashMap::new()),
            permits: Semaphore::new(8),
            market_permits: Semaphore::new(6),
            market: Mutex::new(Window {
                starts: VecDeque::new(),
                limit: 270,
                blocked: None,
            }),
            metadata: Mutex::new(Window {
                starts: VecDeque::new(),
                limit: 45,
                blocked: None,
            }),
            cache: Mutex::new(HashMap::new()),
            flights: Mutex::new(HashMap::new()),
            metrics: Metrics::default(),
        }
    }
    pub fn stats(&self) -> Stats {
        let (cooldown_seconds, market_remaining) = {
            let w = self.market.lock().unwrap();
            (
                w.blocked
                    .and_then(|t| t.checked_duration_since(Instant::now()))
                    .map(|d| d.as_secs() + 1)
                    .unwrap_or(0),
                w.remaining(),
            )
        };
        let metadata_remaining = self.metadata.lock().unwrap().remaining();
        let m = &self.metrics;
        let r = m.requests.load(Ordering::Relaxed);
        let c = self.cache.lock().unwrap();
        Stats {
            requests: r,
            cache_hits: m.hits.load(Ordering::Relaxed),
            active: m.active.load(Ordering::Relaxed),
            peak_concurrency: m.peak.load(Ordering::Relaxed),
            average_ms: if r > 0 {
                m.elapsed.load(Ordering::Relaxed) / r
            } else {
                0
            },
            errors: m.errors.load(Ordering::Relaxed),
            cached_entries: c.len(),
            cache_bytes: c.values().map(|v| v.bytes).sum(),
            cooldown_seconds,
            market_remaining,
            metadata_remaining,
        }
    }
    fn key(proxy: &str) -> String {
        hex::encode(Sha256::digest(proxy.as_bytes()))
    }
    fn client(&self, proxy: &str) -> Result<Client> {
        let key = Self::key(proxy);
        if let Some(c) = self.clients.lock().unwrap().get(&key) {
            return Ok(c.clone());
        }
        let mut builder = Client::builder()
            .timeout(Duration::from_secs(12))
            .connect_timeout(Duration::from_secs(5))
            .pool_idle_timeout(Duration::from_secs(90))
            .pool_max_idle_per_host(16)
            .redirect(Policy::none())
            .user_agent("VigilantEngine-Native/0.3.0");
        if let Some(p) = parse_proxy(proxy)? {
            let mut agent = Proxy::all(&p.uri).map_err(|_| "Invalid proxy configuration.")?;
            if !p.user.is_empty() {
                agent = agent.basic_auth(&p.user, &p.password);
            }
            builder = builder.proxy(agent);
        } else {
            builder = builder.no_proxy();
        }
        let c = builder
            .build()
            .map_err(|_| "Could not configure the HTTP client.")?;
        let mut clients = self.clients.lock().unwrap();
        if clients.len() >= 16 {
            clients.clear();
        }
        clients.insert(key, c.clone());
        Ok(c)
    }
    pub async fn json(&self, url: &str, body: Option<&Value>, proxy: &str) -> Result<Value> {
        let _market = if url.starts_with("https://api.dexscreener.com/") {
            Some(
                self.market_permits
                    .acquire()
                    .await
                    .map_err(|_| "Market engine stopped.")?,
            )
        } else {
            None
        };
        let permit = self
            .permits
            .acquire()
            .await
            .map_err(|_| "Network engine stopped.")?;
        let client = self.client(proxy)?;
        let started = Instant::now();
        let n = self.metrics.active.fetch_add(1, Ordering::Relaxed) + 1;
        self.metrics.peak.fetch_max(n, Ordering::Relaxed);
        let _active = Active(&self.metrics);
        self.metrics.requests.fetch_add(1, Ordering::Relaxed);
        let request = if let Some(body) = body {
            client.post(url).json(body)
        } else {
            client.get(url)
        };
        let response = request.send().await.map_err(|_| {
            self.metrics.errors.fetch_add(1, Ordering::Relaxed);
            "Network request failed. Check the connection, RPC endpoint or proxy.".to_string()
        })?;
        let status = response.status();
        if status.as_u16() == 429 {
            let retry = response
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(60)
                .clamp(1, 300);
            if url.starts_with("https://api.dexscreener.com/") {
                let until = Some(Instant::now() + Duration::from_secs(retry));
                self.market.lock().unwrap().blocked = until;
                self.metadata.lock().unwrap().blocked = until;
            }
            self.metrics.errors.fetch_add(1, Ordering::Relaxed);
            return Err(format!("Upstream rate limit: retry in {retry} seconds."));
        }
        if !status.is_success() {
            self.metrics.errors.fetch_add(1, Ordering::Relaxed);
            return Err(format!(
                "Upstream returned HTTP {}. Requests are not redirected or silently retried.",
                status.as_u16()
            ));
        }
        if response
            .content_length()
            .is_some_and(|n| n > MAX_RESPONSE as u64)
        {
            return Err("Response exceeds the size limit.".into());
        }
        let mut stream = response.bytes_stream();
        let mut data = Vec::new();
        while let Some(part) = stream.next().await {
            let part = part.map_err(|_| "Response transfer failed.")?;
            if data.len() + part.len() > MAX_RESPONSE {
                return Err("Response exceeds the size limit.".into());
            }
            data.extend_from_slice(&part);
        }
        self.metrics
            .elapsed
            .fetch_add(started.elapsed().as_millis() as u64, Ordering::Relaxed);
        drop(permit);
        serde_json::from_slice(&data).map_err(|_| "Upstream returned invalid JSON.".into())
    }
    pub async fn market_json(
        &self,
        path: &str,
        ttl: Duration,
        metadata: bool,
        proxy: &str,
    ) -> Result<Arc<Value>> {
        if !path.starts_with('/') || path.starts_with("//") {
            return Err("Invalid market API path.".into());
        }
        let key = Self::key(proxy) + path;
        if let Some(c) = self
            .cache
            .lock()
            .unwrap()
            .get(&key)
            .filter(|v| v.expires > Instant::now())
        {
            self.metrics.hits.fetch_add(1, Ordering::Relaxed);
            return Ok(c.value.clone());
        }
        let flight = {
            self.flights
                .lock()
                .unwrap()
                .entry(key.clone())
                .or_insert_with(|| Arc::new(OnceCell::new()))
                .clone()
        };
        let result = flight
            .get_or_init(|| async {
                let window = if metadata {
                    &self.metadata
                } else {
                    &self.market
                };
                window.lock().unwrap().take(Instant::now())?;
                let value = Arc::new(
                    self.json(
                        &("https://api.dexscreener.com".to_string() + path),
                        None,
                        proxy,
                    )
                    .await?,
                );
                let bytes = value.to_string().len();
                let mut cache = self.cache.lock().unwrap();
                cache.retain(|_, c| c.expires > Instant::now());
                while cache.len() >= 128
                    || cache.values().map(|v| v.bytes).sum::<usize>() + bytes > 32 * 1024 * 1024
                {
                    let oldest = cache
                        .iter()
                        .min_by_key(|(_, v)| v.expires)
                        .map(|(k, _)| k.clone());
                    if let Some(k) = oldest {
                        cache.remove(&k);
                    } else {
                        break;
                    }
                }
                cache.insert(
                    key.clone(),
                    Cached {
                        value: value.clone(),
                        expires: Instant::now() + ttl,
                        bytes,
                    },
                );
                Ok(value)
            })
            .await
            .clone();
        let mut flights = self.flights.lock().unwrap();
        if flights.get(&key).is_some_and(|f| Arc::ptr_eq(f, &flight)) {
            flights.remove(&key);
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_authenticated_proxy_without_losing_password_punctuation() {
        let p = parse_proxy("host.test:8080:user:p:a@ss").unwrap().unwrap();
        // An @ inside tuple passwords must not be confused with URL credentials.
        assert_eq!(p.user, "user");
        assert_eq!(p.password, "p:a@ss");
        let p = parse_proxy("https://u%40x:p%3Aa@host.test:8443")
            .unwrap()
            .unwrap();
        assert_eq!(p.uri, "https://host.test:8443");
        assert_eq!(p.user, "u@x");
        assert_eq!(p.password, "p:a");
        assert!(parse_proxy("socks5://host:1080").is_err());
    }
    #[test]
    fn rate_budget_is_shared_bounded_and_recovers() {
        let now = Instant::now();
        let mut w = Window {
            starts: VecDeque::new(),
            limit: 2,
            blocked: None,
        };
        assert!(w.take(now).is_ok());
        assert!(w.take(now).is_ok());
        assert!(w.take(now).is_err());
        assert!(w.take(now + Duration::from_secs(61)).is_ok());
    }
    #[test]
    fn permits_private_rpc_but_rejects_embedded_credentials() {
        assert!(rpc_url("http://localhost:8899").is_ok());
        assert!(rpc_url("http://127.0.0.1:8545").is_ok());
        assert!(rpc_url("https://user:secret@host.test").is_err());
    }
}
