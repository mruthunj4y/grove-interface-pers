import { getTransaction, getTransactionReceipt } from 'grove-components/src/js/sharedEth/eth';
import { reportError } from './utils';
import trxStorage from '../trxStorage';

// Check interval for pending transactions (in milliseconds)
const PENDING_TRX_CHECK_INTERVAL = 3000; // Check every 5 seconds

const transactionStorage = trxStorage('transactions');

async function handleReceipt(app, eth, trxHash, blockNumber, receipt, trxNonce) {
  console.log('🔄 Processing receipt for transaction:', trxHash);
  console.log('🧾 Receipt:', receipt);
  
  if (!app || !app.ports || !app.ports.giveUpdateTrxPort) {
    console.error('❌ ERROR: giveUpdateTrxPort not available in app object');
    return null;
  }
  
  // Ignore missing receipts or receipts that are beyond our knowledge of the
  // latest block (this is to provide consistency with the rest of the UI)
  if (!receipt) {
    console.log('❓ No receipt found for transaction:', trxHash);
    return null;
  } else {
    // Comptroller, CToken & CEther all share the exact same event definition on failures
    // so we only need one of the to decode a failure in receipt logs.
    const Comptroller = getContractJsonByName(eth, 'Comptroller');
    const CToken = getContractJsonByAddress(eth, receipt.to);
    const nonOracleFailureEvent = getEvent(eth, Comptroller, 'Failure');

    const status = receipt.status === true ? 1 : 0;

    const failures = receipt.logs
      .map((log) => {
        if (nonOracleFailureEvent && nonOracleFailureEvent.matches(log)) {
          return nonOracleFailureEvent.decode(log);
        }
      })
      .filter((log) => !!log);

    var error = null;

    if (failures[0]) {
      // TODO: failure.info
      // TODO: failure.detail
      error = failures[0].error.toString(); // TODO: This should be a number
    }

    console.log('✅ Sending transaction update to Elm:', {
      trxHash,
      status,
      error,
      trxNonce
    });
    
    app.ports.giveUpdateTrxPort.send({
      trxHash: trxHash,
      status: status,
      error: error,
      trxNonce: trxNonce,
    });
    
    // Also update the transaction in storage
    console.log('💾 Updating transaction in storage:', trxHash, 'status:', status);
    transactionStorage.update(trxHash, status, error);
  }
}
// Function to subscribe to transaction status checks
export function subscribeToCheckTrxStatus(app, eth) {
   if (!app || !app.ports || !app.ports.checkTrxStatusPort) {
       console.error('ERROR: checkTrxStatusPort not available in app object');
       return;
   }

   console.log('Setting up checkTrxStatusPort subscription');
   
   app.ports.checkTrxStatusPort.subscribe(({ blockNumber, trxHash }) => {
    console.log('🔍 RECEIVED CHECK REQUEST for transaction:', trxHash, 'at block:', blockNumber);
    
    if (!eth) {
        console.error('ERROR: eth object is not available for transaction checking');
        return;
    }
    
    if (!trxHash) {
        console.error('ERROR: Invalid transaction hash received');
        return;
    }
    
    // First get the transaction details
    console.log('Fetching transaction details for:', trxHash);
    getTransaction(eth, trxHash)
        .then(transaction => {
            console.log('📄 Transaction details received:', transaction ? 'FOUND' : 'NOT FOUND');
            
            if (!transaction) {
                console.error('Transaction not found:', trxHash);
                return null;
            }
            
            // Then get the receipt separately to ensure we get a proper response
            console.log('Fetching transaction receipt for:', trxHash);
            return getTransactionReceipt(eth, trxHash)
                .then(receipt => {
                    console.log('📝 Receipt details for', trxHash, ':', receipt ? 'FOUND' : 'NOT FOUND');
                    
                    // If receipt exists, transaction is mined - process it
                    if (receipt) {
                        console.log('✅ Transaction is mined, updating status for:', trxHash);
                        return handleReceipt(app, eth, trxHash, blockNumber, receipt, transaction.nonce);
                    } else {
                        console.log('⏳ Transaction still pending, no receipt yet for:', trxHash);
                        // No need to update status as it should already be pending (0)
                        return null;
                    }
                })
                .catch(receiptError => {
                    console.error('❌ ERROR fetching receipt:', receiptError);
                    reportError(app)(receiptError);
                    return null;
                });
        })
        .catch(error => {
            console.error('❌ ERROR checking transaction status:', error);
            reportError(app)(error);
        });
});
}

