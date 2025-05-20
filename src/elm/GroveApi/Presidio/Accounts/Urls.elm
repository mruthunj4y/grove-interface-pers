module GroveApi.Presidio.Accounts.Urls exposing (accountsRequestUrl)

import GroveApi.Common.Url
import GroveApi.Presidio.Accounts.Models exposing (AccountRequest)
import GroveComponents.Eth.Network exposing (Network)
import Decimal
import Dict exposing (Dict)
import Url.Builder as UrlBuilder


accountsRequestUrl : Dict String String -> Network -> AccountRequest -> Maybe String
accountsRequestUrl apiBaseUrlMap network accountsRequest = Nothing
