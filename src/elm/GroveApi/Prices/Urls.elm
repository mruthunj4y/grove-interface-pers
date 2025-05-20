module GroveApi.Prices.Urls exposing (pricesRequestUrl)

import GroveApi.Common.Url
import GroveComponents.Eth.Network exposing (Network)
import Dict exposing (Dict)
import Url.Builder as UrlBuilder


type alias PricesRequestOptions =
    { block_timestamp : Maybe Int }


pricesRequestUrl : Dict String String -> Network -> PricesRequestOptions -> Maybe String
pricesRequestUrl apiBaseUrlMap network requestOptions =
    let
        queryFinal =
            case requestOptions.block_timestamp of
                Just timestamp ->
                    [ UrlBuilder.string "block_timestamp" (String.fromInt timestamp) ]

                _ ->
                    []
    in
    GroveApi.Common.Url.buildApiUrl apiBaseUrlMap network "v2/prices" queryFinal
