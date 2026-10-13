# DEX Arbitrage Console — Solana, BSC and Arbitrum One

Adapted from [ligmaligma-jpeg/bsc-arb-bot](https://github.com/ligmaligma-jpeg/bsc-arb-bot), commit `df38419c9c35f4d691e7b848c6199a3bc5d14db4`.
Original MIT-licensed files remain under `upstream/`. This GUI replaces the broken Python monitor runtime with a browser UI and authenticated HTTP RPC backend. It does not run the original Python monitor or hold a trading key on the server. Imported account keys are held only in browser memory while unlocked.

## DEX Screener workspace

The default screen discovers real pools on Solana, BSC and Arbitrum One. Top Gainers ranks the discovered and watched universe for 5m, 1h, 6h or 24h; the public API does not provide a complete chain-wide gainers endpoint. Public top/latest boosts and token profiles seed discovery, alongside chain presets and up to 12 watched mints per chain. A batched token lookup keeps requests bounded. Search and Compare load all API-reported pools for the selected mint. Live polling can be paused and configured to 15/30/60/120 seconds; it pauses while the workspace is hidden. Stale data is labeled and failed requests retain prior results. Filters, address-based spread matching, fetched-price trails and CSV export are included.

Displayed spreads are spot comparisons, not executable profits. BSC and Arbitrum quotes use the existing configured V2 routers and executor, include flash fees, the retained 2% developer fee and the gas budget, then require a fresh full transaction simulation. Unsupported pools remain visible for market tracking. Borrow limits can be configured above 100, including 1000, with the configured maximum, reserve-share cap and actual lender liquidity still enforced.

### Solana execution and wallet

Solana uses direct standard-SPL-token routes through Raydium and PumpSwap with two different pools. Kamino supplies wrapped SOL principal, both swaps run between one flash borrow and its matching repayment, and the final swap encodes a floor covering principal, flash fee, the configured network budget, retained new-account rent and minimum net profit. Pool formats, owner, reserve/vaults, signer count, blockhash lifetime, transaction size and allowed instructions are checked. Token-2022, other swap programs and multi-hop Raydium routes are currently tracking-only. There is no Solana developer fee.

Connect Phantom/Solflare or import an English BIP-39 phrase locally. The default Solana path is `m/44'/501'/0'/0'`; optional phrase passphrases and custom fully hardened paths are supported. Review the full address before saving. Only the derived 32-byte seed is encrypted with AES-256-GCM and PBKDF2-SHA256 (310,000 iterations, random salt/IV); the phrase and password are never posted to the API or saved. Backups contain only the encrypted account. Local signers lock on reload, disconnect, page exit and five minutes of inactivity. BSC/Arbitrum retain the separate Ethereum V3 encrypted wallet import.

Enable Live review before simulation, then review and explicitly sign within the 30-second review lifetime. The client journals intent before signing and signature before broadcast, verifies that external wallets return the same transaction message, and never automatically retries an uncertain submission. The relay validates and simulates again with the real signature before sending. Native SOL is required for network fees and token-account rent, even though the flash loan funds principal. Larger routes may need pool address lookup tables configured in Solana settings.

## Features

- Private signed-in workspace with a responsive dashboard and 40-scan trend.
- Real direct V2 round trips across selected DEXs and ERC-20 tokens, pinned to a block.
- All-pairs mode enumerates every index from each enabled V2 factory, discovers wrapped native tokens (WBNB on BSC, WETH on Arbitrum) beyond the manual list, and quotes them in bounded batches. Browser IndexedDB stores the catalog and atomic page/quote checkpoints for pause, resume and reload recovery. The catalog includes token-to-token pools and explicit unreadable/low-liquidity status.
- Wrapped native flash-swap borrowing from a separate PancakeSwap pair. The lender cannot be either swap pool because a flash-swap lending pair remains locked in its callback.
- Actual router quotes, round-trip impact, conservative per-leg slippage, rounded repayment, the upstream 2% developer fee, reserve limits, gas budget and minimum net profit.
- Browser wallet connection or single-account seed import, network switch, native/wrapped native balance diagnostics, dry-run simulation and individually reviewed signing.
- GUI v2 executor deployment and exact runtime/immutable parameter/owner verification.
- Owner-controlled router permissions and executor withdrawal previews.
- Persistent local transaction intents before wallet submission, receipt checks after two confirmations, uncertain submission recovery by verifying the exact transaction hash.
- Local settings/history, JSON configuration import/export with RPC credentials redacted on export, CSV transaction history and JSON activity export.
- Arbitrum One (42161) with PancakeSwap V2 and Uniswap V2 presets, USDC/USDT0/ARB assets, ETH fees and WETH round trips. Network profiles keep RPC URLs, limits, DEXs/tokens and executor addresses separate; configuration backups cover every saved profile.
- BSC mainnet defaults from upstream; BSC testnet requires user-supplied compatible tokens and a second router. Addresses are verified at runtime; availability is not assumed.

## Run and build

Node.js 24 or newer, pnpm. Install: `pnpm install`. Compile: `pnpm run compile`. Tests: `pnpm test`. Type checks: `pnpm exec tsc --noEmit`. Build: `pnpm build`.

The app uses the included Vinext/Cloudflare Sites integration. Hosted identity is provided by Sites; it rejects anonymous API calls. For your own non-Sites hosting, replace that identity integration with server-side authentication before exposure. Never hardcode a wallet private key or send a seed to the server or chat. The optional seed-import form derives and encrypts the account entirely in the browser.

## Workflow

1. Connect MetaMask, Rabby or another injected EVM wallet, or open **Wallets** to import and encrypt a seed locally. Switch its network to the one selected in the app.
2. Check the RPC/network and configure DEXs, tokens, borrow size and gas/profit limits.
3. Choose **All factory pairs** (default) and **Scan now**, or open **All pairs → Scan all pairs**. Pause/resume preserves the last saved factory page. **Configured tokens** retains the original manual watchlist scan. Monitoring runs only while the browser tab is open. There is no hidden unattended signer or automatic wallet broadcast.
4. In Executor, simulate deployment of `FlashArbitrageV2`, or attach and verify an existing GUI v2 deployment. Original upstream bytecode is intentionally refused for live use.
5. Enable **Live review** in Settings when ready. Review the full addresses, fee budget and nonce, then confirm the individual transaction in your wallet.
6. Check receipts in Transactions. A confirmed deployment is verified and attached automatically. Failed/uncertain submissions stay visible; do not retry until the intended nonce/hash is resolved.
7. Simulate a qualifying route and confirm it in your wallet only after reviewing the fresh transaction preview.

Live mode resets on page reload, wallet changes and configuration changes. Monitoring and transaction previews pause on relevant changes. Network settings/history are local to this browser; export them for backups or another device. An RPC URL with a provider credential is sensitive even though it is not a wallet key.

## Arbitrum One

Select **Arbitrum One · Mainnet** in the top network menu, then switch your browser wallet or unlock the imported local account. The app uses chain ID 42161, the public `https://arb1.arbitrum.io/rpc` endpoint and Arbiscan links. BSC settings are retained when switching. Older single-network settings migrate without losing the selected executor.

The Arbitrum presets are PancakeSwap V2 and Uniswap V2. Compatible V2 routers can be added in **DEXs & tokens**. This executor quotes WETH round trips; V3, concentrated-liquidity pools, Arbitrum Nova and Arbitrum Sepolia are not implemented.

Deploy a separate GUI v2 executor on Arbitrum through **Executor**, or attach and verify an existing Arbitrum GUI v2 deployment. ETH pays fees; the flash swap borrows WETH from a separate PancakeSwap V2 pool. The existing contract ABI and bytecode are unchanged: its legacy `wbnb` field is the constructor-supplied wrapped native token, which is WETH on Arbitrum. The lender retains PancakeSwap's 25 bps invariant; trade fees are reflected in each actual router quote, so no PancakeSwap fee is applied to Uniswap's swaps.

Transaction preparation uses `eth_estimateGas` with a 25% gas reserve and the RPC gas price. Arbitrum's gas estimate covers execution and Ethereum posting costs in equivalent Arbitrum gas units; both components are therefore covered by the ETH budget check. The overview quote subtracts the configured gas budget until a full transaction is prepared. Receipt costs use total gas used times effective gas price. Two Arbitrum block confirmations indicate local receipt inclusion, not Ethereum finality. No signing or deployment occurs when changing networks or scanning.

## All-pairs scanning

The scanner reads `allPairsLength()` and every `allPairs(index)` from the factories verified through your enabled V2 routers. It checks pair factory membership, token addresses and reserves, then reads optional symbols/decimals for discovered wrapped native assets. Missing metadata uses an address label/raw units without dropping the pool. **Skip failed pools and token quotes** is enabled by default: failed index lookups or pool reads are recorded as unreadable entries and the cursor continues. In strict mode, partial factory-index reads or transient pool errors leave the cursor unchanged. **Recheck page** retries a saved range without disturbing discovery progress. Token-to-token pools appear in the catalog; only wrapped native → token → wrapped native routes are supported by the current executor.

Each API request enumerates at most 32 pairs or quotes at most 4 discovered tokens across the configured routers. Default pacing uses 16 pairs per page, 8 RPC calls per batch and a 200 ms delay between batches. **Settings → RPC pacing & skipped pools** exposes batch/page sizes, delay, a gentle preset and strict/skip mode. A gentle batch size or many routers reduces token quote groups to one to bound request work. Pages rotate among enabled factories; a large DEX does not hold up the smaller ones. Pair records and a deduplicated quote queue are stored in IndexedDB, without loading the entire catalog into memory. Financial/network/DEX setting changes select a separate catalog scope; pacing and skip changes keep the saved cursor. Saved quotes include their block and timestamp. The route table/export retain the best 200 routes while progress counts reflect every quote processed.

If a token quote group fails in skip mode, the scanner isolates the tokens, saves valid quotes and records only the failing tokens. **Retry failed quotes** requeues all recorded failures; success clears their failed status. Failed tokens do not count as successfully quoted. Setup errors, wrong networks and cancellation still stop processing. Strict mode retries temporary reads at most three times, then pauses at the saved cursor/quote queue. Provider diagnostics classify rate limits, missing block/state data, timeouts and contract reverts without displaying upstream messages. In particular, a contract revert reported as `-32603` is not treated as a temporary provider outage. Transaction simulation/signing remains mandatory and submissions are never retried automatically. This direct-RPC workflow needs no proxy relay or separate host.

After a complete pass, **Refresh all quotes** revisits all cached wrapped native tokens using current reserves, discovers newly appended pairs and replaces the quote summary. **Rebuild catalog** rereads every factory index. PancakeSwap on BSC has millions of factory pairs, so full enumeration can take a long time and requires browser storage and a responsive RPC. Pauses, reloads and RPC failures can be resumed; scanning stops while this tab is closed.

Negative net quotes represent estimated losses after the configured costs and are labeled **LOSS / No qualifying routes**. Pools below the configured minimum wrapped native reserves remain visible in the catalog, but are excluded from executable route quotes. Every trade preparation re-quotes only the selected discovered token, re-verifies the executor and simulates the full transaction before an individually reviewed signature.

## Contract changes

`contracts/FlashArbitrageV2.sol` adds callback provenance, exact active-data checks, owner-only initiation, a router allowlist, loan/swap pair separation, bounded approvals, allowance cleanup, explicit output/profit floors, checked ERC-20 return data and donation-preserving profit accounting. A losing round trip reverts. The existing developer fee/address is retained: 2% of realized gross wrapped native profit is sent to `0x6A3404e7fdeE519AaaB364E1C27Db07aa99Ec922`.

## Local seed import

Open **Wallets** to import a 12, 15, 18, 21 or 24-word English BIP-39 phrase. An optional BIP-39 passphrase and custom derivation path are supported; the default path is `m/44'/60'/0'/0/0`. Review the full derived address before saving. A different passphrase/path produces a different account.

Only the selected account is imported. The phrase, BIP-39 passphrase and plaintext private key are never sent to the server or saved. The derived private key is encrypted as an Ethereum V3 keystore using scrypt (N=65536, r=8, p=1) and a separate password of at least 12 characters, then stored in this browser. Backup/restore downloads only the encrypted JSON. The original recovery phrase must be backed up separately.

The imported account is locked on reload/disconnect and after 5 minutes without interaction. Unsaved address-review imports expire after 5 minutes. Locking drops the active signer reference and resets live mode. Each action still requires a fresh simulation, Live review and an explicit **Sign & send locally** click. The intended signed transaction hash is persisted before the server is asked to relay the public signed transaction. The relay rechecks its chain, sender, nonce, gas caps and executor scope; it never receives the private key.

Use a trusted device and a dedicated wallet: browser extensions or compromised page code can access an unlocked browser key. Download an encrypted backup and keep its password before clearing browser storage.

No frontend claim or local test constitutes an independent audit. Gas costs apply even to reverted transactions. Estimates are not guaranteed profits; RPC behavior, liquidity and inclusion can change. No mainnet transaction was submitted during development.

## Provenance and sources

- Original repository and MIT license in `upstream/`.
- PancakeSwap official V2 address reference: https://developer.pancakeswap.finance/contracts/v2/addresses
- PancakeSwap V2 fee reference: https://docs.pancakeswap.finance/trade/pancakeswap-exchange/trade
- Same-token repayment uses `ceil(borrow * 10000 / 9975)` for a 25/10000 fee-adjusted invariant. It is not simply borrow plus a rounded-down 0.25%.
- Arbitrum chain reference: https://docs.arbitrum.io/chain-info
- Arbitrum gas estimation: https://docs.arbitrum.io/how-arbitrum-works/deep-dives/gas-and-fees
- Uniswap V2 deployments: https://developers.uniswap.org/docs/protocols/v2/deployments
- Native USDC deployments: https://developers.circle.com/stablecoins/usdc-contract-addresses
- USDT0 deployments: https://docs.usdt0.to/technical-documentation/deployments
- ARB token: https://docs.arbitrum.foundation/token-supply
- Source improvements and UI implementation: ChatGPT (OpenAI), at Koby Dench's direction.

DEX Screener API: https://docs.dexscreener.com/api/reference
Raydium Trade API: https://docs.raydium.io/sdk-api/trade-api
Kamino flash loans: https://kamino.com/docs/build/developers/multiply/flash-loans
PumpSwap SDK: https://github.com/pump-fun/pump-public-docs
