import { Sleuth } from '@compound-finance/sleuth';
import { StaticJsonRpcProvider } from '@ethersproject/providers';
import BN from '../../node_modules/bn.js';
import connectedWalletPorts from '../../node_modules/grove-components/src/js/sharedEth/connectedWalletPorts';
import EthUtils from '../../node_modules/web3-utils';
import FaucetToken from './json/contracts/FaucetToken.json';
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
} from 'grove-components/src/js/sharedEth/eth';

import SleuthQuery from '../sleuth/out/SleuthLens.sol/SleuthLens.json';
import { parseWeiStr, toScaledDecimal } from 'grove-components/src/js/sharedJs/math.js';

const PROVIDER_TYPE_NONE = 0;
const PROVIDER_TYPE_LEDGER = 1;
const PROVIDER_TYPE_WALLET_LINK = 2;
const PROVIDER_TYPE_WEB3 = 3;
const PROVIDER_TYPE_SHOW_ACCOUNT = 3;

const ACCOUNT_CHECK_INTERVAL_MS = 2000;
const NETWORK_CHECK_INTERVAL_MS = 4000;
const NEW_BLOCK_CHECK_INTERVAL_MS = 60_000;
const SECONDS_PER_BLOCK = 12;
const BLOCKS_PER_DAY = new BN(7200); // 12 seconds per block
const EXP_DECIMALS = 18;
const CALCULATE_ACCOUNT_VALUES_DECIMALS = 36;
const EXP_SCALE_BN = new BN(10).pow(new BN(18)); // 1e18 used for BN.div
const defaultCallParams = { gas: 1.0e10 };

const transactionStorage = trxStorage('transactions');
const preferencesStorage = storage('preferences');

// We wait this amount of milliseconds before informing Elm of a new block
// we've heard about from Web3. This is to give Infura time to clear caches
// and reduce the likelihood of getting stale data.
const NEW_BLOCK_DELAY = 1500;

var currentSendGasPrice;

// Add these constants at the top of the file
const DEFAULT_GAS_PRICE = "1000000000"; // 1 Gwei
const DEFAULT_GAS_LIMIT = "3000000"; // 3M gas limit
const XRPLEVM_PRICE = "1000000000000000000"; // 1.0 in wei

// Track app initialization state
let isAppInitialized = false;
let pendingMessages = [];

// Helper function to safely send port messages
function safeSendPort(port, data) {
    if (!port) {
        console.warn('Port is undefined, skipping message send');
        return;
    }
    
    try {
        console.log('Attempting to send port message:', { port, data });
        port.send(data);
    } catch (error) {
        console.error('Error sending port message:', error);
    }
}

function reportError(app) {
    return (error) => {
        if (app && app.ports && app.ports.giveError) {
            safeSendPort(app.ports.giveError, error.toString());
        } else {
            console.error('Error reporting failed - app or ports not initialized:', error);
        }
    };
}

// Function to process pending messages after app initialization
function processPendingMessages() {
    pendingMessages.forEach(({ port, data }) => {
        safeSendPort(port, data);
    });
    pendingMessages = [];
}

function getContractJsonByName(eth, contractName) {
  let targetContractAbi = eth.currentAbiMap[contractName];

  if (!targetContractAbi) {
    console.warn('Cannot find abi for contract: ', contractName);
    targetContractAbi = [];
  }

  return {
    contractName: contractName,
    abi: targetContractAbi,
  };
}

function getContractJsonByAddress(eth, contractAddress) {
  const contractName = eth.currentAddressToNameMap[contractAddress.toLowerCase()];
  return getContractJsonByName(eth, contractName);
}

async function getBlockTimestamps(blockNumbers, network) {
  if (blockNumbers.length === 0) {
    return {};
  } else {
    // TODO: Handle local network (e.g. by direct eth_getBlockByNumber calls)
    let timestampsResult = await fetch(
      `https://timestamp.compound.finance/${blockNumbers.join(',')}?network=${network}`
    );
    return await timestampsResult.json();
  }
}

async function handleReceipt(app, eth, trxHash, blockNumber, receipt, trxNonce) {
  // Ignore missing receipts or receipts that are beyond our knowledge of the
  // latest block (this is to provide consistency with the rest of the UI)
  if (!receipt || receipt.blockNumber > blockNumber) {
    return null;
  } else {
    // Comptroller, CToken & CEther all share the exact same event definition on failures
    // so we only need one of the to decode a failure in receipt logs.
    const Comptroller = getContractJsonByName(eth, 'Comptroller');
    const CToken = getContractJsonByAddress(eth, receipt.to);
    const nonOracleFailureEvent = getEvent(eth, Comptroller, 'Failure');

    const status = receipt.status === true ? 1 : 0;

    const failures = receipt.logs
      .map((log) => {
        if (nonOracleFailureEvent && nonOracleFailureEvent.matches(log)) {
          return nonOracleFailureEvent.decode(log);
        }
      })
      .filter((log) => !!log);

    var error = null;

    if (failures[0]) {
      // TODO: failure.info
      // TODO: failure.detail
      error = failures[0].error.toString(); // TODO: This should be a number
    }

    app.ports.giveUpdateTrxPort.send({
      trxHash: trxHash,
      status: status,
      error: error,
      trxNonce: trxNonce,
    });
  }
}

