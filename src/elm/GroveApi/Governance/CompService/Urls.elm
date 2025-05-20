module GroveApi.Governance.CompService.Urls exposing (accountCompDistributionUrl, marketCompDistributionUrl)

import GroveApi.Common.Url
import GroveApi.Governance.CompService.Models exposing (AccountCompDistributionRequest, MarketCompDistributionRequest)
import GroveComponents.Eth.Network exposing (Network)
import Dict exposing (Dict)
import Url.Builder as UrlBuilder


accountCompDistributionUrl : Dict String String -> Network -> AccountCompDistributionRequest -> Maybe String
accountCompDistributionUrl apiBaseUrlMap network accountRequest =
    let
        queryParams =
            [ UrlBuilder.string "address" accountRequest.address ]
    in
    GroveApi.Common.Url.buildApiUrl apiBaseUrlMap network "v2/governance/comp/account" queryParams


marketCompDistributionUrl : Dict String String -> Network -> MarketCompDistributionRequest -> Maybe String
marketCompDistributionUrl apiBaseUrlMap network marketRequest =
    let
        queryParams =
            case marketRequest.addresses of
                [] ->
                    []

                addressList ->
                    let
                        addressesQueryArg =
                            addressList
                                |> String.join ","
                    in
                    [ UrlBuilder.string "addresses" addressesQueryArg ]
    in
    GroveApi.Common.Url.buildApiUrl apiBaseUrlMap network "v2/governance/comp" queryParams
