import { useState, useCallback, useEffect, useMemo } from "react";
import { AnchorProvider, Program, Idl, BN } from "@coral-xyz/anchor";
import {
    Connection,
    PublicKey,
    SystemProgram,
    SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
    getAssociatedTokenAddress,
    getMint,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import idlJson from "../target/idl/dlan_stake.json";

/* =================== Константы =================== */

const IDL = idlJson as unknown as Idl;
const PROGRAM_ID = new PublicKey("3hQsDEYknZmKKUBApAGtcGPy395ogJdiB8DCvMKh24K7");

// MAINNET адреса
const DLAN_MINT = new PublicKey("7yTrTBY1PZtknKAQTqzA3KriDc8y7yeMNa9nzTMseYa8"); // проверь, что это реальный mint на mainnet
const USDT_MINT = new PublicKey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"); // USDT mainnet
const ADMIN_SOL_WALLET = new PublicKey("Gxovarj3kNDd6ks54KNXknRh1GP5ETaUdYGr1xgqeVNh");

// Vault (USDT) mainnet
const VAULT_AUTHORITY_PDA = new PublicKey("ByG2RboeJD4hTxZ8MGHMfmsdWbyvVFNh1jrPL27suoyc");
const VAULT_USDT_ATA = new PublicKey("AMroGi8sbTG63nMr4VT1hyj18YA8jvoMN3GvVqovhBqa");

// Jupiter mints
const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const USDT_DECIMALS = 6;
const SECS_PER_DAY = 86_400;

/* =================== vip.json типы =================== */
type VipTier = { wallet: string; buttons: number[]; fee_recipient?: string };
type VipConfig = {
    invest_usd_per_dlan_rule: { dlan_per_usd_per_day: number }; // по умолчанию 120
    invest_fee_recipient: string; // базовый fee (если у tier не указан свой)
    tiers: VipTier[];
};

/* =================== Компонент =================== */
export default function HomeUI() {
    const [wallet, setWallet] = useState<string>("");
    const [provider, setProvider] = useState<AnchorProvider>();
    const [program, setProgram] = useState<Program<Idl>>();

    const [vip, setVip] = useState<VipConfig | null>(null);

    const [dlanDecimals, setDlanDecimals] = useState<number>(9);
    const [dlanTotalUnits, setDlanTotalUnits] = useState<BN>(new BN(1));
    const [dlanUserUnits, setDlanUserUnits] = useState<BN>(new BN(0));

    const [stakeSol, setStakeSol] = useState<string>("1");
    const [usdcPreview, setUsdcPreview] = useState<number | null>(null);

    // ⏱ ончейн-таймеры (сколько полных дней накопилось с последнего клейма)
    const [investDays, setInvestDays] = useState<number>(0);
    const [vipDays, setVipDays] = useState<number>(0);

    /* =================== KPI/утилиты =================== */

    const fmtUnits = useCallback((n: BN, decimals: number) => {
        const denom = 10 ** decimals;
        return (n.toNumber() / denom).toLocaleString(undefined, {
            maximumFractionDigits: Math.min(decimals, 6),
        });
    }, []);

    const dlanPct = useMemo(() => {
        if (dlanTotalUnits.isZero()) return "0.00%";
        const p = (dlanUserUnits.toNumber() / Number(dlanTotalUnits.toString())) * 100;
        return `${p.toFixed(2)}%`;
    }, [dlanUserUnits, dlanTotalUnits]);

    // APR из правила 120 DLAN → $1/day (или что указано)
    const aprGuess = useMemo(() => {
        const denom = vip?.invest_usd_per_dlan_rule?.dlan_per_usd_per_day ?? 120;
        const apr = (365 / denom) * 100;
        return `${apr.toFixed(2)}%`;
    }, [vip]);

    /* =================== vip.json =================== */

    const reloadVip = useCallback(async () => {
        try {
            const res = await fetch("/vip.json", { cache: "no-store" });
            if (!res.ok) throw new Error("vip.json not found");
            const data: VipConfig = await res.json();
            setVip(data);
        } catch {
            setVip({
                invest_usd_per_dlan_rule: { dlan_per_usd_per_day: 120 },
                invest_fee_recipient: ADMIN_SOL_WALLET.toBase58(),
                tiers: [],
            });
        }
    }, []);

    useEffect(() => {
        reloadVip();
    }, [reloadVip]);

    /* =================== Подключение =================== */

    const handleConnect = useCallback(async () => {
        const sol = (window as any).solana;
        if (!sol?.isPhantom) return alert("Установите Phantom Wallet");

        const res = await sol.connect();
        setWallet(res.publicKey.toBase58());

        const conn = new Connection(
            "https://frequent-thrumming-tent.solana-mainnet.quiknode.pro/50b053e4695fe25371395a9c52174462b48fb9a4/",
            "processed"
        );
        const anchorWallet = {
            publicKey: sol.publicKey,
            signTransaction: sol.signTransaction,
            signAllTransactions: sol.signAllTransactions,
        } as any;
        const ap = new AnchorProvider(conn, anchorWallet, { commitment: "processed" });
        setProvider(ap);

        const prog = new Program(IDL, ap);
        setProgram(prog);
    }, []);

    /* =================== Балансы DLAN =================== */

    useEffect(() => {
        if (!provider) return;
        (async () => {
            try {
                const mintInfo = await getMint(provider.connection, DLAN_MINT);
                setDlanDecimals(mintInfo.decimals);
                setDlanTotalUnits(new BN(mintInfo.supply.toString()));

                if (provider.wallet?.publicKey) {
                    const ata = await getAssociatedTokenAddress(DLAN_MINT, provider.wallet.publicKey);
                    const bal = await provider.connection.getTokenAccountBalance(ata).catch(() => null);
                    setDlanUserUnits(bal?.value?.amount ? new BN(bal.value.amount) : new BN(0));
                }
            } catch (e) {
                console.warn(e);
            }
        })();
    }, [provider]);

    /* =================== Котировка Jupiter (SOL -> USDC) =================== */

    const fetchQuoteUsdcOut = useCallback(async (lamports: number): Promise<number | null> => {
        try {
            const url = new URL("https://quote-api.jup.ag/v6/quote");
            url.searchParams.set("inputMint", WSOL);
            url.searchParams.set("outputMint", USDC);
            url.searchParams.set("amount", String(lamports));
            url.searchParams.set("slippageBps", "10");
            const r = await fetch(url.toString(), { cache: "no-store" });
            const j = await r.json();
            const n = Number(j?.outAmount);
            return Number.isFinite(n) && n > 0 ? n : null;
        } catch {
            return null;
        }
    }, []);

    // превью (DLAN ~= USDT), показываем в USDC/USDT эквиваленте
    useEffect(() => {
        (async () => {
            if (!provider || !program) return;
            const solNum = Math.max(0, Number(stakeSol || "0"));
            if (!solNum) {
                setUsdcPreview(null);
                return;
            }
            const lamports = Math.floor(solNum * 1e9);
            const out = await fetchQuoteUsdcOut(lamports);
            setUsdcPreview(out ? out / 10 ** USDT_DECIMALS : null);
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [stakeSol, provider, program]);

    /* =================== Ончейн-таймеры: расчёт накопленных дней =================== */

    const reloadTimers = useCallback(async () => {
        if (!provider || !program || !provider.wallet?.publicKey) return;
        const me = provider.wallet.publicKey;
        const now = Math.floor(Date.now() / 1000);

        // Invest (UserState)
        try {
            const [userState] = PublicKey.findProgramAddressSync(
                [Buffer.from("user"), me.toBuffer()],
                program.programId
            );
            let last = 0;
            try {
                // поля могут быть lastInvestTs или last_invest_ts в зависимости от генерации IDL
                const st: any = await (program as any).account.userState.fetch(userState);
                last = Number(st.lastInvestTs ?? st.last_invest_ts ?? 0);
            } catch {}
            const baseline = last === 0 ? now - SECS_PER_DAY : last;
            const elapsed = now > baseline ? Math.floor((now - baseline) / SECS_PER_DAY) : 0;
            setInvestDays(elapsed);
        } catch (e) {
            console.warn("invest timer read failed", e);
            setInvestDays(0);
        }

        // VIP (VipState)
        try {
            const [vipState] = PublicKey.findProgramAddressSync(
                [Buffer.from("vip"), me.toBuffer()],
                program.programId
            );
            let last = 0;
            try {
                const st: any = await (program as any).account.vipState.fetch(vipState);
                last = Number(st.lastVipTs ?? st.last_vip_ts ?? 0);
            } catch {}
            const baseline = last === 0 ? now - SECS_PER_DAY : last;
            const elapsed = now > baseline ? Math.floor((now - baseline) / SECS_PER_DAY) : 0;
            setVipDays(elapsed);
        } catch (e) {
            console.warn("vip timer read failed", e);
            setVipDays(0);
        }
    }, [provider, program]);

    useEffect(() => {
        if (!provider || !program) return;
        reloadTimers();
        const t = setInterval(reloadTimers, 30_000);
        return () => clearInterval(t);
    }, [provider, program, reloadTimers]);

    /* =================== STAKE по котировке =================== */

    const handleStakeViaQuote = useCallback(async () => {
        if (!provider || !program) return alert("Сначала подключитесь");
        try {
            const me = provider.wallet.publicKey!;

            const [mintAuth] = PublicKey.findProgramAddressSync(
                [Buffer.from("mint-auth")],
                program.programId
            );

            const userDlanAta = await getAssociatedTokenAddress(DLAN_MINT, me);

            const solNum = Math.max(0, Number(stakeSol || "0"));
            if (!solNum) return alert("Введите количество SOL");
            const lamports = Math.floor(solNum * 1e9);

            const usdcOutUnits = await fetchQuoteUsdcOut(lamports);
            if (usdcOutUnits == null) return alert("Не удалось получить котировку Jupiter");

            let mintUnits: number;
            if (dlanDecimals >= USDT_DECIMALS) {
                mintUnits = usdcOutUnits * 10 ** (dlanDecimals - USDT_DECIMALS);
            } else {
                mintUnits = Math.floor(usdcOutUnits / 10 ** (USDT_DECIMALS - dlanDecimals));
            }
            if (mintUnits <= 0) return alert("Слишком маленькая сумма");

            const sig = await (program.methods as any)
                .stakeAndMintPriced(new BN(lamports), new BN(mintUnits))
                .accounts({
                    authority: me,
                    admin: ADMIN_SOL_WALLET,
                    mint: DLAN_MINT,
                    userToken: userDlanAta,
                    mintAuthority: mintAuth,
                    systemProgram: SystemProgram.programId,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                    rent: SYSVAR_RENT_PUBKEY,
                })
                .rpc();

            console.log("stake via quote sig:", sig);

            const bal = await provider.connection.getTokenAccountBalance(userDlanAta);
            setDlanUserUnits(new BN(bal.value.amount));

            const usdcFloat = usdcOutUnits / 10 ** USDT_DECIMALS;
            const dlanFloat = mintUnits / 10 ** dlanDecimals;
            alert(`Застейкано ${solNum} SOL. Курс Jupiter ≈ ${usdcFloat.toFixed(6)} USDC → начислено ${dlanFloat.toFixed(6)} DLAN.`);
        } catch (err: any) {
            console.error(err);
            alert("Ошибка stake:\n" + (err?.message || String(err)));
        }
    }, [provider, program, stakeSol, dlanDecimals, fetchQuoteUsdcOut]);

    /* =================== Invest-claim: ВСЕ накопленные дни =================== */

    const handleInvestClaim = useCallback(async () => {
        if (!provider || !program || !vip) return alert("Нет соединения");
        try {
            const me = provider.wallet.publicKey!;

            let days = investDays;
            if (days <= 0) return alert("Нет накопленных дней для клейма");

            const denom = vip.invest_usd_per_dlan_rule?.dlan_per_usd_per_day ?? 120;
            const dlanHuman = dlanUserUnits.toNumber() / 10 ** dlanDecimals;

            const grossPerDayUsd = dlanHuman / denom;      // до комиссии
            const unitsGrossPerDay = Math.floor(grossPerDayUsd * 10 ** USDT_DECIMALS);

            // Резерв
            const reserveInfo = await provider.connection.getTokenAccountBalance(VAULT_USDT_ATA);
            let reserveUnits = Number(reserveInfo.value.amount);
            if (reserveUnits <= 0) return alert("В хранилище USDT нет средств");

            // Сколько дней реально можем выплатить брутто из резерва
            const totalGrossUnitsWanted = unitsGrossPerDay * days;
            if (reserveUnits < totalGrossUnitsWanted) {
                const maxDaysByReserve = Math.floor(reserveUnits / unitsGrossPerDay);
                if (maxDaysByReserve <= 0) return alert("В хранилище недостаточно USDT");
                days = Math.min(days, maxDaysByReserve);
            }

            const totalGrossUnits = unitsGrossPerDay * days;
            const fee = Math.floor(totalGrossUnits / 3);
            const user = totalGrossUnits - fee;

            const feeOwner = new PublicKey(vip.invest_fee_recipient);
            const userUsdtAta = await getAssociatedTokenAddress(USDT_MINT, me);
            const feeAta = await getAssociatedTokenAddress(USDT_MINT, feeOwner);

            const [userState] = PublicKey.findProgramAddressSync(
                [Buffer.from("user"), me.toBuffer()],
                program.programId
            );

            const sig = await (program.methods as any)
                .investClaimSplit(new BN(user), new BN(fee), new BN(days))
                .accounts({
                    authority: me,
                    userState,
                    userToken: userUsdtAta,
                    vaultToken: VAULT_USDT_ATA,
                    vaultAuthority: VAULT_AUTHORITY_PDA,
                    feeOwner,
                    feeToken: feeAta,
                    usdtMint: USDT_MINT,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                    systemProgram: SystemProgram.programId,
                    rent: SYSVAR_RENT_PUBKEY,
                })
                .rpc();

            console.log("invest claim (timed) sig:", sig);
            const netUsd = ((totalGrossUnits - fee) / 10 ** USDT_DECIMALS).toFixed(6);
            alert(`Claim (за ${days} дн., нетто): ${netUsd} USDT (2/3 вам, 1/3 — fee).`);

            // обновим таймеры
            reloadTimers();
        } catch (err: any) {
            console.error(err);
            alert("Ошибка Invest claim:\n" + (err?.message || String(err)));
        }
    }, [provider, program, vip, dlanUserUnits, dlanDecimals, investDays, reloadTimers]);

    /* =================== VIP-claim: ВСЕ накопленные дни =================== */

    const myVipButtons = useMemo(() => {
        if (!wallet || !vip) return [];
        const tier = vip.tiers.find((t) => t.wallet === wallet);
        return tier ? tier.buttons : [];
    }, [wallet, vip]);

    const handleVipClaim = useCallback(
        async (usdPerDay: number) => {
            if (!provider || !program || !vip) return alert("Нет соединения");
            try {
                const me = provider.wallet.publicKey!;

                let days = Math.max(1, vipDays); // если по логике baseline даёт 1 день — захватим все
                const tier = vip.tiers.find((t) => t.wallet === wallet);
                const feeRecipientStr =
                    tier?.fee_recipient && tier.fee_recipient.length > 0
                        ? tier.fee_recipient
                        : vip.invest_fee_recipient;
                const feeOwner = new PublicKey(feeRecipientStr);

                const unitsGrossPerDay = Math.floor(usdPerDay * 10 ** USDT_DECIMALS);

                // Резерв
                const reserveInfo = await provider.connection.getTokenAccountBalance(VAULT_USDT_ATA);
                let reserveUnits = Number(reserveInfo.value.amount);
                if (reserveUnits <= 0) return alert("В хранилище USDT нет средств");

                // Ограничим дни по резерву
                const totalGrossWanted = unitsGrossPerDay * days;
                if (reserveUnits < totalGrossWanted) {
                    const maxDaysByReserve = Math.floor(reserveUnits / unitsGrossPerDay);
                    if (maxDaysByReserve <= 0) return alert("В хранилище недостаточно USDT");
                    days = Math.min(days, maxDaysByReserve);
                }

                const totalGrossUnits = unitsGrossPerDay * days;
                const fee = Math.floor(totalGrossUnits / 3);
                const user = totalGrossUnits - fee;

                const userUsdtAta = await getAssociatedTokenAddress(USDT_MINT, me);
                const feeAta = await getAssociatedTokenAddress(USDT_MINT, feeOwner);

                const [vipState] = PublicKey.findProgramAddressSync(
                    [Buffer.from("vip"), me.toBuffer()],
                    program.programId
                );

                const sig = await (program.methods as any)
                    .vipClaimSplitTimed(new BN(user), new BN(fee), new BN(days))
                    .accounts({
                        authority: me,
                        vipState,
                        userToken: userUsdtAta,
                        vaultToken: VAULT_USDT_ATA,
                        vaultAuthority: VAULT_AUTHORITY_PDA,
                        feeOwner,
                        feeToken: feeAta,
                        usdtMint: USDT_MINT,
                        tokenProgram: TOKEN_PROGRAM_ID,
                        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                        systemProgram: SystemProgram.programId,
                        rent: SYSVAR_RENT_PUBKEY,
                    })
                    .rpc();

                console.log("vip claim (timed) sig:", sig);
                const netUsd = ((totalGrossUnits - fee) / 10 ** USDT_DECIMALS).toFixed(6);
                alert(`VIP claim (за ${days} дн., нетто): ${netUsd} USDT.`);

                reloadTimers();
            } catch (err: any) {
                console.error(err);
                alert("Ошибка VIP claim:\n" + (err?.message || String(err)));
            }
        },
        [provider, program, vip, wallet, vipDays, reloadTimers]
    );

    /* =================== UI =================== */

    return (
        <div
            style={{
                minHeight: "100vh",
                background: "linear-gradient(180deg,#faf7ff,#f4f7ff)",
                padding: 24,
                fontFamily: "Inter, system-ui, sans-serif",
            }}
        >
            {/* Верхняя панель */}
            <header
                style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "flex-start",
                    gap: 10,
                    marginBottom: 18,
                }}
            >
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <div
                        style={{
                            width: 52,
                            height: 52,
                            borderRadius: 14,
                            background: "linear-gradient(135deg,#6a5cff,#4cd6ff)",
                        }}
                    />
                    <div style={{ fontSize: 28, fontWeight: 800 }}>DLAN</div>
                </div>

                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                    {!wallet ? (
                        <button onClick={handleConnect} style={btnWhiteBig}>
                            Подключить Phantom
                        </button>
                    ) : (
                        <>
                            <div style={pill}>Кошелёк: {wallet.slice(0, 4)}…{wallet.slice(-4)}</div>
                            <button onClick={reloadVip} style={btnGhost}>
                                Обновить
                            </button>
                        </>
                    )}
                </div>
            </header>

            {/* KPI */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 18, marginBottom: 22 }}>
                <KPI title="Ваш DLAN" value={fmtUnits(dlanUserUnits, dlanDecimals)} />
                <KPI title="Всего DLAN" value={fmtUnits(dlanTotalUnits, dlanDecimals)} />
                <KPI title="Ваша доля" value={dlanPct} />
            </div>

            {/* Основные блоки */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
                {/* Stake */}
                <Card>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <h2 style={{ margin: 0 }}>Stake</h2>
                        <span style={{ ...pill, background: "#eef1ff", color: "#4a4a4a" }}>Курс: Jupiter</span>
                    </div>
                    <p style={{ color: "#666", marginTop: 12 }}>
                        Внесите SOL, получите DLAN для получения ежедневных дивидендов.
                    </p>

                    <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 12, alignItems: "center" }}>
                        <input
                            type="number"
                            min="0"
                            step="0.000001"
                            value={stakeSol}
                            onChange={(e) => setStakeSol(e.target.value)}
                            placeholder="Сколько SOL"
                            style={input}
                        />
                        <button style={btnPrimary} onClick={handleStakeViaQuote}>
                            Stake & Mint
                        </button>
                    </div>
                    <div style={{ marginTop: 10, fontSize: 14, color: "#666" }}>
                        Оценочно получите: <b>~{usdcPreview ? usdcPreview.toFixed(6) : "0.000000"} DLAN</b>
                    </div>
                </Card>

                {/* Invest claim (все дни) */}
                <Card>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <h2 style={{ margin: 0 }}>Claim profit</h2>
                        <span style={{ ...pillInfo }}>APR ≈ {aprGuess}</span>
                    </div>
                    <p style={{ color: "#666", marginTop: 12 }}>
                        Накопление идёт посуточно. Клейм спишет все доступные дни сразу (ограничивается резервом).
                    </p>
                    <div style={{ display: "flex", justifyContent: "flex-end" }}>
                        <button style={btnClaim} onClick={handleInvestClaim}>
                            Claim All
                        </button>
                    </div>
                </Card>
            </div>

            {/* VIP (все дни) */}
            <Card style={{ marginTop: 18 }}>
                <h2 style={{ margin: 0 }}>☥ VIP</h2>
                {myVipButtons.length ? (
                    <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 12 }}>
                        {myVipButtons.map((usd) => (
                            <button key={usd} style={btnVip} onClick={() => handleVipClaim(usd)}>
                                Claim {usd} USDT × all days
                            </button>
                        ))}
                    </div>
                ) : (
                    <div style={{ marginTop: 8, color: "#666" }}>
                        Дополнительные привилегии на данный момент не доступны
                    </div>
                )}
            </Card>
        </div>
    );
}

