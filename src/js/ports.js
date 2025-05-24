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
} from 'grove-components/src/js/sharedEth/eth.js';
import { parseWeiStr, toScaledDecimal } from 'grove-components/src/js/sharedJs/math.js';
import { NEW_BLOCK_CHECK_INTERVAL_MS, BLOCKS_PER_DAY, EXP_DECIMALS, DEFAULT_GAS_PRICE, DEFAULT_GAS_LIMIT, XRPLEVM_PRICE } from './ports/constants.js';
import {subscribeToPreferences, subscribeToConsole } from './ports/subscription.js';
import {subscribeToNewBlocks} from './ports/blockSubscription'
import {subscribeToCheckTrxStatus, subscribeToStoreTransaction, startPendingTransactionChecker} from './ports/transactionSubscription'
import {reportError, getContractJsonByName, getContractJsonByAddress, getBlockTimestamps, getERC20Balance, getERC20Allowance, supplyUnderlying} from './ports/utils.js'
import {subscribeToCTokenPorts} from './ports/cTokenPorts'


var currentSendGasPrice;

// Track app initialization state
let isAppInitialized = false;
let pendingMessages = [];

// Function to process pending messages after app initialization
function processPendingMessages() {
    console.log('DEBUG: Processing pending messages:', pendingMessages.length);
    const messages = [...pendingMessages];
    pendingMessages = [];
    
    messages.forEach(({ port, data }) => {
        try {
            if (port && typeof port.send === 'function') {
                console.log('DEBUG: Sending delayed message to port');
                port.send(data);
            }
        } catch (error) {
            console.error('Error sending port message:', error);
        }
    });
}

