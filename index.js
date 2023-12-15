import { config } from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import TonWeb from 'tonweb';
import cron from 'node-cron';
import axios from 'axios';

config();

const interval = process.env.MONITOR_INTERVAL || 10;
const sendBalanceChanges = process.env.SAVE_BALANCE_CHANGE === 'true';

const tonweb = new TonWeb(
  new TonWeb.HttpProvider('https://toncenter.com/api/v2/jsonRPC', {
    apiKey: process.env.TONCENTER_API_MAINNET_KEY,
  })
);

const lastBalances = {};
const lastTimestamps = {};

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

const getTonPrice = async () => {
  try {
    const response = await axios.get(
      'https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd'
    );
    return response.data['the-open-network'].usd;
  } catch (error) {
    console.error('Error fetching TON price:', error);
    return 0;
  }
};

const loadWalletAddresses = () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const filePath = path.join(__dirname, 'wallets.json');
  const data = fs.readFileSync(filePath);
  return JSON.parse(data);
};

const getWalletBalance = async (walletAddress, retries = 1) => {
  try {
    const balance = await tonweb.getBalance(walletAddress);
    const balanceFormatted = TonWeb.utils.fromNano(balance);
    console.log(`Balance for address ${walletAddress}: ${balanceFormatted}`);
    return balanceFormatted;
  } catch (error) {
    console.error(`Error getting balance for address ${walletAddress}:`, error);
    if (retries > 0) {
      console.log(`Retrying in 2 seconds...`);
      await delay(2000);
      return getWalletBalance(walletAddress, retries - 1);
    }
    return null;
  }
};

const getWalletTransactions = async (address, limit = 10, retries = 1) => {
  try {
    const transactions = await tonweb.getTransactions(address, limit);
    return transactions;
  } catch (error) {
    console.error(`Error fetching transactions for address ${address}:`, error);
    if (retries > 0) {
      console.log(`Retrying in 2 seconds...`);
      await delay(2000);
      return getWalletTransactions(address, limit, retries - 1);
    }
    return [];
  }
};

const findlatestTxTimestamp = (transactions) => {
  if (!Array.isArray(transactions) || transactions.length === 0) {
    return 0;
  }

  // Find the transaction with the maximum utime
  let latestUtime = transactions[0].utime || 0;
  transactions.forEach((tx) => {
    if (tx.utime > latestUtime) {
      latestUtime = tx.utime;
    }
  });

  return latestUtime;
};

const monitorAddress = async (userId, walletAddress) => {
  try {
    const currentBalance = await getWalletBalance(walletAddress);

    if (currentBalance !== null && lastBalances[userId] !== currentBalance) {
      const balanceChange = currentBalance - lastBalances[userId];
      lastBalances[userId] = currentBalance;
      console.log(
        `Balance change detected for wallet ${walletAddress}: ${balanceChange}`
      );

      // Fetch the latest transactions for the wallet
      const latestTransactions =
        (await getWalletTransactions(walletAddress, 1)) || [];
      const latestTxTimestamp = findlatestTxTimestamp(latestTransactions) || 0;

      // Save the balance change
      if (latestTxTimestamp > 0) {
        // Compare with the stored latest transaction time
        if (latestTxTimestamp > lastTimestamps[userId]) {
          lastTimestamps[userId] = latestTxTimestamp;
          console.log(
            `New transaction detected for user ${userId} at time ${latestTxTimestamp}`
          );

          if (sendBalanceChanges) {
            console.log(
              `Sending balance change ${balanceChange} for user ${userId}...`
            );
            try {
              const response = await axios.post(
                `${process.env.GVND_API_URL}?method=updateWalletBalance`,
                {
                  userId,
                  walletAddress,
                  change: balanceChange,
                  balance: currentBalance,
                  txTimestamp: latestTxTimestamp,
                  price: await getTonPrice(),
                }
              );
              if (response.status == 200) {
                console.log(`Balance change sent successfully`);
              } else {
                console.error(
                  `Error sending balance change (status ${response.status}):`,
                  response.data.error
                );
              }
            } catch (err) {
              console.error(`Error sending balance change: ${err.message}`);
            }
          }
        }
      }
    }
  } catch (error) {
    console.error(`Error monitoring address for user ${userId}:`, error);
  }
};

const initializeBalances = async () => {
  console.log('Initializing balances...');
  const userWalletAddresses = loadWalletAddresses();

  try {
    console.log('Getting initial balances...');
    const balancePromises = Object.entries(userWalletAddresses).map(
      ([userId, walletAddress]) =>
        getWalletBalance(walletAddress).then((balance) => ({ userId, balance }))
    );

    const balances = await Promise.all(balancePromises);
    balances.forEach(({ userId, balance }) => {
      lastBalances[userId] = balance;
      lastTimestamps[userId] = 0;
    });

    cron.schedule(`*/${interval} * * * * *`, () => {
      Object.entries(userWalletAddresses).forEach(([userId, walletAddress]) => {
        monitorAddress(userId, walletAddress);
      });
    });
  } catch (error) {
    console.error('Error initializing balances:', error.message);
  }
};

const main = async () => {
  console.log(`Starting the monitoring (interval: ${interval} seconds)`);
  await initializeBalances();
};

main();
