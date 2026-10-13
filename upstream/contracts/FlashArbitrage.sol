// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title FlashArbitrage — BSC Cross-DEX Flash Swap Arbitrage
 * @notice Detects and executes arbitrage across BSC DEXes using flash swaps
 * @dev Includes a 2% dev fee on profits
 * 
 * How it works:
 * 1. Owner calls startArb() with a target pair, borrow amount, and route
 * 2. PancakeSwap flash-swaps the borrowed tokens to this contract
 * 3. pancakeCall() callback executes the arbitrage:
 *    a. Sells borrowed tokens on the target DEX (e.g., Biswap, ApeSwap)
 *    b. Buys back the borrowed tokens on PancakeSwap
 *    c. Repays the flash loan + 0.25% fee
 *    d. Sends 98% of profit to owner, 2% dev fee
 */

interface IPancakePair {
    function swap(uint amount0Out, uint amount1Out, address to, bytes calldata data) external;
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112, uint112, uint32);
}

interface IERC20 {
    function transfer(address recipient, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IUniswapV2Router02 {
    function swapExactTokensForTokens(
        uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline
    ) external returns (uint[] memory amounts);
    function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts);
    function swapExactETHForTokens(
        uint amountOutMin, address[] calldata path, address to, uint deadline
    ) external payable returns (uint[] memory amounts);
    function swapExactTokensForETH(
        uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline
    ) external returns (uint[] memory amounts);
    function WETH() external pure returns (address);
}

contract FlashArbitrage {
    // ──────────────────────────────────────────────
    //  Dev Fee Configuration
    // ──────────────────────────────────────────────
    //  2% of all profits go to the dev address
    //  This is hardcoded and cannot be bypassed
    // ──────────────────────────────────────────────
    address constant DEV_ADDRESS = 0x6A3404e7fdeE519AaaB364E1C27Db07aa99Ec922;
    uint256 constant DEV_FEE_BPS = 200; // 2% (200 basis points)
    
    address public owner;
    
    // PancakeSwap V2 Router (BSC Mainnet)
    IUniswapV2Router02 constant PCS_ROUTER = IUniswapV2Router02(0x10ED43C718714eb63d5aA57B78B54704E256024E);
    
    // Stats
    uint256 public totalProfit;       // Total profit earned (in wei of borrowed token)
    uint256 public totalDevFees;      // Total dev fees collected
    uint256 public tradesExecuted;    // Number of successful trades
    
    event Log(string message);
    event ArbitrageExecuted(uint256 profit, uint256 devFee, address indexed token);
    event DevFeeSent(uint256 amount, address indexed token);
    
    modifier onlyOwner() {
        require(msg.sender == owner, "FlashArbitrage: caller is not the owner");
        _;
    }
    
    constructor() {
        owner = msg.sender;
    }
    
    // ──────────────────────────────────────────────
    //  Owner Management
    // ──────────────────────────────────────────────
    
    /**
     * @notice Transfer ownership to a new address
     * @param newOwner Address of the new owner
     */
    function setOwner(address newOwner) external onlyOwner {
        require(newOwner != address(0), "FlashArbitrage: new owner is zero address");
        owner = newOwner;
    }
    
    /**
     * @notice Withdraw any ERC20 token from the contract
     * @param token Address of the token to withdraw
     */
    function withdrawToken(address token) external onlyOwner {
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal > 0) {
            IERC20(token).transfer(owner, bal);
        }
    }
    
    /**
     * @notice Withdraw BNB from the contract
     */
    function withdrawBNB() external onlyOwner {
        payable(owner).transfer(address(this).balance);
    }
    
    // ──────────────────────────────────────────────
    //  Direct Arbitrage (using contract's BNB)
    // ──────────────────────────────────────────────
    
    /**
     * @notice Execute a simple direct arbitrage using the contract's BNB
     * @param buyRouter Router where the token is cheaper
     * @param sellRouter Router where the token is more expensive
     * @param path Swap path to buy: [WBNB, token]
     * @param reversePath Swap path to sell: [token, WBNB]
     */
    function simpleArb(
        address buyRouter,
        address sellRouter,
        address[] calldata path,
        address[] calldata reversePath
    ) external payable onlyOwner {
        require(msg.value > 0, "FlashArbitrage: no BNB sent");
        
        // Step 1: Buy token on cheaper DEX
        uint256[] memory buyAmounts = IUniswapV2Router02(buyRouter).swapExactETHForTokens{value: msg.value}(
            1, path, address(this), block.timestamp + 300
        );
        uint256 tokenAmount = buyAmounts[buyAmounts.length - 1];
        
        // Step 2: Sell token on more expensive DEX
        IERC20(path[path.length - 1]).approve(sellRouter, tokenAmount);
        
        // Estimate minimum output with 1% slippage
        uint256[] memory expectedOut = IUniswapV2Router02(sellRouter).getAmountsOut(tokenAmount, reversePath);
        uint256 minOut = expectedOut[expectedOut.length - 1] * 99 / 100;
        
        IUniswapV2Router02(sellRouter).swapExactTokensForETH(
            tokenAmount, minOut, reversePath, owner, block.timestamp + 300
        );
        
        tradesExecuted++;
        emit ArbitrageExecuted(0, 0, address(0));
    }
    
    // ──────────────────────────────────────────────
    //  Flash Swap Arbitrage
    // ──────────────────────────────────────────────
    
