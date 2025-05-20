module GroveApi.Presidio.CTokens.Encoders exposing (cTokenRequestEncoder)

import GroveApi.Common.Encoders exposing (encodeAPIPrecise)
import GroveApi.Presidio.CTokens.Models exposing (CTokenRequest)
import Json.Encode exposing (int, list, object, string)


cTokenRequestEncoder : CTokenRequest -> Json.Encode.Value
cTokenRequestEncoder request =
    let
        requiredParams =
            [ ( "addresses", list string request.addresses ) ]

        blockTimestampParam =
            case request.block_timestamp of
                Just block_timestamp ->
                    [ ( "block_timestamp", int block_timestamp ) ]

                Nothing ->
                    []
    in
    object (requiredParams ++ blockTimestampParam)
