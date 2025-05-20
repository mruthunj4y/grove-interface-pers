import { debug } from 'grove-components/src/js/sharedEth/utils';
import { NEW_BLOCK_CHECK_INTERVAL_MS } from './constants';
import { requestForeground } from '../helpers';
import { getBlockNumber } from 'grove-components/src/js/sharedEth/eth';

// Function to subscribe to new blocks
export function subscribeToNewBlocks(app, eth) {
    var blockTimer;
    var previousBlock;

    function newBlockCheckFunction() {
        requestForeground(() => {
            getBlockNumber(eth)
                .then((blockNumber) => {
                    if (blockNumber && blockNumber !== previousBlock) {
                        debug(`New Block: ${blockNumber}`);
                        app.ports.giveNewBlockPort.send({ block: blockNumber });
                        previousBlock = blockNumber;
                    }
                })
                .catch((error) => {
                    console.warn('Error checking for new block:', error);
                    // Don't stop the polling on error, just log it
                })
                .finally(() => {
                    // Always schedule the next check, even if there was an error
                    blockTimer = setTimeout(newBlockCheckFunction, NEW_BLOCK_CHECK_INTERVAL_MS);
                });
        });
    }

    // Subscribe to ask new block port
    app.ports.askNewBlockPort.subscribe(() => {
        // Clear any existing timer to prevent multiple polling
        if (blockTimer) {
            clearTimeout(blockTimer);
        }
        newBlockCheckFunction();
    });

    // Subscribe to ask new block async port
    app.ports.askNewBlockAsyncPort.subscribe(({blockNumber}) => {
        requestForeground(() => {
            getBlockNumber(eth)
                .then((currentBlockNumber) => {
                    if (currentBlockNumber && currentBlockNumber !== previousBlock) {
                        debug(`New Block: ${currentBlockNumber}`);
                        app.ports.giveNewBlockPort.send({ block: currentBlockNumber });
                        previousBlock = currentBlockNumber;
                    }
                })
                .catch((error) => {
                    console.warn('Error in async block check:', error);
                    // Don't stop the polling on error
                });
        });
    });
} 