// Function to subscribe to transaction storage
// Function to directly check all pending transactions without waiting for new blocks
export function startPendingTransactionChecker(app, eth) {
  console.log('🔄 Starting direct pending transaction checker');
  
  // Create a transaction storage instance
  const transactionStorage = trxStorage('transactions');
  
  // Function to check all pending transactions
  const checkAllPendingTransactions = () => {
    try {
      // Ensure we have the required objects
      if (!eth) {
        console.error('❌ ERROR: eth object is not available for transaction checking');
        return;
      }
      
      if (!app || !app.ports || !app.ports.giveUpdateTrxPort) {
        console.error('❌ ERROR: Required ports are not available in app object');
        return;
      }
      
      // Get all transactions from storage
      const transactions = transactionStorage.getAll();
      
      // Find pending transactions (status === 0)
      const pendingTransactions = Object.values(transactions).filter(tx => tx.status === 0);
      
      if (pendingTransactions.length > 0) {
        console.log(`⏳ Directly checking ${pendingTransactions.length} pending transactions`);
        
        // Check each pending transaction
        pendingTransactions.forEach(tx => {
          const trxHash = tx.trxHash;
          
          // Get transaction receipt directly - this will return null if not yet mined
          getTransactionReceipt(eth, trxHash)
            .then(receipt => {
              // If we have a receipt, the transaction has been mined
              if (receipt) {
                console.log(`✅ Transaction ${trxHash} is confirmed in block ${receipt.blockNumber}`);
                
                // Get the transaction details for the nonce
                getTransaction(eth, trxHash)
                  .then(transaction => {
                    const status = receipt.status === true ? 1 : 0;
                    const trxNonce = transaction ? transaction.nonce : 0;
                    
                    // Update transaction in storage
                    transactionStorage.update(trxHash, status, null);
                    
                    // Send update to Elm
                    console.log(`📤 Sending transaction update to Elm for ${trxHash}:`, { status, blockNumber: receipt.blockNumber });
                    app.ports.giveUpdateTrxPort.send({
                      trxHash: trxHash,
                      status: status,
                      error: null,
                      trxNonce: trxNonce
                    });
                    
                    // For successful transactions, trigger a UI refresh by sending a new block update
                    if (status === 1 && transaction) {
                      console.log(`🔄 Triggering UI refresh after successful transaction`);
                      
                      // Send the current block number to trigger a UI refresh
                      // This will cause the Elm app to refresh market data including collateral status
                      if (app.ports.giveNewBlockPort) {
                        console.log(`📤 Sending block update to trigger UI refresh:`, receipt.blockNumber);
                        setTimeout(() => {
                          app.ports.giveNewBlockPort.send({ block: receipt.blockNumber });
                        }, 1000); // Small delay to ensure transaction update is processed first
                      }
                    }
                  });
              } else {
                console.log(`⏳ Transaction ${trxHash} still pending - no receipt yet`);
              }
            })
            .catch(error => {
              console.error(`❌ Error checking transaction receipt for ${trxHash}:`, error);
            });
        });
      }
    } catch (error) {
      console.error('❌ Error in direct transaction checker:', error);
    }
  };
  
  // Initial check
  checkAllPendingTransactions();
  
  // Set up interval to check pending transactions regularly
  const intervalId = setInterval(checkAllPendingTransactions, PENDING_TRX_CHECK_INTERVAL);
  
  // Return the interval ID so it can be cleared if needed
  return intervalId;
}

export function subscribeToStoreTransaction(app, eth) {
  // port storeTransactionPort : { trxHash : String, networkId : Int, timestamp : Int, contractAddress : String, assetAddress : String, customerAddress : String, fun : String, args : List, status : Maybe Int, error : Maybe String, expectedNonce : Maybe Int } -> Cmd msg
  app.ports.storeTransactionPort.subscribe(
    ({ trxHash, networkId, timestamp, contractAddress, customerAddress, fun, args, status, error, expectedNonce }) => {
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

  // port storeTransactionUpdatePort : { trxHash : String, status : Maybe Int, error : Maybe String } -> Cmd msg
  app.ports.storeTransactionUpdatePort.subscribe(({ trxHash, status, error }) => {
    transactionStorage.update(trxHash, status, error);
  });

  // port askStoredTransactionsPort : {} -> Cmd msg
  app.ports.askStoredTransactionsPort.subscribe(({}) => {
    const transactions = Object.values(transactionStorage.getAll());

    app.ports.giveStoredTransactionsPort.send(transactions);
  });

  // port askClearTransactionsPort : {} -> Cmd msg
  app.ports.askClearTransactionsPort.subscribe(({}) => {
    transactionStorage.clear();
  });
}

// Function to handle transaction notifications
function handleTransactionNotification(app, eth, txModule, txId, txHash, status, blockNumber) {
  // port etherTransactionStatePort : (Json.Decode.Value -> msg) -> Sub msg
  app.ports.etherTransactionStatePort.send({
    txModule,
    txId,
    txHash: txHash,
    status: status,
    blockNumber: blockNumber,
  });
} 