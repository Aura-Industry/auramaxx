import fs from 'fs';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

export interface ChainConfig {
  rpc: string;
  chainId: number;
  explorer: string;
  nativeCurrency: string;
}

export interface WalletConfig {
  chains: Record<string, ChainConfig>;
  defaultChain: string;
  server: {
    port: number;
    host: string;
  };
}

const DEFAULT_CONFIG: WalletConfig = {
  chains: {
    base: {
      rpc: 'https://mainnet.base.org',
      chainId: 8453,
      explorer: 'https://basescan.org',
      nativeCurrency: 'ETH'
    },
    ethereum: {
      rpc: 'https://eth.llamarpc.com',
      chainId: 1,
      explorer: 'https://etherscan.io',
      nativeCurrency: 'ETH'
    }
  },
  defaultChain: 'base',
  server: {
    port: 4747,
    host: '127.0.0.1'
  }
};

export function ensureDataDir(): void {
  const dirs = [DATA_DIR, path.join(DATA_DIR, 'hot'), path.join(DATA_DIR, 'pending')];
  dirs.forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
}

export function loadConfig(): WalletConfig {
  ensureDataDir();
  if (!fs.existsSync(CONFIG_PATH)) {
    saveConfig(DEFAULT_CONFIG);
    return DEFAULT_CONFIG;
  }
  const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
  return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
}

export function saveConfig(config: WalletConfig): void {
  ensureDataDir();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

export const DATA_PATHS = {
  config: CONFIG_PATH,
  wallets: DATA_DIR,
  hotWallets: path.join(DATA_DIR, 'hot'),
  pending: path.join(DATA_DIR, 'pending')
};
