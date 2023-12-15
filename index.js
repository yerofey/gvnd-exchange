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

const getWalletBalance = async (walletAddress) => {
  try {
    const balance = await tonweb.getBalance(walletAddress);
    const balanceFormatted = TonWeb.utils.fromNano(balance);
    console.log(`Balance for address ${walletAddress}: ${balanceFormatted}`);
    return balanceFormatted;
  } catch (error) {
    console.error(`Error getting balance for address ${walletAddress}:`, error);
    return 0;
  }
};

const getWalletTransactions = async (address, limit = 10) => {
  try {
    const transactions = await tonweb.getTransactions(address, limit);
    return transactions;
  } catch (error) {
    console.error(`Error fetching transactions for address ${address}:`, error);
    return [];
  }
};

const findLatestTransactionUtime = (transactions) => {
  if (!Array.isArray(transactions) || transactions.length === 0) {
    return 0;
  }

  // Find the transaction with the maximum utime
  let latestUtime = transactions[0].utime;
  transactions.forEach((tx) => {
    if (tx.utime > latestUtime) {
      latestUtime = tx.utime;
    }
  });

  return latestUtime;
};

const monitorAddress = async (userId, walletAddress, lastBalances) => {
  try {
    const currentBalance = await getWalletBalance(walletAddress);

    if (lastBalances[userId] !== currentBalance) {
      const balanceChange = currentBalance - lastBalances[userId];
      lastBalances[userId] = currentBalance;

      console.log(
        `Balance change detected for wallet ${walletAddress}: ${balanceChange}`
      );

      // Save the balance change
      if (sendBalanceChanges) {
        console.log(`Sending balance change for user ${userId}...`);
        // Fetch the latest transactions for the wallet
        const latestTransactions =
          (await getWalletTransactions(walletAddress, 1)) || [];
        console.log(
          `Latest transactions for ${walletAddress}:`,
          latestTransactions
        );
        const latestTransactionUtime =
          findLatestTransactionUtime(latestTransactions) || 0;

        if (latestTransactionUtime > 0) {
          const response = await axios.post(
            `${process.env.GVND_API_URL}?method=updateWalletBalance`,
            {
              userId,
              walletAddress,
              txTimestamp: latestTransactionUtime,
              balance: currentBalance,
              price: await getTonPrice(),
            }
          );
          console.log('response:', response.data);
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
  const lastBalances = {};

  try {
    console.log('Getting initial balances...');
    const balancePromises = Object.entries(userWalletAddresses).map(
      ([userId, walletAddress]) =>
        getWalletBalance(walletAddress).then((balance) => ({ userId, balance }))
    );

    const balances = await Promise.all(balancePromises);
    balances.forEach(({ userId, balance }) => {
      lastBalances[userId] = balance;
    });

    cron.schedule(`*/${interval} * * * * *`, () => {
      Object.entries(userWalletAddresses).forEach(([userId, walletAddress]) => {
        monitorAddress(userId, walletAddress, lastBalances);
      });
    });
  } catch (error) {
    console.error('Error initializing balances:', error.message);
  }
};

const main = async () => {
  console.log(`Starting the monitoring (interval: ${interval} seconds)`);
  await initializeBalances();
}

main();
