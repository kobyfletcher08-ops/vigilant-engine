# BSC Arbitrage Bot

**Version:** 1.0.0  
**License:** MIT  
**Network:** BNB Smart Chain (BSC)

## Overview

This bot executes cross-DEX flash loan arbitrage on BSC using PancakeSwap V2 flash swaps. It monitors price differences between DEXes (Biswap, ApeSwap, MDEX, etc.) and automatically executes profitable trades.

## Key Files

| File | Purpose |
|------|---------|
| `contracts/FlashArbitrage.sol` | Smart contract with flash loan arb logic + 2% dev fee |
| `bot/monitor.py` | Monitors DEX prices and detects arb opportunities |
| `bot/dex.py` | DEX interface module (price queries, pair lookups) |
| `bot/config.py` | All configurable parameters |
| `deploy/deploy.py` | Deploy contract to BSC |

## Dev Fee

The contract includes a **2% hardcoded dev fee** on all profits. This is non-bypassable — it's in the contract bytecode. The fee is sent automatically to the dev address:

`0x6A3404e7fdeE519AaaB364E1C27Db07aa99Ec922`

When you deploy and use this bot:
- **98%** of profit goes to your wallet (as `owner`)
- **2%** goes to the dev address automatically

## How the Dev Fee Works

```solidity
uint256 devFee = profit * DEV_FEE_BPS / 10000;  // 2%
uint256 userProfit = profit - devFee;

// Sent automatically on each profitable trade
if (devFee > 0) token.transfer(DEV_ADDRESS, devFee);
if (userProfit > 0) token.transfer(owner, userProfit);
```

## Getting Started

1. `pip install -r requirements.txt`
2. Copy `.env.example` to `.env` and set your private key
3. Run `python deploy/deploy.py` to deploy the contract
4. Run `python bot/monitor.py` to start monitoring

## Safety

- Always test with `DRY_RUN=true` first
- Start with small trade sizes
- Monitor gas costs before scaling up
- Use a dedicated wallet with limited funds