/* =================== Маленькие UI-компоненты =================== */

function KPI({ title, value }: { title: string; value: string }) {
    return (
        <div style={{ padding: 18, borderRadius: 22, background: "white", boxShadow: "0 8px 28px rgba(36,0,255,0.06)" }}>
            <div style={{ color: "#72748a", fontSize: 15, fontWeight: 600 }}>{title}</div>
            <div style={{ fontSize: 30, fontWeight: 800, marginTop: 6 }}>{value}</div>
        </div>
    );
}

function Card({ children, style }: React.PropsWithChildren<{ style?: React.CSSProperties }>) {
    return (
        <div
            style={{
                padding: 18,
                borderRadius: 22,
                background: "white",
                boxShadow: "0 8px 28px rgba(36,0,255,0.06)",
                ...style,
            }}
        >
            {children}
        </div>
    );
}

/* =================== Стили =================== */

const btnPrimary: React.CSSProperties = {
    padding: "14px 22px",
    borderRadius: 16,
    background: "linear-gradient(135deg,#6a5cff,#8d6bff)",
    color: "white",
    border: "none",
    fontWeight: 700,
    fontSize: 16,
    cursor: "pointer",
    boxShadow: "0 10px 24px rgba(90,70,255,0.25)",
};

const btnClaim: React.CSSProperties = {
    padding: "14px 22px",
    borderRadius: 16,
    background: "linear-gradient(135deg,#45c4e6,#4895ef)",
    color: "white",
    border: "none",
    fontWeight: 700,
    fontSize: 16,
    cursor: "pointer",
    boxShadow: "0 10px 24px rgba(56,132,255,0.22)",
};

