module Utils.SafeLiquidity exposing
    ( UserLiquidityStatus(..)
    , getAbsoluteMaxBorrowForToken
    , getAbsoluteMaxBorrowInUsd
    , getAbsoluteMaxWithdrawForToken
    , getCurrentBorrowLimitUsd
    , getSafeMaxBorrowForToken
    , getSafeMaxBorrowInUsd
    , getSafeMaxWithdrawForToken
    , getUserCollateralBorrowedRate
    , getUserCollateralizationStatus
    )

import Balances
import GroveComponents.Eth.Ethereum as Ethereum
import GroveComponents.Functions as Functions
import Decimal exposing (Decimal)
import Dict exposing (Dict)
import Eth.Grove exposing (GroveMsg, GroveState)
import Eth.Config exposing (Config)
import Eth.Oracle exposing (OracleState)
import Eth.Token exposing (CToken, Token, TokenState)


safeMaxCollateralValueBorrowPercentage : Decimal
safeMaxCollateralValueBorrowPercentage =
    Decimal.fromString "0.8"
        |> Maybe.withDefault Decimal.one


safeMaxCollateralValueWithdrawPercentage : Decimal
safeMaxCollateralValueWithdrawPercentage =
    Decimal.fromString "1.25"
        |> Maybe.withDefault Decimal.one


type UserLiquidityStatus
    = Safe
    | Caution
    | AtRisk


getUserCollateralBorrowedRate : Eth.Grove.GroveState -> List CToken -> Eth.Oracle.OracleState -> Maybe Decimal
getUserCollateralBorrowedRate groveState cTokens oracleState =
    let
        balanceTotalsUsd =
            Balances.getUnderlyingTotalsInUsd groveState cTokens oracleState

        collateralValueUsd =
            Balances.getCollateralValueInUsd groveState cTokens oracleState
    in
    Decimal.fastdiv balanceTotalsUsd.totalBorrow collateralValueUsd


getUserCollateralizationStatus : Eth.Grove.GroveState -> List CToken -> Eth.Oracle.OracleState -> Maybe UserLiquidityStatus
getUserCollateralizationStatus groveState cTokens oracleState =
    let
        balanceTotalsUsd =
            Balances.getUnderlyingTotalsInUsd groveState cTokens oracleState

        atRiskDecimalPercent =
            Decimal.fromString "0.9"
                |> Maybe.withDefault Decimal.one

        cautionDecimalPercent =
            Decimal.fromString "0.75"
                |> Maybe.withDefault Decimal.zero
    in
    if Decimal.eq balanceTotalsUsd.totalBorrow Decimal.zero then
        Just Safe

    else
        case getUserCollateralBorrowedRate groveState cTokens oracleState of
            Just collateralBorredRate ->
                if Decimal.gt collateralBorredRate atRiskDecimalPercent then
                    Just AtRisk

                else if Decimal.gt collateralBorredRate cautionDecimalPercent then
                    Just Caution

                else
                    Just Safe

            Nothing ->
                Nothing



-- Maximum borrow allowed by the user is just their account liquidity


getAbsoluteMaxBorrowInUsd : GroveState -> OracleState -> Decimal
getAbsoluteMaxBorrowInUsd groveState oracleState =
    case groveState.maybeAccountLiquidityUsd of
        Just accountLiquidityUsd ->
            accountLiquidityUsd

        _ ->
            Decimal.zero


getAbsoluteMaxBorrowForToken : GroveState -> OracleState -> Token -> Decimal
getAbsoluteMaxBorrowForToken groveState oracleState token =
    let
        absoluteMaxBorrowUsd =
            getAbsoluteMaxBorrowInUsd groveState oracleState
    in
    calculateMaxBorrowForToken absoluteMaxBorrowUsd oracleState token



-- Safe max borrow allows the user up to 80% of their collateral value which is
-- the greater of:
-- 1. 0
-- or
-- 2. accountLiquidity - (CollateralValue * (1-0.8))


getSafeMaxBorrowInUsd : GroveState -> TokenState -> OracleState -> Decimal
getSafeMaxBorrowInUsd groveState tokenState oracleState =
    let
        cTokens =
            Dict.values tokenState.cTokens

        collateralValueUsd =
            Balances.getCollateralValueInUsd groveState cTokens oracleState

        safeMinLiquidityPercent =
            Decimal.sub Decimal.one safeMaxCollateralValueBorrowPercentage

        safeMinLiquidityUsd =
            Decimal.mul collateralValueUsd safeMinLiquidityPercent

        maxLiquidityCanBorrow =
            Decimal.sub
                (getAbsoluteMaxBorrowInUsd groveState oracleState)
                safeMinLiquidityUsd
    in
    Functions.decimalMax maxLiquidityCanBorrow Decimal.zero


getSafeMaxBorrowForToken : GroveState -> TokenState -> OracleState -> Token -> Decimal
getSafeMaxBorrowForToken groveState tokenState oracleState token =
    let
        maxSafeBorrowUsd =
            getSafeMaxBorrowInUsd groveState tokenState oracleState
    in
    calculateMaxBorrowForToken maxSafeBorrowUsd oracleState token


