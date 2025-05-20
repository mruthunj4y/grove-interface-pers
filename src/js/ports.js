import { StaticJsonRpcProvider } from '@ethersproject/providers';
import connectedWalletPorts from '../../node_modules/grove-components/src/js/sharedEth/connectedWalletPorts';
import EthUtils from '../../node_modules/web3-utils';
import EIP20Interface from './json/contracts/EIP20Interface.json';
import trxStorage from './trxStorage';
import bnTxStorage from './bnTxStorage';
import storage from './storage';
import { requestForeground } from './helpers';
import {
  debug,
  langFromURL,
  shouldAutoConnect,
  supportFromEntries,
} from 'grove-components/src/js/sharedEth/utils';
import { subscribeToRepl } from './repl';
import {
  getAccounts,
  getBalance,
  getBlockNumber,
  getEvent,
  getLogs,
  getLedgerAddressAndBalance,
  getTransaction,
  getTransactionCount,
  getTransactionReceipt,
  makeEth,
  sign,
  withWeb3Eth,
  withTrxWeb3,
  withGasLimitFromPayload,
  wrapCall,
  wrapCallErr,
  wrapSend,
} from 'grove-components/src/js/sharedEth/xrp.js';
import { parseWeiStr, toScaledDecimal } from 'grove-components/src/js/sharedJs/math.js';
import { NEW_BLOCK_CHECK_INTERVAL_MS, BLOCKS_PER_DAY, EXP_DECIMALS, DEFAULT_GAS_PRICE, DEFAULT_GAS_LIMIT, XRPLEVM_PRICE } from './ports/constants.js';
import { subscribeToGasService, subscribeToPreferences, subscribeToConsole } from './ports/subscription.js';
import {subscribeToNewBlocks} from './ports/blockSubscription'
import {subscribeToStoreTransaction} from './ports/transactionSubscription'
import {reportError, safeSendPort, getContractJsonByName, getContractJsonByAddress, getBlockTimestamps, handleReceipt, getERC20Balance, getERC20Allowance, supplyUnderlying} from './ports/utils.js'
import {subscribeToCTokenPorts} from './ports/cTokenPorts'


var currentSendGasPrice;

// Track app initialization state
let isAppInitialized = false;
let pendingMessages = [];

// Function to process pending messages after app initialization
function processPendingMessages() {
    pendingMessages.forEach(({ port, data }) => {
        if (port) {
            try {
                port.send(data);
            } catch (error) {
                console.error('Error sending port message:', error);
            }
        }
    });
    pendingMessages = [];
}

function subscribeToCheckTrxStatus(app, eth) {
  // port checkTrxStatusPort : { blockNumber : Int, trxHash : String } -> Cmd msg
  app.ports.checkTrxStatusPort.subscribe(({ blockNumber, trxHash }) => {
    Promise.all([getTransaction(eth, trxHash), getTransactionReceipt(eth, trxHash)])
      .then(([transaction, receipt]) => handleReceipt(app, eth, trxHash, blockNumber, receipt, transaction.nonce))
      .catch(reportError(app));
  });
}


function handleTransactionNotification(app, eth, txModule, txId, txHash, status, blockNumber) {
  // port etherTransactionStatePort : (Json.Decode.Value -> msg) -> Sub msg
  app.ports.etherTransactionStatePort.send({
    txModule,
    txId,
    txHash: txHash,
    status: status,
    blockNumber: blockNumber,
  });
}

