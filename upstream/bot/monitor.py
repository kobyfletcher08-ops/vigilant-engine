"""
BSC Arbitrage Monitor — Detects cross-DEX arbitrage opportunities.
"""
import time
import json
import logging
from datetime import datetime
from web3 import Web3

from config import *
from dex import DEXManager

logger = logging.getLogger(__name__)


class ArbitrageMonitor:
    """Monitors multiple DEXes for arbitrage opportunities."""

    def __init__(self, w3: Web3, dry_run: bool = True):
        self.w3 = w3
        self.dry_run = dry_run
        self.dex_manager = DEXManager(w3, DEX_ROUTERS)
        self.trade_log = []

    def check_balance(self) -> float:
        """Check wallet BNB balance."""
        bal = self.w3.eth.get_balance(WALLET_ADDRESS)
        return bal / 1e18

    def run_cycle(self) -> List[dict]:
        """Run one monitoring cycle and return opportunities found."""
        block = self.w3.eth.block_number
        bal = self.check_balance()
        
        print("\n" + "=" * 60)
        print(f"  BSC Arbitrage Monitor — {datetime.now().strftime('%H:%M:%S')}")
        print(f"  Block: {block}  |  Balance: {bal:.6f} BNB (${bal * 570:.2f})")
        print(f"  Mode: {'DRY RUN' if self.dry_run else 'LIVE'}")
        print("=" * 60)
        
        all_opportunities = []
        
        # Check each trading pair across all DEXes
        for base, quote in PAIRS:
            token_in = TOKENS[base]
            token_out = TOKENS[quote]
            
            prices = self.dex_manager.get_all_prices(token_in, token_out)
            print(f"\n  {base}/{quote}:")
            for dex_name, price in prices.items():
                if price:
                    print(f"    {dex_name:16s} {price:.6f}")
                else:
                    print(f"    {dex_name:16s} FAIL")
            
            # Check for arbitrage
            opps = self.dex_manager.find_arbitrage(token_in, token_out, 10**18, 0.5)
            for opp in opps:
                print(f"\n  >> ARBITRAGE: {opp['buy_dex']} -> {opp['sell_dex']}")
                print(f"     Spread: {opp['spread_pct']:.2f}%")
                all_opportunities.append(opp)
        
        # Log
        self._log_cycle(block, bal, all_opportunities)
        
        return all_opportunities

    def _log_cycle(self, block: int, balance: float, opportunities: list):
        """Log cycle data."""
        entry = {
            "timestamp": datetime.now().isoformat(),
            "block": block,
            "balance_bnb": balance,
            "opportunities": len(opportunities),
        }
        self.trade_log.append(entry)
        
        # Keep log manageable
        if len(self.trade_log) > 1000:
            self.trade_log = self.trade_log[-500:]
        
        with open("monitor_log.json", "w") as f:
            json.dump(self.trade_log, f, indent=2)

    def run(self):
        """Main monitoring loop."""
        print("\n" + "#" * 60)
        print("  BSC Arbitrage Monitor Starting...")
        print(f"  Poll interval: {POLL_INTERVAL_SECONDS}s")
        print(f"  Dry run: {self.dry_run}")
        print(f"  Pairs monitored: {len(PAIRS)}")
        print(f"  DEXes monitored: {len(DEX_ROUTERS)}")
        print("#" * 60)
        
        cycle = 0
        while True:
            cycle += 1
            print(f"\n--- Cycle #{cycle} ---")
            try:
                opportunities = self.run_cycle()
                if opportunities:
                    print(f"\n  ** {len(opportunities)} opportunities found")
            except KeyboardInterrupt:
                print("\nShutting down...")
                break
            except Exception as e:
                logger.error(f"Cycle failed: {e}")
                print(f"  Error: {e}")
            
            time.sleep(POLL_INTERVAL_SECONDS)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    
    w3 = Web3(Web3.HTTPProvider(RPC_URL, request_kwargs={"timeout": 10}))
    
    if not w3.is_connected():
        print("Failed to connect to BSC RPC")
        exit(1)
    
    monitor = ArbitrageMonitor(w3, dry_run=DRY_RUN)
    monitor.run()

