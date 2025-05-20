import { parseWeiStr } from 'grove-components/src/js/sharedJs/math.js';
import { DEFAULT_GAS_PRICE } from './constants';
import { langFromURL } from 'grove-components/src/js/sharedEth/utils';
import storage from '../storage';

// Create a single instance of preferences storage
const preferencesStorage = storage('preferences');

// Function to subscribe to console
export function subscribeToConsole(app) {
    app.ports.log.subscribe((msg) => {
        // If msg is an object with a level property, use appropriate console method
        if (typeof msg === 'object' && msg.level) {
            switch(msg.level.toLowerCase()) {
                case 'error':
                    console.error(msg.message || msg);
                    break;
                case 'warn':
                    console.warn(msg.message || msg);
                    break;
                case 'info':
                    console.info(msg.message || msg);
                    break;
                default:
                    console.log(msg.message || msg);
            }
        } else {
            console.log(msg);
        }
    });
} 

// Function to subscribe to gas service

export function subscribeToGasService(app) {
    const web3 = new Web3('https://rpc.testnet.xrplevm.org/');

    app.ports.setGasPricePort.subscribe(async ({ amountWeiStr }) => {
        try {
            // Fetch current gas price from the network
            const gasPrice = await web3.eth.getGasPrice();
            console.log('Current gas price:', web3.utils.fromWei(gasPrice, 'gwei'), 'Gwei');
            currentSendGasPrice = gasPrice;
        } catch (error) {
            console.warn('Error fetching gas price, using default:', error);
            currentSendGasPrice = DEFAULT_GAS_PRICE;
        }
    });
}


// Function to subscribe to preferences
export function subscribeToPreferences(app) {
    const url = new URL(window.location);
    const lang = langFromURL(url, window.navigator.language);

    // port storePreferencesPort : { displayCurrency : String, userLanguage : String, supplyPaneOpen : Bool, borrowPaneOpen : Bool } -> Cmd msg
    app.ports.storePreferencesPort.subscribe((preferences) => {
        preferencesStorage.set(preferences);
    });

    // port askStoredPreferencesPort : {} -> Cmd msg
    app.ports.askStoredPreferencesPort.subscribe(() => {
        const preferences = preferencesStorage.get();
        app.ports.giveStoredPreferencesPort.send({ userLanguage: lang, ...preferences });
    });

    // port askClearPreferencesPort : {} -> Cmd msg
    app.ports.askClearPreferencesPort.subscribe(() => {
        preferencesStorage.set({});
    });
} 

app.ports.setGasPricePort.send({ amountWeiStr: "" }); 