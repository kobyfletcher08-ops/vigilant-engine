# Vigilant Engine Native 0.3

A Windows arbitrage console with a native Rust backend and the Windows WebView2 interface. The application and its build use no Node.js, Electron, npm, or JavaScript blockchain SDKs. Plain browser JavaScript renders the local interface; Rust handles requests, analysis, wallet encryption, transaction construction and signing.

## Market coverage

- Catalogue of all 64 chains listed by DEX Screener when this release was prepared, plus valid chain identifiers returned by its API.
- Track any DEX platform returned by the public API; top gainers, volume and liquidity rankings; exact-address cross-pool comparisons; watchlists; search; live price trails and CSV export.
- Concurrent pooled HTTP, 30-token API batches, in-flight request coalescing, bounded caches and response sizes, shared request budgets and HTTP 429 cooldowns. RPC traffic retains request capacity during market refreshes.
- A default authenticated HTTP/HTTPS proxy and an independent DEX Screener proxy override, accepting `hostname:port:login:password` or a proxy URL. Rotating gateways receive a fresh HTTP/1 connection per outgoing market request so HTTPS tunnel pooling cannot pin their exit IP. Direct and RPC requests retain connection pooling. Proxy failures do not fall back to a direct connection. Proxies do not remove upstream quotas.

DEX Screener's public API provides discovery/search and token pair endpoints, not an exhaustive all-pools or chain-wide top-gainers feed. Rankings cover the pools the app has fetched. A displayed market spread is not an executable profit.

## Execution and wallets

- BSC and Arbitrum One: V2 router quotes and atomic flash-loan execution through the included verified executor. BSC testnet is available for testing. Custom compatible V2 routers and intermediate tokens can be configured.
- Solana mainnet: standard SPL / WSOL direct routes through Raydium and PumpSwap, combined with Kamino flash borrowing and repayment in one transaction. Unsupported protocols and Token-2022 tokens remain available for market tracking.
- Fresh chain checks, exact integer limits, slippage, fees and rent, simulation, short-lived transaction review and explicit local signing. Broadcasts are attempted once; uncertain results retain their intended hash/signature for confirmation checking.
- Local BIP-39 import and native EVM / Ed25519 derivation. Derived keys are encrypted using Argon2id and AES-256-GCM; the phrase is not stored. Five-minute unlock lifetime. Import native backups or supported legacy Ethereum V3 scrypt / Solana encrypted backups.
- The included EVM contract retains the existing **2% developer share of positive gross profit**. This is disclosed in the UI. The wallet needs network fees even when a flash loan funds the principal.

Transactions cannot be instantaneously confirmed by desktop software. RPC latency, liquidity, simulation, block production and competing trades determine execution. No profit is guaranteed.

## Windows

See [WINDOWS.md](WINDOWS.md). The UI is embedded into the EXE. Windows 10/11 x64 and Microsoft Edge WebView2 Runtime are required. Existing Electron data is kept separate: export encrypted wallet backups from the old app and import them in the native app.

## Build without Node.js

Install current stable Rust and Microsoft's C++ build tools on Windows, then:

```powershell
cargo test --locked --lib
cargo build --locked --release --bins
.\target\release\vigilant-engine-native.exe
```

The backend tests and benchmark also run on Linux without desktop GUI development packages:

```sh
cargo test --locked --lib
cargo run --locked --release --bin vigilant-bench
```

Native source is under `src/`; the embedded interface is under `ui/`. The EVM artifact is checked in under `artifacts/` and its source is under `contracts/`. Windows CI runs the actual application and verifies WebView2-to-Rust IPC before packaging.
