module Ether.Contracts.Unitroller exposing
    ( getAdmin
    , getComptrollerImplementation
    , setPendingImplementation
    )

import GroveComponents.Console as Console
import GroveComponents.Eth.Ethereum exposing (ContractAddress(..), CustomerAddress(..))
import GroveComponents.Eth.Network exposing (Network)
import GroveComponents.Ether.BNTransaction as BNTransaction exposing (BNTransactionState)
import GroveComponents.Ether.FromEthereumUtils as FromEthereumUtils
import GroveComponents.Ether.FunctionSpec as FunctionSpec
import GroveComponents.Ether.Value as Value
import GroveComponents.Ether.Web3 as EtherWeb3
import Eth.Config exposing (Config)

getAdmin : Config -> Network -> CustomerAddress -> BNTransactionState -> ( BNTransactionState, Cmd msg )
getAdmin config network customerAddress bnState =
    let
        dataResult =
            FunctionSpec.encodeCall "admin" []

        customerAddressResult =
            FromEthereumUtils.customerAddressToEtherAddress customerAddress

        unitrollerAddressResult =
            FromEthereumUtils.contractAddressToEtherAddress config.unitroller

        ( trx, cmd ) =
            case ( customerAddressResult, unitrollerAddressResult, dataResult ) of
                ( Ok fromAddress, Ok toAddress, Ok data ) ->
                    let
                        bnTransaction =
                            BNTransaction.newTransaction network fromAddress toAddress "getAdmin" [] bnState
                    in
                    ( Just bnTransaction
                    , EtherWeb3.call
                        (BNTransaction.getTxModule network customerAddress)
                        bnTransaction.txId
                        { from = fromAddress
                        , to = toAddress
                        , data = data
                        }
                    )

                _ ->
                    ( Nothing, Console.log "Could not encode data for Unitroller.getAdmin" )
    in
    ( BNTransaction.appendTrx bnState trx, cmd )

getComptrollerImplementation : Config -> Network -> CustomerAddress -> BNTransactionState -> ( BNTransactionState, Cmd msg )
getComptrollerImplementation config network customerAddress bnState =
    let
        dataResult =
            FunctionSpec.encodeCall "comptrollerImplementation" []

        customerAddressResult =
            FromEthereumUtils.customerAddressToEtherAddress customerAddress

        unitrollerAddressResult =
            FromEthereumUtils.contractAddressToEtherAddress config.unitroller

        ( trx, cmd ) =
            case ( customerAddressResult, unitrollerAddressResult, dataResult ) of
                ( Ok fromAddress, Ok toAddress, Ok data ) ->
                    let
                        bnTransaction =
                            BNTransaction.newTransaction network fromAddress toAddress "getComptrollerImplementation" [] bnState
                    in
                    ( Just bnTransaction
                    , EtherWeb3.call
                        (BNTransaction.getTxModule network customerAddress)
                        bnTransaction.txId
                        { from = fromAddress
                        , to = toAddress
                        , data = data
                        }
                    )

                _ ->
                    ( Nothing, Console.log "Could not encode data for Unitroller.getComptrollerImplementation" )
    in
    ( BNTransaction.appendTrx bnState trx, cmd )

setPendingImplementation : Config -> Network -> CustomerAddress -> ContractAddress -> BNTransactionState -> ( BNTransactionState, Cmd msg )
setPendingImplementation config network customerAddress newImplementation bnState =
    let
        dataResult =
            FunctionSpec.encodeCall
                "_setPendingImplementation"
                [ Value.Address (FromEthereumUtils.contractAddressToEtherAddress newImplementation |> Result.withDefault "0x0") ]

        customerAddressResult =
            FromEthereumUtils.customerAddressToEtherAddress customerAddress

        unitrollerAddressResult =
            FromEthereumUtils.contractAddressToEtherAddress config.unitroller

        ( trx, cmd ) =
            case ( customerAddressResult, unitrollerAddressResult, dataResult ) of
                ( Ok fromAddress, Ok toAddress, Ok data ) ->
                    let
                        implementationAddressString =
                            Ethereum.getContractAddressString newImplementation

                        bnTransaction =
                            BNTransaction.newTransaction network fromAddress toAddress "setPendingImplementation" [ implementationAddressString ] bnState
                    in
                    ( Just bnTransaction
                    , EtherWeb3.sendTransaction
                        (BNTransaction.getTxModule network customerAddress)
                        bnTransaction.txId
                        { from = fromAddress
                        , to = toAddress
                        , data = data
                        }
                    )

                _ ->
                    ( Nothing, Console.log "Could not encode data for Unitroller.setPendingImplementation" )
    in
    ( BNTransaction.appendTrx bnState trx, cmd ) 