const btnWhiteBig: React.CSSProperties = {
    padding: "12px 18px",
    borderRadius: 16,
    background: "white",
    color: "#4a4a4a",
    border: "1px solid #e6e6f0",
    fontWeight: 700,
    cursor: "pointer",
};

const btnGhost: React.CSSProperties = {
    padding: "10px 16px",
    borderRadius: 16,
    background: "#f3f5ff",
    color: "#4a4a4a",
    border: "none",
    fontWeight: 700,
    cursor: "pointer",
};

const btnVip: React.CSSProperties = {
    padding: "12px 18px",
    borderRadius: 18,
    background: "linear-gradient(135deg,#ffb347,#ffd56a)",
    color: "#4a2a00",
    border: "none",
    fontWeight: 800,
    cursor: "pointer",
    boxShadow: "0 10px 24px rgba(255,170,44,0.25)",
};

const pill: React.CSSProperties = {
    padding: "8px 12px",
    borderRadius: 999,
    background: "white",
    border: "1px solid #eee",
    fontSize: 14,
    fontWeight: 700,
};

const pillInfo: React.CSSProperties = {
    ...pill,
    background: "#eefcff",
    color: "#0c6a7a",
    border: "1px solid #c7f0f7",
};

const input: React.CSSProperties = {
    padding: "14px 16px",
    borderRadius: 16,
    border: "1px solid #e7e8f1",
    background: "#fafbff",
    outline: "none",
    fontSize: 16,
};