function subscribeToCTokenPorts(app, eth) {
  // port askLiquidatePort : { cTokenAddress : String, customerAddress : String, borrowerAddress : String, borrowedAssetAmountWeiStr : String, borrowedAssetDecimals : Int, desiredAssetAddress : String, desiredAssetDecimals : Int, isCEther : Bool  } -> Cmd msg
  app.ports.askLiquidatePort.subscribe(
    ({
      cTokenAddress,
      customerAddress,
      borrowerAddress,
      borrowedAssetAmountWeiStr,
      borrowedAssetDecimals,
      desiredAssetAddress,
      desiredAssetDecimals,
      isCEther,
    }) => {
      const CEther = getContractJsonByName(eth, 'cETH');
      const CToken = getContractJsonByAddress(eth, cTokenAddress);
      const closeAmountWei = parseWeiStr(borrowedAssetAmountWeiStr);

      if (isCEther) {
        wrapSend(
          app,
          eth,
          CEther,
          cTokenAddress,
          'liquidateBorrow',
          [borrowerAddress, desiredAssetAddress],
          cTokenAddress,
          customerAddress,
          currentSendGasPrice,
          {
            value: closeAmountWei,
            displayArgs: [cTokenAddress, closeAmountWei, desiredAssetAddress],
          }
        )
          .then((trxHash) => {
            app.ports.giveLiquidatePort.send({
              borrowerAddress: borrowerAddress,
              borrowedAssetAddress: cTokenAddress,
              borrowedAmount: toScaledDecimal(closeAmountWei, borrowedAssetDecimals),
              desiredCollateralAddress: desiredAssetAddress,
            });
          })
          .catch(reportError(app));
      } else {
        wrapSend(
          app,
          eth,
          CToken,
          cTokenAddress,
          'liquidateBorrow',
          [borrowerAddress, closeAmountWei, desiredAssetAddress],
          cTokenAddress,
          customerAddress,
          currentSendGasPrice,
          {
            displayArgs: [cTokenAddress, closeAmountWei, desiredAssetAddress],
          }
        )
          .then((trxHash) => {
            app.ports.giveLiquidatePort.send({
              borrowerAddress: borrowerAddress,
              borrowedAssetAddress: cTokenAddress,
              borrowedAmount: toScaledDecimal(closeAmountWei, borrowedAssetDecimals),
              desiredCollateralAddress: desiredAssetAddress,
            });
          })
          .catch(reportError(app));
      }
    }
  );

  function handleNonAccountQueryResults(app, cTokens, slethResponse) {
    if (!app || !app.ports) {
        console.error('App or ports not initialized');
        return;
    }

    try {
        const cTokenMetadataList = (slethResponse?.cTokens || []).map(
            ({
                cToken: cTokenAddress,
                exchangeRateCurrent: exchangeRateResult,
                supplyRatePerBlock: supplyRateResult,
                borrowRatePerBlock: borrowRateResult,
                reserveFactorMantissa: reserveFactorResult,
                totalBorrows: totalBorrowsResult,
                totalReserves: totalReservesResult,
                totalSupply: totalSupplyResult,
                totalCash: totalCashResult,
                isListed: isListedResult,
                collateralFactorMantissa: collateralFactorMantissaResult,
                underlyingAssetAddress: underlyingAssetAddress,
                cTokenDecimals: cTokenDecimals,
                underlyingDecimals: underlyingDecimals,
                compSupplySpeed: compSupplySpeedResult,
                compBorrowSpeed: compBorrowSpeedResult,
                borrowCap: borrowCapResult,
                mintGuardianPaused: mintGuardianPausedResult,
                underlyingPrice: underlyingPriceResult,
            }) => {
                try {
                    const totalCash = toScaledDecimal(totalCashResult || "0", underlyingDecimals || 18);
                    const exchangeRateCurrent = exchangeRateResult || "1000000000000000000";
                    const mantissa = 18 + parseInt(underlyingDecimals || 18) - (cTokenDecimals || 18);
                    const oneCTokenInUnderlying = exchangeRateCurrent / Math.pow(10, mantissa);
                    const totalSupplyScaled = (totalSupplyResult || "0") / Math.pow(10, cTokenDecimals || 18);

                    return {
                        cTokenAddress: cTokenAddress && typeof cTokenAddress === 'string' ? cTokenAddress.toLowerCase() : cTokenAddress,
                        exchangeRate: toScaledDecimal(exchangeRateCurrent, EXP_DECIMALS),
                        supplyRatePerDay: toScaledDecimal((supplyRateResult || "0") * BLOCKS_PER_DAY, EXP_DECIMALS),
                        borrowRatePerDay: toScaledDecimal((borrowRateResult || "0") * BLOCKS_PER_DAY, EXP_DECIMALS),
                        collateralFactor: toScaledDecimal(collateralFactorMantissaResult || "0", EXP_DECIMALS),
                        reserveFactor: toScaledDecimal(reserveFactorResult || "0", EXP_DECIMALS),
                        totalBorrows: toScaledDecimal(totalBorrowsResult || "0", underlyingDecimals || 18),
                        totalReserves: toScaledDecimal(totalReservesResult || "0", underlyingDecimals || 18),
                        totalSupply: toScaledDecimal(totalSupplyResult || "0", cTokenDecimals || 18),
                        totalSupplyUnderlying: toScaledDecimal(totalSupplyScaled * oneCTokenInUnderlying, 0),
                        totalUnderlyingCash: totalCash,
                        compSupplySpeedPerBlock: toScaledDecimal(compSupplySpeedResult || "0", EXP_DECIMALS),
                        compSupplySpeedPerDay: toScaledDecimal((compSupplySpeedResult || "0") * BLOCKS_PER_DAY, EXP_DECIMALS),
                        compBorrowSpeedPerBlock: toScaledDecimal(compBorrowSpeedResult || "0", EXP_DECIMALS),
                        compBorrowSpeedPerDay: toScaledDecimal((compBorrowSpeedResult || "0") * BLOCKS_PER_DAY, EXP_DECIMALS),
                        borrowCap: toScaledDecimal(borrowCapResult || "0", underlyingDecimals || 18),
                        mintGuardianPaused: mintGuardianPausedResult || false,
                        underlyingPrice: toScaledDecimal(underlyingPriceResult || XRPLEVM_PRICE, EXP_DECIMALS),
                        underlyingAssetAddress: underlyingAssetAddress && typeof underlyingAssetAddress === 'string' ? underlyingAssetAddress.toLowerCase() : underlyingAssetAddress,
                    };
                } catch (error) {
                    console.error(`DEBUG: Error processing cToken ${cTokenAddress}:`, error);
                    return null;
                }
            }
        ).filter(Boolean);

        console.log('DEBUG: First cToken metadata:', cTokenMetadataList[0]);

        if (app.ports.giveCTokenMetadataPort) {
            app.ports.giveCTokenMetadataPort.send(cTokenMetadataList);
        } else {
            console.error('DEBUG: giveCTokenMetadataPort not initialized');
        }

        let allPricesList = cTokenMetadataList.map(({ cTokenAddress, underlyingPrice, underlyingAssetAddress }) => {
            if (!underlyingAssetAddress) {
                console.warn(`DEBUG: No underlying asset address found for cToken ${cTokenAddress}`);
                return null;
            }
            return {
                underlyingAssetAddress: underlyingAssetAddress && typeof underlyingAssetAddress === 'string' ? underlyingAssetAddress.toLowerCase() : underlyingAssetAddress,
                value: underlyingPrice,
            };
        }).filter(Boolean);
        console.log('DEBUG: First price data:', allPricesList[0]);

        if (app.ports.giveOraclePricesAllPort) {
            app.ports.giveOraclePricesAllPort.send(allPricesList);
        } else {
            console.error('DEBUG: giveOraclePricesAllPort not initialized');
        }

        if (app.ports.giveEtherUsdPricePort) {
            console.log('DEBUG: Sending ether price to Elm');
            app.ports.giveEtherUsdPricePort.send({ price: "1.0" });
        } else {
            console.error('DEBUG: giveEtherUsdPricePort not initialized');
        }

        if (app.ports.giveComptrollerMetadataPort) {
            const comptrollerData = {
                closeFactor: toScaledDecimal(slethResponse?.closeFactorMantissa || "0", EXP_DECIMALS),
                liquidationIncentive: toScaledDecimal(slethResponse?.liquidationIncentiveMantissa || "0", EXP_DECIMALS),
            };
            console.log('DEBUG: Sending comptroller metadata to Elm:', comptrollerData);
            app.ports.giveComptrollerMetadataPort.send(comptrollerData);
        } else {
            console.error('DEBUG: giveComptrollerMetadataPort not initialized');
        }
    } catch (error) {
        console.error('DEBUG: Error in handleNonAccountQueryResults:', error);
        // Send empty data on error to prevent UI from breaking
        if (app.ports.giveCTokenMetadataPort) {
            app.ports.giveCTokenMetadataPort.send([]);
        }
        if (app.ports.giveOraclePricesAllPort) {
            app.ports.giveOraclePricesAllPort.send([]);
        }
        if (app.ports.giveEtherUsdPricePort) {
            app.ports.giveEtherUsdPricePort.send({ price: "1.0" });
        }
        if (app.ports.giveComptrollerMetadataPort) {
            app.ports.giveComptrollerMetadataPort.send({
                closeFactor: "0",
                liquidationIncentive: "0",
            });
        }
        if (app.ports.giveError) {
            app.ports.giveError.send(error.toString());
        }
    }
  }

  //port queryAllNoAccountPort : { blockNumber : Int, cTokens : List ( String, CTokenPortData ), comptroller : String } -> Cmd msg
  app.ports.queryAllNoAccountPort.subscribe(async ({ blockNumber, cTokens: cTokenEntries, comptroller }) => {
    console.log('queryAllNoAccountPort called with:', { blockNumber, cTokenEntries, comptroller });
    
    try {
        let cTokens = supportFromEntries(cTokenEntries);
        console.log('Processed cTokens:', cTokens);

        // For XRPLEVM, we'll use a fixed price of 1.0 for all tokens
        const response = {
            closeFactorMantissa: "0",
            liquidationIncentiveMantissa: "0",
            cTokens: Object.keys(cTokens).map(cTokenAddress => ({
                cToken: cTokenAddress.toLowerCase(),
                underlyingPrice: XRPLEVM_PRICE,
                exchangeRateCurrent: "1000000000000000000",
                supplyRatePerBlock: "0",
                borrowRatePerBlock: "0",
                totalBorrows: "0",
                totalReserves: "0",
                totalSupply: "0",
                totalCash: "0",
                isListed: true,
                collateralFactorMantissa: "500000000000000000", // 0.5
                underlyingAssetAddress: cTokens[cTokenAddress].underlyingAssetAddress && typeof cTokens[cTokenAddress].underlyingAssetAddress === 'string' ? cTokens[cTokenAddress].underlyingAssetAddress.toLowerCase() : cTokens[cTokenAddress].underlyingAssetAddress,
                cTokenDecimals: "18",
                underlyingDecimals: "18",
                compSupplySpeed: "0",
                compBorrowSpeed: "0",
                borrowCap: "0",
                mintGuardianPaused: false
            }))
        };

        console.log('Generated response:', response);
        handleNonAccountQueryResults(app, cTokens, response);
    } catch (error) {
        console.error('Error in queryAllNoAccountPort:', error);
        safeSendPort(app.ports.giveError, error.toString());
    }
  });

  // port queryAllWithAccountPort : { blockNumber : Int, customerAddress : String, cTokens : List ( String, CTokenPortData ), compAddress: String, capFactoryAddress: String } -> Cmd msg
  app.ports.queryAllWithAccountPort.subscribe(
    async ({ blockNumber, customerAddress, cTokens: cTokenEntries, compAddress, capFactoryAddress }) => {
        try {
            if (!customerAddress) {
                throw new Error('customerAddress is required');
            }
            if (!compAddress) {
                throw new Error('compAddress is required');
            }

            console.log('queryAllWithAccountPort called with:', { blockNumber, customerAddress, cTokenEntries, compAddress, capFactoryAddress });

            const effectiveCapFactoryAddress = capFactoryAddress || '0x0000000000000000000000000000000000000000';
            let cTokens = supportFromEntries(cTokenEntries);
            console.log('Processed cTokens:', cTokens);

            // For XRPLEVM, we'll use a fixed price of 1.0 for all tokens
            const response = {
                closeFactorMantissa: "0",
                liquidationIncentiveMantissa: "0",
                marketsIn: [],
                liquidity: "0",
                shortfall: "0",
                compMetadata: {
                    balance: "0",
                    votes: "0",
                    delegate: "0x0000000000000000000000000000000000000000",
                    allocated: "0"
                },
                capFactoryAllowance: "0",
                cTokens: Object.keys(cTokens).map(cTokenAddress => ({
                    cToken: cTokenAddress.toLowerCase(),
                    underlyingPrice: XRPLEVM_PRICE,
                    exchangeRateCurrent: "1000000000000000000",
                    supplyRatePerBlock: "0",
                    borrowRatePerBlock: "0",
                    totalBorrows: "0",
                    totalReserves: "0",
                    totalSupply: "0",
                    totalCash: "0",
                    isListed: true,
                    collateralFactorMantissa: "500000000000000000", // 0.5
                    underlyingAssetAddress: cTokens[cTokenAddress].underlyingAssetAddress && typeof cTokens[cTokenAddress].underlyingAssetAddress === 'string' ? cTokens[cTokenAddress].underlyingAssetAddress.toLowerCase() : cTokens[cTokenAddress].underlyingAssetAddress,
                    cTokenDecimals: "18",
                    underlyingDecimals: "18",
                    compSupplySpeed: "0",
                    compBorrowSpeed: "0",
                    borrowCap: "0",
                    mintGuardianPaused: false,
                    balanceOf: "0",
                    borrowBalanceCurrent: "0",
                    balanceOfUnderlying: "0",
                    tokenBalance: "0",
                    tokenAllowance: "0"
                }))
            };

            console.log('Generated response:', response);

            // Process and send the data
            handleNonAccountQueryResults(app, cTokens, response);

            // Send account-specific data
            safeSendPort(app.ports.giveAccountLimitsPort, {
                customerAddress: customerAddress,
                accountLiquidity: "0",
                accountShortfall: "0",
                assetsIn: [
                    "0x0f6e54a0cDE8e09d3035aF966eBa96EE2ba29D30".toLowerCase(), // GDai
                    "0xE052EEAd18405406D43047790b1C765180b1F447".toLowerCase()  // GWBTC
                ],
                trxCount: 0
            });

            // Send balance data
            const balanceData = Object.keys(cTokens).map(cTokenAddress => ({
                cTokenAddress: cTokenAddress.toLowerCase(),
                customerAddress: customerAddress,
                cTokenWalletBalance: "0",
                underlyingAssetAddress: cTokens[cTokenAddress].underlyingAssetAddress && typeof cTokens[cTokenAddress].underlyingAssetAddress === 'string' ? cTokens[cTokenAddress].underlyingAssetAddress.toLowerCase() : cTokens[cTokenAddress].underlyingAssetAddress,
                underlyingBorrowBalance: "0",
                underlyingSupplyBalance: "0",
                underlyingTokenWalletBalance: "0",
                underlyingTokenAllowance: "0"
            }));

            safeSendPort(app.ports.giveCTokenBalancesAllPort, balanceData);

            safeSendPort(app.ports.giveCompAccruedPort, {
                customerAddress: customerAddress,
                compAccrued: "0",
            });

            safeSendPort(app.ports.giveTokenAllowanceTokenPort, {
                assetAddress: compAddress,
                contractAddress: effectiveCapFactoryAddress,
                customerAddress: customerAddress,
                allowance: "0",
            });

        } catch (error) {
            console.error('Error in queryAllWithAccountPort:', error);
            safeSendPort(app.ports.giveError, error.toString());
        }
    }
  );
}

