// pages/_app.tsx
import React, { useMemo } from 'react';
import type { AppProps } from 'next/app';
import dynamic from 'next/dynamic';
import '../styles/globals.css';

import { clusterApiUrl } from '@solana/web3.js';
import {
    ConnectionProvider,
    WalletProvider,
} from '@solana/wallet-adapter-react';
import {
    WalletModalProvider,
} from '@solana/wallet-adapter-react-ui';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-wallets';
import { WalletAdapterNetwork } from '@solana/wallet-adapter-base';

import '@solana/wallet-adapter-react-ui/styles.css';
import { MyAnchorProvider } from '../components/AnchorProvider';

// вот он — отключаем SSR именно для кнопки
const WalletMultiButton = dynamic(
    () =>
        import('@solana/wallet-adapter-react-ui').then(
            (mod) => mod.WalletMultiButton
        ),
    { ssr: false }
);

export default function App({ Component, pageProps }: AppProps) {
    // выбираем сеть
    const network = WalletAdapterNetwork.Devnet;
    const endpoint =
        process.env.NEXT_PUBLIC_CLUSTER_URL ?? clusterApiUrl(network);

    // список адаптеров — у нас только Phantom
    const wallets = useMemo(() => [new PhantomWalletAdapter()], []);

    return (
        <ConnectionProvider endpoint={endpoint}>
            <WalletProvider wallets={wallets} autoConnect>
                <WalletModalProvider>
                    {/* Кнопка внутри динамически загруженного компонента */}
                    <div style={{ position: 'absolute', top: 16, right: 16 }}>
                        <WalletMultiButton />
                    </div>

                    {/* Ваш Anchor‑провайдер и остальной рендер */}
                    <MyAnchorProvider>
                        <Component {...pageProps} />
                    </MyAnchorProvider>
                </WalletModalProvider>
            </WalletProvider>
        </ConnectionProvider>
    );
}
