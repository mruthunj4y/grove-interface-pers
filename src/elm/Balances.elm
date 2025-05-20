module Balances exposing
    ( getAssetsNotYetEntered
    , getCollateralValueInUsd
    , getHasAnyAssetEnabledForBorrowing
    , getInterestRate
    , getMintGuardianPaused
    , getUnderlyingBalances
    , getUnderlyingInterestBalances
    , getUnderlyingTotalsInUsd
    , getWalletBalanceNonSafeEther
    , getWalletBalanceSafeEther
    , hasEnteredAsset
    )

import Decimal exposing (Decimal)
import Dict
import Eth.Config exposing (Config)
import Eth.Grove exposing (CTokenBalances, CTokenInterestBalances, CTokenMetadataDict, GroveState)
import Eth.Oracle exposing (OracleState)
import Eth.Token exposing (CToken)
import GroveComponents.Eth.Ethereum as Ethereum exposing (Account(..), AssetAddress(..), ContractAddress(..), CustomerAddress(..), getContractAddressString)
import GroveComponents.Functions as Functions


getUnderlyingBalances : GroveState -> ContractAddress -> Maybe CTokenBalances
getUnderlyingBalances groveState (Contract cTokenAddress) =
    groveState.balances
        |> Dict.get cTokenAddress


getUnderlyingInterestBalances : GroveState -> ContractAddress -> Maybe CTokenInterestBalances
getUnderlyingInterestBalances groveState (Contract cTokenAddress) =
    groveState.interestBalances
        |> Dict.get cTokenAddress


type alias UnderlyingBalancesInUsd =
    { underlyingBorrowBalanceUsd : Decimal
    , underlyingBorrowInterestUsd : Decimal
    , underlyingSupplyBalanceUsd : Decimal
    , underlyingSupplyInterestUsd : Decimal
    }


getUnderlyingBalancesInUsd : GroveState -> CToken -> OracleState -> Maybe UnderlyingBalancesInUsd
getUnderlyingBalancesInUsd groveState cToken oracleState =
    Functions.map2 (Eth.Oracle.getOraclePrice oracleState cToken.underlying)
        (getUnderlyingBalances groveState cToken.contractAddress)
        (\priceInUsd underlyingBalances ->
            let
                maybeInterestBalances =
                    groveState.interestBalances
                        |> Dict.get (Ethereum.getContractAddressString cToken.contractAddress)

                ( actualBorrowInterest, actualSupplyInterest ) =
                    case maybeInterestBalances of
                        Just interestBalances ->
                            ( Maybe.withDefault Decimal.zero interestBalances.underlyingBorrowInterestPaid
                            , Maybe.withDefault Decimal.zero interestBalances.underlyingSupplyInterestEarned
                            )

                        Nothing ->
                            ( Decimal.zero
                            , Decimal.zero
                            )
            in
            { underlyingBorrowBalanceUsd = Decimal.mul priceInUsd underlyingBalances.underlyingBorrowBalance
            , underlyingBorrowInterestUsd = Decimal.mul priceInUsd actualBorrowInterest
            , underlyingSupplyBalanceUsd = Decimal.mul priceInUsd underlyingBalances.underlyingSupplyBalance
            , underlyingSupplyInterestUsd = Decimal.mul priceInUsd actualSupplyInterest
            }
        )


type alias InterestRates =
    { borrowRate : Decimal
    , supplyRate : Decimal
    }


getInterestRate : CTokenMetadataDict -> ContractAddress -> Maybe InterestRates
getInterestRate cTokenMetadataDict (Contract cTokenAddress) =
    cTokenMetadataDict
        |> Dict.get cTokenAddress
        |> Maybe.map (\metaData -> { borrowRate = metaData.borrowRate, supplyRate = metaData.supplyRate })

getMintGuardianPaused : CTokenMetadataDict -> ContractAddress -> Bool
getMintGuardianPaused cTokenMetadataDict (Contract cTokenAddress) =
    cTokenMetadataDict
        |> Dict.get cTokenAddress
        |> Maybe.map .mintGuardianPaused
        |> Maybe.withDefault False


type alias UnderlyingBalanceTotals =
    { totalBorrow : Decimal
    , totalBorrowInterest : Decimal
    , totalSupply : Decimal
    , totalSupplyInterest : Decimal
    }