function subscribeToEtherPorts(app, eth) {
  // port etherSendTransactionPort : String -> Encode.Value -> Cmd msg
  app.ports.etherSendTransactionPort.subscribe(([txModule, txId, { from, to, data, value }]) => {
    const trxPayload = {
      from,
      to,
      data,
      value,
    };

    withTrxWeb3(
      eth,
      (web3Eth) => {
        withGasLimitFromPayload(web3Eth, trxPayload).then((estimatedGasLimit) => {
          let trxPayloadWithGasLimit = Object.assign(trxPayload, {
            gas: estimatedGasLimit,
          });
          web3Eth
            .sendTransaction(trxPayloadWithGasLimit)
            .on('transactionHash', (txHash) => {
              // If no blocknative, then let's try creating a non BN Transaction
              // so it can be watched for every new block.
              app.ports.giveNewNonBNTrxPort.send({
                txModule,
                txId,
                txHash: txHash,
              });

              // Finally let's trigger a reject of the BNTransaction so we don't try 2
              // of them.
              app.ports.etherTransactionRejectedPort.send({
                txModule,
                txId,
              });
            })
            .catch((e) => {
              // User denied transaction signature
              if (e.code === 4001) {
                // port etherTransactionRejectedPort : (Json.Decode.Value -> msg) -> Sub msg
                app.ports.etherTransactionRejectedPort.send({
                  txModule,
                  txId,
                });
              } else {
                console.log('Error sending transaction: ', e);
              }
            });
        });
      },
      () => {
        console.error('Cannot send transaction without transaction Web3');
      }
    );
  });

  // port etherWatchTransactionPort : ( String, Int, String ) -> Encode.Value -> Cmd msg
  app.ports.etherWatchTransactionPort.subscribe(([txModule, txId, txHash]) => {
    getTransactionReceipt(eth, txHash)
      .then((receipt) => {
        if (!receipt) {
          return null;
        } else {
          const status = receipt.status === true ? 'confirmed' : 'failed';

          // port etherTransactionStatePort : (Json.Decode.Value -> msg) -> Sub msg
          app.ports.etherTransactionStatePort.send({
            txModule,
            txId,
            txHash: txHash,
            status: status,
            blockNumber: null,
          });
        }
      })
      .catch(reportError(app));
  });
}

function subscribeToFlywheelPorts(app, eth) {
  // port askClaimCompPort : { comptrollerAddress : String, customerAddress : String, markets : List String } -> Cmd msg
  app.ports.askClaimCompPort.subscribe(({ comptrollerAddress, customerAddress, markets }) => {
    const Comptroller = getContractJsonByName(eth, 'Comptroller');

    wrapSend(
      app,
      eth,
      Comptroller,
      comptrollerAddress,
      'claimComp',
      [customerAddress, markets],
      comptrollerAddress,
      customerAddress,
      currentSendGasPrice,
      {
        displayArgs: [customerAddress],
      }
    ).catch(reportError(app));
  });
}

