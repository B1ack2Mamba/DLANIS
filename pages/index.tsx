import { useState, useCallback, useEffect, useMemo } from "react";
import { AnchorProvider, Program, Idl, BN } from "@coral-xyz/anchor";
import {
  Connection,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  getMint,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createTransferInstruction,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import idlJson from "../target/idl/dlan_stake.json";

/* =================== Константы =================== */

const IDL = idlJson as unknown as Idl;
const PROGRAM_ID = new PublicKey("3hQsDEYknZmKKUBApAGtcGPy395ogJdiB8DCvMKh24K7");

// MAINNET адреса
const DLAN_MINT = new PublicKey("7yTrTBY1PZtknKAQTqzA3KriDc8y7yeMNa9nzTMseYa8"); // проверь реальный mint
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

  // Stake USDT
  const [stakeUsdt, setStakeUsdt] = useState<string>("100");

  // ⏱ накопленные дни по таймерам
  const [investDays, setInvestDays] = useState<number>(0);
  const [vipDays, setVipDays] = useState<number>(0);

  // 💰 резерв USDT (юниты = 1e6) — используем только в расчётах, не показываем
  const [reserveUnits, setReserveUnits] = useState<number>(0);

  /* =================== Утилиты/KPI =================== */

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

  const denom = vip?.invest_usd_per_dlan_rule?.dlan_per_usd_per_day ?? 120;

  // Текущий баланс пользователя → USDT/день (уже с учётом 1/3 комиссии, но без слова)
  const dlanHuman = useMemo(
    () => dlanUserUnits.toNumber() / 10 ** dlanDecimals,
    [dlanUserUnits, dlanDecimals]
  );
  const perDayGross = useMemo(() => (denom > 0 ? dlanHuman / denom : 0), [dlanHuman, denom]);
  const perDay = useMemo(() => perDayGross * (2 / 3), [perDayGross]); // показываем как "USDT/день"

  // APR уже с учётом 1/3 комиссии
  const aprWithFee = useMemo(() => {
    const grossApr = (365 / (denom || 120)) * 100;
    return `${(grossApr * (2 / 3)).toFixed(2)}%`;
  }, [denom]);

  // Invest-накопления
  const investAccrued = useMemo(() => perDay * investDays, [perDay, investDays]);

  // Сколько дней можно выплатить по резерву (внутренний расчёт)
  const unitsGrossPerDay = useMemo(
    () => Math.floor(perDayGross * 10 ** USDT_DECIMALS),
    [perDayGross]
  );
  const maxDaysByReserve = useMemo(() => {
    if (unitsGrossPerDay <= 0) return 0;
    return Math.floor(reserveUnits / unitsGrossPerDay);
  }, [reserveUnits, unitsGrossPerDay]);

  const investDaysWithdrawable = useMemo(
    () => Math.min(investDays, maxDaysByReserve),
    [investDays, maxDaysByReserve]
  );
  const investWithdrawable = useMemo(
    () => perDay * investDaysWithdrawable,
    [perDay, investDaysWithdrawable]
  );

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

  /* =================== Котировка Jupiter (SOL → USDC) =================== */

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

  /* =================== Ончейн-таймеры и резерв (резерв не показываем) =================== */

  const reloadTimersAndReserve = useCallback(async () => {
    if (!provider || !program || !provider.wallet?.publicKey) return;
    const me = provider.wallet.publicKey;
    const now = Math.floor(Date.now() / 1000);

    // Invest
    try {
      const [userState] = PublicKey.findProgramAddressSync(
        [Buffer.from("user"), me.toBuffer()],
        program.programId
      );
      let last = 0;
      try {
        const st: any = await (program as any).account.userState.fetch(userState);
        last = Number(st.lastInvestTs ?? st.last_invest_ts ?? 0);
      } catch {}
      const baseline = last === 0 ? now - SECS_PER_DAY : last;
      const elapsed = now > baseline ? Math.floor((now - baseline) / SECS_PER_DAY) : 0;
      setInvestDays(elapsed);
    } catch {
      setInvestDays(0);
    }

    // VIP
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
    } catch {
      setVipDays(0);
    }

    // Reserve USDT (внутренне)
    try {
      const reserveInfo = await provider.connection.getTokenAccountBalance(VAULT_USDT_ATA);
      setReserveUnits(Number(reserveInfo.value.amount) || 0);
    } catch {
      setReserveUnits(0);
    }
  }, [provider, program]);

  useEffect(() => {
    if (!provider || !program) return;
    reloadTimersAndReserve();
    const t = setInterval(reloadTimersAndReserve, 30_000);
    return () => clearInterval(t);
  }, [provider, program, reloadTimersAndReserve]);

  /* =================== STAKE: SOL → DLAN (через котировку) =================== */

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
          mintAuthority: [mintAuth][0],
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

  /* =================== STAKE: USDT → DLAN (прямой) =================== */

  const handleStakeUsdtMint = useCallback(async () => {
    if (!provider || !program) return alert("Сначала подключитесь");
    try {
      const me = provider.wallet.publicKey!;
      const usdtNum = Math.max(0, Number(stakeUsdt || "0"));
      if (!usdtNum) return alert("Введите количество USDT");
      const usdtUnits = Math.floor(usdtNum * 10 ** USDT_DECIMALS);

      // DLAN к минту (скейл по децималям)
      let mintUnits: number;
      if (dlanDecimals >= USDT_DECIMALS) {
        mintUnits = usdtUnits * 10 ** (dlanDecimals - USDT_DECIMALS);
      } else {
        mintUnits = Math.floor(usdtUnits / 10 ** (USDT_DECIMALS - dlanDecimals));
      }
      if (mintUnits <= 0) return alert("Слишком маленькая сумма");

      const userUsdtAta = await getAssociatedTokenAddress(USDT_MINT, me);
      const userDlanAta = await getAssociatedTokenAddress(DLAN_MINT, me);

      const userUsdtAtaInfo = await provider.connection.getAccountInfo(userUsdtAta);
      const ixs: any[] = [];

      // создать USDT-ATA, если её нет
      if (!userUsdtAtaInfo) {
        ixs.push(
          createAssociatedTokenAccountInstruction(
            me,           // payer
            userUsdtAta,  // ata
            me,           // owner
            USDT_MINT
          )
        );
      }

      // перевод USDT в хранилище
      ixs.push(
        createTransferInstruction(
          userUsdtAta,
          VAULT_USDT_ATA,
          me,
          usdtUnits
        )
      );

      // инструкция программы: mint DLAN (lamports = 0)
      const [mintAuth] = PublicKey.findProgramAddressSync([Buffer.from("mint-auth")], program.programId);
      const progIx = await (program.methods as any)
        .stakeAndMintPriced(new BN(0), new BN(mintUnits))
        .accounts({
          authority: me,
          admin: ADMIN_SOL_WALLET,
          mint: DLAN_MINT,
          userToken: userDlanAta,
          mintAuthority: [mintAuth][0],
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .instruction();

      ixs.push(progIx);

      const tx = new Transaction().add(...ixs);
      const sig = await provider.sendAndConfirm(tx, []);
      console.log("stake USDT & mint sig:", sig);

      const bal = await provider.connection.getTokenAccountBalance(userDlanAta);
      setDlanUserUnits(new BN(bal.value.amount));

      const dlanFloat = mintUnits / 10 ** dlanDecimals;
      alert(`Зачислено ${stakeUsdt} USDT в хранилище и начислено ${dlanFloat.toFixed(6)} DLAN.`);
    } catch (err: any) {
      console.error(err);
      alert("Ошибка Stake USDT:\n" + (err?.message || String(err)));
    }
  }, [provider, program, stakeUsdt, dlanDecimals]);

  /* =================== Invest-claim: ВСЕ накопленные дни =================== */

  const handleInvestClaim = useCallback(async () => {
    if (!provider || !program || !vip) return alert("Нет соединения");
    try {
      const me = provider.wallet.publicKey!;

      let days = investDays;
      if (days <= 0) return alert("Нет накопленных дней для клейма");

      const unitsGrossPerDayLocal = Math.floor(perDayGross * 10 ** USDT_DECIMALS);

      // Резерв (внутренне)
      const reserveInfo = await provider.connection.getTokenAccountBalance(VAULT_USDT_ATA);
      let reserveUnitsLocal = Number(reserveInfo.value.amount);
      if (reserveUnitsLocal <= 0) return alert("В хранилище USDT нет средств");

      // Ограничим дни по резерву
      const totalGrossWanted = unitsGrossPerDayLocal * days;
      if (reserveUnitsLocal < totalGrossWanted) {
        const maxDaysByReserveLocal = Math.floor(reserveUnitsLocal / unitsGrossPerDayLocal);
        if (maxDaysByReserveLocal <= 0) return alert("В хранилище недостаточно USDT");
        days = Math.min(days, maxDaysByReserveLocal);
      }

      const totalGrossUnits = unitsGrossPerDayLocal * days;
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
      const paid = ((totalGrossUnits - fee) / 10 ** USDT_DECIMALS).toFixed(6);
      alert(`Claim за ${days} дн.: ${paid} USDT.`);

      reloadTimersAndReserve();
    } catch (err: any) {
      console.error(err);
      alert("Ошибка Invest claim:\n" + (err?.message || String(err)));
    }
  }, [provider, program, vip, investDays, perDayGross, reloadTimersAndReserve]);

  /* =================== VIP-claim: ВСЕ накопленные дни =================== */

  const myVipButtons = useMemo(() => {
    if (!wallet || !vip) return [];
    const tier = vip.tiers.find((t) => t.wallet === wallet);
    return tier ? tier.buttons : [];
  }, [wallet, vip]);

  // хелпер для отображения по каждой VIP-кнопке
  const vipStats = useCallback(
    (usdPerDay: number) => {
      const perDayDisplay = usdPerDay * (2 / 3);
      const unitsGrossPerDayLocal = Math.floor(usdPerDay * 10 ** USDT_DECIMALS);
      const maxDays = unitsGrossPerDayLocal > 0 ? Math.floor(reserveUnits / unitsGrossPerDayLocal) : 0;
      const daysWithdrawable = Math.min(vipDays, maxDays);
      return {
        perDayDisplay,
        accrued: perDayDisplay * vipDays,
        withdrawable: perDayDisplay * daysWithdrawable,
        daysWithdrawable,
      };
    },
    [vipDays, reserveUnits]
  );

  const handleVipClaim = useCallback(
    async (usdPerDay: number) => {
      if (!provider || !program || !vip) return alert("Нет соединения");
      try {
        const me = provider.wallet.publicKey!;

        let days = Math.max(1, vipDays);

        const tier = vip.tiers.find((t) => t.wallet === wallet);
        const feeRecipientStr =
          tier?.fee_recipient && tier.fee_recipient.length > 0
            ? tier.fee_recipient
            : vip.invest_fee_recipient;
        const feeOwner = new PublicKey(feeRecipientStr);

        const unitsGrossPerDayLocal = Math.floor(usdPerDay * 10 ** USDT_DECIMALS);

        // Резерв (внутренне)
        const reserveInfo = await provider.connection.getTokenAccountBalance(VAULT_USDT_ATA);
        let reserveUnitsLocal = Number(reserveInfo.value.amount);
        if (reserveUnitsLocal <= 0) return alert("В хранилище USDT нет средств");

        const totalGrossWanted = unitsGrossPerDayLocal * days;
        if (reserveUnitsLocal < totalGrossWanted) {
          const maxDaysByReserveLocal = Math.floor(reserveUnitsLocal / unitsGrossPerDayLocal);
          if (maxDaysByReserveLocal <= 0) return alert("В хранилище недостаточно USDT");
          days = Math.min(days, maxDaysByReserveLocal);
        }

        const totalGrossUnits = unitsGrossPerDayLocal * days;
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
        const paid = ((totalGrossUnits - fee) / 10 ** USDT_DECIMALS).toFixed(6);
        alert(`VIP claim за ${days} дн.: ${paid} USDT.`);

        reloadTimersAndReserve();
      } catch (err: any) {
        console.error(err);
        alert("Ошибка VIP claim:\n" + (err?.message || String(err)));
      }
    },
    [provider, program, vip, wallet, vipDays, reloadTimersAndReserve]
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
              <button
                onClick={() => {
                  reloadVip();
                  reloadTimersAndReserve();
                }}
                style={btnGhost}
              >
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
        <KPI title="Ваша доля DLAN" value={dlanPct} />
      </div>

      {/* Основная симметричная сетка: слева оба стейка (вертикально), справа — клейм */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
        {/* Левая колонка: два Stake-а подряд */}
        <div style={{ display: "grid", gridAutoRows: "min-content", gap: 18 }}>
          {/* Stake SOL */}
          <Card>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h2 style={{ margin: 0 }}>Stake (SOL)</h2>
              <span style={{ ...pill, background: "#eef1ff", color: "#4a4a4a" }}>Курс: Jupiter</span>
            </div>
            <p style={{ color: "#666", marginTop: 12 }}>
              Внесите SOL, мы сконвертируем по Jupiter и начислим DLAN.
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

          {/* Stake USDT */}
          <Card>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h2 style={{ margin: 0 }}>Stake (USDT)</h2>
              <span style={{ ...pill, background: "#eefcff", color: "#0c6a7a", border: "1px solid #c7f0f7" }}>
                1 USDT → ~1 DLAN
              </span>
            </div>
            <p style={{ color: "#666", marginTop: 12 }}>
              Переводим USDT в хранилище и начисляем DLAN напрямую.
            </p>

            <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 12, alignItems: "center" }}>
              <input
                type="number"
                min="0"
                step="0.000001"
                value={stakeUsdt}
                onChange={(e) => setStakeUsdt(e.target.value)}
                placeholder="Сколько USDT"
                style={input}
              />
              <button style={btnPrimary} onClick={handleStakeUsdtMint}>
                Stake & Mint
              </button>
            </div>
          </Card>
        </div>

        {/* Правая колонка: Claim profit */}
        <Card>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h2 style={{ margin: 0 }}>Claim profit</h2>
            <span style={{ ...pillInfo }}>APR ≈ {aprWithFee}</span>
          </div>
          <p style={{ color: "#666", marginTop: 12 }}>
            Накопление идёт посуточно. Клейм спишет все доступные дни сразу.
          </p>

          {/* Дневной доход и накопления */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 8 }}>
            <MiniStat label="USDT/день" value={`${perDay.toFixed(6)} USDT`} />
            <MiniStat label="Накоплено" value={`${investAccrued.toFixed(6)} USDT`} />
          </div>

          {/* Доступно к выводу (без показа резерва) */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 12, marginTop: 8 }}>
            <MiniStat label="Доступно к выводу" value={`${investWithdrawable.toFixed(6)} USDT`} />
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
            <button style={btnClaim} onClick={handleInvestClaim}>
              Claim All
            </button>
          </div>
        </Card>
      </div>

      {/* Нижний ряд — VIP (все метрики на кнопках) */}
      <Card style={{ marginTop: 18 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ margin: 0 }}>☥</h2>
          <span style={{ ...pill, background: "#f8f5ff", border: "1px solid #e8ddff" }}>
            Дней накоплено: {vipDays}
          </span>
        </div>
        {myVipButtons.length ? (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}>
            {myVipButtons.map((usd) => {
              const s = vipStats(usd);
              return (
                <div key={usd} style={{ padding: 12, borderRadius: 16, background: "white", border: "1px solid #eef1ff" }}>
                  <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 8 }}>Пакет: {usd} USDT/день</div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    <MiniStat label="USDT/день" value={`${s.perDayDisplay.toFixed(2)} USDT`} />
                    <MiniStat label="Накоплено" value={`${s.accrued.toFixed(2)} USDT`} />
                  </div>
                  <div style={{ marginTop: 8 }}>
                    <MiniStat label="Доступно к выводу" value={`${s.withdrawable.toFixed(2)} USDT`} />
                  </div>
                  <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
                    <button style={btnVip} onClick={() => handleVipClaim(usd)}>
                      Claim 
                    </button>
                  </div>
                </div>
              );
            })}
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

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        padding: 12,
        borderRadius: 16,
        background: "#fafbff",
        border: "1px solid #e7e8f1",
      }}
    >
      <div style={{ fontSize: 12, color: "#74788d", fontWeight: 700 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 800, marginTop: 4 }}>{value}</div>
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
