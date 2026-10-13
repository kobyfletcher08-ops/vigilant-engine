"""
DEX interaction module for BSC cross-DEX arbitrage.
Provides interfaces to multiple DEX routers for price queries and swaps.
"""
import json
import logging
from typing import Dict, List, Optional, Tuple
from web3 import Web3

logger = logging.getLogger(__name__)

# Minimal router ABI for price queries
ROUTER_ABI = json.loads('''[
    {"inputs":[{"internalType":"uint256","name":"amountIn","type":"uint256"},{"internalType":"address[]","name":"path","type":"address[]"}],"name":"getAmountsOut","outputs":[{"internalType":"uint256[]","name":"amounts","type":"uint256[]"}],"stateMutability":"view","type":"function"},
    {"inputs":[{"internalType":"uint256","name":"amountOutMin","type":"uint256"},{"internalType":"address[]","name":"path","type":"address[]"},{"internalType":"address","name":"to","type":"address"},{"internalType":"uint256","name":"deadline","type":"uint256"}],"name":"swapExactETHForTokens","outputs":[{"internalType":"uint256[]","name":"amounts","type":"uint256[]"}],"stateMutability":"payable","type":"function"},
    {"inputs":[{"internalType":"uint256","name":"amountOutMin","type":"uint256"},{"internalType":"address[]","name":"path","type":"address[]"},{"internalType":"address","name":"to","type":"address"},{"internalType":"uint256","name":"deadline","type":"uint256"}],"name":"swapExactTokensForETH","outputs":[{"internalType":"uint256[]","name":"amounts","type":"uint256[]"}],"stateMutability":"nonpayable","type":"function"},
    {"inputs":[{"internalType":"uint256","name":"amountIn","type":"uint256"},{"internalType":"uint256","name":"amountOutMin","type":"uint256"},{"internalType":"address[]","name":"path","type":"address[]"},{"internalType":"address","name":"to","type":"address"},{"internalType":"uint256","name":"deadline","type":"uint256"}],"name":"swapExactTokensForTokens","outputs":[{"internalType":"uint256[]","name":"amounts","type":"uint256[]"}],"stateMutability":"nonpayable","type":"function"}
]''')

ERC20_ABI = json.loads('''[
    {"constant":true,"inputs":[],"name":"decimals","outputs":[{"name":"","type":"uint8"}],"type":"function"},
    {"constant":true,"inputs":[{"name":"","type":"address"}],"name":"balanceOf","outputs":[{"name":"","type":"uint256"}],"type":"function"},
    {"constant":false,"inputs":[{"name":"spender","type":"address"},{"name":"amount","type":"uint256"}],"name":"approve","outputs":[{"name":"","type":"bool"}],"type":"function"},
    {"constant":true,"inputs":[{"name":"","type":"address"},{"name":"","type":"address"}],"name":"allowance","outputs":[{"name":"","type":"uint256"}],"type":"function"}
]''')

FACTORY_ABI = json.loads('''[
    {"inputs":[{"internalType":"address","name":"","type":"address"},{"internalType":"address","name":"","type":"address"}],"name":"getPair","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"}
]''')


class DEX:
    """Interface to a single DEX router."""

    def __init__(self, name: str, router_address: str, w3: Web3):
        self.name = name
        self.router_address = Web3.to_checksum_address(router_address)
        self.router = w3.eth.contract(address=self.router_address, abi=ROUTER_ABI)
        self.w3 = w3

    def get_price(self, token_in: str, token_out: str, amount_in: int = 10**18) -> Optional[int]:
        """Get the output amount for a simulated swap."""
        try:
            path = [
                Web3.to_checksum_address(token_in),
                Web3.to_checksum_address(token_out),
            ]
            amounts = self.router.functions.getAmountsOut(amount_in, path).call()
            return amounts[-1]
        except Exception as e:
            logger.debug(f"{self.name} price fetch failed: {e}")
            return None

    def __repr__(self) -> str:
        return f"DEX({self.name})"


class DEXManager:
    """Manages multiple DEX instances and provides cross-DEX price comparison."""

    def __init__(self, w3: Web3, routers: Dict[str, str]):
        self.w3 = w3
        self.dexes = {name: DEX(name, addr, w3) for name, addr in routers.items()}
        self.factory = w3.eth.contract(
            address=Web3.to_checksum_address("0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73"),
            abi=FACTORY_ABI,
        )

    def get_all_prices(self, token_in: str, token_out: str, amount: int = 10**18) -> Dict[str, Optional[float]]:
        """Get prices for a pair across all DEXes."""
        prices = {}
        for name, dex in self.dexes.items():
            out = dex.get_price(token_in, token_out, amount)
            if out is not None:
                prices[name] = out / (10**18)
            else:
                prices[name] = None
        return prices

    def find_arbitrage(self, token_in: str, token_out: str, amount: int = 10**18, min_spread: float = 0.5) -> List[dict]:
        """Find arbitrage opportunities for a token pair across DEXes."""
        prices = self.get_all_prices(token_in, token_out, amount)
        
        opportunities = []
        dex_names = [n for n, p in prices.items() if p is not None]
        
        for i in range(len(dex_names)):
            for j in range(i + 1, len(dex_names)):
                a, b = dex_names[i], dex_names[j]
                pa, pb = prices[a], prices[b]
                
                if min(pa, pb) <= 0:
                    continue
                
                spread_pct = abs(pa - pb) / min(pa, pb) * 100
                
                if spread_pct >= min_spread:
                    if pa < pb:
                        buy_dex, sell_dex = a, b
                        buy_price, sell_price = pa, pb
                    else:
                        buy_dex, sell_dex = b, a
                        buy_price, sell_price = pb, pa
                    
                    opportunities.append({
                        "buy_dex": buy_dex,
                        "sell_dex": sell_dex,
                        "buy_price": buy_price,
                        "sell_price": sell_price,
                        "spread_pct": spread_pct,
                        "pair": f"{token_in[:10]}.../{token_out[:10]}...",
                    })
        
        return opportunities

    def get_pair_address(self, token0: str, token1: str) -> Optional[str]:
        """Get the PancakeSwap pair address for two tokens."""
        try:
            pair = self.factory.functions.getPair(
                Web3.to_checksum_address(token0),
                Web3.to_checksum_address(token1),
            ).call()
            return pair if pair != "0x0000000000000000000000000000000000000000" else None
        except Exception as e:
            logger.debug(f"getPair failed: {e}")
            return None

