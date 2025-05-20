module Utils.GovernanceHelper exposing
    ( GovernanceHelperData
    , Proposal
    , abiDecoder
    , governanceHelperDataFromConfig
    , governanceProposalDecoder
    , proposalThreshold
    )

import GroveApi.Governance.ProposalService.Decoders exposing (proposalStateDecoder)
import GroveApi.Governance.ProposalService.Models exposing (ProposalState)
import GroveComponents.DecoderHelper exposing (andMap)
import GroveComponents.Eth.Decoders exposing (stringDecimal)
import GroveComponents.Eth.Ethereum exposing (getContractAddressString)
import GroveComponents.Eth.Network as Network exposing (Network(..))
import GroveComponents.Utils.NumberFormatter exposing (formatToDecimalPlaces)
import Decimal exposing (Decimal)
import Dict exposing (Dict)
import Eth.Config exposing (Config)
import Json.Decode exposing (Decoder, andThen, bool, field, int, list, map2, map3, map7, oneOf, string, succeed)
import Strings.Translations as Translations
import Utils.ABIHelper exposing (ABIInputOutputType, ABIValue)

type alias ActionData =
    { functionName : String
    , functionArgs : List String
    , functionCall : String
    }

type alias Proposal =
    { id : Int
    , transactionHash : String
    , title : String
    , description : String
    , proposer : String
    , eta : String
    , startBlock : String
    , endBlock : String
    , for_votes : Decimal
    , against_votes : Decimal
    , canceled : Bool
    , executed : Bool
    , states : List ProposalState
    , targets : List String
    , values : List String
    , signatures : List String
    , calldatas : List String
    , actionsData : List ActionData
    }

type alias GovernanceHelperData =
    { contractAddressToName : Dict String String
    , cTokenToUnderlyingDecimals : Dict String Int
    , cTokenToUnderlyingSymbol : Dict String String
    , tokensToDecimals : Dict String Int
    }

abiDecoder : Decoder ABIValue
abiDecoder =
    map7 ABIValue
        (oneOf
            [ field "inputs"
                (list
                    (map2 ABIInputOutputType
                        (field "name" string)
                        (field "type" string)
                    )
                )
            , succeed []
            ]
        )
        (oneOf [ field "name" string, succeed "" ])
        (oneOf
            [ field "outputs"
                (list
                    (map2 ABIInputOutputType
                        (field "name" string)
                        (field "type" string)
                    )
                )
            , succeed []
            ]
        )
        (oneOf [ field "payable" bool, succeed False ])
        (oneOf [ field "stateMutability" string, succeed "" ])
        (field "type" string)
        (oneOf [ field "signature" string, succeed "" ])

governanceProposalDecoder : Decoder Proposal
governanceProposalDecoder =
    succeed Proposal
        |> andMap (field "id" int)
        |> andMap (field "transactionHash" string)
        |> andMap (field "title" string)
        |> andMap (field "description" string)
        |> andMap (field "proposer" string)
        |> andMap (field "eta" string)
        |> andMap (field "startBlock" string)
        |> andMap (field "endBlock" string)
        |> andMap (field "forVotes" stringDecimal)
        |> andMap (field "againstVotes" stringDecimal)
        |> andMap (field "canceled" bool)
        |> andMap (field "executed" bool)
        |> andMap (field "states" (list proposalStateDecoder))
        |> andMap (field "targets" (list string))
        |> andMap (field "values" (list string))
        |> andMap (field "signatures" (list string))
        |> andMap (field "calldatas" (list string))
        |> andMap
            (field "actionsData"
                (list
                    (map3 ActionData
                        (field "functionName" string)
                        (field "functionArgs" (list string))
                        (field "functionCall" string)
                    )
                )
            )

