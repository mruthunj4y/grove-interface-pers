module GroveApi.Common.Url exposing (buildApiUrl)

import GroveComponents.Eth.Network exposing (Network(..))
import Dict exposing (Dict)
import Url.Builder as UrlBuilder exposing (QueryParameter)


buildApiUrl : Dict String String -> Network -> String -> List QueryParameter -> Maybe String
buildApiUrl apiBaseUrlMap network apiEndpoint endpointQueryParams =
    let
        lowercaseNetworkName =
            String.toLower (GroveComponents.Eth.Network.networkName network)

        shouldAddNetworkQueryParam =
            case network of

                Xrplevm ->
                    True

                _ ->
                    False

        finalQueryParams =
            if shouldAddNetworkQueryParam then
                endpointQueryParams ++ [ UrlBuilder.string "network" lowercaseNetworkName ]

            else
                endpointQueryParams
    in
    Dict.get lowercaseNetworkName apiBaseUrlMap
        |> Maybe.map (\apiBaseUrl -> apiBaseUrl ++ UrlBuilder.relative [ apiEndpoint ] finalQueryParams)
