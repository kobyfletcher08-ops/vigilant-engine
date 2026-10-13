# Validation

Solidity 0.8.30 compilation and production Worker build pass. TypeScript checks pass.
Local EVM tests cover atomic repayment, 98/2 profit splitting, preserving donated balances, clearing allowances, rejecting unauthorized callbacks/non-owner calls, refusing a lending pair used by the route, losing-route reverts and revoked routers.
70 tests pass in total. A read-only BSC mainnet RPC check returned real direct pools and round-trip routes; below-limit ApeSwap pools were excluded. No live transaction was submitted.

Pure/RPC tests cover configuration bounds, precision and repayment rounding, fee/gas profit floors, RPC response correlation, exact uncertain-intent recovery, canonical bytecode verification, both quote directions, lender separation and reserve-share rejection.

The RPC client uses the Worker-supported `manual` redirect policy. Redirect responses are rejected with a direct-URL configuration message; regression coverage checks 301, 302, 303, 307 and 308 responses without following them.

Browser visual QA was unavailable in this managed environment. No live wallet, funded key, mainnet deployment, mainnet trade or testnet trade was used. A production build and local EVM results are not a security audit or proof of live profitability. The original upstream BSC DEX addresses remain presets; Arbitrum uses documented PancakeSwap V2 and Uniswap V2 deployments. Each router is verified and can report unavailable.


## Seed import update

Five additional tests cover all supported BIP-39 lengths, whitespace/checksum/path validation, optional passphrase/account derivation, encrypted backup round trips without plaintext secrets, wrong-password and excessive-KDF rejection, local signing and locking, a read-only wallet RPC allowlist, and signed-relay owner/chain/fee/nonce checks. Intended hashes are saved before relay requests in the client. Only public synthetic/unfunded test wallets were used.

## All-pairs update

Factory tests cover enabled-router verification, full counts, unavailable factories, page boundaries (including the last partial page), pair membership, token/reserve classification, symbol fallback, optional metadata and unchanged cursors after partial RPC or transient provider failures. IndexedDB tests use fake-indexeddb to verify atomic record/cursor writes, rollback, reload recovery, deduplicated token queues, quote checkpointing, scoped configuration isolation, append-only growth, repair without cursor movement, clear/rebuild and refresh. Quote aggregation retains at most 200 routes with exact loss ordering and removes routes that disappear from a fresh batch. A transaction-preparation test re-quotes a token outside the manual list, checks the generated calldata and rejects the route when profit limits change. Additional tests cover classified provider failures without secret/error-message disclosure, transient quote-batch refusal, bounded read retries and aborting a retry wait before another request is sent.

A read-only mainnet check returned factory counts of 3,433,038 PancakeSwap V2 pairs, 3,498 Biswap pairs and 6,506 ApeSwap pairs. The first and last 32 PancakeSwap indices were enumerated. Metadata requests failed on the public RPC, and a later follow-up was blocked by the environment's network proxy; production metadata behavior and a complete crawl are unverified. Optional metadata no longer excludes verified pools from raw-unit quotes; retryable provider errors preserve the page for retry. No browser visual/interaction QA or live transaction was performed.

## Skipped-failure update

Skip mode records failed indices or pool reads and advances while keeping strict mode available. Tests verify index/detail alignment after skipped lookups, per-pool isolation, configurable page sizes, batching, migration of legacy settings, redacted error categories and `-32603` contract-revert classification. IndexedDB version-1 catalog data survives the version-2 migration. Failed quote tests verify persistence across reads, deduplication, removal of stale routes, exclusion from success counts, requeue/recovery, and scope-local refresh/clear. Quote-controller tests isolate a failed group so working tokens succeed, stop on wrong-chain/strict-mode errors and cancel recovery before another token request. Browser QA and current live RPC behavior remain unverified; no further network workaround or live transaction was used.

## Arbitrum One update

Twelve additional regression tests cover supported-chain validation, chain-specific V2 and asset presets, migration and persistence of independent network profiles/executors, RPC credential redaction across every exported profile, WETH quotes for six-decimal tokens, lender separation, Arbitrum deployment constructor parameters and trade/withdraw calldata, full RPC gas-estimate budgeting, ETH balance checks, chain-bound receipt costs, imported-wallet signatures and relay checks on chain 42161, all-pairs discovery and IndexedDB network isolation. The Solidity ABI and bytecode are unchanged; existing BSC executors remain compatible.

A read-only Arbitrum One public RPC check verified chain 42161 and the router-reported WETH address at block 514,237,786. Both default routers passed wrapped-token verification and returned readable V2 factory lists: 846 PancakeSwap V2 pairs and 8,862 Uniswap V2 pairs at that block. The first eight PancakeSwap pairs were enumerated and classified as low liquidity or token-to-token catalog entries. A subsequent default-token quote scan at block 514,238,143 verified both routers, found two pools above the reserve floor and no eligible cross-DEX route with a separate lender; the remaining preset pools were below the configured liquidity floor. These are observations at those blocks, not fixed counts or evidence of a profitable route. No mainnet transaction was submitted. Browser interaction/visual QA, a full Arbitrum catalog crawl and live executor deployment/trading remain unverified.

## DEX Screener and Solana update

The new tests cover chain/mint/quote identity, Solana case sensitivity, timeframe ranking, absent market metrics, canonical external links, bounded watchlists and batched discovery, redirects, rate limits and oversized responses. Solana wallet tests use only a public synthetic unfunded mnemonic to verify hardened derivation, address review, AES-GCM/PBKDF2 encrypted backup round trips, wrong passwords, tampering, KDF bounds, stripping unknown fields, signer ownership, review expiry, additional signers, unsigned state and locking. Transaction tests cover exact 1000-native-unit settings, configured caps, fee rounding, retained rent in the net floor, official Kamino borrow/repay encodings and index, matching reserves/vaults, unsafe setup/transfers, signer and size limits, Raydium V2 output thresholds and PumpSwap's official sell discriminator.

TypeScript checks and the production build are required for this update. Anchor 0.31's mixed ESM/CommonJS workspace export is routed through its official CommonJS entry for Worker bundling. The legacy Solidity artifact is unchanged. No funded seed, mainnet transaction, Solana flash-loan execution or browser interaction/visual QA was used. Browser QA is unavailable in this managed environment. Tests and builds do not prove a live route is profitable or constitute an independent audit.

A read-only public DEX Screener check returned 9 BSC pools for 9 mints, 6 Arbitrum pools for 6 mints, and 29 Solana pools for 30 mints, with no failed discovery snapshots. These are fetched samples, not complete chain coverage or evidence of executable profit.