calculateMaxBorrowForToken : Decimal -> OracleState -> Token -> Decimal
calculateMaxBorrowForToken maxBorrowInUsd oracleState token =
    case Eth.Oracle.getOraclePrice oracleState token of
        Just tokenPriceUsd ->
            Decimal.fastdiv maxBorrowInUsd tokenPriceUsd
                |> Maybe.withDefault Decimal.zero

        _ ->
            Decimal.zero


getAbsoluteMaxWithdrawForToken : Config -> GroveState -> TokenState -> OracleState -> CToken -> Decimal -> Decimal
getAbsoluteMaxWithdrawForToken config groveState tokenState oracleState cToken tokenSupplyBalance =
    calculateMaxWithdrawWithSafeFactor Decimal.one config groveState tokenState oracleState cToken tokenSupplyBalance



-- Max withdrawable is token balance if the user has 0 borrows or is not entered in the specific asset,
-- else we can only withdraw a Collateral Value that does not take them below a health of
-- 1.25 (ie: account_total_collateral/account_total_borrow) which is the same as
-- saying the max withdrawable is (account_total_collateral - account_total_borrow*1.25).
-- Then we can subtract the target tokens collateral_value from the max withdrawable to get the max
-- percentage of underlying that a user can withdraw to keep at 1.25.


getSafeMaxWithdrawForToken : Config -> GroveState -> TokenState -> OracleState -> CToken -> Decimal -> Decimal
getSafeMaxWithdrawForToken config groveState tokenState oracleState cToken tokenSupplyBalance =
    calculateMaxWithdrawWithSafeFactor safeMaxCollateralValueWithdrawPercentage config groveState tokenState oracleState cToken tokenSupplyBalance


calculateMaxWithdrawWithSafeFactor : Decimal -> Config -> GroveState -> TokenState -> OracleState -> CToken -> Decimal -> Decimal
calculateMaxWithdrawWithSafeFactor collateralValuePercentage config groveState tokenState oracleState cToken tokenSupplyBalance =
    let
        allCTokensList =
            tokenState.cTokens
                |> Dict.values

        balanceTotalsUsd =
            Balances.getUnderlyingTotalsInUsd groveState allCTokensList oracleState

        maybeCTokenMetadata =
            groveState.cTokensMetadata
                |> Dict.get (Ethereum.getContractAddressString cToken.contractAddress)

        maybeTokenPriceUsd =
            Eth.Oracle.getOraclePrice oracleState cToken.underlying
    in
    if Decimal.eq balanceTotalsUsd.totalBorrow Decimal.zero || not (Balances.hasEnteredAsset config groveState cToken) then
        tokenSupplyBalance

    else
        case ( groveState.maybeAccountLiquidityUsd, maybeCTokenMetadata, maybeTokenPriceUsd ) of
            ( Just maybeAccountLiquidityUsd, Just cTokenMetadata, Just tokenPriceUsd ) ->
                let
                    accountTotalCollateralUsd =
                        Balances.getCollateralValueInUsd groveState allCTokensList oracleState

                    safeTotalCollateralUsd =
                        Decimal.mul balanceTotalsUsd.totalBorrow collateralValuePercentage

                    maxWithdrawableLiquidityUsd =
                        Decimal.sub accountTotalCollateralUsd safeTotalCollateralUsd

                    tokenUnderlyingBalances =
                        Balances.getUnderlyingTotalsInUsd groveState [ cToken ] oracleState

                    tokenCollateralValueUsd =
                        tokenUnderlyingBalances.totalSupply
                            |> Decimal.mul cTokenMetadata.collateralFactor
                in
                if Decimal.lte maxWithdrawableLiquidityUsd Decimal.zero then
                    Decimal.zero

                else if Decimal.lt tokenCollateralValueUsd maxWithdrawableLiquidityUsd then
                    tokenSupplyBalance

                else
                    let
                        ratio =
                            Decimal.fastdiv maxWithdrawableLiquidityUsd tokenCollateralValueUsd
                                |> Maybe.withDefault Decimal.zero
                    in
                    ratio
                        |> Decimal.mul tokenSupplyBalance

            _ ->
                Decimal.zero


getCurrentBorrowLimitUsd : GroveState -> TokenState -> OracleState -> Decimal
getCurrentBorrowLimitUsd groveState tokenState oracleState =
    let
        cTokens =
            Dict.values tokenState.cTokens

        balanceTotalsUsd =
            Balances.getUnderlyingTotalsInUsd groveState cTokens oracleState

        accountLiquidityUsd =
            groveState.maybeAccountLiquidityUsd
                |> Maybe.withDefault Decimal.zero

        --Total Borrow Limit is AccountLiquidity + TotalBorrowBalance
        totalBorrowLimitUsd =
            Decimal.add balanceTotalsUsd.totalBorrow accountLiquidityUsd
    in
    totalBorrowLimitUsd
