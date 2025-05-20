import { safeSendPort, reportError, getContractJsonByName, getContractJsonByAddress } from './utils';
import { BLOCKS_PER_DAY, EXP_DECIMALS, XRPLEVM_PRICE } from './constants';
import { parseWeiStr, toScaledDecimal } from 'grove-components/src/js/sharedJs/math.js';
import { getERC20Balance } from './utils';

// Function to handle non-account query results
export function handleNonAccountQueryResults(app, cTokens, slethResponse) {
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

        if (app.ports.giveCTokenMetadataPort) {
            app.ports.giveCTokenMetadataPort.send(cTokenMetadataList);
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

        if (app.ports.giveOraclePricesAllPort) {
            app.ports.giveOraclePricesAllPort.send(allPricesList);
        }

        if (app.ports.giveEtherUsdPricePort) {
            app.ports.giveEtherUsdPricePort.send({ price: "1.0" });
        }

        if (app.ports.giveComptrollerMetadataPort) {
            const comptrollerData = {
                closeFactor: toScaledDecimal(slethResponse?.closeFactorMantissa || "0", EXP_DECIMALS),
                liquidationIncentive: toScaledDecimal(slethResponse?.liquidationIncentiveMantissa || "0", EXP_DECIMALS),
            };
            app.ports.giveComptrollerMetadataPort.send(comptrollerData);
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

// Function to subscribe to CToken ports
export function subscribeToCTokenPorts(app, eth) {
    // Subscribe to liquidation port
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

    // Subscribe to query all without account port
    app.ports.queryAllNoAccountPort.subscribe(async ({ blockNumber, cTokens: cTokenEntries, comptroller }) => {
        try {
            let cTokens = supportFromEntries(cTokenEntries);
            console.log("ctokens", cTokens);

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
            handleNonAccountQueryResults(app, cTokens, response);
        } catch (error) {
            console.error('Error in queryAllNoAccountPort:', error);
            safeSendPort(app.ports.giveError, error.toString());
        }
    });

    // Subscribe to query all with account port
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

                handleNonAccountQueryResults(app, cTokens, response);

                safeSendPort(app.ports.giveAccountLimitsPort, {
                    customerAddress: customerAddress,
                    accountLiquidity: "0",
                    accountShortfall: "0",
                    assetsIn: [],
                    trxCount: 0,
                });

                const balancePromises = Object.keys(cTokens).map(async cTokenAddress => {
                    const underlyingAddress = cTokens[cTokenAddress].underlyingAssetAddress;
                    if (!underlyingAddress) return null;

                    const underlyingBalance = await getERC20Balance(eth, underlyingAddress, customerAddress);
                    
                    return {
                        cTokenAddress: cTokenAddress,
                        customerAddress: customerAddress,
                        cTokenWalletBalance: "0",
                        underlyingAssetAddress: underlyingAddress,
                        underlyingBorrowBalance: "0",
                        underlyingSupplyBalance: "0",
                        underlyingTokenWalletBalance: getBalance(eth, underlyingAddress, customerAddress),
                        underlyingTokenAllowance: "0"
                    };
                });

                const balanceData = (await Promise.all(balancePromises)).filter(Boolean);
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