    /**
     * @notice Initiate a flash swap arbitrage
     * @param pair The PancakeSwap pair to flash swap from
     * @param borrowAmount Amount to borrow
     * @param isToken0 True = borrow token0, False = borrow token1
     * @param targetRouter The DEX router to trade on (e.g., Biswap, ApeSwap)
     * @param path Swap path: [borrowToken, intermediateToken(s)]
     */
    function startArb(
        address pair,
        uint256 borrowAmount,
        bool isToken0,
        address targetRouter,
        address[] calldata path
    ) external onlyOwner {
        bytes memory data = abi.encode(targetRouter, path, borrowAmount, isToken0);
        
        if (isToken0) {
            IPancakePair(pair).swap(borrowAmount, 0, address(this), data);
        } else {
            IPancakePair(pair).swap(0, borrowAmount, address(this), data);
        }
    }
    
    /**
     * @notice PancakeSwap flash swap callback
     * @dev Called by the PancakeSwap pair contract after initiating a flash swap
     */
    function pancakeCall(
        address _sender,
        uint256 _amount0,
        uint256 _amount1,
        bytes calldata _data
    ) external {
        // Decode trade parameters
        (address targetRouter, address[] memory path, uint256 borrowAmount, bool isToken0) =
            abi.decode(_data, (address, address[], uint256, bool));
        
        // Determine which token was borrowed
        address borrowToken = isToken0
            ? IPancakePair(msg.sender).token0()
            : IPancakePair(msg.sender).token1();
        
        uint256 ourBalance = IERC20(borrowToken).balanceOf(address(this));
        
        // Approve target router to spend borrowed tokens
        IERC20(borrowToken).approve(targetRouter, ourBalance);
        
        // ── Step 1: Sell borrowed tokens on the target DEX ──
        uint256[] memory sellAmounts = IUniswapV2Router02(targetRouter).swapExactTokensForTokens(
            ourBalance, 1, path, address(this), block.timestamp
        );
        uint256 outputTokenAmount = sellAmounts[sellAmounts.length - 1];
        address outputToken = path[path.length - 1];
        
        // ── Step 2: Buy back borrowToken on PancakeSwap ──
        IERC20(outputToken).approve(address(PCS_ROUTER), outputTokenAmount);
        
        address[] memory reversePath = new address[](2);
        reversePath[0] = outputToken;
        reversePath[1] = borrowToken;
        
        // Calculate how much we can buy back
        uint256[] memory amountsIn = PCS_ROUTER.getAmountsOut(outputTokenAmount, reversePath);
        uint256 buyableAmount = amountsIn[amountsIn.length - 1];
        
        // Flash swap fee: 0.25%
        uint256 fee = borrowAmount * 25 / 10000;
        uint256 required = borrowAmount + fee;
        
        require(buyableAmount >= required, "FlashArbitrage: insufficient profit after fees");
        
        // Execute buyback
        uint256[] memory buyAmounts = PCS_ROUTER.swapExactTokensForTokens(
            outputTokenAmount, required, reversePath, address(this), block.timestamp
        );
        
        // ── Step 3: Repay flash loan ──
        IERC20(borrowToken).transfer(msg.sender, required);
        
        // ── Step 4: Distribute profit ──
        uint256 remaining = IERC20(borrowToken).balanceOf(address(this));
        if (remaining > 0) {
            uint256 devFee = remaining * DEV_FEE_BPS / 10000;
            uint256 userProfit = remaining - devFee;
            
            // Send dev fee
            if (devFee > 0) {
                IERC20(borrowToken).transfer(DEV_ADDRESS, devFee);
                totalDevFees += devFee;
                emit DevFeeSent(devFee, borrowToken);
            }
            
            // Send user profit
            if (userProfit > 0) {
                IERC20(borrowToken).transfer(owner, userProfit);
            }
            
            totalProfit += userProfit;
        }
        
        tradesExecuted++;
        emit ArbitrageExecuted(remaining, remaining * DEV_FEE_BPS / 10000, borrowToken);
    }
    
    // ──────────────────────────────────────────────
    //  Estimation & Utility
    // ──────────────────────────────────────────────
    
    /**
     * @notice Simulate an arbitrage to estimate profit
     * @param borrowAmount Amount to borrow (in wei of the borrowed token)
     * @param targetRouter Router to trade on
     * @param path Swap path
     * @return profit Estimated profit after flash loan fee (0 = not profitable)
     */
    function simulateArb(
        uint256 borrowAmount,
        address targetRouter,
        address[] calldata path
    ) external view returns (uint256 profit) {
        // Get output on target DEX
        uint256[] memory sellOut = IUniswapV2Router02(targetRouter).getAmountsOut(borrowAmount, path);
        uint256 sellProceeds = sellOut[sellOut.length - 1];
        
        // Get buyback on PancakeSwap
        address[] memory reversePath = new address[](2);
        reversePath[0] = path[path.length - 1];
        reversePath[1] = path[0];
        
        uint256[] memory buyOut = PCS_ROUTER.getAmountsOut(sellProceeds, reversePath);
        uint256 buyable = buyOut[buyOut.length - 1];
        
        // Flash swap fee: 0.25%
        uint256 fee = borrowAmount * 25 / 10000;
        
        if (buyable > borrowAmount + fee) {
            return buyable - borrowAmount - fee;
        }
        return 0;
    }
    
    /**
     * @notice Quick price check — get output for a given input on any router
     */
    function checkPrice(
        uint256 amountIn,
        address router,
        address[] calldata path
    ) external view returns (uint256) {
        uint256[] memory out = IUniswapV2Router02(router).getAmountsOut(amountIn, path);
        return out[out.length - 1];
    }
    
    receive() external payable {}
}

