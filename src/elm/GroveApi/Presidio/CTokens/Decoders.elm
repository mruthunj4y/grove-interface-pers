module GroveApi.Presidio.CTokens.Decoders exposing (cTokenResponseDecoder)

import GroveApi.Common.Decoders exposing (apiErrorDecoder, apiPrecise)
import GroveApi.Common.Models exposing (API_Error)
import GroveApi.Presidio.CTokens.Models exposing (CToken, CTokenRequest, CTokenResponse, Metadata)
import GroveComponents.DecoderHelper exposing (andMap)
import GroveComponents.Eth.Ethereum as Ethereum exposing (ContractAddress(..))
import Decimal exposing (Decimal)
import Json.Decode exposing (Decoder, andThen, field, int, list, map2, map3, map4, maybe, null, nullable, oneOf, string, succeed)


cTokenResponseDecoder : Decoder CTokenResponse
cTokenResponseDecoder =
    map4 CTokenResponse
        (field "request"
            (map3 CTokenRequest
                (field "addresses"
                    (list string)
                )
                (field "block_number" (maybe int))
                (field "block_timestamp" (maybe int))
            )
        )
        (field "cToken"
            (list cTokenDecoder)
        )
        (field "error" apiErrorDecoder)
        (field "meta"
            (nullable
                (map2 Metadata
                    (field "unique_borrowers" int)
                    (field "unique_suppliers" int)
                )
            )
        )


cTokenDecoder : Json.Decode.Decoder CToken
cTokenDecoder =
    let
        addEthValues apiToken =
            let
                supplyValue =
                    calculateTotalSupply apiToken

                borrowValue =
                    calculateTotalBorrow apiToken

                borrowCapValue =
                    calculateBorrowCap apiToken
            in
            succeed
                { apiToken
                    | total_supply_value_in_eth = supplyValue
                    , total_borrow_value_in_eth = borrowValue
                    , underlying_borrow_cap_in_eth = borrowCapValue
                }
    in
    succeed CToken
        |> andMap (field "borrow_rate" apiPrecise)
        |> andMap (field "borrow_cap" apiPrecise)
        |> andMap (field "cash" apiPrecise)
        |> andMap (field "collateral_factor" apiPrecise)
        |> andMap (field "exchange_rate" apiPrecise)
        |> andMap (field "interest_rate_model_address" string)
        |> andMap (field "name" string)
        |> andMap (field "number_of_borrowers" int)
        |> andMap (field "number_of_suppliers" int)
        |> andMap (field "reserves" apiPrecise)
        |> andMap (field "reserve_factor" apiPrecise)
        |> andMap (field "supply_rate" apiPrecise)
        |> andMap (field "symbol" string)
        |> andMap (field "token_address" string)
        |> andMap (field "total_borrows" apiPrecise)
        |> andMap (field "total_supply" apiPrecise)
        |> andMap (field "underlying_address" (maybe string))
        |> andMap (field "underlying_name" string)
        |> andMap (field "underlying_price" apiPrecise)
        |> andMap (field "underlying_symbol" string)
        |> andMap (field "comp_supply_apy" <| oneOf [ apiPrecise, null Decimal.zero ])
        |> andMap (field "comp_borrow_apy" <| oneOf [ apiPrecise, null Decimal.zero ])
        -- set total supply, total borrow and underlying borrow cap value to zero to create valid record, can calculate in "andThen"
        |> andMap (succeed Decimal.zero)
        |> andMap (succeed Decimal.zero)
        |> andMap (succeed Decimal.zero)
        |> andThen addEthValues


calculateTotalBorrow : CToken -> Decimal
calculateTotalBorrow { total_borrows, underlying_price } =
    total_borrows
        |> Decimal.mul underlying_price


calculateTotalSupply : CToken -> Decimal
calculateTotalSupply { total_supply, exchange_rate, underlying_price } =
    total_supply
        |> Decimal.mul exchange_rate
        |> Decimal.mul underlying_price


calculateBorrowCap : CToken -> Decimal
calculateBorrowCap { borrow_cap, underlying_price } =
    borrow_cap
        |> Decimal.mul underlying_price


apiErrorDecoder : Json.Decode.Decoder (Maybe API_Error)
apiErrorDecoder =
    Json.Decode.nullable
        (Json.Decode.map2 API_Error
            (Json.Decode.field "error_code" Json.Decode.int)
            (Json.Decode.field "message" Json.Decode.string)
        )
