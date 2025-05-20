module Admin exposing
    ( InternalMsg
    , Model
    , Translator
    , emptyState
    , init
    , subscriptions
    , translator
    , update
    , view
    )

import Array exposing (Array)
import GroveComponents.Console as Console
import GroveComponents.Eth.Ethereum exposing (Account(..), AssetAddress(..), ContractAddress(..), CustomerAddress(..), getContractAddressString, isValidAddress)
import GroveComponents.Eth.Network exposing (Network(..), networkName)
import GroveComponents.Functions exposing (handleError)
import GroveComponents.Utils.GroveHtmlAttributes exposing (HrefLinkType(..), class, id, onClickStopPropagation, placeholder, type_, value)
import GroveComponents.Utils.Markup exposing (disabled)
import GroveComponents.Utils.Time
import Decimal
import Dict exposing (Dict)
import Eth.Config exposing (Config)
import Eth.Contract exposing (ContractInfo, contractList)
import Html exposing (Html, button, div, h2, input, label, p, section, text)
import Html.Events exposing (onClick, onInput)
import Json.Decode exposing (field, list)
import Json.Encode
import Port exposing (encodeParameters, giveEncodedParameters)
import Regex exposing (contains)
import Strings.Translations as Translations
import Time
import Utils.ABIHelper exposing (ABIValue)
import Utils.GovernanceHelper exposing (abiDecoder)


type alias Model =
    { maybeTarget : Maybe ( String, String )
    , maybeFunction : Maybe ABIValue
    , maybeDataArg : Maybe String
    , functionTypes : List String
    , functionArgs : Array (Maybe String)
    , argsValid : Array Bool
    , contractsDropdownActive : Bool
    , functionsDropdownActive : Bool
    , value : String
    , errors : List String
    }


type InternalMsg
    = SetTarget ( String, String )
    | SetFunction ABIValue
    | SetArg Int String String
    | SetValue String
    | ToggleContractDropdown Bool
    | ToggleFunctionDropdown Bool
    | EncodeParametersResult String
    | Error String


type Msg
    = ForSelf InternalMsg


type alias TranslationDictionary msg =
    { onInternalMessage : InternalMsg -> msg
    }


type alias Translator msg =
    Msg -> msg


translator : TranslationDictionary msg -> Translator msg
translator { onInternalMessage } msg =
    case msg of
        ForSelf internal ->
            onInternalMessage internal



-- Delay in Days


emptyState : Model
emptyState =
    { maybeTarget = Nothing
    , maybeFunction = Nothing
    , maybeDataArg = Nothing
    , functionTypes = []
    , functionArgs = Array.empty
    , argsValid = Array.empty
    , contractsDropdownActive = False
    , functionsDropdownActive = False
    , value = "0"
    , errors = []
    }


init : ( Model, Cmd Msg )
init =
    let
        initState =
            emptyState
    in
    ( initState, Cmd.none )


