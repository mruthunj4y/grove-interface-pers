module GroveApi.Governance.HistoryService.Urls exposing (governanceHistoryRequestUrl)

import GroveApi.Common.Url
import GroveApi.Governance.HistoryService.Models exposing (GovernanceHistoryRequest)
import GroveComponents.Eth.Network exposing (Network)
import Dict exposing (Dict)


governanceHistoryRequestUrl : Dict String String -> Network -> GovernanceHistoryRequest -> Maybe String
governanceHistoryRequestUrl apiBaseUrlMap network _ =
    GroveApi.Common.Url.buildApiUrl apiBaseUrlMap network "v2/governance/history" []
