import { config } from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { mnemonicNew, mnemonicToWalletKey } from '@ton/crypto';
import TonWeb from 'tonweb';
import cron from 'node-cron';
import axios from 'axios';

config();

const sendBalanceChanges = false;

const tonweb = new TonWeb(
  new TonWeb.HttpProvider('https://toncenter.com/api/v2/jsonRPC', {
    apiKey: process.env.TONCENTER_API_MAINNET_KEY,
  })
);

const getTonPrice = async () => {
  try {
    const response = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd');
    return response.data['the-open-network'].usd;
  } catch (error) {
    console.error('Error fetching TON price:', error);
    return 0;
  }
}

const loadWalletAddresses = () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const filePath = path.join(__dirname, 'wallets.json');
  const data = fs.readFileSync(filePath);
  return JSON.parse(data);
};

const getWalletBalance = async (walletAddress) => {
  try {
    console.log(`Getting balance for address ${walletAddress}`);
    const balance = await tonweb.getBalance(walletAddress);
    const balanceFormatted = TonWeb.utils.fromNano(balance);
    console.log(`Balance for address ${walletAddress}: ${balanceFormatted}`);
    return balanceFormatted;
  } catch (error) {
    console.error(`Error getting balance for address ${walletAddress}:`, error);
    return 0;
  }
}

const monitorAddress = async (userId, walletAddress, lastBalances) => {
  console.log(`Checking address ${walletAddress} for user ${userId}...`);

  try {
    const currentBalance = await getWalletBalance(walletAddress);

    if (lastBalances[userId] !== currentBalance) {
      const balanceChange = currentBalance - lastBalances[userId];
      lastBalances[userId] = currentBalance;

      console.log(`Balance change detected for user ${userId}: ${balanceChange}`);

      if (sendBalanceChanges) {
        const response = await axios.post(`${process.env.GVND_API_URL}?method=updateWalletBalance`, {
          userId,
          walletAddress,
          balance: currentBalance,
          price: await getTonPrice(),
        });
        console.log('response:', response.data);
      }
    }
  } catch (error) {
    console.error(`Error monitoring address for user ${userId}:`, error);
  }
}

const initializeBalances = async () => {
  console.log('Initializing balances...');
  const userWalletAddresses = loadWalletAddresses();
  const lastBalances = {};

  try {
    console.log('Getting initial balances...');
    const balancePromises = Object.entries(userWalletAddresses).map(([userId, walletAddress]) =>
      getWalletBalance(walletAddress).then(balance => ({ userId, balance }))
    );

    const balances = await Promise.all(balancePromises);
    balances.forEach(({ userId, balance }) => {
      lastBalances[userId] = balance;
      // lastBalances[userId] = 0;
    });

    cron.schedule('*/30 * * * * *', () => {
      Object.entries(userWalletAddresses).forEach(([userId, walletAddress]) => {
        monitorAddress(userId, walletAddress, lastBalances);
      });
    });
  } catch (error) {
    console.error('Error initializing balances:', error.message);
  }
}

initializeBalances();
