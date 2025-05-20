module Utils.CTokenHelper exposing (CTokenType(..), getAllSupportedCTokens)

import Balances
import Decimal
import Dict
import Eth.Grove exposing (GroveState)
import Eth.Token exposing (CToken, TokenState)
import Debug


type CTokenType
    = ForCollateral
    | ForBorrow


getAllSupportedCTokens : GroveState -> TokenState -> CTokenType -> List CToken
getAllSupportedCTokens groveState tokenState cTokenType =
    tokenState.cTokens
        |> Dict.values
        |> List.filterMap
            (\cToken ->
                let
                    mintPaused =
                        Balances.getMintGuardianPaused groveState.cTokensMetadata cToken.contractAddress && cTokenType == ForCollateral
                in
                if mintPaused then
                    let
                        underlyingBalances =
                            Balances.getUnderlyingBalances groveState cToken.contractAddress

                        ( supplyBalance, borrowBalance ) =
                            ( underlyingBalances
                                |> Maybe.map .underlyingSupplyBalance
                                |> Maybe.withDefault Decimal.zero
                            , underlyingBalances
                                |> Maybe.map .underlyingBorrowBalance
                                |> Maybe.withDefault Decimal.zero
                            )
                    in
                    if Decimal.eq supplyBalance Decimal.zero && Decimal.eq borrowBalance Decimal.zero then
                        Nothing
                    else
                        Just cToken
                else
                    Just cToken
            )
