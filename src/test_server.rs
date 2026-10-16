//! Local-only HTTP fixtures; no wallet or upstream service is contacted by tests.
use serde_json::Value;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Mutex,
};
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
pub struct Server {
    pub url: String,
    pub requests: Arc<AtomicUsize>,
    pub connections: Arc<AtomicUsize>,
    pub headers: Arc<Mutex<Vec<String>>>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}
pub async fn server(
    handler: impl Fn(Value) -> (u16, Value) + Send + Sync + 'static,
    delay: Duration,
) -> Server {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let requests = Arc::new(AtomicUsize::new(0));
    let connections = Arc::new(AtomicUsize::new(0));
    let headers = Arc::new(Mutex::new(Vec::new()));
    let handler = Arc::new(handler);
    let (c, r, h) = (connections.clone(), requests.clone(), headers.clone());
    let task = tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                break;
            };
            c.fetch_add(1, Ordering::SeqCst);
            let (handler, r, h) = (handler.clone(), r.clone(), h.clone());
            tokio::spawn(async move {
                loop {
                    let mut bytes = Vec::new();
                    let header_end = loop {
                        let mut b = [0; 1024];
                        let Ok(n) = stream.read(&mut b).await else {
                            return;
                        };
                        if n == 0 {
                            return;
                        }
                        bytes.extend_from_slice(&b[..n]);
                        if bytes.len() > 100000 {
                            return;
                        }
                        if let Some(p) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                            break p + 4;
                        }
                    };
                    let head = String::from_utf8_lossy(&bytes[..header_end]).to_string();
                    let size = head
                        .lines()
                        .find_map(|s| {
                            s.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .and_then(|n| n.trim().parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    while bytes.len() < header_end + size {
                        let mut b = [0; 1024];
                        let Ok(n) = stream.read(&mut b).await else {
                            return;
                        };
                        if n == 0 {
                            return;
                        }
                        bytes.extend_from_slice(&b[..n]);
                    }
                    let body = serde_json::from_slice(&bytes[header_end..header_end + size])
                        .unwrap_or(Value::Null);
                    h.lock().unwrap().push(head);
                    r.fetch_add(1, Ordering::SeqCst);
                    tokio::time::sleep(delay).await;
                    let (status, value) = handler(body);
                    let data = value.to_string();
                    let reply=format!("HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: keep-alive\r\n\r\n{data}",data.len());
                    if stream.write_all(reply.as_bytes()).await.is_err() {
                        return;
                    }
                }
            });
        }
    });
    Server {
        url,
        requests,
        connections,
        headers,
        task,
    }
}
