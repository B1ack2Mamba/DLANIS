'use client';

import { FC, ReactNode, useMemo, createContext, useContext } from 'react';
import {
    AnchorProvider as RpcProvider,
    Program,
    Idl,
    web3,
} from '@coral-xyz/anchor';
import { useAnchorWallet } from '@solana/wallet-adapter-react';
import rawIdl from './idl/dlan_stake.json';

import { clusterApiUrl, Connection } from '@solana/web3.js';
import { WalletAdapterNetwork } from '@solana/wallet-adapter-base';

const idl = ((rawIdl as any).default ?? rawIdl) as Idl & { address: string };
export const DLAN_PROGRAM_ID = new web3.PublicKey(idl.address);

const ProgramContext = createContext<Program<Idl> | null>(null);
export const useProgram = (): Program<Idl> => {
    const prog = useContext(ProgramContext);
    if (!prog) throw new Error('Program not initialized');
    return prog;
};

export const MyAnchorProvider: FC<{ children: ReactNode }> = ({ children }) => {
    // читаем сеть из env, дефолт — Devnet
    const network =
        (process.env.NEXT_PUBLIC_WALLET_NETWORK as WalletAdapterNetwork) ||
        WalletAdapterNetwork.Devnet;

    const endpoint =
        process.env.NEXT_PUBLIC_CLUSTER_URL ?? clusterApiUrl(network);

    const connection = useMemo(
        () => new Connection(endpoint, 'confirmed'),
        [endpoint]
    );

    const wallet = useAnchorWallet();

    const provider = useMemo(
        () =>
            wallet
                ? new RpcProvider(connection, wallet, {
                    preflightCommitment: 'confirmed',
                })
                : null,
        [connection, wallet]
    );

    const program = useMemo(
        () => (provider ? new Program(idl, provider) : null),
        [provider]
    );

    if (!provider || !program) return <>{children}</>;
    return (
        <ProgramContext.Provider value={program}>
            {children}
        </ProgramContext.Provider>
    );
};