function subscribeToNewBlocks(app, eth) {
  var blockTimer;
  var previousBlock;

  function newBlockCheckFunction() {
    requestForeground(() => {
      getBlockNumber(eth)
        .then((blockNumber) => {
          if (blockNumber && blockNumber !== previousBlock) {
            debug(`New Block: ${blockNumber}`);
            app.ports.giveNewBlockPort.send({ block: blockNumber });
            previousBlock = blockNumber;
          }
        })
        .catch((error) => {
          console.warn('Error checking for new block:', error);
          // Don't stop the polling on error, just log it
        })
        .finally(() => {
          // Always schedule the next check, even if there was an error
          blockTimer = setTimeout(newBlockCheckFunction, NEW_BLOCK_CHECK_INTERVAL_MS);
        });
    });
  }

  // port askNewBlockPort : {} -> Cmd msg
  app.ports.askNewBlockPort.subscribe(() => {
    // Clear any existing timer to prevent multiple polling
    if (blockTimer) {
      clearTimeout(blockTimer);
    }
    newBlockCheckFunction();
  });

  // port askNewBlockAsyncPort : { blockNumber : Int } -> Cmd msg
  app.ports.askNewBlockAsyncPort.subscribe(({blockNumber}) => {
    requestForeground(() => {
      getBlockNumber(eth)
        .then((currentBlockNumber) => {
          if (currentBlockNumber && currentBlockNumber !== previousBlock) {
            debug(`New Block: ${currentBlockNumber}`);
            app.ports.giveNewBlockPort.send({ block: currentBlockNumber });
            previousBlock = currentBlockNumber;
          }
        })
        .catch((error) => {
          console.warn('Error in async block check:', error);
          // Don't stop the polling on error
        });
    });
  });
}