// Helper function to safely send port messages
function safeSendPort(port, data) {
    if (!port) {
        console.error('Port is not defined');
        return;
    }
    
    if (isAppInitialized) {
        try {
            port.send(data);
        } catch (error) {
            console.error('Error sending port message:', error);
        }
    } else {
        console.log('DEBUG: App not initialized, queuing message');
        pendingMessages.push({ port, data });
    }
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
  let connectedAddress = null;
  let data = null;
  
  try {
    // Get connected wallet address
    if (globEthereum) {
      try {
        const accounts = await globEthereum.request({ method: 'eth_requestAccounts' });
        connectedAddress = accounts[0]?.toLowerCase();
      } catch (error) {
        console.error('Failed to get wallet address:', error);
      }
    }

    console.log('Connected address:', connectedAddress);
    
    // GraphQL API endpoint
    const GRAPHQL_URL = 'https://api.goldsky.com/api/public/project_cmamdoy8hyjpy01xr03dodf4o/subgraphs/grove/v1/gn';
    
    // Query for all data in one request
    const query = `
      query {
        comptrollers {
          id
          closeFactor
          liquidationIncentive
          priceOracle
        }
        markets {
          id
          symbol
          name
          underlyingAddress
          underlyingName
          underlyingSymbol
          underlyingDecimals
          underlyingPriceUSD
          exchangeRate
          supplyRate
          borrowRate
          reserveFactor
          collateralFactor
          totalSupply
          totalBorrows
          cash
          reserves
          blockTimestamp
          interestRateModelAddress
          accrualBlockNumber
          borrowIndex
          numberOfBorrowers
          numberOfSuppliers
        }
        accountGTokens(where: {account: "${connectedAddress}"}) {
          id
          symbol
          gTokenBalance
          totalUnderlyingSupplied
          totalUnderlyingRepaid
          totalUnderlyingRedeemed
          totalUnderlyingBorrowed
          enteredMarket
          accountBorrowIndex
          accrualBlockNumber
          transactionTimes
          transactionHashes
          storedBorrowBalance
          market {
            id
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
        account(id: "${connectedAddress || '0x0000000000000000000000000000000000000000'}") {
          id
          hasBorrowed
          countLiquidated
          countLiquidator
        }
      }
    `;
            // accountGTokens(where: {account: "${connectedAddress}"}) {


    // Fetch data from GraphQL API
    console.log('Fetching data from GraphQL API...');
    const response = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query })
    });

    if (!response.ok) {
      throw new Error(`GraphQL request failed with status ${response.status}`);
    }

    const result = await response.json();
    console.log('GraphQL data received:', result);
    


    // Extract market data
    const markets = Array.isArray(result.data.markets) ? result.data.markets : [];
    const marketData = markets.reduce((acc, market) => {
      acc[market.id.toLowerCase()] = market;
      return acc;
    }, {});
    
    // Save the data for further processing
    data = result;
    
    // Create an account object with default values if account data is null
    const accountData = data.data.account || {
      hasBorrowed: false,
      id: connectedAddress,
      countLiquidator: 0,
      countLiquidated: 0
    };

    // Transform account data - handle empty accountGTokens case
    const realAccountData =
      data.data.accountGTokens?.reduce((accounts, token) => {
        console.log(token);
        
        // Fix: Don't rely on token.account which might be undefined
        // Instead, use the connectedAddress we already have
        const accountId = connectedAddress;
        
        let account = accounts.find((a) => a.customerAddress === accountId);

        if (!account) {
          account = {
            customerAddress: accountId,
            assetsIn: [],
            accountLiquidity: '0',
            accountShortfall: '0',
            trxCount: 0,
            // Use the account data we extracted earlier
            hasBorrowed: accountData.hasBorrowed,
            countLiquidator: accountData.countLiquidator,
            countLiquidated: accountData.countLiquidated,
            tokens: [],
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
        account.accountLiquidity = (
          parseFloat(account.accountLiquidity) + Math.max(0, suppliedValue - borrowedValue)
        ).toString();
        account.accountShortfall = (
          parseFloat(account.accountShortfall) + Math.max(0, borrowedValue - suppliedValue)
        ).toString();
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
          numberOfSuppliers: market.numberOfSuppliers,
        });

        return accounts;
      }, []) || [];

    // Create empty account data if none exists
    if (realAccountData.length === 0) {
      realAccountData.push({
        customerAddress: connectedAddress,
        assetsIn: [],
        accountLiquidity: '0',
        accountShortfall: '0',
        trxCount: 0,
        hasBorrowed: accountData.hasBorrowed,
        countLiquidator: accountData.countLiquidator,
        countLiquidated: accountData.countLiquidated,
        tokens: [],
      });
    }

    // Return the processed data for use by other functions
    return {
      graphQLData: data,
      comptrollerData: data.data.comptrollers[0] || {
        closeFactor: '0',
        liquidationIncentive: '0',
      },
      marketData,
      connectedAddress
    };
  } catch (error) {
    console.error('Error processing GraphQL data:', error);
    
    // Make sure connectedAddress is defined and used in error handling too
    // If we don't have a connected address yet, try to get it
    if (!connectedAddress) {
      try {
        if (globEthereum) {
          const accounts = await globEthereum.request({ method: 'eth_requestAccounts' });
          connectedAddress = accounts[0]?.toLowerCase();
        }
      } catch (e) {
        console.error('Could not get address during error handling:', e);
      }
    }
    
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
        customerAddress: connectedAddress || '0x0000000000000000000000000000000000000000',
        accountLiquidity: '0',
        accountShortfall: '0',
        assetsIn: [],
        trxCount: 0,
        hasBorrowed: false,
        countLiquidator: 0,
        countLiquidated: 0,
      });
    }
    if (app.ports.giveComptrollerMetadataPort) {
      safeSendPort(app.ports.giveComptrollerMetadataPort, {
        closeFactor: '0',
        liquidationIncentive: '0',
      });
    }
    if (app.ports.giveEtherUsdPricePort) {
      safeSendPort(app.ports.giveEtherUsdPricePort, { price: '0' });
    }
    
    // Return null to indicate an error occurred
    return null;
  }
}

