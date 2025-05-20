module Eth.Config exposing (BasicConfig, CTokenConfig, Config, RawCTokenConfig, TokenConfig, basicConfigDecoder, getCTokenAddresses, getUnderlyingTokenAddresses, loadConfig, loadConfigs)

import GroveComponents.Eth.Decoders exposing (decodeContractAddress)
import GroveComponents.Eth.Ethereum exposing (AssetAddress(..), ContractAddress(..), areContractsEqual, contractAddressToAssetAddress)
import GroveComponents.Functions as Functions
import Dict exposing (Dict)
import Json.Decode exposing (Decoder, Error, bool, decodeValue, field, int, string)
import Json.Encode
import Debug
import String


type alias BasicConfig =
    { contracts : Dict String ContractAddress
    , cTokensRaw : Dict String RawCTokenConfig
    , tokens : Dict String TokenConfig
    , interestModels : Dict String InterestRateModelConfig
    , blocks : Dict String Int
    }

-- type alias BasicConfig =
--     { networkId : Int
--     , networkName : String
--     }

type alias TokenConfig =
    { name : String
    , symbol : String
    , decimals : Int
    , address : ContractAddress
    , supported : Maybe Bool
    , reader : Maybe ContractAddress
    }


type alias CTokenConfig =
    { name : String
    , symbol : String
    , decimals : Int
    , address : ContractAddress
    , underlying : TokenConfig
    }


type alias InterestRateModelConfig =
    { contract : String
    , address : ContractAddress
    }


-- This is the config as defined in the json config file, but we want to coerce to a better form


type alias RawCTokenConfig =
    { name : String
    , symbol : String
    , decimals : Int
    , address : ContractAddress
    , underlying : Maybe ContractAddress
    }


type alias Config =
    { comptroller : ContractAddress
    , priceOracle : ContractAddress
    , groveLens : ContractAddress
    , cEtherToken : TokenConfig --TODO: This is likey a different config entirely since we don't have an underlying.
    , cTokens : Dict String CTokenConfig
    , maybeCErc20Delegate : Maybe ContractAddress
    , maybeCompToken : Maybe TokenConfig
    , blocks : Dict String Int
    , basicConfig : BasicConfig
    }


getCTokenAddresses : Dict String CTokenConfig -> List ContractAddress
getCTokenAddresses cTokenConfigDict =
    cTokenConfigDict
        |> Dict.values
        |> List.map .address


getUnderlyingTokenAddresses : Dict String CTokenConfig -> List AssetAddress
getUnderlyingTokenAddresses cTokenConfigDict =
    cTokenConfigDict
        |> Dict.values
        |> List.map .underlying
        |> List.map .address
        |> List.map contractAddressToAssetAddress


basicConfigDecoder : Decoder (Dict String (Maybe BasicConfig))
basicConfigDecoder =
    Json.Decode.dict <|
        Json.Decode.maybe
            (Json.Decode.map5 BasicConfig
                (field "Contracts" (Json.Decode.dict decodeContractAddress))
                (field "cTokens" (Json.Decode.dict decodeRawCToken))
                (field "Tokens" (Json.Decode.dict decodeToken))
                (field "InterestRateModel" (Json.Decode.dict decodeInterestRateModel))
                (field "Blocks"
                    (Json.Decode.dict Json.Decode.int)
                )
            )


loadConfigs : Json.Encode.Value -> Result Error (Dict String Config)
loadConfigs json =
    decodeValue basicConfigDecoder json
        |> Result.map
            (Functions.dictFilterMap
                (\basicConfigKey maybeBasicConfig ->
                    maybeBasicConfig
                        |> Maybe.andThen (loadConfig basicConfigKey)
                )
            )


loadConfig : String -> BasicConfig -> Maybe Config
loadConfig networkName ({ contracts, cTokensRaw, tokens, blocks } as basicConfig) =
    let
        maybeComptroller =
            case Dict.get "Comptroller" contracts of
                Just addr -> Just addr
                Nothing -> Dict.get "comptroller" contracts

        maybePriceOracle =
            case Dict.get "PriceOracleProxy" contracts of
                Just addr -> Just addr
                Nothing -> Dict.get "priceOracleProxy" contracts

        maybeGroveLens =
            case Dict.get "GroveLens" contracts of
                Just addr -> Just addr
                Nothing -> Dict.get "CompoundLens" contracts

        maybeCErc20Delegate =
            case Dict.get "cErc20Delegate" contracts of
                Just addr -> Just addr
                Nothing -> Dict.get "GErc20Delegator" contracts

        maybeCompToken =
            Dict.get "COMP" tokens

        -- For XRPLEVM, we'll use XRP as the native token instead of ETH
        xrplevmToken =
            { name = "XRP"
            , symbol = "XRP"
            , decimals = 18
            , address = Contract "0x0000000000000000000000000000000000000000"  -- This will be the native XRP address
            , supported = Just True
            , reader = Nothing
            }

        -- Process cTokens, mapping them to their underlying tokens
        cTokens =
            Functions.dictFilterMap
                (\key rawCTokenConfig ->
                    tokens
                        |> Dict.values
                        |> List.filter (\tokenConfig -> Just tokenConfig.address == rawCTokenConfig.underlying)
                        |> List.head
                        |> Maybe.map
                            (\tokenConfig ->
                                { name = rawCTokenConfig.name
                                , symbol = rawCTokenConfig.symbol
                                , decimals = rawCTokenConfig.decimals
                                , address = rawCTokenConfig.address
                                , underlying = tokenConfig
                                }
                            )
                )
                cTokensRaw
    in
    Functions.map4
        maybeComptroller
        maybePriceOracle
        (Just xrplevmToken)  -- Use XRPLEVM token instead of ETH
        maybeGroveLens
        (\comptroller priceOracle nativeToken groveLens ->
            { comptroller = comptroller
            , priceOracle = priceOracle
            , groveLens = groveLens
            , cEtherToken = nativeToken  -- Rename this field in the future to be more generic
            , cTokens = cTokens
            , maybeCErc20Delegate = maybeCErc20Delegate
            , maybeCompToken = maybeCompToken
            , blocks = blocks
            , basicConfig = basicConfig
            }
        )


decodeRawCToken : Decoder RawCTokenConfig
decodeRawCToken =
    Json.Decode.map5 RawCTokenConfig
        (field "name" string)
        (field "symbol" string)
        (field "decimals" int)
        (field "address" decodeContractAddress)
        (Json.Decode.maybe (field "underlying" decodeContractAddress))


decodeToken : Decoder TokenConfig
decodeToken =
    Json.Decode.map6 TokenConfig
        (field "name" string)
        (field "symbol" string)
        (field "decimals" int)
        (field "address" decodeContractAddress)
        (Json.Decode.maybe (field "supported" bool))
        (Json.Decode.maybe (field "reader" decodeContractAddress))


decodeInterestRateModel : Decoder InterestRateModelConfig
decodeInterestRateModel =
    Json.Decode.map2 InterestRateModelConfig
        (field "contract" string)
        (field "address" decodeContractAddress)