function subscribeToCheckTrxStatus(app, eth) {
  // port checkTrxStatusPort : { blockNumber : Int, trxHash : String } -> Cmd msg
  app.ports.checkTrxStatusPort.subscribe(({ blockNumber, trxHash }) => {
    Promise.all([getTransaction(eth, trxHash), getTransactionReceipt(eth, trxHash)])
      .then(([transaction, receipt]) => handleReceipt(app, eth, trxHash, blockNumber, receipt, transaction.nonce))
      .catch(reportError(app));
  });
}

function subscribeToStoreTransaction(app, eth) {
  // port storeTransactionPort : { trxHash : String, networkId : Int, timestamp : Int, contractAddress : String, assetAddress : String, customerAddress : String, fun : String, args : List, status : Maybe Int, error : Maybe String, expectedNonce : Maybe Int } -> Cmd msg
  app.ports.storeTransactionPort.subscribe(
    ({ trxHash, networkId, timestamp, contractAddress, customerAddress, fun, args, status, error, expectedNonce }) => {
      transactionStorage.put(
        trxHash,
        networkId,
        timestamp,
        contractAddress,
        customerAddress,
        fun,
        args,
        status,
        error,
        expectedNonce
      );
    }
  );

  // port storeTransactionUpdatePort : { trxHash : String, status : Maybe Int, error : Maybe String } -> Cmd msg
  app.ports.storeTransactionUpdatePort.subscribe(({ trxHash, status, error }) => {
    transactionStorage.update(trxHash, status, error);
  });

  // port askStoredTransactionsPort : {} -> Cmd msg
  app.ports.askStoredTransactionsPort.subscribe(({}) => {
    const transactions = Object.values(transactionStorage.getAll());

    app.ports.giveStoredTransactionsPort.send(transactions);
  });

  // port askClearTransactionsPort : {} -> Cmd msg
  app.ports.askClearTransactionsPort.subscribe(({}) => {
    transactionStorage.clear();
  });
}

