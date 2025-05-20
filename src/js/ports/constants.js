import BN from '../../../node_modules/bn.js';

// Constants used across the ports system
export const PROVIDER_TYPE_NONE = 0;
export const PROVIDER_TYPE_LEDGER = 1;
export const PROVIDER_TYPE_WALLET_LINK = 2;
export const PROVIDER_TYPE_WEB3 = 3;
export const PROVIDER_TYPE_SHOW_ACCOUNT = 3;

export const ACCOUNT_CHECK_INTERVAL_MS = 2000;
export const NETWORK_CHECK_INTERVAL_MS = 4000;
export const NEW_BLOCK_CHECK_INTERVAL_MS = 60_000;
export const SECONDS_PER_BLOCK = 12;
export const BLOCKS_PER_DAY = 7200; // 12 seconds per block
export const EXP_DECIMALS = 18;
export const CALCULATE_ACCOUNT_VALUES_DECIMALS = 36;
export const EXP_SCALE_BN = new BN(10).pow(new BN(18)); // 1e18 used for BN.div

export const DEFAULT_GAS_PRICE = "1000000000"; // 1 Gwei
export const DEFAULT_GAS_LIMIT = "3000000"; // 3M gas limit
export const XRPLEVM_PRICE = "1000000000000000000"; // 1.0 in wei

// We wait this amount of milliseconds before informing Elm of a new block
// we've heard about from Web3. This is to give Infura time to clear caches
// and reduce the likelihood of getting stale data.
export const NEW_BLOCK_DELAY = 1500; 