// Test function to fetch data from GraphQL API
async function testGraphQLData(app, eth, globEthereum) {
    try {
        // Get connected wallet address
        if (!globEthereum) {
            console.error('Ethereum provider not available');
            return;
        }

        const accounts = await globEthereum.request({ method: 'eth_requestAccounts' });
        const connectedAddress = accounts[0]?.toLowerCase();
        
        if (!connectedAddress) {
            console.error('No connected wallet address found');
            return;
        }

        const GRAPHQL_URL = 'https://api.goldsky.com/api/public/project_cmamdoy8hyjpy01xr03dodf4o/subgraphs/grove/v1/gn';
        
        // Query for all data with specific account filter
        const mainQuery = `
            query {
                comptrollers {
                    closeFactor
                    id
                    liquidationIncentive
                    priceOracle
                }
                markets {
                    accrualBlockNumber
                    borrowIndex
                    blockTimestamp
                    borrowRate
                    cash
                    collateralFactor
                    exchangeRate
                    id
                    interestRateModelAddress
                    name
                    numberOfBorrowers
                    numberOfSuppliers
                    reserveFactor
                    reserves
                    supplyRate
                    symbol
                    totalBorrows
                    totalSupply
                    underlyingAddress
                    underlyingDecimals
                    underlyingName
                    underlyingPriceUSD
                    underlyingSymbol
                }
                accountGTokens(where: { account: "${connectedAddress}" }) {
                    id
                    symbol
                    totalUnderlyingSupplied
                    totalUnderlyingRepaid
                    totalUnderlyingRedeemed
                    totalUnderlyingBorrowed
                    gTokenBalance
                    accountBorrowIndex
                    accrualBlockNumber
                    enteredMarket
                    transactionTimes
                    transactionHashes
                    storedBorrowBalance
                    account {
                        id
                        countLiquidator
                        hasBorrowed
                        countLiquidated
                    }
                    market {
                        collateralFactor
                        exchangeRate
                        underlyingPriceUSD
                        underlyingAddress
                        totalSupply
                        totalBorrows
                        supplyRate
                        borrowRate
                        reserves
                        reserveFactor
                    }
                }
            }
        `;

        // Fetch all data
        const response = await fetch(GRAPHQL_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                query: mainQuery
            })
        });
        const data = await response.json();
        console.log('GraphQL Data:', data);

        // Extract comptroller data
        const comptrollerData = data.data.comptrollers[0] || {
            closeFactor: "0.5",
            liquidationIncentive: "1.08"
        };

        // Extract market data
        const marketData = data.data.markets.reduce((acc, market) => {
            acc[market.id.toLowerCase()] = market;
            return acc;
        }, {});

        // Transform account data - handle empty accountGTokens case
        const realAccountData = data.data.accountGTokens?.reduce((accounts, token) => {
            const accountId = token.account.id.toLowerCase();
            let account = accounts.find(a => a.customerAddress === accountId);
            
            if (!account) {
                account = {
                    customerAddress: accountId,
                    assetsIn: [],
                    accountLiquidity: "0",
                    accountShortfall: "0",
                    trxCount: 0,
                    hasBorrowed: token.account.hasBorrowed,
                    countLiquidator: token.account.countLiquidator,
                    countLiquidated: token.account.countLiquidated,
                    tokens: []
                };
                accounts.push(account);
            }

            // Get market data for this token
            const market = marketData[token.id.split('-')[0].toLowerCase()] || token.market;

            // Calculate collateral and borrow values
            const collateralFactor = parseFloat(market.collateralFactor);
            const underlyingPrice = parseFloat(market.underlyingPriceUSD);
            
            // Use actual supplied and borrowed amounts from the token data
            const suppliedValue = parseFloat(token.totalUnderlyingSupplied) * underlyingPrice * collateralFactor;
            const borrowedValue = parseFloat(token.storedBorrowBalance) * underlyingPrice;

            // Update account totals
            account.accountLiquidity = (parseFloat(account.accountLiquidity) + Math.max(0, suppliedValue - borrowedValue)).toString();
            account.accountShortfall = (parseFloat(account.accountShortfall) + Math.max(0, borrowedValue - suppliedValue)).toString();
            account.trxCount += token.transactionHashes.length;

            if (token.enteredMarket) {
                account.assetsIn.push(token.id.split('-')[0].toLowerCase());
            }

            // Add token data
            account.tokens.push({
                cTokenAddress: token.id.split('-')[0].toLowerCase(),
                symbol: token.symbol,
                gTokenBalance: token.gTokenBalance,
                storedBorrowBalance: token.storedBorrowBalance,
                totalUnderlyingBorrowed: token.totalUnderlyingBorrowed,
                totalUnderlyingRedeemed: token.totalUnderlyingRedeemed,
                totalUnderlyingRepaid: token.totalUnderlyingRepaid,
                totalUnderlyingSupplied: token.totalUnderlyingSupplied,
                enteredMarket: token.enteredMarket,
                accountBorrowIndex: token.accountBorrowIndex,
                accrualBlockNumber: token.accrualBlockNumber,
                transactionHashes: token.transactionHashes,
                transactionTimes: token.transactionTimes,
                collateralFactor: market.collateralFactor,
                underlyingPrice: market.underlyingPriceUSD,
                underlyingAssetAddress: market.underlyingAddress.toLowerCase(),
                exchangeRate: market.exchangeRate,
                supplyRate: market.supplyRate,
                borrowRate: market.borrowRate,
                totalSupply: market.totalSupply,
                totalBorrows: market.totalBorrows,
                reserves: market.reserves,
                reserveFactor: market.reserveFactor,
                underlyingDecimals: market.underlyingDecimals,
                underlyingSymbol: market.underlyingSymbol,
                underlyingName: market.underlyingName,
                numberOfBorrowers: market.numberOfBorrowers,
                numberOfSuppliers: market.numberOfSuppliers
            });

            return accounts;
        }, []) || [];

        // Create empty account data if none exists
        if (realAccountData.length === 0) {
            realAccountData.push({
                customerAddress: connectedAddress,
                assetsIn: [],
                accountLiquidity: "0",
                accountShortfall: "0",
                trxCount: 0,
                hasBorrowed: false,
                countLiquidator: 0,
                countLiquidated: 0,
                tokens: []
            });
        }

        // Create a map of unique token addresses to avoid duplicate balance checks
        const uniqueTokens = new Map();
        Object.values(marketData).forEach(market => {
            if (!uniqueTokens.has(market.underlyingAddress.toLowerCase())) {
                uniqueTokens.set(market.underlyingAddress.toLowerCase(), {
                    address: market.underlyingAddress.toLowerCase(),
                    decimals: market.underlyingDecimals
                });
            }
        });

        // Check balances only for unique tokens
        const balancePromises = Array.from(uniqueTokens.values()).map(async ({ address, decimals }) => {
            const balance = await getERC20Balance(connectedAddress, address, decimals);
            return { address, balance };
        });

        const balances = await Promise.all(balancePromises);
        const balanceMap = new Map(balances.map(({ address, balance }) => [address, balance]));

        // Create token balances for all markets
        const cTokenBalances = Object.values(marketData).map(market => ({
            cTokenAddress: market.id.toLowerCase(),
            customerAddress: connectedAddress,
            cTokenWalletBalance: "0",
            underlyingAssetAddress: market.underlyingAddress.toLowerCase(),
            underlyingBorrowBalance: "0",
            underlyingSupplyBalance: "0",
            underlyingTokenWalletBalance: balanceMap.get(market.underlyingAddress.toLowerCase()) || "0",
            underlyingTokenAllowance: "0"
        }));

        // Send data through ports
        if (app.ports.giveOraclePricesAllPort) {
            const oraclePrices = Object.values(marketData).map(market => ({
                underlyingAssetAddress: market.underlyingAddress.toLowerCase(),
                value: market.underlyingPriceUSD
            }));
            safeSendPort(app.ports.giveOraclePricesAllPort, oraclePrices);
        }
        
        if (app.ports.giveCTokenMetadataPort) {
            const cTokenMetadata = Object.values(marketData).map(market => {
                // Calculate totalSupplyUnderlying from exchange rate and total supply
                const totalSupplyUnderlying = (parseFloat(market.totalSupply) * parseFloat(market.exchangeRate)).toString();
                
                return {
                    cTokenAddress: market.id.toLowerCase(),
                    exchangeRate: market.exchangeRate,
                    supplyRatePerDay: (parseFloat(market.supplyRate) * BLOCKS_PER_DAY).toString(),
                    borrowRatePerDay: (parseFloat(market.borrowRate) * BLOCKS_PER_DAY).toString(),
                    collateralFactor: market.collateralFactor,
                    reserveFactor: market.reserveFactor,
                    totalBorrows: market.totalBorrows,
                    totalReserves: market.reserves,
                    totalSupply: market.totalSupply,
                    totalSupplyUnderlying: totalSupplyUnderlying,
                    totalUnderlyingCash: market.cash,
                    underlyingPrice: market.underlyingPriceUSD,
                    underlyingAssetAddress: market.underlyingAddress.toLowerCase(),
                    compSupplySpeedPerBlock: "0",
                    compSupplySpeedPerDay: "0",
                    compBorrowSpeedPerBlock: "0",
                    compBorrowSpeedPerDay: "0",
                    borrowCap: "0",
                    mintGuardianPaused: false
                };
            });
            safeSendPort(app.ports.giveCTokenMetadataPort, cTokenMetadata);
        }
        
        if (app.ports.giveCTokenBalancesAllPort) {
            safeSendPort(app.ports.giveCTokenBalancesAllPort, cTokenBalances);
        }
        
        if (app.ports.giveAccountLimitsPort) {
            safeSendPort(app.ports.giveAccountLimitsPort, realAccountData[0]);
        }
        
        if (app.ports.giveComptrollerMetadataPort) {
            safeSendPort(app.ports.giveComptrollerMetadataPort, {
                closeFactor: comptrollerData.closeFactor || "0.5",
                liquidationIncentive: comptrollerData.liquidationIncentive || "1.08"
            });
        }
        
        if (app.ports.giveEtherUsdPricePort) {
            // Find ETH price from markets if available
            const ethMarket = Object.values(marketData).find(m => m.underlyingSymbol === 'ETH');
            safeSendPort(app.ports.giveEtherUsdPricePort, { 
                price: ethMarket?.underlyingPriceUSD || "2000" 
            });
        }

    } catch (error) {
        console.error('Error fetching GraphQL data:', error);
        // Send empty data on error
        if (app.ports.giveOraclePricesAllPort) {
            safeSendPort(app.ports.giveOraclePricesAllPort, []);
        }
        if (app.ports.giveCTokenMetadataPort) {
            safeSendPort(app.ports.giveCTokenMetadataPort, []);
        }
        if (app.ports.giveCTokenBalancesAllPort) {
            safeSendPort(app.ports.giveCTokenBalancesAllPort, []);
        }
        if (app.ports.giveAccountLimitsPort) {
            safeSendPort(app.ports.giveAccountLimitsPort, {
                customerAddress: connectedAddress,
                accountLiquidity: "0",
                accountShortfall: "0",
                assetsIn: [],
                trxCount: 0,
                hasBorrowed: false,
                countLiquidator: 0,
                countLiquidated: 0
            });
        }
        if (app.ports.giveComptrollerMetadataPort) {
            safeSendPort(app.ports.giveComptrollerMetadataPort, {
                closeFactor: "0.5",
                liquidationIncentive: "1.08"
            });
        }
        if (app.ports.giveEtherUsdPricePort) {
            safeSendPort(app.ports.giveEtherUsdPricePort, { price: "2000" });
        }
    }
}

