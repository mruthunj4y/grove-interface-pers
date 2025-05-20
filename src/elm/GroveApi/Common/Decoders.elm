module GroveApi.Common.Decoders exposing (apiErrorDecoder, apiPrecise, paginationSummaryDecoder)

import GroveApi.Common.Models exposing (API_Error, PaginationSummary)
import GroveComponents.Eth.Decoders
import Decimal exposing (Decimal)
import Json.Decode exposing (field)


apiPrecise : Json.Decode.Decoder Decimal
apiPrecise =
    Json.Decode.field "value" GroveComponents.Eth.Decoders.stringDecimal


apiErrorDecoder : Json.Decode.Decoder (Maybe API_Error)
apiErrorDecoder =
    Json.Decode.nullable
        (Json.Decode.map2 API_Error
            (Json.Decode.field "error_code" Json.Decode.int)
            (Json.Decode.field "message" Json.Decode.string)
        )


paginationSummaryDecoder : Json.Decode.Decoder PaginationSummary
paginationSummaryDecoder =
    Json.Decode.map4 PaginationSummary
        (Json.Decode.field "page_number" Json.Decode.int)
        (Json.Decode.field "page_size" Json.Decode.int)
        (Json.Decode.field "total_entries" Json.Decode.int)
        (Json.Decode.field "total_pages" Json.Decode.int)