update : InternalMsg -> Model -> ( Model, Cmd Msg )
update internalMsg model =
    case internalMsg of
        EncodeParametersResult dataString ->
            ( { model | maybeDataArg = Just dataString }, Cmd.none )

        SetTarget tuple ->
            ( { model
                | maybeTarget = Just tuple
                , maybeFunction = Nothing
                , maybeDataArg = Nothing
                , value = "0"
              }
            , Cmd.none
            )

        SetFunction abiValue ->
            let
                fnTypes =
                    List.map .type_ abiValue.inputs

                fnArgs =
                    Array.repeat (List.length fnTypes) Nothing

                argsValid =
                    Array.repeat (List.length fnTypes) True

                dataArg =
                    if List.length fnTypes == 0 then
                        Just "0x0"

                    else
                        Nothing
            in
            ( { model | maybeFunction = Just abiValue, maybeDataArg = dataArg, functionTypes = fnTypes, functionArgs = fnArgs, argsValid = argsValid, value = "0" }, Cmd.none )

        SetArg index valueType value ->
            let
                newArgValid =
                    case valueType of
                        "uint256" ->
                            case Decimal.fromString value of
                                Just decimal ->
                                    Decimal.eq decimal (Decimal.truncate 0 decimal)

                                Nothing ->
                                    False

                        "address" ->
                            isValidAddress value

                        "bytes" ->
                            let
                                isValidBytes =
                                    Maybe.withDefault Regex.never (Regex.fromString "^(0x)")
                            in
                            contains isValidBytes value

                        _ ->
                            True

                newArgsValid =
                    Array.set index newArgValid model.argsValid

                newArgs =
                    let
                        sanitizeValue =
                            case valueType of
                                "uint256" ->
                                    Maybe.withDefault Decimal.zero (Decimal.fromString value)
                                        |> Decimal.truncate 0
                                        |> Decimal.toString

                                _ ->
                                    value
                    in
                    Array.set index (Just sanitizeValue) model.functionArgs

                newArgsList =
                    newArgs
                        |> Array.toList
                        |> List.filterMap identity
                        |> List.map Json.Encode.string

                argsCompleted : Bool
                argsCompleted =
                    newArgsList
                        |> List.length
                        |> (==) (Array.length newArgs)

                argsValid : Bool
                argsValid =
                    newArgsValid
                        |> Array.foldl (&&) True

                ( dataArg, encodeParamsCmd ) =
                    if argsCompleted && argsValid then
                        ( model.maybeDataArg, encodeParameters model.functionTypes newArgsList )

                    else
                        ( Nothing, Cmd.none )
            in
            ( { model | functionArgs = newArgs, argsValid = newArgsValid, maybeDataArg = dataArg }, encodeParamsCmd )

        SetValue value ->
            ( { model | value = value }, Cmd.none )

        ToggleContractDropdown isActive ->
            ( { model | contractsDropdownActive = isActive, functionsDropdownActive = False }, Cmd.none )

        ToggleFunctionDropdown isActive ->
            ( { model | contractsDropdownActive = False, functionsDropdownActive = isActive }, Cmd.none )

        Error error ->
            ( { model | errors = error :: model.errors }, Console.error error )


view : Translations.Lang -> Dict String Config -> Json.Encode.Value -> Account -> Maybe Network -> Model -> Html Msg
view userLanguage configs abiFilesRaw account maybeNetwork model =
    let
        nameOfNetwork =
            case maybeNetwork of
                Just network ->
                    String.toLower (networkName network)

                Nothing ->
                    ""

        maybeNetworkConfig =
            Dict.get nameOfNetwork configs

        adminView =
            case maybeNetworkConfig of
                Just config ->
                    adminDashboardView configs abiFilesRaw account maybeNetwork model

                Nothing ->
                    noAdminView
    in
    div [ id "Admin" ] [ adminView ]


noAdminView : Html Msg
noAdminView =
    div [ class "container" ] [ text "The current selected network doesn't have admin functionality" ]