getUnderlyingTotalsInUsd : GroveState -> List CToken -> OracleState -> UnderlyingBalanceTotals
getUnderlyingTotalsInUsd groveState cTokens oracleState =
    let
        emptyTotals =
            { totalBorrow = Decimal.zero
            , totalBorrowInterest = Decimal.zero
            , totalSupply = Decimal.zero
            , totalSupplyInterest = Decimal.zero
            }
    in
    List.foldl
        (\cToken runningBalanceTotals ->
            let
                maybeUnderlyingBalancesUsd =
                    getUnderlyingBalancesInUsd groveState cToken oracleState
            in
            case maybeUnderlyingBalancesUsd of
                Just underlyingBalancesUsd ->
                    { totalBorrow = Decimal.add underlyingBalancesUsd.underlyingBorrowBalanceUsd runningBalanceTotals.totalBorrow
                    , totalBorrowInterest = Decimal.add underlyingBalancesUsd.underlyingBorrowInterestUsd runningBalanceTotals.totalBorrowInterest
                    , totalSupply = Decimal.add underlyingBalancesUsd.underlyingSupplyBalanceUsd runningBalanceTotals.totalSupply
                    , totalSupplyInterest = Decimal.add underlyingBalancesUsd.underlyingSupplyInterestUsd runningBalanceTotals.totalSupplyInterest
                    }

                Nothing ->
                    runningBalanceTotals
        )
        emptyTotals
        cTokens


getWalletBalanceNonSafeEther : Config -> Account -> GroveState -> CToken -> Maybe Decimal
getWalletBalanceNonSafeEther config account groveState cToken =
    case ( Eth.Token.isCEtherToken config cToken, account ) of
        ( True, Acct customerAddress etherBalance ) ->
            etherBalance

        _ ->
            Dict.get (getContractAddressString cToken.contractAddress) groveState.balances
                |> Maybe.map .underlyingTokenWalletBalance


getWalletBalanceSafeEther : Config -> Account -> GroveState -> CToken -> Maybe Decimal
getWalletBalanceSafeEther config account groveState cToken =
    case ( Eth.Token.isCEtherToken config cToken, account ) of
        ( True, Acct customerAddress etherBalance ) ->
            case ( Decimal.fromFloat 0.005, etherBalance ) of
                ( Just etherMaxAdjustment, Just actualEtherBalance ) ->
                    Decimal.sub actualEtherBalance etherMaxAdjustment
                        |> Functions.decimalMax Decimal.zero
                        |> Just

                _ ->
                    etherBalance

        _ ->
            Dict.get (getContractAddressString cToken.contractAddress) groveState.balances
                |> Maybe.map .underlyingTokenWalletBalance


getCollateralValueInUsd : Eth.Grove.GroveState -> List CToken -> Eth.Oracle.OracleState -> Decimal
getCollateralValueInUsd groveState cTokens oracleState =
    let
        balanceTotalsUsd =
            getUnderlyingTotalsInUsd groveState cTokens oracleState

        accountLiquidityUsd =
            groveState.maybeAccountLiquidityUsd
                |> Maybe.withDefault Decimal.zero

        accountShortfallUsd =
            groveState.maybeAccountShortfallUsd
                |> Maybe.withDefault Decimal.zero

        -- Actual account liquidity is the summation of both accountLiquidity and accountShortfall
        -- as only one of the them can be non-zero at a time.
        actualAccountLiquidityUsd =
            Decimal.add accountLiquidityUsd (Decimal.mul Decimal.minusOne accountShortfallUsd)
    in
    Decimal.add actualAccountLiquidityUsd balanceTotalsUsd.totalBorrow


hasEnteredAsset : Config -> GroveState -> CToken -> Bool
hasEnteredAsset config groveState cToken =
    getAssetsNotYetEntered config groveState
        |> Maybe.withDefault []
        |> List.member cToken.contractAddress
        |> not


getAssetsNotYetEntered : Config -> GroveState -> Maybe (List ContractAddress)
getAssetsNotYetEntered config groveState =
    case groveState.maybeAssetsIn of
        Just assetsIn ->
            let
                cTokensAddressList =
                    Dict.values config.cTokens
                        |> List.map .address


                assetsToAdd =
                    cTokensAddressList
                        |> List.filterMap
                            (\cTokenAddress ->
                                if List.member cTokenAddress assetsIn then
                                    Nothing

                                else
                                    Just cTokenAddress
                            )
            in
            Just assetsToAdd

        _ ->
            Nothing


getHasAnyAssetEnabledForBorrowing : Config -> GroveState -> Maybe Bool
getHasAnyAssetEnabledForBorrowing config groveState =
    case groveState.maybeAssetsIn of
        Just assetsIn ->
            not (List.isEmpty assetsIn)
                |> Just

        _ ->
            Nothing
