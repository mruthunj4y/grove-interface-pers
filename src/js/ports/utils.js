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


function formatBigIntToDecimalString(value, decimals) {
    const s = value.toString().padStart(decimals + 1, '0');
    const intPart = s.slice(0, -decimals);
    const decPart = s.slice(-decimals).replace(/0+$/, ''); // Remove trailing zeros
    return decPart ? `${intPart}.${decPart}` : intPart;
}

export async function getERC20Balance(userAddress, tokenContractAddress, decimal = 18) {
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

        if (!result) throw new Error("Empty result from eth_call");

        const balance = BigInt(result);
        const formatted = formatBigIntToDecimalString(balance, decimal);
        return formatted;
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