module GroveApi.GasService.Decoders exposing (gasPriceResponseDecoder)

import GroveApi.Common.Decoders
import GroveApi.Common.Models exposing (API_Error)
import GroveApi.GasService.Models exposing (API_GasPriceResponse)
import GroveComponents.Eth.Decoders
import Json.Decode exposing (field)


gasPriceResponseDecoder : Json.Decode.Decoder API_GasPriceResponse
gasPriceResponseDecoder =
    Json.Decode.map4 API_GasPriceResponse
        (Json.Decode.field "average" GroveApi.Common.Decoders.apiPrecise)
        (Json.Decode.field "fast" GroveApi.Common.Decoders.apiPrecise)
        (Json.Decode.field "fastest" GroveApi.Common.Decoders.apiPrecise)
        (Json.Decode.field "safe_low" GroveApi.Common.Decoders.apiPrecise)