function subscribeToPreferences(app, eth) {
  const url = new URL(window.location);
  const lang = langFromURL(url, window.navigator.language);
  // port storePreferencesPort : { displayCurrency : String, userLanguage : String, supplyPaneOpen : Bool, borrowPaneOpen : Bool } -> Cmd msg
  app.ports.storePreferencesPort.subscribe((preferences) => {
    preferencesStorage.set(preferences);
  });

  // port askStoredPreferencesPort : {} -> Cmd msg
  app.ports.askStoredPreferencesPort.subscribe(() => {
    const preferences = preferencesStorage.get();
    app.ports.giveStoredPreferencesPort.send({ userLanguage: lang, ...preferences });
  });

  // port askClearPreferencesPort : {} -> Cmd msg
  app.ports.askClearPreferencesPort.subscribe(() => {
    preferencesStorage.set({});
  });
}

function subscribeToGasService(app) {
  // port setGasPricePort : { amountWeiStr : String } -> Cmd msg
  app.ports.setGasPricePort.subscribe(({ amountWeiStr }) => {
    try {
      const gasPriceWei = parseWeiStr(amountWeiStr);
      currentSendGasPrice = gasPriceWei;
    } catch (error) {
      console.warn('Error setting gas price, using default:', error);
      currentSendGasPrice = DEFAULT_GAS_PRICE;
    }
  });
}

