port module Eth.Token exposing
    ( CToken
    , CTokenSet
    , Token
    , TokenMsg(..)
    , TokenState
    , clearTokenState
    , emptyState
    , ethDecimals
    , getCTokenAddress
    , getCTokenByAddress
    , getTokenAddress
    , getUnderlyingTokenByAddress
    , getUnderlyingTokenDecimals
    , getUnderlyingTokenSymbol
    , isCAPFactoryApproved
    , isCEtherToken
    , tokenInit
    , tokenNewBlockCmd
    , tokenSubscriptions
    , tokenUpdate
    )

import BigInt
import GroveComponents.Console as Console
import GroveComponents.Eth.Decoders exposing (decimal, decodeAssetAddress, decodeContractAddress, decodeCustomerAddress)
import GroveComponents.Eth.Ethereum as Ethereum exposing (Account(..), AssetAddress(..), ContractAddress(..), CustomerAddress(..), assetAddressToContractAddress, contractAddressToAssetAddress, getAssetAddressString, getContractAddressString, getCustomerAddressString)
import GroveComponents.Eth.Network exposing (Network)
import GroveComponents.Eth.TokenMath as TokenMath
import GroveComponents.Ether.BNTransaction as BNTransaction exposing (BNTransactionState)
import GroveComponents.Ether.FromEthereumUtils as FromEthereumUtils
import GroveComponents.Ether.FunctionSpec as FunctionSpec
import GroveComponents.Ether.Helpers
import GroveComponents.Ether.Value as Value
import GroveComponents.Ether.Web3 as EtherWeb3
import GroveComponents.Functions exposing (default, handleError, maybeMap)
import Decimal exposing (Decimal)
import Dict exposing (Dict)
import Eth.Config exposing (Config, TokenConfig)
import Json.Decode exposing (Value, decodeValue, field, int, string, succeed)
import Source.Infura exposing (loadEtherPrice)
import Utils.Http

type alias CTokenConfig =
    { address : ContractAddress
    , name : String
    , symbol : String
    , decimals : Int
    , underlying : TokenConfig
    }

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
    }


type alias CTokenSet =
    Dict String CToken


type alias TokenState =
    { cTokens : CTokenSet
    , tokenAllowances : Dict String Decimal -- allowances key is a concat of asset-contract (0xdead-0xbeef)
    , infuraEtherPrice : Maybe Decimal
    , errors : List String
    }



-- Records used for processing port responses


type alias TokenAllowance =
    { asset : AssetAddress --This is the underlying ie BAT
    , contract : ContractAddress --This is the cToken ie cBAT
    , customer : CustomerAddress
    , allowance : Decimal
    }


type TokenMsg
    = SetTokenAllowance TokenAllowance
    | SetInfuraEtherUSD Decimal
    | Web3TransactionMsg
    | Error String


type TokenTransactionMsg
    = NoOp  -- Placeholder for now, can be expanded with actual transaction types as needed


loadCTokenSet : Dict String CTokenConfig -> CTokenSet
loadCTokenSet dict =
    Dict.map
        (\k t ->
            let
                underlyingToken =
                    { assetAddress = contractAddressToAssetAddress t.underlying.address
                    , name = t.underlying.name
                    , symbol = t.underlying.symbol
                    , decimals = t.underlying.decimals
                    }
            in
            { contractAddress = t.address
            , name = t.name
            , symbol = t.symbol
            , decimals = t.decimals
            , underlying = underlyingToken
            }
        )
        dict


emptyState : TokenState
emptyState =
    { cTokens = Dict.empty
    , tokenAllowances = Dict.empty
    , infuraEtherPrice = Nothing
    , errors = []
    }


tokenInit : Config -> ( TokenState, Cmd TokenMsg )
tokenInit config =
    ( { cTokens = loadCTokenSet config.cTokens
      , tokenAllowances = Dict.empty
      , infuraEtherPrice = Nothing
      , errors = []
      }
    , askEtherPrice config
    )


ethDecimals : Int
ethDecimals =
    18


compDecimals : Int
compDecimals =
    18


tokenAllowancesKey : AssetAddress -> ContractAddress -> String
tokenAllowancesKey assetAddress contractAddress =
    getAssetAddressString assetAddress ++ "-" ++ getContractAddressString contractAddress


askEtherPrice : Config -> Cmd TokenMsg
askEtherPrice config =
    loadEtherPrice (handleError (Utils.Http.showError >> Error) SetInfuraEtherUSD)


tokenNewBlockCmd : Config -> TokenState -> Int -> Account -> Cmd TokenMsg
tokenNewBlockCmd config tokenState blockNumber maybeAccount =
    askEtherPrice config


