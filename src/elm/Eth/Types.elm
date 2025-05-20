module Eth.Types exposing
    ( Token
    , CToken
    , TokenConfig
    , GTokenConfig
    )

import GroveComponents.Eth.Ethereum exposing (AssetAddress(..), ContractAddress(..))

type alias Token =
    { assetAddress : AssetAddress
    , name : String
    , symbol : String
    , decimals : Int
    }

type alias CToken =
    { contractAddress : ContractAddress
    , name : String
    , symbol : String
    , decimals : Int
    , underlying : Token
    , initialExchangeRateMantissa : String
    }

type alias TokenConfig =
    { address : ContractAddress
    , name : String
    , symbol : String
    , decimals : Int
    }

type alias GTokenConfig =
    { address : ContractAddress
    , name : String
    , symbol : String
    , decimals : Int
    , initialExchangeRateMantissa : String
    , underlying : ContractAddress
    } 