function subscribeToConsole(app) {
  app.ports.log.subscribe((msg) => {
    // If msg is an object with a level property, use appropriate console method
    if (typeof msg === 'object' && msg.level) {
      switch(msg.level.toLowerCase()) {
        case 'error':
          console.error(msg.message || msg);
          break;
        case 'warn':
          console.warn(msg.message || msg);
          break;
        case 'info':
          console.info(msg.message || msg);
          break;
        default:
          console.log(msg.message || msg);
      }
    } else {
      console.log(msg);
    }
  });
}

const decodeParameters = (abi, fnABI, data) => {
  const regex = /(\w+)\(([\w,]*)\)/;
  const res = regex.exec(fnABI);
  if (!res) {
    return {
      functionName: '',
      functionArgs: [],
      functionCall: '',
    };
  }
  const [_, fnName, fnInputs] = res;
  const inputTypes = fnInputs.split(',');
  const parameters = abi.decodeParameters(inputTypes, data);

  const args =
    fnInputs.length > 0
      ? inputTypes.map((_, index) => {
          const parameter = parameters[index];
          return parameter ? parameter.toString() : '';
        })
      : [];

  return {
    functionName: fnName,
    functionArgs: args,
    functionCall: `${fnName}(${args.join(', ')})`,
  };
};

const isStale = (eta) => {
  const now = Date.now() / 1000;
  const gracePeriod = 1209600; // Timelock constant of 14 days
  return now > Number(eta) + gracePeriod;
};

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

