import { debug } from 'grove-components/src/js/sharedEth/utils';

// Helper function to safely send port messages
export function safeSendPort(port, data) {
    if (!port) {
        console.warn('Port is undefined, skipping message send');
        return;
    }
    
    try {
        port.send(data);
    } catch (error) {
        console.error('Error sending port message:', error);
    }
}

// Function to report errors through the app's error port
export function reportError(app) {
    return (error) => {
        if (app && app.ports && app.ports.giveError) {
            safeSendPort(app.ports.giveError, error.toString());
        } else {
            console.error('Error reporting failed - app or ports not initialized:', error);
        }
    };
}

// Function to get contract JSON by name
export function getContractJsonByName(eth, contractName) {
    let targetContractAbi = eth.currentAbiMap[contractName];

    if (!targetContractAbi) {
        console.warn('Cannot find abi for contract: ', contractName);
        targetContractAbi = [];
    }

    return {
        contractName: contractName,
        abi: targetContractAbi,
    };
}

// Function to get contract JSON by address
export function getContractJsonByAddress(eth, contractAddress) {
    const contractName = eth.currentAddressToNameMap[contractAddress.toLowerCase()];
    return getContractJsonByName(eth, contractName);
}

// Function to get block timestamps
export async function getBlockTimestamps(blockNumbers, network) {
    if (blockNumbers.length === 0) {
        return {};
    } else {
        let timestampsResult = await fetch(
            `https://timestamp.compound.finance/${blockNumbers.join(',')}?network=${network}`
        );
        return await timestampsResult.json();
    }
}

// Function to handle transaction receipts
export async function handleReceipt(app, eth, trxHash, blockNumber, receipt, trxNonce) {
    console.log('handleReceipt called with:', {
        trxHash,
        blockNumber,
        receiptBlockNumber: receipt?.blockNumber,
        receiptTo: receipt?.to,
        trxNonce
    });

    if (!receipt || receipt.blockNumber > blockNumber) {
        console.log('Skipping receipt - no receipt or block number mismatch');
        return null;
    } else {
        const Comptroller = getContractJsonByName(eth, 'Comptroller');
        console.log('Comptroller contract:', {
            contractName: Comptroller.contractName,
            address: Comptroller.contractName
        });

        const CToken = getContractJsonByAddress(eth, receipt.to);
        console.log('CToken contract:', {
            address: receipt.to,
            contractName: CToken?.contractName
        });

        const nonOracleFailureEvent = getEvent(eth, Comptroller, 'Failure');
        console.log('Failure event:', nonOracleFailureEvent);

        // Convert status to match the expected format in the UI
        const status = receipt.status === true ? 1 : 0;
        console.log('Transaction status:', status);

        const failures = receipt.logs
            .map((log) => {
                if (nonOracleFailureEvent && nonOracleFailureEvent.matches(log)) {
                    return nonOracleFailureEvent.decode(log);
                }
            })
            .filter((log) => !!log);

        console.log('Transaction failures:', failures);

        var error = null;

        if (failures[0]) {
            error = failures[0].error.toString();
            console.log('Transaction error:', error);
        }

        // Send transaction update to UI
        if (app.ports.giveUpdateTrxPort) {
            console.log('Sending update to giveUpdateTrxPort');
            app.ports.giveUpdateTrxPort.send({
                trxHash: trxHash,
                status: status,
                error: error,
                trxNonce: trxNonce,
            });
        } else {
            console.log('giveUpdateTrxPort not available');
        }

        // Also send transaction state update to ensure UI is updated
        if (app.ports.etherTransactionStatePort) {
            console.log('Sending update to etherTransactionStatePort');
            app.ports.etherTransactionStatePort.send({
                txModule: 'collateral',
                txId: trxNonce,
                txHash: trxHash,
                status: status === 1 ? 'confirmed' : 'failed',
                blockNumber: receipt.blockNumber
            });
        } else {
            console.log('etherTransactionStatePort not available');
        }

        // Log receipt details for debugging
        console.log('Transaction receipt details:', {
            to: receipt.to,
            from: receipt.from,
            contractAddress: receipt.contractAddress,
            logs: receipt.logs,
            status: receipt.status,
            blockNumber: receipt.blockNumber
        });

        // If this is an enterMarkets transaction and it was successful, trigger a refresh of account data
        if (status === 1 && receipt.to && receipt.to.toLowerCase() === Comptroller.contractName.toLowerCase()) {
            // Trigger a refresh of account data
            if (app.ports.queryAllWithAccountPort) {
                const accounts = await eth.getAccounts();
                if (accounts && accounts.length > 0) {
                    const customerAddress = accounts[0];
                    app.ports.queryAllWithAccountPort.send({
                        blockNumber: receipt.blockNumber,
                        customerAddress: customerAddress,
                        cTokens: [], // This will be populated by the Elm side
                        compAddress: '0x0000000000000000000000000000000000000000',
                        capFactoryAddress: '0x0000000000000000000000000000000000000000'
                    });
                }
            }
        }
    }
}


// Function to get ERC20 token balance
    export async function getERC20Balance(userAddress, tokenContractAddress, decimal) {
    const functionSelector = '0x70a08231';
    const address = userAddress.replace('0x', '').padStart(64, '0');
    const data = functionSelector + address;

    try {
        const result = await window.ethereum.request({
            method: 'eth_call',
            params: [
                {
                    to: tokenContractAddress,
                    data: data,
                },
                'latest',
            ],
        });

        const balance = BigInt(result).toString();
        const decimalForm = balance / (10 ** decimal);
        console.log('balance',decimalForm);
        return decimalForm;
    } catch (error) {
        console.error('Error fetching token balance:', error);
        return "0";
    }
} 

export async function getERC20Allowance(userAddress, underlyingAssetAddress, tokenContractAddress, decimal=18) {
    const functionSelector = '0xdd62ed3e'; // allowance(address,address)
    const ownerAddress = userAddress.replace('0x', '').padStart(64, '0');
    const spender = tokenContractAddress.replace('0x', '').padStart(64, '0');
    const data = functionSelector + ownerAddress + spender;

    try {
        const result = await window.ethereum.request({
            method: 'eth_call',
            params: [
                {
                    to: underlyingAssetAddress,
                    data: data,
                },
                'latest',
            ],
        });

        const allowance = BigInt(result).toString();
        const decimalForm = allowance / (10 ** decimal);
        return decimalForm;
    } catch (error) {
        console.error('Error fetching token allowance:', error);
        return "0";
    }
}

export async function supplyUnderlying(tokenAddress) {
    const functionSelector = '0x18160ddd'; // totalSupply()
    const data = functionSelector;

    try {
        const result = await window.ethereum.request({
            method: 'eth_call',
            params: [
                {
                    to: tokenAddress,
                    data: data,
                },
                'latest',
            ],
        });

        const totalSupply = BigInt(result).toString();
        return totalSupply;
    } catch (error) {
        console.error('Error fetching total supply:', error);
        return "0";
    }
}
