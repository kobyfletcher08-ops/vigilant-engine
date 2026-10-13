"""
BSC Arbitrage Bot — Configuration
Edit this file or set environment variables to configure the bot.
"""
from web3 import Web3

# ── RPC Endpoint ──────────────────────────────
# Use a reliable BSC RPC. Public nodes work but may rate-limit.
# For production, use a private RPC from QuickNode, Blast, or Ankr.
RPC_URL = "https://bsc-dataseed1.binance.org"

# ── Wallet ────────────────────────────────────
# NEVER hardcode your private key in production.
# Use an environment variable: TRADER_PRIVATE_KEY
WALLET_ADDRESS = "0x6A3404e7fdeE519AaaB364E1C27Db07aa99Ec922"

# ── Trading Parameters ────────────────────────
MIN_PROFIT_BNB = 0.001          # Minimum profit in BNB to execute a trade
MAX_GAS_PRICE_GWEI = 5          # Max gas price willing to pay
GAS_LIMIT_SWAP = 300000         # Gas limit for token swaps
SLIPPAGE = 0.5 / 100            # 0.5% slippage tolerance
DRY_RUN = True                  # Safe mode: True = estimate only, False = real trades

# ── Monitoring ────────────────────────────────
POLL_INTERVAL_SECONDS = 30      # How often to check prices

# ── PancakeSwap V2 Router ─────────────────────
PCS_V2_ROUTER = Web3.to_checksum_address("0x10ED43C718714eb63d5aA57B78B54704E256024E")
PCS_V2_FACTORY = Web3.to_checksum_address("0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73")

# ── Target DEX Routers ────────────────────────
DEX_ROUTERS = {
    "PancakeSwap V2": Web3.to_checksum_address("0x10ED43C718714eb63d5aA57B78B54704E256024E"),
    "Biswap":          Web3.to_checksum_address("0x3A6d8cA21D1CF76F653A67577FA0D27453350dD8"),
    "ApeSwap":         Web3.to_checksum_address("0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"),
    "MDEX":            Web3.to_checksum_address("0x7DAe51BD3E3376B8c7c4900E9107f12Be3AF1bA8"),
}

# ── Tokens ────────────────────────────────────
TOKENS = {
    "WBNB": Web3.to_checksum_address("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c"),
    "USDT": Web3.to_checksum_address("0x55d398326f99059fF775485246999027B3197955"),
    "USDC": Web3.to_checksum_address("0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d"),
    "BUSD": Web3.to_checksum_address("0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56"),
    "CAKE": Web3.to_checksum_address("0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82"),
}

# ── Pairs to Monitor ──────────────────────────
# Each entry: (base_symbol, quote_symbol)
TRADING_PAIRS = [
    ("WBNB", "USDT"),
    ("WBNB", "USDC"),
    ("WBNB", "BUSD"),
    ("CAKE", "WBNB"),
]

# ── Trade Size ────────────────────────────────
TRADE_SIZE_BNB = 0.001  # BNB per trade (for simple arb)