adminDashboardView : Dict String Config -> Json.Encode.Value -> Account -> Maybe Network -> Model -> Html Msg
adminDashboardView configs abiFilesRaw account maybeNetwork model =
    let
        dropdownActiveClass dropdown =
            if dropdown model then
                " active"

            else
                ""

        nameOfNetwork =
            case maybeNetwork of
                Just network ->
                    String.toLower (networkName network)

                Nothing ->
                    ""

        maybeNetworkConfig =
            Dict.get nameOfNetwork configs

        contracts : List ( String, String )
        contracts =
            case maybeNetworkConfig of
                Just config ->
                    [ ( "Comptroller", getContractAddressString config.comptroller )
                    , ( "PriceOracle", getContractAddressString config.priceOracle )
                    , ( "cETH", getContractAddressString config.cEtherToken.address )
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
                                        [ ( cTokenSymbol, addressString ), ( cTokenConfig.underlying.symbol, underlyingAddress ) ]
                                    )
                                |> List.concat
                           )

                Nothing ->
                    []

        ( targetContract, targetAddress ) =
            case model.maybeTarget of
                Just ( name, address ) ->
                    ( name, address )

                Nothing ->
                    ( "Select a contract", "" )

        abi =
            if targetContract /= "Select a contract" then
                case
                    Json.Decode.decodeValue
                        (field nameOfNetwork (field targetContract (list abiDecoder)))
                        abiFilesRaw
                of
                    Ok decodedAbi ->
                        decodedAbi

                    Err _ ->
                        []

            else
                []

        functions =
            abi
                |> List.filterMap
                    (\fn ->
                        if fn.type_ == "function" && (fn.stateMutability == "payayble" || fn.stateMutability == "nonpayable") then
                            Just fn

                        else
                            Nothing
                    )

        ( selectedFunctionName, inputs, functionSignature ) =
            case model.maybeFunction of
                Just fn ->
                    let
                        argTypes =
                            List.map .type_ fn.inputs
                                |> String.join ","

                        sig =
                            fn.name ++ "(" ++ argTypes ++ ")"
                    in
                    ( fn.name, fn.inputs, sig )

                Nothing ->
                    ( "Select a function", [], "" )

        selectFunctionDiv =
            if List.length functions > 0 then
                div [ class "container" ]
                    [ label [ class "medium" ] [ text "Select A Function" ]
                    , div [ class "dropdown dropdown--big", onClickStopPropagation (ForSelf (ToggleFunctionDropdown (not model.functionsDropdownActive))) ]
                        [ div [ class "dropdown__selected dropdown__selected--light" ]
                            [ p [ class "small" ] [ text selectedFunctionName ]
                            ]
                        , div [ class ("dropdown__options dropdown__options--light" ++ dropdownActiveClass .functionsDropdownActive) ]
                            (functions
                                |> List.map
                                    (\fn ->
                                        div [ class "dropdown__option dropdown__option--light", onClick (ForSelf (SetFunction fn)) ]
                                            [ p [ class "small" ] [ text fn.name ] ]
                                    )
                            )
                        ]
                    , label [] [ text ("Signature: " ++ functionSignature) ]
                    ]

            else
                div [] []

        dataArgDiv =
            case model.maybeDataArg of
                Just data ->
                    label [] [ text ("Data: " ++ data) ]

                Nothing ->
                    text ""
    in
    div []
        [ section []
            [ div [ class "container" ]
                [ h2 [] [ text "Admin Dashboard" ]
                ]
            ]
        , section []
            [ div [ class "container" ]
                [ label [ class "medium" ] [ text "Select Contract" ]
                , div [ class "dropdown dropdown--big", onClickStopPropagation (ForSelf (ToggleContractDropdown (not model.contractsDropdownActive))) ]
                    [ div [ class "dropdown__selected dropdown__selected--light" ]
                        [ p [ class "small" ] [ text targetContract ]
                        ]
                    , div [ class ("dropdown__options dropdown__options--light" ++ dropdownActiveClass .contractsDropdownActive) ]
                        (contracts
                            |> List.map
                                (\( name, address ) ->
                                    div [ class "dropdown__option dropdown__option--light", onClick (ForSelf (SetTarget ( name, address ))) ]
                                        [ p [ class "small" ] [ text name ] ]
                                )
                        )
                    ]
                , label [] [ text ("Target: " ++ targetAddress) ]
                ]
            ]
        , section []
            [ selectFunctionDiv
            ]
        , section []
            [ div [ class "container" ]
                (inputs
                    |> List.indexedMap
                        (\index fnInput ->
                            let
                                labelText =
                                    fnInput.name ++ " (" ++ fnInput.type_ ++ ")"

                                inputValue =
                                    case Array.get index model.functionArgs of
                                        Just maybeVal ->
                                            case maybeVal of
                                                Just val ->
                                                    val

                                                _ ->
                                                    ""

                                        Nothing ->
                                            ""

                                hasErrorClass =
                                    case Array.get index model.argsValid of
                                        Just isValid ->
                                            if isValid then
                                                ""

                                            else
                                                "has-error"

                                        Nothing ->
                                            ""
                            in
                            div []
                                [ label [] [ text labelText ]
                                , input [ class hasErrorClass, type_ "text", placeholder labelText, onInput (ForSelf << SetArg index fnInput.type_), value inputValue ] []
                                ]
                        )
                )
            , div [ class "container" ]
                [ dataArgDiv ]
            ]
        , section []
            [ div [ class "container" ]
                [ label [] [ text "Enter Value" ]
                , input [ type_ "text", placeholder "value", onInput (ForSelf << SetValue), value model.value ] []
                ]
            ]
        ]



-- Ports


subscriptions : Model -> Sub Msg
subscriptions _ =
    Sub.batch
        [ giveEncodedParameters (handleError (ForSelf << Error << Json.Decode.errorToString) (ForSelf << EncodeParametersResult))
        ]
