Vigilant Engine Native 0.3.0 — Windows x64

Download either the EXE or the ZIP. The ZIP contains the same executable, these instructions and the measured benchmark. Both downloads are not required.

Put the EXE in a writable folder and double-click it. Microsoft Edge WebView2 Runtime must be installed (normally present on Windows 10/11). If Windows reports it missing, install Microsoft's official Evergreen WebView2 Runtime from https://developer.microsoft.com/microsoft-edge/webview2/ . No Node.js or Electron is needed.

The application creates VigilantEngine-Rust-Data alongside the EXE. Keep this folder when updating. It contains settings, encrypted wallet keys, history and the WebView2 profile. Proxy and RPC credentials are local settings; keep the data folder private. Configuration exports remove these credentials.

Migration: keep the previous Electron version and its data folder until the new app is configured. Export encrypted wallet backups from the old app, then restore them in Wallets. Recovery phrases are not stored. Unlocking lasts five minutes. Always retain independent recovery backups.

Proxy setup: Settings > RPC / default HTTP(S) proxy. Enter hostname:port:login:password or an HTTP(S) proxy URL. Use the DEX Screener override to route market requests through a different proxy. Save, then use Test saved market connection. Leave the override empty to use the default. An empty default means direct requests. Rotating gateways use a new connection for each outgoing market request. Cached results do not trigger a request or rotate the gateway. There is no silent direct fallback when a configured proxy fails.

The scanner reduces redundant requests using batches, shared caches, rate budgets and cooldowns. A proxy cannot guarantee exemption from DEX Screener limits. Cached results remain visible during upstream throttling.

All chains in the selector support market tracking. Live execution is limited to the supported BSC/Arbitrum V2 and Solana Raydium/PumpSwap adapters. Market prices alone are not executable arbitrage quotes. Review simulation, the expected net result, all fees and the network before signing. The included EVM executor has the existing 2% developer share of positive gross profit.

No code can make blockchain confirmations instantaneous or guarantee profit. Failed on-chain transactions can still consume network fees. An uncertain submission is saved and never retried automatically; check confirmations before preparing another transaction.

The binary is not code-signed, so Windows may show an unknown-publisher prompt. Compare its SHA-256 hash with SHA256SUMS.txt from the same GitHub release.