governanceHelperDataFromConfig : Maybe Config -> GovernanceHelperData
governanceHelperDataFromConfig maybeConfig =
    case maybeConfig of
        Just config ->
            let
                cErc20Delegate : List ( String, String )
                cErc20Delegate =
                    case config.maybeCErc20Delegate of
                        Just cErc20DelegateEntry ->
                            [ ( getContractAddressString cErc20DelegateEntry, "CErc20Delegate" ) ]

                        Nothing ->
                            []

                contractAddressToName : Dict String String
                contractAddressToName =
                    Dict.fromList
                        ([ ( getContractAddressString config.comptroller, "Comptroller" )
                         , ( getContractAddressString config.priceOracle, "PriceOracle" )
                         ]
                            ++ (config.cTokens
                                    |> Dict.toList
                                    |> List.map
                                        (\( cTokenSymbol, cTokenConfig ) ->
                                            let
                                                addressString =
                                                    getContractAddressString cTokenConfig.address

                                                underlyingAddress =
                                                    getContractAddressString cTokenConfig.underlying.address
                                            in
                                            [ ( addressString, cTokenSymbol ), ( underlyingAddress, cTokenConfig.underlying.symbol ) ]
                                        )
                                    |> List.concat
                               )
                            ++ cErc20Delegate
                        )

                cTokenToUnderlyingDecimals : Dict String Int
                cTokenToUnderlyingDecimals =
                    Dict.fromList
                        (config.cTokens
                            |> Dict.toList
                            |> List.map
                                (\( cTokenSymbol, cTokenConfig ) ->
                                    let
                                        cTokenAddressString =
                                            getContractAddressString cTokenConfig.address

                                        underlyingDecimals =
                                            cTokenConfig.underlying.decimals
                                    in
                                    [ ( cTokenSymbol, underlyingDecimals ), ( cTokenAddressString, underlyingDecimals ) ]
                                )
                            |> List.concat
                        )

                cTokenToUnderlyingSymbol : Dict String String
                cTokenToUnderlyingSymbol =
                    Dict.fromList
                        (config.cTokens
                            |> Dict.toList
                            |> List.map
                                (\( cTokenSymbol, cTokenConfig ) ->
                                    let
                                        cTokenAddressString =
                                            getContractAddressString cTokenConfig.address

                                        underlyingSymbol =
                                            cTokenConfig.underlying.symbol
                                    in
                                    [ ( cTokenSymbol, underlyingSymbol ), ( cTokenAddressString, underlyingSymbol ) ]
                                )
                            |> List.concat
                        )

                tokenToDecimals : Dict String Int
                tokenToDecimals =
                    Dict.fromList
                        (config.cTokens
                            |> Dict.toList
                            |> List.map
                                (\( cTokenSymbol, cTokenConfig ) ->
                                    let
                                        cTokenAddressString =
                                            getContractAddressString cTokenConfig.address

                                        underlyingAddressString =
                                            getContractAddressString cTokenConfig.underlying.address
                                    in
                                    [ ( cTokenSymbol, cTokenConfig.decimals )
                                    , ( cTokenAddressString, cTokenConfig.decimals )
                                    , ( cTokenConfig.underlying.symbol, cTokenConfig.underlying.decimals )
                                    , ( underlyingAddressString, cTokenConfig.underlying.decimals )
                                    ]
                                )
                            |> List.concat
                        )
            in
            { contractAddressToName = contractAddressToName
            , cTokenToUnderlyingDecimals = cTokenToUnderlyingDecimals
            , cTokenToUnderlyingSymbol = cTokenToUnderlyingSymbol
            , tokensToDecimals = tokenToDecimals
            }

        Nothing ->
            { contractAddressToName = Dict.empty
            , cTokenToUnderlyingDecimals = Dict.empty
            , cTokenToUnderlyingSymbol = Dict.empty
            , tokensToDecimals = Dict.empty
            }

proposalThreshold : Network -> Decimal
proposalThreshold network =
    if network == Network.Xrplevm then
        Decimal.fromInt 25000
    else
        Decimal.fromInt 100000
