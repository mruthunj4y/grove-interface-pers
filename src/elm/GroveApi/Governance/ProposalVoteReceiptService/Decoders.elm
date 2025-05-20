module GroveApi.Governance.ProposalVoteReceiptService.Decoders exposing (proposalVoteReceiptResponseDecoder)

import GroveApi.Common.Decoders exposing (apiErrorDecoder, paginationSummaryDecoder)
import GroveApi.Governance.Common.Decoders exposing (displayAccountDecoder)
import GroveApi.Governance.ProposalService.Decoders exposing (proposalDecoder)
import GroveApi.Governance.ProposalVoteReceiptService.Models
    exposing
        ( ProposalVoteReceipt
        , ProposalVoteReceiptRequest
        , ProposalVoteReceiptResponse
        , createProposalVoteReceipt
        )
import GroveComponents.Eth.Decoders exposing (stringDecimal)
import Decimal exposing (Decimal)
import Json.Decode exposing (Decoder, andThen, bool, fail, field, int, list, map, map4, maybe, nullable, string, succeed)
import Json.Decode.Pipeline exposing (optional, required)
import Time


proposalVoteReceiptResponseDecoder : Decoder ProposalVoteReceiptResponse
proposalVoteReceiptResponseDecoder =
    map4 ProposalVoteReceiptResponse
        (field "request"
            (succeed ProposalVoteReceiptRequest
                |> optional "proposal_id" (nullable int) Nothing
                |> optional "account" (nullable string) Nothing
                |> optional "support" (nullable bool) Nothing
                |> required "with_proposal_data" bool
                |> required "page_size" int
                |> required "page_number" int
            )
        )
        (field "pagination_summary" paginationSummaryDecoder)
        (field "proposal_vote_receipts"
            (list proposalVoteReceiptDecoder)
        )
        (field "error" apiErrorDecoder)


proposalVoteReceiptDecoder : Json.Decode.Decoder ProposalVoteReceipt
proposalVoteReceiptDecoder =
    succeed createProposalVoteReceipt
        |> required "proposal_id" int
        |> required "voter" displayAccountDecoder
        |> required "support" bool
        |> required "votes" stringDecimal
        |> optional "proposal" (nullable proposalDecoder) Nothing
