import { getTransaction, getTransactionReceipt } from 'grove-components/src/js/sharedEth/eth';
import { handleReceipt } from './utils';
import { reportError } from './utils';
import trxStorage from '../trxStorage';

const transactionStorage = trxStorage('transactions');
// Function to subscribe to transaction status checks
export function subscribeToCheckTrxStatus(app, eth) {
    // Subscribe to check transaction status port
    app.ports.checkTrxStatusPort.subscribe(({ blockNumber, trxHash }) => {
        console.log('checkTrxStatusPort called with:', { blockNumber, trxHash });
        
        Promise.all([getTransaction(eth, trxHash), getTransactionReceipt(eth, trxHash)])
            .then(([transaction, receipt]) => {
                console.log('Transaction check results:', {
                    transaction: {
                        hash: transaction.hash,
                        from: transaction.from,
                        to: transaction.to,
                        nonce: transaction.nonce
                    },
                    receipt: {
                        blockNumber: receipt?.blockNumber,
                        status: receipt?.status,
                        to: receipt?.to
                    }
                });
                return handleReceipt(app, eth, trxHash, blockNumber, receipt, transaction.nonce);
            })
            .catch(error => {
                console.error('Error checking transaction status:', error);
                reportError(app)(error);
            });
    });
}

// Function to subscribe to transaction storage
export function subscribeToStoreTransaction(app, eth) {
    // Subscribe to store transaction port
    app.ports.storeTransactionPort.subscribe(
        ({ trxHash, networkId, timestamp, contractAddress, customerAddress, fun, args, status, error, expectedNonce }) => {
            console.log('Storing transaction:', {
                trxHash,
                networkId,
                contractAddress,
                customerAddress,
                fun,
                args,
                status,
                error,
                expectedNonce
            });
            
            transactionStorage.put(
                trxHash,
                networkId,
                timestamp,
                contractAddress,
                customerAddress,
                fun,
                args,
                status,
                error,
                expectedNonce
            );
        }
    );

    // Subscribe to store transaction update port
    app.ports.storeTransactionUpdatePort.subscribe(({ trxHash, status, error }) => {
        console.log('Updating transaction:', { trxHash, status, error });
        transactionStorage.update(trxHash, status, error);
    });

    // Subscribe to ask stored transactions port
    app.ports.askStoredTransactionsPort.subscribe(({}) => {
        const transactions = Object.values(transactionStorage.getAll());
        console.log('Retrieved stored transactions:', transactions);
        app.ports.giveStoredTransactionsPort.send(transactions);
    });

    // Subscribe to ask clear transactions port
    app.ports.askClearTransactionsPort.subscribe(({}) => {
        console.log('Clearing all transactions');
        transactionStorage.clear();
    });
}

// Function to handle transaction notifications
export function handleTransactionNotification(app, eth, txModule, txId, txHash, status, blockNumber) {
    app.ports.etherTransactionStatePort.send({
        txModule,
        txId,
        txHash: txHash,
        status: status,
        blockNumber: blockNumber,
    });
}

// Function to subscribe to ether ports
export function subscribeToEtherPorts(app, eth) {
    // Subscribe to ether send transaction port
    app.ports.etherSendTransactionPort.subscribe(([txModule, txId, { from, to, data, value }]) => {
        const trxPayload = {
            from,
            to,
            data,
            value,
        };

        withTrxWeb3(
            eth,
            (web3Eth) => {
                withGasLimitFromPayload(web3Eth, trxPayload).then((estimatedGasLimit) => {
                    let trxPayloadWithGasLimit = Object.assign(trxPayload, {
                        gas: estimatedGasLimit,
                    });
                    web3Eth
                        .sendTransaction(trxPayloadWithGasLimit)
                        .on('transactionHash', (txHash) => {
                            app.ports.giveNewNonBNTrxPort.send({
                                txModule,
                                txId,
                                txHash: txHash,
                            });

                            app.ports.etherTransactionRejectedPort.send({
                                txModule,
                                txId,
                            });
                        })
                        .catch((e) => {
                            if (e.code === 4001) {
                                app.ports.etherTransactionRejectedPort.send({
                                    txModule,
                                    txId,
                                });
                            } else {
                                console.log('Error sending transaction: ', e);
                            }
                        });
                });
            },
            () => {
                console.error('Cannot send transaction without transaction Web3');
            }
        );
    });

    // Subscribe to ether watch transaction port
    app.ports.etherWatchTransactionPort.subscribe(([txModule, txId, txHash]) => {
        getTransactionReceipt(eth, txHash)
            .then((receipt) => {
                if (!receipt) {
                    return null;
                } else {
                    const status = receipt.status === true ? 'confirmed' : 'failed';

                    app.ports.etherTransactionStatePort.send({
                        txModule,
                        txId,
                        txHash: txHash,
                        status: status,
                        blockNumber: null,
                    });
                }
            })
            .catch(reportError(app));
    });
} 