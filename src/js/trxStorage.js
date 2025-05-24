import createStorage from './storage';

function trxStorage(storageKey) {
  const storage = createStorage(storageKey);

  function put(trxHash, network, timestamp, contractAddress, customerAddress, fun, args, status, error, expectedNonce) {
    const transactions = storage.get({});

    // If status is null, default to pending (0)
    const transactionStatus = status === null ? 0 : status;

    transactions[trxHash] = {
      trxHash,
      network,
      timestamp,
      contractAddress,
      customerAddress,
      fun,
      args,
      status: transactionStatus, // Use the determined status
      error,
      expectedNonce
    }

    console.log(`Storing transaction ${trxHash} with status:`, transactionStatus);
    storage.set(transactions);
  }

  function update(trxHash, status, error) {
    const transactions = storage.get({});
    const currentTrx = transactions[trxHash];

    if (currentTrx) {
      console.log(`Updating transaction ${trxHash} status from ${currentTrx.status} to ${status}`);
      
      transactions[trxHash] = Object.assign(
        {},
        currentTrx,
        {
          status: status,
          error: error
        }
      )

      storage.set(transactions);
    } else {
      console.warn(`Tried to update non-existent transaction: ${trxHash}`);
    }
  }

  function getAll() {
    const res = storage.get({});
    return res;
  }

  function clear() {
    storage.set({});
  }

  return {
    put,
    update,
    getAll,
    clear
  };
}

export default trxStorage;