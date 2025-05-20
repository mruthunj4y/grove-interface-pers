module Eth.Contract exposing (ContractInfo, contractList)

import GroveComponents.Eth.Ethereum exposing (ContractAddress(..), getContractAddressString)
import Dict
import Eth.Config exposing (Config)



type alias ContractInfo =
    { friendlyName : String
    , abiName : String
    , address : String
    }


contractList : Maybe Config -> List ContractInfo
contractList maybeNetworkConfig =
    let
        contractsRaw =
            case maybeNetworkConfig of
                Just config ->
                    let
                        namedContract : String -> ContractAddress -> ContractInfo
                        namedContract name entry =
                            { friendlyName = name
                            , abiName = name
                            , address = getContractAddressString entry 
                            }

                        friendlyNamedContract : String -> String -> ContractAddress -> ContractInfo
                        friendlyNamedContract friendlyName actualName entry =
                            { friendlyName = friendlyName
                            , abiName = actualName
                            , address = getContractAddressString entry 
                            }

                        expendableContracts =
                            []  -- Removed all expendable contracts as they're not needed

                    in
                    [ { friendlyName = "Comptroller"
                        , abiName = "Comptroller"
                        , address = getContractAddressString config.comptroller 
                        }
                    , { friendlyName = "PriceOracle"
                        , abiName = "PriceOracle"
                        , address = getContractAddressString config.priceOracle 
                        }
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
                                        [ { friendlyName = cTokenSymbol
                                            , abiName = cTokenSymbol
                                            , address = addressString 
                                            }
                                        , { friendlyName = cTokenConfig.underlying.symbol
                                            , abiName = cTokenConfig.underlying.symbol
                                            , address = underlyingAddress 
                                            }
                                        ]
                                    )
                                |> List.concat
                           )

                Nothing ->
                    []
    in
    contractsRaw
        |> List.sortBy .friendlyName
