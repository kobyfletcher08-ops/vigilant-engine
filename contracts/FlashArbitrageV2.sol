// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
interface Token {function balanceOf(address) external view returns(uint256);}
interface Pair {function token0() external view returns(address);function token1() external view returns(address);function swap(uint256,uint256,address,bytes calldata) external;}
interface Factory {function getPair(address,address) external view returns(address);}
interface Router {function factory() external view returns(address);function WETH() external view returns(address);function swapExactTokensForTokens(uint256,uint256,address[] calldata,address,uint256) external returns(uint256[] memory);}

/// @notice Authenticated, owner-controlled WBNB round-trip flash swaps.
/// @dev The lending pair must differ from BOTH swap pairs. Tokens must support standard transfers.
contract FlashArbitrageV2 {
    address public owner;
    address public immutable wbnb;
    address public immutable pancakeFactory;
    address public constant DEV_ADDRESS=0x6A3404e7fdeE519AaaB364E1C27Db07aa99Ec922;
    uint256 public constant DEV_FEE_BPS=200;
    mapping(address=>bool) public allowedRouter;
    uint256 public tradesExecuted;
    uint256 public totalProfit;
    uint256 public totalDevFees;
    uint256 private phase;
    address private activePair;
    bytes32 private activeDataHash;
    uint256 private beforeBalance;
    struct Trade {address loanPair;address token;address buyRouter;address sellRouter;uint256 amount;uint256 minAssetOut;uint256 minWbnbOut;uint256 minProfit;uint256 deadline;}
    event ArbitrageExecuted(uint256 grossProfit,uint256 userProfit,uint256 devFee,address loanPair,address token);
    event RouterAllowed(address router,bool allowed);
    modifier onlyOwner(){require(msg.sender==owner,"owner only");_;}
    modifier idle(){require(phase==0,"busy");_;}
    constructor(address wrapped,address factory,address[] memory routers){
        require(wrapped.code.length>0&&factory.code.length>0,"missing protocol");owner=msg.sender;wbnb=wrapped;pancakeFactory=factory;
        require(routers.length>=2&&routers.length<=8,"router count");for(uint256 i;i<routers.length;i++)_allow(routers[i],true);
    }
    function _allow(address router,bool allowed) private {if(allowed){require(router.code.length>0&&Router(router).WETH()==wbnb,"bad router");require(Router(router).factory().code.length>0,"bad factory");}allowedRouter[router]=allowed;emit RouterAllowed(router,allowed);}
    function setRouter(address router,bool allowed) external onlyOwner idle {_allow(router,allowed);}
    function repayment(uint256 amount) public pure returns(uint256){return (amount*10000+9974)/9975;}
    function startArb(Trade calldata trade) external onlyOwner idle {
        require(trade.amount>0&&trade.minProfit>0&&trade.deadline>=block.timestamp&&trade.deadline<=block.timestamp+120,"invalid bounds");
        require(trade.token!=wbnb&&trade.token.code.length>0,"bad token");
        require(trade.buyRouter!=trade.sellRouter&&allowedRouter[trade.buyRouter]&&allowedRouter[trade.sellRouter],"router denied");
        address t0=Pair(trade.loanPair).token0();address t1=Pair(trade.loanPair).token1();
        require((t0==wbnb||t1==wbnb)&&Factory(pancakeFactory).getPair(t0,t1)==trade.loanPair,"unverified lender");
        require(Factory(Router(trade.buyRouter).factory()).getPair(wbnb,trade.token)!=trade.loanPair&&Factory(Router(trade.sellRouter).factory()).getPair(wbnb,trade.token)!=trade.loanPair,"lender would lock swap");
        beforeBalance=Token(wbnb).balanceOf(address(this));phase=1;activePair=trade.loanPair;bytes memory data=abi.encode(trade);activeDataHash=keccak256(data);
        Pair(trade.loanPair).swap(t0==wbnb?trade.amount:0,t1==wbnb?trade.amount:0,address(this),data);
        require(phase==2,"callback missing");phase=0;activePair=address(0);activeDataHash=bytes32(0);
    }
    function pancakeCall(address sender,uint256 amount0,uint256 amount1,bytes calldata data) external {
        require(phase==1&&msg.sender==activePair&&sender==address(this)&&keccak256(data)==activeDataHash,"unauthorized callback");
        phase=2;Trade memory trade=abi.decode(data,(Trade));
        require((amount0==trade.amount&&amount1==0)||(amount1==trade.amount&&amount0==0),"borrow mismatch");
        require(Token(wbnb).balanceOf(address(this))>=beforeBalance+trade.amount,"borrow not received");
        uint256 assetBefore=Token(trade.token).balanceOf(address(this));
        address[] memory path=new address[](2);path[0]=wbnb;path[1]=trade.token;
        _approve(wbnb,trade.buyRouter,trade.amount);
        Router(trade.buyRouter).swapExactTokensForTokens(trade.amount,trade.minAssetOut,path,address(this),trade.deadline);
        _approve(wbnb,trade.buyRouter,0);
        uint256 assetAmount=Token(trade.token).balanceOf(address(this))-assetBefore;require(assetAmount>=trade.minAssetOut,"first leg output");
        path[0]=trade.token;path[1]=wbnb;_approve(trade.token,trade.sellRouter,assetAmount);
        Router(trade.sellRouter).swapExactTokensForTokens(assetAmount,trade.minWbnbOut,path,address(this),trade.deadline);
        _approve(trade.token,trade.sellRouter,0);
        uint256 due=repayment(trade.amount);uint256 finalBalance=Token(wbnb).balanceOf(address(this));
        require(finalBalance>=beforeBalance+due+trade.minProfit,"profit floor");_transfer(wbnb,msg.sender,due);
        uint256 gross=finalBalance-beforeBalance-due;uint256 devFee=gross*DEV_FEE_BPS/10000;uint256 userProfit=gross-devFee;
        _transfer(wbnb,DEV_ADDRESS,devFee);_transfer(wbnb,owner,userProfit);
        totalProfit+=userProfit;totalDevFees+=devFee;tradesExecuted++;emit ArbitrageExecuted(gross,userProfit,devFee,trade.loanPair,trade.token);
    }
    function withdraw(address token,address recipient,uint256 amount) external onlyOwner idle {
        require(recipient!=address(0)&&recipient!=address(this)&&amount>0,"invalid transfer");
        if(token==address(0)){(bool sent,)=recipient.call{value:amount}("");require(sent,"native transfer");}else _transfer(token,recipient,amount);
    }
    function _approve(address token,address spender,uint256 amount) private {
        _call(token,abi.encodeWithSignature("approve(address,uint256)",spender,0));
        if(amount>0)_call(token,abi.encodeWithSignature("approve(address,uint256)",spender,amount));
    }
    function _transfer(address token,address recipient,uint256 amount) private {if(amount>0)_call(token,abi.encodeWithSignature("transfer(address,uint256)",recipient,amount));}
    function _call(address token,bytes memory data) private {(bool ok,bytes memory returned)=token.call(data);require(ok&&(returned.length==0||abi.decode(returned,(bool))),"token operation failed");}
    receive() external payable {}
}
