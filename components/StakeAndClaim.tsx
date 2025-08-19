// components/StakeAndClaim.tsx
'use client';

import React, { FC, useState, useMemo } from 'react';
import { PublicKey, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { useAnchorWallet } from '@solana/wallet-adapter-react';
import BN from 'bn.js';

// Типы из Anchor
import type { Program, Idl } from '@coral-xyz/anchor';
import { useProgram } from './AnchorProvider';

// Адрес вашей программы (из IDL)
const DLAN_PROGRAM_ID = new PublicKey(
    '3hQsDEYknZmKKUBApAGtcGPy395ogJdiB8DCvMKh24K7'
);

// Адреса mint’ов (из env)
const STAKE_MINT = new PublicKey(process.env.NEXT_PUBLIC_STAKE_MINT!);
const REWARD_MINT = new PublicKey(process.env.NEXT_PUBLIC_REWARD_MINT!);

// Публичный ключ вашего кошелька-админа
const ADMIN_PUBLIC_KEY = new PublicKey('F37yZcrqkne6EMM9hhTRgr7SWULk1MMPnbJ7mhrq4YFP');

export const StakeAndClaim: FC = () => {
    const [amountSOL, setAmountSOL] = useState('0.1');
    const wallet = useAnchorWallet(); // ваш кошелёк

    // Программа Anchor
    let program: Program<Idl> | null = null;
    try {
        program = useProgram();
    } catch { }

    // PDA-адрес пула
    const POOL_PDA = useMemo<PublicKey>(() => {
        if (!program) return PublicKey.default;
        return PublicKey.findProgramAddressSync(
            [Buffer.from('pool')],
            program.programId
        )[0];
    }, [program]);

    // PDA-адрес казны
    const TREASURY_PDA = useMemo<PublicKey>(() => {
        if (!program) return PublicKey.default;
        return PublicKey.findProgramAddressSync(
            [Buffer.from('treasury')],
            program.programId
        )[0];
    }, [program]);

    // PDA-адрес authority mint
    const MINT_AUTHORITY_PDA = useMemo<PublicKey>(() => {
        if (!program) return PublicKey.default;
        return PublicKey.findProgramAddressSync(
            [Buffer.from('mint_authority')],
            POOL_PDA
        )[0];
    }, [program, POOL_PDA]);

    // Инициализация пула (однократно, только админ)
    const handleInitPool = async () => {
        if (!program) return alert('Программа не инициализирована');
        if (!wallet) return alert('Подключите кошелёк');

        try {
            await program.methods
                .initializePool()
                .accounts({
                    pool: POOL_PDA,
                    treasury: TREASURY_PDA,
                    payer: wallet.publicKey,
                    systemProgram: SystemProgram.programId,
                })
                .rpc();
            alert('Пул успешно инициализирован!');
        } catch (err: any) {
            console.error(err);
            alert(`Ошибка инициализации пула: ${err.message}`);
        }
    };

    // Stake SOL
    const handleStake = async () => {
        if (!program) return alert('Программа не инициализирована');
        if (!wallet) return alert('Подключите кошелёк');

        const lamports = new BN(
            Math.floor(parseFloat(amountSOL) * LAMPORTS_PER_SOL)
        );
        const owner = wallet.publicKey!;
        const userAta = await getAssociatedTokenAddress(STAKE_MINT, owner);

        try {
            await program.methods
                .stake(lamports)
                .accounts({
                    pool: POOL_PDA,
                    user: owner,
                    userOwner: owner,
                    poolTreasury: MINT_AUTHORITY_PDA,
                    mint: STAKE_MINT,
                    userToken: userAta,
                    mintAuthority: MINT_AUTHORITY_PDA,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    systemProgram: SystemProgram.programId,
                })
                .rpc();
            alert(`Успешно застейкано ${amountSOL} SOL`);
        } catch (err: any) {
            console.error(err);
            alert(`Ошибка при stake: ${err.message}`);
        }
    };

    // Claim наград
    const handleClaim = async () => {
        if (!program) return alert('Программа не инициализирована');
        if (!wallet) return alert('Подключите кошелёк');

        const owner = wallet.publicKey!;
        const userAta = await getAssociatedTokenAddress(REWARD_MINT, owner);

        try {
            await program.methods
                .claim()
                .accounts({
                    pool: POOL_PDA,
                    user: owner,
                    userOwner: owner,
                    mint: REWARD_MINT,
                    userToken: userAta,
                    mintAuthority: MINT_AUTHORITY_PDA,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .rpc();
            alert('Награды успешно выплачены');
        } catch (err: any) {
            console.error(err);
            alert(`Ошибка при claim: ${err.message}`);
        }
    };

    return (
        <div style={{ padding: 20 }}>
            <h2>Stake & Claim</h2>
            <div style={{ marginBottom: 16 }}>
                <label>Количество SOL:&nbsp;</label>
                <input
                    type="number"
                    step="0.01"
                    value={amountSOL}
                    onChange={(e) => setAmountSOL(e.target.value)}
                    style={{ width: 80 }}
                />
                &nbsp;
                {/* Показываем Init Pool только если подключён админ */}
                {wallet?.publicKey?.equals(ADMIN_PUBLIC_KEY) && (
                    <button onClick={handleInitPool} style={{ marginRight: 8 }}>
                        Init Pool
                    </button>
                )}
                <button onClick={handleStake} style={{ marginRight: 8 }}>
                    Stake
                </button>
                <button onClick={handleClaim}>
                    Claim
                </button>
            </div>
            {!wallet && <p>Пожалуйста, подключите кошелёк для работы.</p>}
        </div>
    );
};

export default StakeAndClaim;