// Add test data function
async function sendTestData(app, eth, globEthereum) {
    await testGraphQLData(app, eth, globEthereum);
}

function subscribe(
  app,
  globEthereum,
  dataProviders,
  networkMap,
  networkAbiMap,
  defaultNetwork,
  configFiles,
  configAbiFiles,
  configNameToAddressMappings,
  walletConnectProjectId
) {
    // Mark app as initialized
    isAppInitialized = true;
    
    // Set initial gas price
    currentSendGasPrice = DEFAULT_GAS_PRICE;
    
    // Process any pending messages
    processPendingMessages();

    const eth = makeEth(dataProviders, networkMap, networkAbiMap, configNameToAddressMappings, defaultNetwork);
    connectedWalletPorts.subscribe(app, eth, globEthereum, networkMap, defaultNetwork, walletConnectProjectId);

    // Send test data after a short delay to ensure ports are initialized
    setTimeout(async () => {
        await sendTestData(app, eth, globEthereum);
    }, 1000);

    // Subscribe to account changes to refresh data
    if (globEthereum) {
        globEthereum.on('accountsChanged', async (accounts) => {
            if (accounts.length > 0) {
                await sendTestData(app, eth, globEthereum);
            }
        });
    }

    subscribeToConsole(app);
    subscribeToCTokenPorts(app, eth);
    subscribeToNewBlocks(app, eth);
    subscribeToCheckTrxStatus(app, eth);
    subscribeToStoreTransaction(app, eth);
    subscribeToPreferences(app);
    subscribeToGasService(app);
    subscribeToRepl(app, eth, configFiles, configAbiFiles, connectedWalletPorts.showAccount);
    subscribeToFlywheelPorts(app, eth);
    subscribeToEtherPorts(app, eth);
}

export default {
  subscribe,
};