// Add test data function
async function sendTestData(app, eth, globEthereum) {
  console.log('DEBUG: Starting sendTestData function');
  
  try {
    // Fetch real data from GraphQL
    const graphQLResponse = await testGraphQLData(app, eth, globEthereum);
    
    if (!graphQLResponse) {
      throw new Error('Failed to fetch GraphQL data');
    }
    
    const { graphQLData, comptrollerData, marketData, connectedAddress } = graphQLResponse;
    
    // Fallback test data for CToken metadata
    const testCTokenMetadata = [
      {
        cTokenAddress: "0x0f6e54a0cDE8e09d3035aF966eBa96EE2ba29D30".toLowerCase(), // GDai
        exchangeRate: "1", // 1.0
        supplyRatePerDay: "0.001", // 0.001 (0.1%)
        borrowRatePerDay: "0.002", // 0.002 (0.2%)
        collateralFactor: "0.8", // 0.8 (80%)
        reserveFactor: "0.1", // 0.1 (10%)
        totalBorrows: "1000", // 1,000 DAI
        totalUnderlyingCash: "2000", // 2,000 DAI
        totalReserves: "0.1", // 0.1 DAI
        totalSupply: "3000", // 3,000 cDAI
        totalSupplyUnderlying: "3000", // 3,000 DAI
        compSupplySpeedPerBlock: "0.001", // 0.001 COMP per block
        compSupplySpeedPerDay: "0.1", // 0.1 COMP per day
        compBorrowSpeedPerBlock: "0.002", // 0.002 COMP per block
        compBorrowSpeedPerDay: "0.2", // 0.2 COMP per day
        borrowCap: "10000", // 10,000 DAI
        mintGuardianPaused: false,
        underlyingPrice: "1", // 1.0 USD
        underlyingAssetAddress: "0xeBD8479f1DF837e4169D2A69663e1CeDE6A6FC1A".toLowerCase(),
      }
    ];

  
    
    // Test comptroller metadata using the comptroller data from GraphQL or fallback
const comptrollerMetadata = {
  closeFactor:
    comptrollerData?.closeFactor !== null && comptrollerData?.closeFactor !== undefined
      ? comptrollerData.closeFactor
      : "0",
  liquidationIncentive:
    comptrollerData?.liquidationIncentive !== null && comptrollerData?.liquidationIncentive !== undefined
      ? comptrollerData.liquidationIncentive
      : "0"
};


    const oraclePrices = Object.values(marketData).map(market => ({
      underlyingAssetAddress: market.underlyingAddress?.toLowerCase() || "",
      value: market.underlyingPriceUSD || "1"
    }));
    if (oraclePrices.length === 0) {
      oraclePrices.push(
        {
          underlyingAssetAddress: "",
          value: "0"
        },
        {
          underlyingAssetAddress: "", 
          value: "0"
        }
      );
    }

    // Transform GraphQL market data to cToken metadata format
    const cTokenMetadata = Object.values(marketData).map(market => ({
      cTokenAddress: market.id?.toLowerCase(),
      exchangeRate: market.exchangeRate || "1",
      supplyRatePerDay: (parseFloat(market.supplyRate || "0") * BLOCKS_PER_DAY).toString(),
      borrowRatePerDay: (parseFloat(market.borrowRate || "0") * BLOCKS_PER_DAY).toString(),
      collateralFactor: market.collateralFactor || "0.8",
      reserveFactor: market.reserveFactor || "0.1",
      totalBorrows: market.totalBorrows || "0",
      totalUnderlyingCash: market.cash || "0",
      totalReserves: market.reserves || "0",
      totalSupply: market.totalSupply || "0",
      totalSupplyUnderlying: market.totalSupply || "0", // Not directly available in GraphQL
      compSupplySpeedPerBlock: "0.001", // Fallback value
      compSupplySpeedPerDay: "0.1", // Fallback value
      compBorrowSpeedPerBlock: "0.002", // Fallback value
      compBorrowSpeedPerDay: "0.2", // Fallback value
      borrowCap: "10000", // Fallback value
      mintGuardianPaused: false,
      underlyingPrice: market.underlyingPriceUSD || "1",
      underlyingAssetAddress: market.underlyingAddress?.toLowerCase() || ""
    }));
    if (cTokenMetadata.length === 0) {
      console.log('DEBUG: Using fallback cToken metadata');
      cTokenMetadata.push(...testCTokenMetadata);
    }


    const accountTokens = graphQLData.data.accountGTokens || [];
    
    let accountLimits = {
      customerAddress: connectedAddress || "0x0000000000000000000000000000000000000000",
      accountLiquidity: "0",
      accountShortfall: "0",
      assetsIn: [],
      trxCount: 0
    };
    
    const balancePromises = Object.values(marketData).map(async market => {
      try {
        // Fetch token balances and allowances
        const walletBalance = await getERC20Balance(connectedAddress, market.underlyingAddress);
        const allowance = await getERC20Allowance(connectedAddress, market.underlyingAddress, market.id?.toLowerCase());
        
        return {
          cTokenAddress: market.id?.toLowerCase(),
          customerAddress: connectedAddress || "0x0000000000000000000000000000000000000000",
          cTokenWalletBalance: "0",  // Default to 0 for non-interacted markets
          underlyingAssetAddress: market.underlyingAddress?.toLowerCase() || "",
          underlyingBorrowBalance: "0", // Default values
          underlyingSupplyBalance: "0", // Default values
          underlyingTokenWalletBalance: walletBalance,
          underlyingTokenAllowance: allowance
        };
      } catch (error) {
        console.error('Error fetching market data for', market.id, error);
        // Return a valid object even on error
        return {
          cTokenAddress: market.id?.toLowerCase(),
          customerAddress: connectedAddress || "0x0000000000000000000000000000000000000000",
          cTokenWalletBalance: "0",
          underlyingAssetAddress: market.underlyingAddress?.toLowerCase() || "",
          underlyingBorrowBalance: "0",
          underlyingSupplyBalance: "0",
          underlyingTokenWalletBalance: "0",
          underlyingTokenAllowance: "0"
        };
      }
    });
        let cTokenBalances = [];
    try {
      cTokenBalances = await Promise.all(balancePromises);
    } catch (error) {
      console.error('Error resolving market balances:', error);
      // Create an empty array as fallback
      cTokenBalances = [];
    }
        if (accountTokens.length > 0) {
      accountTokens.forEach(token => {
        const cTokenAddress = token.id.split('-')[0]?.toLowerCase();
        const existingIndex = cTokenBalances.findIndex(item => 
          item.cTokenAddress === cTokenAddress && 
          item.customerAddress === connectedAddress
        );
        
        if (existingIndex >= 0) {
          // Update existing entry with user data
          cTokenBalances[existingIndex].cTokenWalletBalance = token.gTokenBalance || "0";
          cTokenBalances[existingIndex].underlyingBorrowBalance = token.storedBorrowBalance || "0";
          cTokenBalances[existingIndex].underlyingSupplyBalance = token.totalUnderlyingSupplied || "0";
        }
      });
    }
    
    if (accountTokens.length > 0) {
      console.log('DEBUG: Processing account tokens');
    } else {
      console.log('DEBUG: Using fallback account data');
    }
    
    if (app.ports.giveOraclePricesAllPort) {
      safeSendPort(app.ports.giveOraclePricesAllPort, oraclePrices);
    }
    
    if (app.ports.giveCTokenMetadataPort) {
      console.log('DEBUG: Sending CToken metadata:', cTokenMetadata);
      safeSendPort(app.ports.giveCTokenMetadataPort, cTokenMetadata);
    }
    
    if (app.ports.giveCTokenBalancesAllPort) {
      safeSendPort(app.ports.giveCTokenBalancesAllPort, cTokenBalances);
    }
    
    if (app.ports.giveAccountLimitsPort) {
      safeSendPort(app.ports.giveAccountLimitsPort, accountLimits);
    }
    
    if (app.ports.giveComptrollerMetadataPort) {
      safeSendPort(app.ports.giveComptrollerMetadataPort, comptrollerMetadata);
    }
    
    if (app.ports.giveEtherUsdPricePort) {
      console.log('DEBUG: Sending ether price');
      safeSendPort(app.ports.giveEtherUsdPricePort, { price: "220" });
    }

    console.log('DEBUG: Data sending complete');
  } catch (error) {
    console.error('Error in sendTestData:', error);
    
    if (app.ports.giveEtherUsdPricePort) {
      safeSendPort(app.ports.giveEtherUsdPricePort, { price: "2000" });
    }
  }
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
    
    // Start the direct transaction checker to poll for transaction status
    // This will regularly check all pending transactions without waiting for new blocks
    console.log('Starting direct transaction checker for pending transactions');
    startPendingTransactionChecker(app, eth);
    subscribeToPreferences(app);
    // subscribeToGasService(app);
    subscribeToRepl(app, eth, configFiles, configAbiFiles, connectedWalletPorts.showAccount);
    subscribeToFlywheelPorts(app, eth);
    subscribeToEtherPorts(app, eth);
}


export default {
  subscribe,
};