// Add test data function
async function sendTestData(app) {
    console.log('DEBUG: Sending test data through ports');
    
    // Fetch real data from GraphQL
    const graphQLData = await testGraphQLData();
    
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
        },
        {
            cTokenAddress: "0xE052EEAd18405406D43047790b1C765180b1F447".toLowerCase(), // GWBTC
            exchangeRate: "1", // 1.0
            supplyRatePerDay: "0.001", // 0.001 (0.1%)
            borrowRatePerDay: "0.002", // 0.002 (0.2%)
            collateralFactor: "0.8", // 0.8 (80%)
            reserveFactor: "0.1", // 0.1 (10%)
            totalBorrows: "0.1", // 0.1 WBTC
            totalUnderlyingCash: "0.2", // 0.2 WBTC
            totalReserves: "0.01", // 0.01 WBTC
            totalSupply: "0.3", // 0.3 cWBTC
            totalSupplyUnderlying: "0.3", // 0.3 WBTC
            compSupplySpeedPerBlock: "0.001", // 0.001 COMP per block
            compSupplySpeedPerDay: "0.1", // 0.1 COMP per day
            compBorrowSpeedPerBlock: "0.002", // 0.002 COMP per block
            compBorrowSpeedPerDay: "0.2", // 0.2 COMP per day
            borrowCap: "1", // 1 WBTC
            mintGuardianPaused: false,
            underlyingPrice: "30000", // 30,000 USD
            underlyingAssetAddress: "0x7A4cA9C3C5E6bB9B5C8E9577f3398743A2Ee025B".toLowerCase(),
        }
    ];

    // Fallback test data for account limits
    const testAccountLimits = {
        customerAddress: "0x823FD11EbcD10171262F4E5B91f789A369Dd8496",
        accountLiquidity: "1000", // 1,000 USD
        accountShortfall: "0",
        assetsIn: [
            "0x0f6e54a0cDE8e09d3035aF966eBa96EE2ba29D30".toLowerCase(), // GDai
            "0xE052EEAd18405406D43047790b1C765180b1F447".toLowerCase()  // GWBTC
        ],
        trxCount: 0
    };
    
    // Transform GraphQL data into our expected format
    const realCTokenMetadata = graphQLData?.cTokenData?.data?.cTokens?.map(token => ({
        cTokenAddress: token.id.toLowerCase(),
        exchangeRate: token.exchangeRate,
        supplyRatePerDay: (parseFloat(token.supplyRatePerBlock) * BLOCKS_PER_DAY).toString(),
        borrowRatePerDay: (parseFloat(token.borrowRatePerBlock) * BLOCKS_PER_DAY).toString(),
        collateralFactor: token.collateralFactor,
        reserveFactor: token.reserveFactor,
        totalBorrows: token.totalBorrows,
        totalReserves: token.totalReserves,
        totalSupply: token.totalSupply,
        totalUnderlyingCash: token.totalCash,
        underlyingPrice: token.underlying?.price || "1",
        underlyingAssetAddress: token.underlying?.id?.toLowerCase(),
        // Keep dummy data for fields not available in GraphQL
        compSupplySpeedPerBlock: "0.001",
        compSupplySpeedPerDay: "0.1",
        compBorrowSpeedPerBlock: "0.002",
        compBorrowSpeedPerDay: "0.2",
        borrowCap: "10000",
        mintGuardianPaused: false
    })) || [];

    // Transform account data
    const realAccountData = graphQLData?.accountData?.data?.accounts?.map(account => ({
        customerAddress: account.id.toLowerCase(),
        assetsIn: account.tokens.map(token => token.id.toLowerCase()),
        // Keep dummy data for fields not available in GraphQL
        accountLiquidity: "1000",
        accountShortfall: "0",
        trxCount: 0
    })) || [];

    // Test data for Oracle prices using actual XRPLEVM addresses
    const testOraclePrices = [
        {
            underlyingAssetAddress: "0xeBD8479f1DF837e4169D2A69663e1CeDE6A6FC1A".toLowerCase(), // DAI
            value: "1" // 1.0 DAI
        },
        {
            underlyingAssetAddress: "0x7A4cA9C3C5E6bB9B5C8E9577f3398743A2Ee025B".toLowerCase(), // WBTC
            value: "30000" // 30,000 USD
        }
    ];
    
    // Test data for CToken balances (keep dummy data as wallet balances not available in GraphQL)
    const testCTokenBalances = [
        {
            cTokenAddress: "0x0f6e54a0cDE8e09d3035aF966eBa96EE2ba29D30".toLowerCase(), // GDai
            customerAddress: "0x823FD11EbcD10171262F4E5B91f789A369Dd8496",
            cTokenWalletBalance: "100", // 100 cDAI
            underlyingAssetAddress: "0xeBD8479f1DF837e4169D2A69663e1CeDE6A6FC1A".toLowerCase(), // DAI
            underlyingBorrowBalance: "50", // 50 DAI
            underlyingSupplyBalance: "100", // 100 DAI
            underlyingTokenWalletBalance: "200", // 200 DAI
            underlyingTokenAllowance: "1000" // 1,000 DAI
        },
        {
            cTokenAddress: "0xE052EEAd18405406D43047790b1C765180b1F447".toLowerCase(), // GWBTC
            customerAddress: "0x823FD11EbcD10171262F4E5B91f789A369Dd8496",
            cTokenWalletBalance: "0.1", // 0.1 cWBTC
            underlyingAssetAddress: "0x7A4cA9C3C5E6bB9B5C8E9577f3398743A2Ee025B".toLowerCase(), // WBTC
            underlyingBorrowBalance: "0.05", // 0.05 WBTC
            underlyingSupplyBalance: "0.1", // 0.1 WBTC
            underlyingTokenWalletBalance: "0.2", // 0.2 WBTC
            underlyingTokenAllowance: "1" // 1 WBTC
        }
    ];
    
    // Test data for comptroller metadata
    const testComptrollerMetadata = {
        closeFactor: "0.5", // 0.5 (50%)
        liquidationIncentive: "1.08" // 1.08 (8% bonus)
    };

    // Send test data through ports
    if (app.ports.giveOraclePricesAllPort) {
        console.log('DEBUG: Sending test oracle prices');
        safeSendPort(app.ports.giveOraclePricesAllPort, testOraclePrices);
    }
    
    if (app.ports.giveCTokenMetadataPort) {
        console.log('DEBUG: Sending CToken metadata');
        safeSendPort(app.ports.giveCTokenMetadataPort, realCTokenMetadata.length > 0 ? realCTokenMetadata : testCTokenMetadata);
    }
    
    if (app.ports.giveCTokenBalancesAllPort) {
        console.log('DEBUG: Sending test CToken balances');
        safeSendPort(app.ports.giveCTokenBalancesAllPort, testCTokenBalances);
    }
    
    if (app.ports.giveAccountLimitsPort) {
        console.log('DEBUG: Sending account limits');
        safeSendPort(app.ports.giveAccountLimitsPort, realAccountData.length > 0 ? realAccountData[0] : testAccountLimits);
    }
    
    if (app.ports.giveComptrollerMetadataPort) {
        console.log('DEBUG: Sending test comptroller metadata');
        safeSendPort(app.ports.giveComptrollerMetadataPort, testComptrollerMetadata);
    }
    
    if (app.ports.giveEtherUsdPricePort) {
        console.log('DEBUG: Sending test ether price');
        safeSendPort(app.ports.giveEtherUsdPricePort, { price: "2000" }); // 2,000 USD
    }
}