{-| This update function is used to handle all non-web3 transactions messages. Eventually these messages
will probably be converted to web3 reads from the web3 elm module but until we do that change we'll
continue to separate the handling from the web3 transactions to make things easier to read.
-}
tokenUpdate : Config -> TokenMsg -> ( TokenState, BNTransactionState ) -> ( ( TokenState, Cmd TokenMsg ), ( BNTransactionState, Cmd msg ) )
tokenUpdate config msg ( { cTokens, tokenAllowances } as state, bnState ) =
    case msg of
        SetTokenAllowance { asset, contract, customer, allowance } ->
            let
                tokenAllownceKey =
                    tokenAllowancesKey asset contract

                updatedTokenAllowances =
                    Dict.insert tokenAllownceKey allowance tokenAllowances
            in
            ( ( { state | tokenAllowances = updatedTokenAllowances }, Cmd.none )
            , ( bnState, Cmd.none )
            )

        SetInfuraEtherUSD price ->
            ( ( { state | infuraEtherPrice = Just price }, Cmd.none )
            , ( bnState, Cmd.none )
            )

        Web3TransactionMsg ->
            ( ( state, Cmd.none )
            , tokenTransactionUpdate config NoOp ( state, bnState )
            )

        Error error ->
            ( ( { state | errors = error :: state.errors }, Console.error error )
            , ( bnState, Cmd.none )
            )


{-| This update function is used to actually create the web3 transactions and submit them for user confirmation.
We split up the handling of messages that trigger the web3 confirm transaction flow and other Token messages
that may update this modules state (like balances for instance).
-}
tokenTransactionUpdate : Config -> TokenTransactionMsg -> ( TokenState, BNTransactionState ) -> ( BNTransactionState, Cmd msg )
tokenTransactionUpdate config msg ( { cTokens }, bnState ) =
    case msg of
        _ ->
            ( bnState, Cmd.none )

tokenSubscriptions : TokenState -> Sub TokenMsg
tokenSubscriptions state =
    Sub.batch
        [ giveTokenAllowance (handleError (Json.Decode.errorToString >> Error) SetTokenAllowance)
        ]


clearTokenState : TokenState -> TokenState
clearTokenState state =
    { state | tokenAllowances = Dict.empty }


isCEtherToken : Config -> CToken -> Bool
isCEtherToken config cToken =
    config.cEtherToken.address == cToken.contractAddress


isCAPFactoryApproved : Config -> TokenState -> Bool
isCAPFactoryApproved config tokenState =
    let
        capFactoryAllowance =
            case config.maybeCompToken of
                Just compToken ->
                    let
                        tokenAllownceKey =
                            tokenAllowancesKey (contractAddressToAssetAddress compToken.address) (Contract "0x0000000000000000000000000000000000000000")
                    in
                    Dict.get tokenAllownceKey tokenState.tokenAllowances
                        |> Maybe.withDefault Decimal.zero

                _ ->
                    Decimal.zero
    in
    Decimal.gte capFactoryAllowance (Decimal.fromInt 100)



-- FUNCTIONS


getTokenAddress : Token -> String
getTokenAddress token =
    case token.assetAddress of
        Asset assetAddress ->
            assetAddress


getCTokenAddress : CToken -> String
getCTokenAddress cToken =
    case cToken.contractAddress of
        Contract contractAddress ->
            contractAddress


getCTokenByAddress : CTokenSet -> String -> Maybe CToken
getCTokenByAddress cTokens assetAddress =
    let
        cTokensList =
            cTokens
                |> Dict.values

        matchingCTokensList =
            cTokensList
                |> List.filter (\cToken -> getCTokenAddress cToken == assetAddress)
    in
    List.head matchingCTokensList


getUnderlyingTokenByAddress : CTokenSet -> String -> Maybe Token
getUnderlyingTokenByAddress cTokens assetAddress =
    let
        underlyingTokensList =
            cTokens
                |> Dict.values
                |> List.map .underlying

        matchingUnderlyingTokensList =
            underlyingTokensList
                |> List.filter (\underlyingToken -> getTokenAddress underlyingToken == assetAddress)
    in
    List.head matchingUnderlyingTokensList


getUnderlyingTokenSymbol : CTokenSet -> String -> Maybe String
getUnderlyingTokenSymbol cTokens assetAddress =
    getCTokenByAddress cTokens assetAddress
        |> maybeMap .underlying
        |> maybeMap .symbol


getUnderlyingTokenDecimals : CTokenSet -> String -> Maybe Int
getUnderlyingTokenDecimals cTokens assetAddress =
    getCTokenByAddress cTokens assetAddress
        |> maybeMap .underlying
        |> maybeMap .decimals



-- PORTS

port giveTokenAllowanceTokenPort : (Value -> msg) -> Sub msg


giveTokenAllowance : (Result Json.Decode.Error TokenAllowance -> msg) -> Sub msg
giveTokenAllowance wrapper =
    let
        decoder =
            Json.Decode.map4 TokenAllowance
                (field "assetAddress" decodeAssetAddress)
                (field "contractAddress" decodeContractAddress)
                (field "customerAddress" decodeCustomerAddress)
                (field "allowance" decimal)
    in
    giveTokenAllowanceTokenPort
        (decodeValue decoder >> wrapper)
