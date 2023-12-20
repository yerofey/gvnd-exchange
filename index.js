import { config } from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import TonWeb from 'tonweb';
import cron from 'node-cron';
import axios from 'axios';
import Redis from 'ioredis';

config();

const interval = process.env.MONITOR_INTERVAL || 10;
const sendBalanceChanges = process.env.SAVE_BALANCE_CHANGE === 'true';

const redis = new Redis(process.env.REDIS_URL);
const tonweb = new TonWeb(
  new TonWeb.HttpProvider('https://toncenter.com/api/v2/jsonRPC', {
    apiKey: process.env.TONCENTER_API_MAINNET_KEY,
  })
);

const getUserBalance = async (userId) => {
  const balance = await redis.get(`balance:${userId}`);
  return balance ? parseFloat(balance) : null;
};

const saveUserBalance = async (userId, balance) => {
  await redis.set(`balance:${userId}`, balance);
};

const getTxTimestamp = async (userId) => {
  const timestamp = await redis.get(`txTimestamp:${userId}`);
  return timestamp ? parseInt(timestamp, 10) : 0;
};

const saveUserTxTimestamp = async (userId, timestamp) => {
  await redis.set(`txTimestamp:${userId}`, timestamp);
};

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

const getTonPrice = async () => {
  try {
    const response = await axios.get(
      'https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd'
    );
    return response?.data['the-open-network']?.usd || 0;
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
    const storedBalance = await getUserBalance(userId);
    const storedTxTimestamp = await getTxTimestamp(userId);

    if (currentBalance !== null && storedBalance != currentBalance) {
      await saveUserBalance(userId, currentBalance);
      const balanceChange = currentBalance - storedBalance;
      console.log(
        `Balance change detected for wallet ${walletAddress}: ${balanceChange}`
      );

      // Fetch the latest transactions for the wallet
      await delay(200);
      const latestTransactions =
        (await getWalletTransactions(walletAddress, 1)) || [];
      console.log(latestTransactions);
      const latestTxTimestamp = findlatestTxTimestamp(latestTransactions) || 0;
      console.log(`Latest transaction for user ${userId} timestamp: ${latestTxTimestamp}`);

      // Save the balance change
      if (latestTxTimestamp > 0 && latestTxTimestamp > storedTxTimestamp) {
        await saveUserTxTimestamp(userId, latestTxTimestamp);
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
  } catch (error) {
    console.error(`Error monitoring address for user ${userId}:`, error);
  }
};

const initializeBalances = async () => {
  console.log('Initializing balances...');
  const userWalletAddresses = loadWalletAddresses();

  try {
    console.log('Getting initial balances...');
    const balances = [];

    for (const [userId, walletAddress] of Object.entries(userWalletAddresses)) {
      const storedBalance = await getUserBalance(userId);
      const currentBalance = await getWalletBalance(walletAddress);
      const balance = currentBalance || storedBalance || 0;
      balances.push({ userId, balance });
      await saveUserBalance(userId, balance);
      await delay(200);
      const storedTxTimestamp = await getTxTimestamp(userId);
      const latestTransactions = await getWalletTransactions(walletAddress, 1);
      const latestTxTimestamp = findlatestTxTimestamp(latestTransactions);
      if (latestTxTimestamp > 0 && latestTxTimestamp > storedTxTimestamp) {
        await saveUserTxTimestamp(userId, latestTxTimestamp);
      }
      await delay(500);
    }

    cron.schedule(`*/${interval} * * * * *`, async () => {
      for (const [userId, walletAddress] of Object.entries(userWalletAddresses)) {
        await delay(500);
        await monitorAddress(userId, walletAddress);
      }
    });
  } catch (error) {
    console.error('Error initializing balances:', error.message);
  }
};

const healthCheck = async () => {
  try {
    const response = await axios.post(`${process.env.GVND_API_URL}?method=exchangeHealthCheck`);
    if (response.status == 200) {
      console.log(`API Health Check OK`);
    } else {
      console.error(`API Health Check Failed: Status ${response.status}`);
    }
  } catch (error) {
    console.error('API Health Check Error:', error.message);
  }
};

const initializeHealthCheck = () => {
  healthCheck();
  cron.schedule('*/30 * * * * *', healthCheck);
};

const main = async () => {
  console.log(`Starting the monitoring (interval: ${interval} seconds)`);
  initializeHealthCheck();
  await delay(500);
  await initializeBalances();
};

main();
