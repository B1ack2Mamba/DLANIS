import { useState, useCallback, useEffect, useMemo } from "react";
import { AnchorProvider, Program, Idl, BN } from "@coral-xyz/anchor";
import {
  Connection,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  VersionedTransaction, // <-- используем версионированные транзакции
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

// MAINNET адреса (проверь mint DLAN)
const DLAN_MINT = new PublicKey("7yTrTBY1PZtknKAQTqzA3KriDc8y7yeMNa9nzTMseYa8");
// mainnet USDT
const USDT_MINT = new PublicKey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");
const ADMIN_SOL_WALLET = new PublicKey("Gxovarj3kNDd6ks54KNXknRh1GP5ETaUdYGr1xgqeVNh");

// Vault (USDT)
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
  invest_usd_per_dlan_rule: { dlan_per_usd_per_day: number };
  invest_fee_recipient: string;
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

  // сумма для свопа USDT → SOL
  const [stakeUsdt, setStakeUsdt] = useState<string>("100");

  // ⏱ накопленные дни
  const [investDays, setInvestDays] = useState<number>(0);
  const [vipDays, setVipDays] = useState<number>(0);

  // 💰 резерв USDT (юниты 1e6)
  const [reserveUnits, setReserveUnits] = useState<number>(0);

  // модалки
  const [showClaimModal, setShowClaimModal] = useState(false);
  const [showVipModal, setShowVipModal] = useState(false);
  const [showStakeModal, setShowStakeModal] = useState(false);

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

  // USDT/день с учётом комиссии 1/3
  const dlanHuman = useMemo(
    () => dlanUserUnits.toNumber() / 10 ** dlanDecimals,
    [dlanUserUnits, dlanDecimals]
  );
  const perDayGross = useMemo(() => (denom > 0 ? dlanHuman / denom : 0), [dlanHuman, denom]);
  const perDay = useMemo(() => perDayGross * (2 / 3), [perDayGross]);

  // APR (с учётом 1/3 комиссии)
  const aprWithFee = useMemo(() => {
    const grossApr = (365 / (denom || 120)) * 100;
    return `${(grossApr * (2 / 3)).toFixed(2)}%`;
  }, [denom]);

  // резерв → ограничение дней
  const unitsGrossPerDay = useMemo(
    () => Math.floor(perDayGross * 10 ** USDT_DECIMALS),
    [perDayGross]
  );

  const claimStats = useMemo(() => {
    const maxDays = unitsGrossPerDay > 0 ? Math.floor(reserveUnits / unitsGrossPerDay) : 0;
    const daysWithdrawable = Math.min(investDays, maxDays);
    return {
      perDayDisplay: perDay,
      accrued: perDay * investDays,
      withdrawable: perDay * daysWithdrawable,
      daysWithdrawable,
    };
  }, [perDay, investDays, unitsGrossPerDay, reserveUnits]);

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
      "https://lb.drpc.live/solana/AqUGUz8ODUJ3r-2BHSjcsn_P78zYt9wR8L7o_hXb38UN",
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

  /* =================== Jupiter quote/swap =================== */

  const fetchQuoteUsdcOut = useCallback(async (lamports: number): Promise<number | null> => {
    try {
      const url = new URL("https://public.jupiterapi.com/quote");
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

  // Надёжный quote с подробной ошибкой
  const fetchQuote = async (inputMint: string, outputMint: string, amountUnits: number | bigint) => {
    const amountStr = (typeof amountUnits === "bigint" ? amountUnits : BigInt(Math.floor(amountUnits))).toString();

    const url = new URL("https://public.jupiterapi.com/quote");
    url.searchParams.set("inputMint", inputMint);
    url.searchParams.set("outputMint", outputMint);
    url.searchParams.set("amount", amountStr);
    url.searchParams.set("slippageBps", "50");
    url.searchParams.set("swapMode", "ExactIn");
    url.searchParams.set("onlyDirectRoutes", "false");

    const r = await fetch(url.toString(), { headers: { accept: "application/json" }, cache: "no-store" });
    const text = await r.text();
    if (!r.ok) throw new Error(`Jupiter quote failed: ${r.status} ${text}`);
    return JSON.parse(text);
  };

  // Построение и отправка swap-транзакции (V0)
  const executeJupiterSwap = useCallback(
    async (quoteResponse: any) => {
      if (!provider?.wallet?.publicKey) throw new Error("Wallet not connected");
     const swapRes = await fetch("https://public.jupiterapi.com/swap", {
        method: "POST",
       headers: { "content-type": "application/json", "accept": "application/json" },
        body: JSON.stringify({
          quoteResponse,
          userPublicKey: provider.wallet.publicKey.toBase58(),
          wrapUnwrapSOL: true,
          asLegacyTransaction: false, // версионированная tx
        }),
      });
      const swapText = await swapRes.text();
      if (!swapRes.ok) throw new Error(`Jupiter swap failed: ${swapRes.status} ${swapText}`);

      const { swapTransaction } = JSON.parse(swapText);
      const raw = Buffer.from(swapTransaction, "base64");
      const vtx = VersionedTransaction.deserialize(raw);

      // Phantom умеет подписывать VersionedTransaction
      const signed = await (provider.wallet as any).signTransaction(vtx);
      const sig = await provider.connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
      });
      const conf = await provider.connection.confirmTransaction(sig, "confirmed");
      if (conf.value.err) throw new Error("Swap tx failed on chain");
      return sig;
    },
    [provider]
  );

  // превью DLAN по Jupiter (SOL→USDC≈DLAN)
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

  /* =================== Таймеры/резерв =================== */

  const reloadTimersAndReserve = useCallback(async () => {
    if (!provider || !program || !provider.wallet?.publicKey) return;
    const me = provider.wallet.publicKey;
    const now = Math.floor(Date.now() / 1000);

    // Invest
    try {
      const [userState] = PublicKey.findProgramAddressSync(
        [Buffer.from("user"), me.toBuffer()],
        (program as any).programId
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
        (program as any).programId
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

    // Reserve USDT
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

  /* =================== Stake: SOL → DLAN =================== */

  const handleStakeViaQuote = useCallback(async () => {
    if (!provider || !program) return alert("Сначала подключитесь");
    try {
      const me = provider.wallet.publicKey!;
      const [mintAuth] = PublicKey.findProgramAddressSync([Buffer.from("mint-auth")], (program as any).programId);
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

  /* =================== Swap: USDT → SOL =================== */

  const handleSwapUsdtToSol = useCallback(async () => {
    if (!provider?.wallet?.publicKey) return alert("Сначала подключитесь");

    try {
      const units = BigInt(Math.floor(Math.max(0, Number(stakeUsdt || "0")) * 10 ** USDT_DECIMALS));
      if (units <= 0n) return alert("Введите количество USDT");

      const quote = await fetchQuote(USDT_MINT.toBase58(), WSOL, units);
      if (!quote || !quote.routePlan || quote.routePlan.length === 0) {
        throw new Error("Маршрут не найден (попробуйте другой объём или позже)");
      }

      const sig = await executeJupiterSwap(quote);
      alert(`Swap USDT→SOL отправлен.\nTx: ${sig}`);
    } catch (e: any) {
      const msg = String(e?.message || e);
      if (msg.includes("TOKEN_NOT_TRADABLE") || msg.includes("not tradable")) {
        alert(
          "Jupiter вернул TOKEN_NOT_TRADABLE.\n" +
            "Проверь сеть Phantom (Mainnet) и что USDT mint — Es9vMFr... (mainnet). Затем сделай hard-refresh (Ctrl/Cmd+Shift+R)."
        );
        return;
      }
      console.error(e);
      alert("Ошибка swap USDT→SOL:\n" + msg);
    }
  }, [provider, stakeUsdt]);

  /* =================== Invest-claim: ВСЕ накопленные дни =================== */

  const handleInvestClaim = useCallback(async () => {
    if (!provider || !program || !vip) return alert("Нет соединения");
    try {
      const me = provider.wallet.publicKey!;

      let days = investDays;
      if (days <= 0) return alert("Нет накопленных дней для клейма");

      const unitsGrossPerDayLocal = Math.floor(perDayGross * 10 ** USDT_DECIMALS);

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

      const feeOwner = new PublicKey(vip.invest_fee_recipient);
      const userUsdtAta = await getAssociatedTokenAddress(USDT_MINT, me);
      const feeAta = await getAssociatedTokenAddress(USDT_MINT, feeOwner);

      const [userState] = PublicKey.findProgramAddressSync(
        [Buffer.from("user"), me.toBuffer()],
        (program as any).programId
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

  /* =================== VIP =================== */

  const myVipButtons = useMemo(() => {
    if (!wallet || !vip) return [];
    const tier = vip.tiers.find((t) => t.wallet === wallet);
    return tier ? tier.buttons : [];
  }, [wallet, vip]);

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
          (program as any).programId
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

      {/* Основная сетка — слева Stake, справа Claim */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
        {/* Stake (SOL) */}
        <Card>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h2 style={{ margin: 0 }}>Stake</h2>
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
            Оценочно получите: <b>~{usdcPreview ? usdcPreview.toFixed(6) : "0.000000"} DLAN</b> по курсу Solana в Jupiter
          </div>
          <div style={{ marginTop: 10 }}>
            <button onClick={() => setShowStakeModal(true)} style={pillSmallLink}>USDT-SOL Swap</button>
          </div>
        </Card>

        {/* Claim */}
        <Card>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h2 style={{ margin: 0 }}>Claim profit</h2>
            <span style={pillInfo}>APR ≈ {aprWithFee}</span>
          </div>
          <p style={{ color: "#666", marginTop: 12 }}>
            Вывод накопленной прибыли за все дни сразу.
          </p>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <button onClick={() => setShowClaimModal(true)} style={pillSmallLink}>Детали</button>
            <button style={btnClaim} onClick={handleInvestClaim}>Claim All</button>
          </div>
        </Card>
      </div>

      {/* VIP снизу */}
      <Card style={{ marginTop: 18 }}>
        <h2 style={{ margin: 0 }}>☥</h2>
        {myVipButtons.length ? (
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 12 }}>
            {myVipButtons.map((usd) => (
              <button key={usd} style={btnVip} onClick={() => handleVipClaim(usd)}>
                Claim {usd} USDT
              </button>
            ))}
          </div>
        ) : (
          <div style={{ marginTop: 8, color: "#666" }}>
            Дополнительные привилегии на данный момент не доступны
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
          <button onClick={() => setShowVipModal(true)} style={pillSmallLink}>Детали</button>
        </div>
      </Card>

      {/* =================== МОДАЛКИ =================== */}

      {/* Claim details — узкая колонка слева */}
      {showClaimModal && (
        <Modal onClose={() => setShowClaimModal(false)} title="Детали">
          <div style={{ maxWidth: 420 }}>
            <div style={{ padding: 12, borderRadius: 16, background: "#fafbff", border: "1px solid #e7e8f1" }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <MiniStat label="USDT/день" value={`${claimStats.perDayDisplay.toFixed(6)} USDT`} />
                <MiniStat label="Накоплено" value={`${claimStats.accrued.toFixed(6)} USDT`} />
              </div>
              <div style={{ marginTop: 8 }}>
                <MiniStat label="Доступно к выводу" value={`${claimStats.withdrawable.toFixed(6)} USDT`} />
                <div style={{ fontSize: 12, color: "#777", marginTop: 6 }}>
                  Дней накоплено: {investDays} | Дней доступно: {claimStats.daysWithdrawable}
                </div>
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
                <button
                  style={btnClaim}
                  onClick={() => { setShowClaimModal(false); handleInvestClaim(); }}
                >
                  Claim
                </button>
              </div>
            </div>
          </div>
        </Modal>
      )}

      {/* VIP details — тоже узкая */}
      {showVipModal && (
        <Modal onClose={() => setShowVipModal(false)} title="Детали">
          {myVipButtons.length ? (
            <div style={{ maxWidth: 420 }}>
              {myVipButtons.map((usd) => {
                const s = vipStats(usd);
                return (
                  <div key={usd} style={{ padding: 12, borderRadius: 16, background: "#fafbff", border: "1px solid #e7e8f1", marginBottom: 14 }}>
                    <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 8 }}>Пакет: {usd} USDT/день</div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                      <MiniStat label="USDT/день" value={`${s.perDayDisplay.toFixed(2)} USDT`} />
                      <MiniStat label="Накоплено" value={`${s.accrued.toFixed(2)} USDT`} />
                    </div>
                    <div style={{ marginTop: 8 }}>
                      <MiniStat label="Доступно к выводу" value={`${s.withdrawable.toFixed(2)} USDT`} />
                      <div style={{ fontSize: 12, color: "#777", marginTop: 6 }}>
                        Дней накоплено: {vipDays} | Дней доступно: {s.daysWithdrawable}
                      </div>
                    </div>
                    <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
                      <button style={btnVip} onClick={() => { setShowVipModal(false); handleVipClaim(usd); }}>
                        Claim
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div style={{ color: "#666" }}>Нет доступных возможностей</div>
          )}
        </Modal>
      )}

      {/* Stake options: только SWAP USDT→SOL */}
      {showStakeModal && (
        <Modal onClose={() => setShowStakeModal(false)} title="USDT-SOL Swap">
          <div style={{ maxWidth: 560 }}>
            <div style={{ padding: 12, borderRadius: 16, background: "#fafbff", border: "1px solid #e7e8f1" }}>
              <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 8 }}>Swap USDT → SOL (через Jupiter)</div>
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
                <button style={btnPrimary} onClick={() => { setShowStakeModal(false); handleSwapUsdtToSol(); }}>
                  Swap to SOL
                </button>
              </div>
              <div style={{ marginTop: 8, fontSize: 12, color: "#666" }}>
                Средства придут в виде SOL прямо на ваш кошелёк (wrap/unwrap SOL выполняется автоматически).
              </div>
            </div>
          </div>
        </Modal>
      )}
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

function Modal({
  title,
  children,
  onClose,
}: React.PropsWithChildren<{ title: string; onClose: () => void }>) {
  return (
    <div style={modalBackdrop} role="dialog" aria-modal="true">
      <div style={modalCard}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <div style={{ fontWeight: 900, fontSize: 18 }}>{title}</div>
          <button onClick={onClose} style={modalCloseBtn}>×</button>
        </div>
        <div>{children}</div>
      </div>
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

const pillSmallLink: React.CSSProperties = {
  ...pill,
  padding: "6px 10px",
  fontSize: 12,
  background: "#f3f5ff",
  color: "#333",
  border: "1px solid #e6e6f0",
  cursor: "pointer",
};

const input: React.CSSProperties = {
  padding: "14px 16px",
  borderRadius: 16,
  border: "1px solid #e7e8f1",
  background: "#fafbff",
  outline: "none",
  fontSize: 16,
};

/* modal styles */
const modalBackdrop: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.22)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 16,
  zIndex: 9999,
};

const modalCard: React.CSSProperties = {
  width: "min(920px, 96vw)",
  maxHeight: "80vh",
  overflowY: "auto",
  background: "white",
  borderRadius: 20,
  boxShadow: "0 24px 60px rgba(0,0,0,0.18)",
  padding: 16,
};

const modalCloseBtn: React.CSSProperties = {
  border: "none",
  background: "#f3f5ff",
  borderRadius: 999,
  width: 32,
  height: 32,
  fontSize: 18,
  cursor: "pointer",
};





