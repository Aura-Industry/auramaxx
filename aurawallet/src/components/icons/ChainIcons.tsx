import React from 'react';

interface IconProps {
  size?: number;
  className?: string;
}

export const BaseIcon: React.FC<IconProps> = ({ size = 16, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 111 111" fill="none" className={className}>
    <path d="M54.921 110.034C85.359 110.034 110.034 85.402 110.034 55.017C110.034 24.6319 85.359 0 54.921 0C26.0432 0 2.35281 22.1714 0 50.3923H72.8467V59.6416H0C2.35281 87.8625 26.0432 110.034 54.921 110.034Z" fill="currentColor"/>
  </svg>
);

export const EthereumIcon: React.FC<IconProps> = ({ size = 16, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 256 417" className={className}>
    <path fill="currentColor" d="M127.961 0l-2.795 9.5v275.668l2.795 2.79 127.962-75.638z"/>
    <path fill="currentColor" opacity="0.6" d="M127.962 0L0 212.32l127.962 75.639V154.158z"/>
    <path fill="currentColor" d="M127.961 312.187l-1.575 1.92v98.199l1.575 4.6L256 236.587z"/>
    <path fill="currentColor" opacity="0.6" d="M127.962 416.905v-104.72L0 236.585z"/>
    <path fill="currentColor" opacity="0.8" d="M127.961 287.958l127.96-75.637-127.96-58.162z"/>
    <path fill="currentColor" opacity="0.4" d="M0 212.32l127.96 75.638v-133.8z"/>
  </svg>
);

export const ArbitrumIcon: React.FC<IconProps> = ({ size = 16, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 256 256" className={className}>
    <path fill="currentColor" d="M128 0C57.308 0 0 57.308 0 128s57.308 128 128 128 128-57.308 128-128S198.692 0 128 0zm70.56 186.624l-17.856-49.088L128 217.6l-52.704-80.064-17.856 49.088L128 38.4l70.56 148.224z"/>
  </svg>
);

export const OptimismIcon: React.FC<IconProps> = ({ size = 16, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 256 256" className={className}>
    <circle cx="128" cy="128" r="128" fill="currentColor"/>
    <path fill="white" d="M81.5 170.5c-11.3 0-20.2-3.2-26.7-9.5-6.5-6.4-9.8-15.3-9.8-26.8 0-14.5 4.2-26.2 12.5-35.2 8.4-9 19.5-13.5 33.3-13.5 11 0 19.7 3.1 26.2 9.4 6.5 6.2 9.7 14.9 9.7 26 0 14.7-4.2 26.6-12.5 35.7-8.3 9-19.4 13.5-33.3 13.5h.6v.4zm3.8-18c7.4 0 13.3-3.1 17.8-9.2 4.5-6.2 6.7-14.3 6.7-24.4 0-6.8-1.5-12-4.6-15.8-3-3.7-7.3-5.6-12.8-5.6-7.4 0-13.4 3.1-17.8 9.3-4.5 6.2-6.7 14.3-6.7 24.3 0 6.8 1.6 12 4.7 15.7 3.1 3.8 7.3 5.7 12.7 5.7z"/>
    <path fill="white" d="M137.5 169V87.5h26.3c10.5 0 18.5 2.2 24 6.7 5.5 4.4 8.3 10.8 8.3 19.2 0 8.8-2.9 15.8-8.8 20.8-5.9 5-14.1 7.5-24.6 7.5h-7.8V169h-17.4zm17.4-43.8h5.3c5.2 0 9.1-1.1 11.8-3.4 2.7-2.3 4-5.5 4-9.8 0-3.8-1.2-6.6-3.6-8.6-2.4-2-6-3-10.8-3h-6.7v24.8z"/>
  </svg>
);

export const PolygonIcon: React.FC<IconProps> = ({ size = 16, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 256 256" className={className}>
    <path fill="currentColor" d="M177.1 94.9c-3.5-2-7.8-2-11.3 0l-26.4 15.6-17.9 10.2-26.4 15.6c-3.5 2-7.8 2-11.3 0l-20.7-12.2c-3.5-2-5.7-5.8-5.7-9.8V91.8c0-3.9 2.1-7.7 5.7-9.8l20.5-11.9c3.5-2 7.8-2 11.3 0l20.5 11.9c3.5 2 5.7 5.8 5.7 9.8v15.6l17.9-10.4V81.1c0-3.9-2.1-7.7-5.7-9.8L95.7 47.8c-3.5-2-7.8-2-11.3 0L45.2 71.4c-3.6 2.1-5.7 5.9-5.7 9.8v47.1c0 3.9 2.1 7.7 5.7 9.8l38.8 22.5c3.5 2 7.8 2 11.3 0l26.4-15.4 17.9-10.4 26.4-15.4c3.5-2 7.8-2 11.3 0l20.5 11.9c3.5 2 5.7 5.8 5.7 9.8v22.5c0 3.9-2.1 7.7-5.7 9.8l-20.4 12c-3.5 2-7.8 2-11.3 0l-20.5-11.9c-3.5-2-5.7-5.8-5.7-9.8v-15.4l-17.9 10.4v15.8c0 3.9 2.1 7.7 5.7 9.8l38.8 22.5c3.5 2 7.8 2 11.3 0l38.8-22.5c3.5-2 5.7-5.8 5.7-9.8v-47.3c0-3.9-2.1-7.7-5.7-9.8l-39-22.3z"/>
  </svg>
);

export const SolanaIcon: React.FC<IconProps> = ({ size = 16, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 397 311" className={className}>
    <path fill="currentColor" d="M64.6 237.9c2.4-2.4 5.7-3.8 9.2-3.8h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1l62.7-62.7z"/>
    <path fill="currentColor" d="M64.6 3.8C67.1 1.4 70.4 0 73.8 0h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1L64.6 3.8z"/>
    <path fill="currentColor" d="M333.1 120.1c-2.4-2.4-5.7-3.8-9.2-3.8H6.5c-5.8 0-8.7 7-4.6 11.1l62.7 62.7c2.4 2.4 5.7 3.8 9.2 3.8h317.4c5.8 0 8.7-7 4.6-11.1l-62.7-62.7z"/>
  </svg>
);

export const DefaultChainIcon: React.FC<IconProps> = ({ size = 16, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className}>
    <circle cx="12" cy="12" r="10"/>
    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
    <path d="M2 12h20"/>
  </svg>
);

export const getChainIcon = (chain: string): React.FC<IconProps> => {
  const icons: Record<string, React.FC<IconProps>> = {
    base: BaseIcon,
    ethereum: EthereumIcon,
    arbitrum: ArbitrumIcon,
    optimism: OptimismIcon,
    polygon: PolygonIcon,
    solana: SolanaIcon,
    'solana-devnet': SolanaIcon,
  };
  return icons[chain.toLowerCase()] || DefaultChainIcon;
};
