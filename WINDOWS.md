# Vigilant Engine for Windows

The desktop package includes the full interface, Node runtime and API backend. It runs locally without Render, Cloudflare, a separate Node installation or a ChatGPT sign-in. Internet access is needed for market data and blockchain RPCs.

Download `VigilantEngine-0.2.1-Windows-x64.exe` from the GitHub release. Open it on Windows 10/11 x64. The portable EXE keeps its application data in `VigilantEngine-Data` next to the EXE; keep that directory when updating. The ZIP contains the same application as an unpacked folder; extract it and run `VigilantEngine.exe`. It uses the normal Windows user-data directory. Both builds are unsigned.

Version 0.2.1 fixes the `Origin required` / `Unexpected token O` error when the desktop interface calls its backend. Origin checks use Electron's trusted Chromium initiator, including when the optional HTTP Origin header is absent. The Windows startup check now exercises POST requests to all three APIs from the actual renderer.

Use Settings for your BSC/Arbitrum RPC and proxy. Solana has its own settings under DEX Screener → Solana. Proxies accept `hostname:port:login:password`, `https://hostname:port:login:password`, or `http(s)://login:password@hostname:port`. Requests use real CONNECT tunneling and reused connections; proxy errors never silently fall back to a direct connection. Credentials are removed from exported configuration backups.

Import and unlock a wallet under Wallets (EVM) or the Solana execution panel. Seed derivation, encryption and signing remain in the isolated local interface. Seeds and private keys are never sent to the backend. Browser wallet extensions are supported by the web version; the desktop uses the local signer.

DEX Screener tracks every returned DEX without a platform allowlist. BSC and Arbitrum execution supports configured, verified V2-compatible routers and the included authenticated executor. Solana execution supports Raydium and PumpSwap standard-SPL routes with an atomic Kamino flash loan. Unsupported pool types remain available for tracking. Actual router quotes, network fees, liquidity and fresh full simulations determine whether a route can be submitted.

Fetching uses pooled connections, coalesced market requests and a five-second market refresh option. Submission occurs after the final simulation and explicit signature. Network confirmation time still depends on the blockchain. Transactions are not automatically repeated after an uncertain response.

## Build from source

Install Node 24 and pnpm 11.25.0, then run:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
pnpm exec tsc --noEmit
pnpm desktop:pack
```

The frontend and backend are staged in `desktop-package`; downloads are written to `release`. The `Windows desktop executable` GitHub Actions workflow also launches the Windows application to verify that the interface, secure context and local backend load before uploading either package. No funded-wallet transaction is part of the build or tests.
