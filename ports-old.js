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
} from 'grove-components/src/js/sharedEth/xrp.js';

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
                        cTokenAddress: cTokenAddress,
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

        let allPricesList = cTokenMetadataList.map(({ cTokenAddress, underlyingPrice }) => {
            let underlyingAssetAddress = cTokens[cTokenAddress.toLowerCase()]?.underlyingAssetAddress;
            if (!underlyingAssetAddress) {
                console.warn(`DEBUG: No underlying asset address found for cToken ${cTokenAddress}`);
                return null;
            }
            return {
                underlyingAssetAddress: underlyingAssetAddress,
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
                cToken: cTokenAddress,
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
                underlyingAssetAddress: cTokens[cTokenAddress].underlyingAssetAddress,
                cTokenDecimals: "18",
                underlyingDecimals: "18",
                compSupplySpeed: "0",
                compBorrowSpeed: "0",
                borrowCap: "0",
                mintGuardianPaused: false
            }))
        };

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

            const effectiveCapFactoryAddress = capFactoryAddress || '0x0000000000000000000000000000000000000000';
            let cTokens = supportFromEntries(cTokenEntries);

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
                    cToken: cTokenAddress,
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
                    underlyingAssetAddress: cTokens[cTokenAddress].underlyingAssetAddress,
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

            // Process and send the data
            handleNonAccountQueryResults(app, cTokens, response);

            // Send account-specific data
            safeSendPort(app.ports.giveAccountLimitsPort, {
                customerAddress: customerAddress,
                accountLiquidity: "0",
                accountShortfall: "0",
                assetsIn: [],
                trxCount: 0,
            });

            // Send balance data
            const balanceData = Object.keys(cTokens).map(cTokenAddress => ({
                cTokenAddress: cTokenAddress,
                customerAddress: customerAddress,
                cTokenWalletBalance: "0",
                underlyingAssetAddress: cTokens[cTokenAddress].underlyingAssetAddress,
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
    
    // Process any pending messages
    processPendingMessages();

    const eth = makeEth(dataProviders, networkMap, networkAbiMap, configNameToAddressMappings, defaultNetwork);
    connectedWalletPorts.subscribe(app, eth, globEthereum, networkMap, defaultNetwork, walletConnectProjectId);

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
