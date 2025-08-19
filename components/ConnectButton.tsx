// components/ConnectButton.tsx
'use client';
import { FC } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';

export const ConnectButton: FC = () => {
    const { publicKey, connect, disconnect, connecting } = useWallet();
    if (publicKey) {
        return <button onClick={() => disconnect()}>Disconnect</button>;
    }
    return (
        <button onClick={() => connect().catch(() => { })}>
            {connecting ? 'Connecting…' : 'Connect Phantom'}
        </button>
    );
};
