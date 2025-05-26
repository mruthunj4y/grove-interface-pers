import { debug } from 'grove-components/src/js/sharedEth/utils';
import { NEW_BLOCK_CHECK_INTERVAL_MS } from './constants';
import { requestForeground } from '../helpers';
import { getBlockNumber, getTransactionReceipt } from 'grove-components/src/js/sharedEth/eth';
import trxStorage from '../trxStorage';

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
                        
                        // Send new block notification to Elm
                        app.ports.giveNewBlockPort.send({ block: blockNumber });
                        previousBlock = blockNumber;
                        
                        // Manually check pending transactions
                        checkPendingTransactions(app, eth, blockNumber);
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
                        
                        // Manually check pending transactions
                        checkPendingTransactions(app, eth, currentBlockNumber);
                    }
                })
                .catch((error) => {
                    console.warn('Error in async block check:', error);
                    // Don't stop the polling on error
                });
        });
    });
} 

// Function to manually check pending transactions when a new block arrives
function checkPendingTransactions(app, eth, blockNumber) {
    try {
        // Check if we have the required app object
        if (!app || !app.ports || !app.ports.giveUpdateTrxPort) {
            console.error('❌ ERROR: Required ports are not available in app object');
            return;
        }
        
        // Get all transactions from storage
        const transactionStorage = trxStorage('transactions');
        const transactions = transactionStorage.getAll();
        
        // Find pending transactions (status === 0)
        const pendingTransactions = Object.values(transactions).filter(tx => tx.status === 0);
        
        if (pendingTransactions.length > 0) {
            console.log(`🔍 Checking ${pendingTransactions.length} pending transactions at block ${blockNumber}`);
            
            // Process each pending transaction
            pendingTransactions.forEach(tx => {
                const trxHash = tx.trxHash;
                
                // Directly call the checkTrxStatus port
                if (app.ports.checkTrxStatusPort) {
                    console.log(`📋 Requesting status check for transaction: ${trxHash}`);
                    app.ports.checkTrxStatusPort.send({
                        blockNumber: blockNumber,
                        trxHash: trxHash
                    });
                } else {
                    // Fallback if port is not available - use direct approach
                    console.log(`⚠️ checkTrxStatusPort not available, using direct check for: ${trxHash}`);
                    getTransactionReceipt(eth, trxHash).then(receipt => {
                        if (receipt) {
                            getTransaction(eth, trxHash).then(transaction => {
                                if (transaction) {
                                    const status = receipt.status === true ? 1 : 0;
                                    const nonce = transaction.nonce || 0;
                                    
                                    // Update transaction in storage
                                    transactionStorage.update(trxHash, status, null);
                                    
                                    // Send update to Elm
                                    app.ports.giveUpdateTrxPort.send({
                                        trxHash: trxHash,
                                        status: status,
                                        error: null,
                                        trxNonce: nonce
                                    });
                                    
                                    console.log(`✅ Transaction ${trxHash} confirmed with status ${status}`);
                                }
                            }).catch(error => {
                                console.error(`❌ Error getting transaction details: ${error.message}`);
                            });
                        }
                    }).catch(error => {
                        console.error(`❌ Error checking receipt: ${error.message}`);
                    });
                }
            });
        }
    } catch (error) {
        console.error('❌ Error checking pending transactions:', error);
    }
}
