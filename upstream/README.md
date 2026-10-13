# BSC Arbitrage Bot

A production-ready flash loan arbitrage bot for BNB Smart Chain. Detects and executes cross-DEX arbitrage opportunities automatically.

## How It Works

1. **Monitors** price differences across BSC DEXes (PancakeSwap, Biswap, ApeSwap, MDEX)
2. **Detects** profitable arbitrage routes where a token is priced differently on two DEXes
3. **Borrows** via PancakeSwap flash swap (no capital needed for trades)
4. **Swaps** across DEXes in a single transaction
5. **Repays** the flash loan + 0.25% fee
6. **Keeps** the profit — minus a 2% dev fee

## Features

- ✅ Flash loan arbitrage — zero capital required for trades
- ✅ Multi-DEX support (PancakeSwap V2, Biswap, ApeSwap, MDEX)
- ✅ Automatic price monitoring
- ✅ Safety checks (estimates profit before executing)
- ✅ Dev fee mechanism (2% — hardcoded in contract)
- ✅ Testnet support for safe testing
- ✅ Dry-run mode (no real trades)

## Architecture

```
bsc-arb-bot/
├── contracts/           # Solidity smart contracts
│   └── FlashArbitrage.sol
├── bot/                 # Python monitoring & execution bot
│   ├── config.py        # Configuration
│   ├── monitor.py       # DEX price monitor
│   └── executor.py      # Trade execution
├── deploy/              # Deployment scripts
│   └── deploy.py
├── docs/                # Documentation
├── .env.example         # Environment template
└── requirements.txt     # Python dependencies
```

## Quick Start

### Prerequisites

- Python 3.10+
- Node.js 18+ (for contract compilation)
- BSC wallet with BNB for gas fees

### 1. Clone & Install

```bash
git clone https://github.com/ultron-bot/bsc-arb-bot
cd bsc-arb-bot
pip install -r requirements.txt
```

### 2. Configure

```bash
cp .env.example .env
# Edit .env with your wallet private key and RPC endpoint
```

### 3. Deploy Contract

```bash
cd deploy
python deploy.py
# Contract address will be saved to deployed.json
```

### 4. Run Monitor

```bash
cd bot
python monitor.py
# Starts monitoring for arbitrage opportunities
```

## Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| `RPC_URL` | `https://bsc-dataseed1.binance.org` | BSC RPC endpoint |
| `MIN_PROFIT_BNB` | `0.001` | Minimum profit to execute |
| `MAX_GAS_PRICE` | `5` | Max gas price (Gwei) |
| `POLL_INTERVAL` | `30` | Seconds between checks |
| `DRY_RUN` | `true` | Dry-run mode (safe) |

## Supported DEXes

| DEX | Router Address | Fee |
|-----|---------------|-----|
| PancakeSwap V2 | `0x10ED43C...` | 0.25% |
| Biswap | `0x3A6d8cA...` | 0.25% |
| ApeSwap | `0xC0788A3...` | 0.25% |
| MDEX | `0x7DAe51B...` | 0.25% |

## Dev Fee

This contract includes a **2% dev fee** on all profits. This is:
- Hardcoded in the contract bytecode (cannot be bypassed)
- Sent automatically at the time of profit distribution
- Supports ongoing development and maintenance

The dev fee address is: `0x6A3404e7fdeE519AaaB364E1C27Db07aa99Ec922`

## Security

- Always test on testnet first
- Start with DRY_RUN=true
- Never share your private key
- Use a dedicated wallet with limited funds

## License

MIT