// Test function to fetch data from GraphQL API
async function testGraphQLData() {
    const GRAPHQL_URL = 'https://api.goldsky.com/api/public/project_cmamdoy8hyjpy01xr03dodf4o/subgraphs/grove/v1/gn';
    
    // Query for CToken data
    const cTokenQuery = `
        query {
            cTokens {
                id
                symbol
                underlying {
                    id
                    symbol
                    price
                }
                exchangeRate
                supplyRatePerBlock
                borrowRatePerBlock
                totalBorrows
                totalReserves
                totalSupply
                totalCash
                collateralFactor
                reserveFactor
            }
        }
    `;

    // Query for account data
    const accountQuery = `
        query {
            accounts {
                id
                tokens {
                    id
                    symbol
                    borrowBalance
                    supplyBalance
                }
            }
        }
    `;

    try {
        // Fetch CToken data
        const cTokenResponse = await fetch(GRAPHQL_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                query: cTokenQuery
            })
        });
        const cTokenData = await cTokenResponse.json();
        console.log('CToken Data from GraphQL:', cTokenData);

        // Fetch account data
        const accountResponse = await fetch(GRAPHQL_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                query: accountQuery
            })
        });
        const accountData = await accountResponse.json();
        console.log('Account Data from GraphQL:', accountData);

        return {
            cTokenData,
            accountData
        };
    } catch (error) {
        console.error('Error fetching GraphQL data:', error);
        return null;
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
    console.log('DEBUG: Initialized with gas price:', currentSendGasPrice);
    
    // Process any pending messages
    processPendingMessages();

    const eth = makeEth(dataProviders, networkMap, networkAbiMap, configNameToAddressMappings, defaultNetwork);
    connectedWalletPorts.subscribe(app, eth, globEthereum, networkMap, defaultNetwork, walletConnectProjectId);

    // Send test data after a short delay to ensure ports are initialized
    setTimeout(async () => {
        console.log('DEBUG: Sending test data after initialization');
        await sendTestData(app);
    }, 1000);

    subscribeToConsole(app);
    subscribeToCTokenPorts(app, eth);
    subscribeToNewBlocks(app, eth);
    subscribeToCheckTrxStatus(app, eth);
    subscribeToStoreTransaction(app, eth);
    subscribeToPreferences(app, eth);
    subscribeToGasService(app);
    subscribeToRepl(app, eth, configFiles, configAbiFiles, connectedWalletPorts.showAccount);
    subscribeToFlywheelPorts(app, eth);
    subscribeToEtherPorts(app, eth);
}

export default {
  subscribe,
};
