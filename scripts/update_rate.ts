/**
 * scripts/update_rate.ts
 * Обновляет on-chain курс DLAN_per_SOL из CoinGecko.
 * Запуск:
 *   ADMIN_SECRET='[...из id.json...]' ts-node scripts/update_rate.ts
 */

import fetch from "node-fetch";
import { Connection, Keypair, PublicKey, clusterApiUrl } from "@solana/web3.js";
import { AnchorProvider, Idl, Program, BN } from "@coral-xyz/anchor";
import idl from "../my-dapp/target/idl/dlan_stake.json";

// Если хотите жёстко задать ProgramID, можно оставить, но он нам не нужен
// при 2-аргументном конструкторе.
// const PROGRAM_ID = new PublicKey("3hQsDEYknZmKKUBApAGtcGPy395ogJdiB8DCvMKh24K7");

// Кол-во знаков у DLAN (поставьте ваши реальные decimals)
const DLAN_DECIMALS = 9;

async function main() {
    // 1) Цена SOL (USD) из CoinGecko
    const res = await fetch(
        "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
        { headers: { "x-cg-pro-api-key": process.env.COINGECKO_KEY ?? "" } }
    );
    const json = await res.json();
    const price = Number(json?.solana?.usd);
    if (!Number.isFinite(price)) {
        throw new Error("Не удалось получить цену SOL от CoinGecko");
    }

    // 2) Курс: минимальные единицы DLAN за 1 SOL
    const scaled = Math.floor(price * 10 ** DLAN_DECIMALS);
    console.log("SOL price (USD):", price, "→ dlan_per_sol_scaled:", scaled);

    // 3) Провайдер/программа под админ-ключом
    const conn = new Connection(clusterApiUrl("devnet"), "confirmed");
    const admin = Keypair.fromSecretKey(
        Uint8Array.from(JSON.parse(process.env.ADMIN_SECRET!))
    );

    // минимальная реализация AnchorWallet
    const wallet = {
        publicKey: admin.publicKey,
        signAllTransactions: async (txs: any[]) => {
            txs.forEach((t) => t.partialSign(admin));
            return txs;
        },
        signTransaction: async (tx: any) => {
            tx.partialSign(admin);
            return tx;
        },
    } as any;

    const provider = new AnchorProvider(conn, wallet, { commitment: "confirmed" });

    // ВАЖНО: двухаргументная сигнатура (idl, provider)
    const program = new Program(idl as unknown as Idl, provider);

    // 4) PDA конфига — используем program.programId
    const [configPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("config")],
        program.programId
    );

    // 5) Если конфиг не создан — раскомментируйте один раз:
    // const sigInit = await program.methods
    //   .initConfig(new BN(scaled))
    //   .accounts({
    //     admin: admin.publicKey,
    //     config: configPda,
    //     systemProgram: PublicKey.default, // или SystemProgram.programId
    //   })
    //   .rpc();
    // console.log("init_config tx:", sigInit);

    // 6) Обновляем курс
    const sig = await program.methods
        .setRate(new BN(scaled))
        .accounts({
            admin: admin.publicKey,
            config: configPda,
        })
        .rpc();

    console.log("set_rate tx:", sig);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
