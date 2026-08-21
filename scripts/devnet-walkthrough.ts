/**
 * End-to-end devnet walkthrough for agent_registry.
 *
 * Proves the deployed program actually works on a real cluster by driving the
 * full builder journey and asserting on-chain state after every step:
 *
 *   initialize_config → register_builder → stake_bond → submit_listing → approve_listing
 *
 * Uses a throwaway SPL mint as a stand-in for $AGENT (which does not exist yet)
 * and a freshly generated builder keypair funded from your CLI wallet, so the
 * authority checks are exercised across two real parties rather than one.
 *
 * Run:  yarn devnet:walkthrough
 *
 * Safe to re-run: steps that already exist are detected and skipped.
 */
import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { AgentRegistry } from "../target/types/agent_registry";

const RPC = process.env.DEVNET_RPC ?? "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey("22rFHvivAX4hDwx3NdwfQ1hsyorwDFxc9JLy5WcZV7x6");

const UNIT = 1_000_000; // 6 decimals, matching the assumed $AGENT precision
const TIER_BONDS: [BN, BN, BN] = [
  new BN(25_000 * UNIT),
  new BN(100_000 * UNIT),
  new BN(400_000 * UNIT),
];
const TIER_CEILINGS: [BN, BN, BN] = [
  new BN(25_000 * UNIT),
  new BN(150_000 * UNIT),
  new BN(1_000_000 * UNIT),
];
/** Short on purpose so the unbonding flow is testable here. Production is 14 days. */
const DEVNET_UNBOND_PERIOD = 60;

const BUILDER_FUNDING = 0.05 * LAMPORTS_PER_SOL;
const GUARDIAN_FUNDING = 0.02 * LAMPORTS_PER_SOL;

/// Matches MIN_TIMELOCK_DELAY in a production build. Deliberately not shortened: the
/// whole point of running this on devnet rather than in the test suite is to exercise the
/// real floor, with the real binary, rather than the 2s one the `localnet` feature allows.
///
/// Which is why this script never waits it out. It queues, proves the delay actually
/// holds, and leaves the proposal pending — re-run after the ETA to complete it.
///
/// `WALKTHROUGH_TIMELOCK` lowers it for a local rehearsal, where the program is built with
/// the `localnet` feature and its floor is seconds rather than an hour. It has no effect
/// against a real deployment: the on-chain floor rejects anything below MIN_TIMELOCK_DELAY.
const DEVNET_TIMELOCK_DELAY = Number(process.env.WALKTHROUGH_TIMELOCK ?? 60 * 60);

const KIND = {
  transferAuthority: { variant: { transferAuthority: {} }, seed: 0 },
  setVaultAuthority: { variant: { setVaultAuthority: {} }, seed: 1 },
  updateTiers: { variant: { updateTiers: {} }, seed: 2 },
} as const;
/// Overridable so the script can be rehearsed against a local validator without the
/// devnet run's mint and builder — which do not exist there — being loaded over it.
const STATE_FILE =
  process.env.WALKTHROUGH_STATE ?? path.join(__dirname, ".devnet-walkthrough.json");

const seed = (s: string) => Buffer.from(s);
const step = (n: number, title: string) =>
  console.log(`\n\x1b[1m── ${n}. ${title}\x1b[0m`);
const ok = (msg: string) => console.log(`   \x1b[32m✓\x1b[0m ${msg}`);
const info = (msg: string) => console.log(`   \x1b[2m${msg}\x1b[0m`);
/** Assert a transaction fails with a specific Anchor error code. */
async function expectFail(promise: Promise<unknown>, code: string, label: string) {
  try {
    await promise;
    throw new Error(`${label}: expected ${code}, but it succeeded`);
  } catch (err: any) {
    const msg = err?.error?.errorCode?.code ?? err?.message ?? String(err);
    if (!String(msg).includes(code)) {
      throw new Error(`${label}: expected ${code}, got ${msg}`);
    }
    ok(`${label} → ${code}`);
  }
}

const link = (sig: string) =>
  info(`https://explorer.solana.com/tx/${sig}?cluster=devnet`);

function loadCliWallet(): Keypair {
  const p = path.join(os.homedir(), ".config", "solana", "id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

/** Persist generated keys so re-runs reuse the same builder and mint. */
function loadState(): {
  builder?: number[];
  mint?: string;
  guardian?: number[];
  vaultAuthority?: number[];
} {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}
function saveState(s: object) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

async function main() {
  const connection = new Connection(RPC, "confirmed");
  const authority = loadCliWallet(); // plays the multisig role on devnet
  const wallet = new anchor.Wallet(authority);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);

  const idl = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "target", "idl", "agent_registry.json"), "utf8")
  ) as AgentRegistry;
  const program = new Program<AgentRegistry>(idl, provider);

  const state = loadState();

  console.log("\x1b[1mAgent Circle — agent_registry devnet walkthrough\x1b[0m");
  info(`cluster:   ${RPC}`);
  info(`program:   ${PROGRAM_ID.toBase58()}`);
  info(`authority: ${authority.publicKey.toBase58()}`);

  const startBal = await connection.getBalance(authority.publicKey);
  info(`balance:   ${(startBal / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  if (startBal < 0.15 * LAMPORTS_PER_SOL) {
    throw new Error(
      "Need at least ~0.15 SOL. Run: solana airdrop 1 --url devnet"
    );
  }

  // ─────────────────────────────────────────────────────────────
  step(1, "Test mint (stand-in for $AGENT)");
  let mint: PublicKey;
  if (state.mint) {
    mint = new PublicKey(state.mint);
    ok(`reusing existing mint ${mint.toBase58()}`);
  } else {
    mint = await createMint(connection, authority, authority.publicKey, null, 6);
    state.mint = mint.toBase58();
    saveState(state);
    ok(`created mint ${mint.toBase58()} (6 decimals)`);
  }
  info("$AGENT does not exist yet — this is a throwaway devnet token.");

  // ─────────────────────────────────────────────────────────────
  step(2, "Builder keypair");
  let builderKp: Keypair;
  if (state.builder) {
    builderKp = Keypair.fromSecretKey(Uint8Array.from(state.builder));
    ok(`reusing builder ${builderKp.publicKey.toBase58()}`);
  } else {
    builderKp = Keypair.generate();
    state.builder = Array.from(builderKp.secretKey);
    saveState(state);
    ok(`generated builder ${builderKp.publicKey.toBase58()}`);
  }

  const builderBal = await connection.getBalance(builderKp.publicKey);
  if (builderBal < 0.01 * LAMPORTS_PER_SOL) {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: authority.publicKey,
        toPubkey: builderKp.publicKey,
        lamports: BUILDER_FUNDING,
      })
    );
    const sig = await sendAndConfirmTransaction(connection, tx, [authority]);
    ok(`funded builder with ${BUILDER_FUNDING / LAMPORTS_PER_SOL} SOL`);
    link(sig);
  } else {
    ok(`builder already funded (${(builderBal / LAMPORTS_PER_SOL).toFixed(4)} SOL)`);
  }

  // PDAs
  const [configPda] = PublicKey.findProgramAddressSync([seed("config")], PROGRAM_ID);
  const [builderPda] = PublicKey.findProgramAddressSync(
    [seed("builder"), builderKp.publicKey.toBuffer()],
    PROGRAM_ID
  );
  const [bondVaultPda] = PublicKey.findProgramAddressSync(
    [seed("bond"), builderPda.toBuffer()],
    PROGRAM_ID
  );
  const [governancePda] = PublicKey.findProgramAddressSync([seed("governance")], PROGRAM_ID);
  /// Seed is a byte computed from the action kind, which the IDL cannot express, so this
  /// account is passed explicitly at every call site rather than resolved by Anchor.
  const pendingPda = (seedByte: number) =>
    PublicKey.findProgramAddressSync(
      [seed("pending"), Buffer.from([seedByte])],
      PROGRAM_ID
    )[0];

  const listingPda = (index: number) =>
    PublicKey.findProgramAddressSync(
      [seed("agent"), builderPda.toBuffer(), Buffer.from(new Uint16Array([index]).buffer)],
      PROGRAM_ID
    )[0];

  // ─────────────────────────────────────────────────────────────
  step(3, "initialize_config  (multisig authority)");
  const existingConfig = await connection.getAccountInfo(configPda);
  if (existingConfig) {
    ok("config already initialised — skipping");
  } else {
    const sig = await program.methods
      .initializeConfig(
        authority.publicKey,
        TIER_BONDS,
        TIER_CEILINGS,
        new BN(DEVNET_UNBOND_PERIOD)
      )
      .accountsPartial({ agentMint: mint, payer: authority.publicKey })
      .rpc();
    ok("config created");
    link(sig);
  }
  const cfg = await program.account.config.fetch(configPda);
  info(`config PDA:     ${configPda.toBase58()}`);
  info(`authority:      ${cfg.authority.toBase58()}`);
  info(`tier 1 bond:    ${cfg.tierBonds[0].toNumber() / UNIT} tokens → $${cfg.tierCeilings[0].toNumber() / UNIT} AUM ceiling`);
  info(`unbond period:  ${cfg.unbondPeriod.toNumber()}s  (production: 1209600s / 14 days)`);
  info(`vault authority: ${cfg.vaultAuthority.toBase58()}  ← unset until agent_vault ships`);

  // ─────────────────────────────────────────────────────────────
  step(4, "register_builder  (builder signs)");
  const existingBuilder = await connection.getAccountInfo(builderPda);
  if (existingBuilder) {
    ok("builder already registered — skipping");
  } else {
    const sig = await program.methods
      .registerBuilder()
      .accountsPartial({ agentMint: mint, authority: builderKp.publicKey })
      .signers([builderKp])
      .rpc();
    ok("builder registered (Builder PDA + bond vault created)");
    link(sig);
  }
  let b = await program.account.builder.fetch(builderPda);
  info(`builder PDA: ${builderPda.toBase58()}`);
  info(`tier ${b.tier} · bond ${b.bondAmount.toNumber() / UNIT} · agents ${b.agentCount}`);
  if (b.tier !== 0 && b.bondAmount.toNumber() === 0) throw new Error("expected tier 0 at registration");

  // ─────────────────────────────────────────────────────────────
  step(5, "Fund the builder with test tokens");
  const builderAta = await getOrCreateAssociatedTokenAccount(
    connection,
    authority,
    mint,
    builderKp.publicKey
  );
  const bal = Number((await getAccount(connection, builderAta.address)).amount);
  if (bal < TIER_BONDS[0].toNumber()) {
    const sig = await mintTo(
      connection,
      authority,
      mint,
      builderAta.address,
      authority,
      TIER_BONDS[1].toNumber()
    );
    ok(`minted ${TIER_BONDS[1].toNumber() / UNIT} test tokens to the builder`);
    link(sig);
  } else {
    ok(`builder already holds ${bal / UNIT} tokens`);
  }

  // ─────────────────────────────────────────────────────────────
  step(6, "stake_bond  → expect promotion to tier 1");
  b = await program.account.builder.fetch(builderPda);
  if (b.tier >= 1) {
    ok(`already at tier ${b.tier} — skipping`);
  } else {
    const sig = await program.methods
      .stakeBond(TIER_BONDS[0])
      .accountsPartial({ authority: builderKp.publicKey, source: builderAta.address })
      .signers([builderKp])
      .rpc();
    ok(`staked ${TIER_BONDS[0].toNumber() / UNIT} tokens`);
    link(sig);
  }
  b = await program.account.builder.fetch(builderPda);
  const vaultBal = Number((await getAccount(connection, bondVaultPda)).amount);
  if (b.tier < 1) throw new Error(`expected tier >= 1, got ${b.tier}`);
  ok(`tier ${b.tier} · bond escrowed on-chain: ${vaultBal / UNIT} tokens`);
  info(`AUM ceiling unlocked: $${cfg.tierCeilings[b.tier - 1].toNumber() / UNIT}`);

  // ─────────────────────────────────────────────────────────────
  step(7, "submit_listing  → expect status Vetting, fees zeroed");
  const index = b.agentCount;
  const listing = listingPda(index);
  const existingListing = await connection.getAccountInfo(listing);
  const agentBot = Keypair.generate(); // the builder's off-platform bot signing key
  if (existingListing) {
    ok(`listing ${index} already exists — skipping`);
  } else {
    const metadataHash = Array.from(Buffer.alloc(32, 7)); // stand-in for the description hash
    const sig = await program.methods
      .submitListing(agentBot.publicKey, 0 /* market: Crypto */, metadataHash)
      .accountsPartial({ builder: builderPda, authority: builderKp.publicKey })
      .signers([builderKp])
      .rpc();
    ok("listing submitted for vetting");
    link(sig);
  }
  let l = await program.account.agentListing.fetch(listing);
  info(`listing PDA: ${listing.toBase58()}`);
  info(`status: ${Object.keys(l.status)[0]} · perf fee ${l.performanceFeeBps} bps (zeroed until approval)`);
  if (!("vetting" in l.status) && !("live" in l.status))
    throw new Error("unexpected listing status");

  // ─────────────────────────────────────────────────────────────
  step(8, "approve_listing  (multisig) → expect Live + locked launch fees");
  if ("live" in l.status) {
    ok("listing already live — skipping");
  } else {
    const sig = await program.methods
      .approveListing(null) // null → locked launch defaults
      .accountsPartial({ listing, authority: authority.publicKey })
      .rpc();
    ok("listing approved");
    link(sig);
  }
  l = await program.account.agentListing.fetch(listing);

  const expect = (label: string, actual: number, want: number) => {
    if (actual !== want) throw new Error(`${label}: expected ${want}, got ${actual}`);
    ok(`${label} = ${actual}`);
  };
  if (!("live" in l.status)) throw new Error("expected status Live");
  ok("status = Live");
  expect("listing fee bps", l.listingFeeBps, 0);
  expect("performance fee bps", l.performanceFeeBps, 1000);
  expect("builder split bps", l.builderSplitBps, 8000);
  expect("position cap bps", l.positionCapBps, 1200);
  expect("max drawdown bps", l.maxDrawdownBps, 1500);

  // ─────────────────────────────────────────────────────────────
  step(9, "initialize_governance  → guardian + timelock");
  let guardianKp: Keypair;
  if (state.guardian) {
    guardianKp = Keypair.fromSecretKey(Uint8Array.from(state.guardian));
    ok(`reusing guardian ${guardianKp.publicKey.toBase58()}`);
  } else {
    guardianKp = Keypair.generate();
    state.guardian = Array.from(guardianKp.secretKey);
    saveState(state);
    ok(`generated guardian ${guardianKp.publicKey.toBase58()}`);
  }

  if ((await connection.getBalance(guardianKp.publicKey)) < 0.005 * LAMPORTS_PER_SOL) {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: authority.publicKey,
        toPubkey: guardianKp.publicKey,
        lamports: GUARDIAN_FUNDING,
      })
    );
    link(await sendAndConfirmTransaction(connection, tx, [authority]));
    ok(`funded guardian with ${GUARDIAN_FUNDING / LAMPORTS_PER_SOL} SOL`);
  }

  if (await connection.getAccountInfo(governancePda)) {
    ok("governance already initialised — skipping");
  } else {
    const sig = await program.methods
      .initializeGovernance(guardianKp.publicKey, new BN(DEVNET_TIMELOCK_DELAY))
      .accountsPartial({ authority: authority.publicKey, payer: authority.publicKey })
      .rpc();
    ok("governance created");
    link(sig);
  }
  const gov = await program.account.governance.fetch(governancePda);
  info(`governance PDA: ${governancePda.toBase58()}`);
  info(`guardian:       ${gov.guardian.toBase58()}`);
  info(`timelock delay: ${gov.timelockDelay.toNumber()}s  (production default: 259200s / 72h)`);

  // ─────────────────────────────────────────────────────────────
  step(10, "guardian emergency stop  → immediate, and one-directional");
  l = await program.account.agentListing.fetch(listing);
  if (!("live" in l.status)) {
    await program.methods
      .resumeListing()
      .accountsPartial({ builder: builderPda, listing, signer: builderKp.publicKey })
      .signers([builderKp])
      .rpc();
    info("listing was paused; resumed first so the stop is observable");
  }

  const pauseSig = await program.methods
    .guardianPauseListing()
    .accountsPartial({ listing, guardian: guardianKp.publicKey })
    .signers([guardianKp])
    .rpc();
  l = await program.account.agentListing.fetch(listing);
  if (!("paused" in l.status)) throw new Error("expected status Paused");
  ok("guardian paused a live listing in one transaction, no delay");
  link(pauseSig);

  await expectFail(
    program.methods
      .resumeListing()
      .accountsPartial({ builder: builderPda, listing, signer: guardianKp.publicKey })
      .signers([guardianKp])
      .rpc(),
    "Unauthorized",
    "guardian cannot un-pause what it paused"
  );

  await program.methods
    .resumeListing()
    .accountsPartial({ builder: builderPda, listing, signer: builderKp.publicKey })
    .signers([builderKp])
    .rpc();
  ok("builder resumed it — restarting stays with the builder or the authority");

  // ─────────────────────────────────────────────────────────────
  step(11, "queue → veto  → a compromised multisig buys an announcement, not the registry");
  const transferPending = pendingPda(KIND.transferAuthority.seed);
  if (await connection.getAccountInfo(transferPending)) {
    info("a transfer proposal is already pending — vetoing it to reset");
    await program.methods
      .vetoChange(KIND.transferAuthority.variant)
      .accountsPartial({
        pending: transferPending,
        signer: guardianKp.publicKey,
        rentRefund: authority.publicKey,
      })
      .signers([guardianKp])
      .rpc();
  }

  const attacker = Keypair.generate();
  const queueSig = await program.methods
    .queueTransferAuthority(KIND.transferAuthority.variant, attacker.publicKey)
    .accountsPartial({
      pending: transferPending,
      authority: authority.publicKey,
      payer: authority.publicKey,
    })
    .rpc();
  ok(`queued a transfer to ${attacker.publicKey.toBase58()}`);
  link(queueSig);

  const cfgDuring = await program.account.config.fetch(configPda);
  if (!cfgDuring.authority.equals(authority.publicKey)) {
    throw new Error("queuing must not transfer authority");
  }
  ok("config.authority unchanged — nothing happened yet");

  await expectFail(
    program.methods
      .executeChange(KIND.transferAuthority.variant)
      .accountsPartial({
        pending: transferPending,
        signer: authority.publicKey,
        rentRefund: authority.publicKey,
      })
      .rpc(),
    "TimelockNotElapsed",
    "cannot execute inside the delay"
  );

  await expectFail(
    program.methods
      .executeChange(KIND.transferAuthority.variant)
      .accountsPartial({
        pending: transferPending,
        signer: guardianKp.publicKey,
        rentRefund: authority.publicKey,
      })
      .signers([guardianKp])
      .rpc(),
    "Unauthorized",
    "guardian cannot execute either"
  );

  const vetoSig = await program.methods
    .vetoChange(KIND.transferAuthority.variant)
    .accountsPartial({
      pending: transferPending,
      signer: guardianKp.publicKey,
      rentRefund: authority.publicKey,
    })
    .signers([guardianKp])
    .rpc();
  if (await connection.getAccountInfo(transferPending)) {
    throw new Error("vetoed proposal should be closed");
  }
  ok("guardian vetoed it — proposal gone, rent returned");
  link(vetoSig);

  // ─────────────────────────────────────────────────────────────
  step(12, "queue set_vault_authority  → resumable across runs");
  const cfgNow = await program.account.config.fetch(configPda);
  const vaultPending = pendingPda(KIND.setVaultAuthority.seed);
  const pendingInfo = await connection.getAccountInfo(vaultPending);

  if (!cfgNow.vaultAuthority.equals(PublicKey.default)) {
    ok(`vault authority already set to ${cfgNow.vaultAuthority.toBase58()}`);
  } else if (pendingInfo) {
    const p = await program.account.pendingChange.fetch(vaultPending);
    const now = Math.floor(Date.now() / 1000);
    const remaining = p.eta.toNumber() - now;

    if (remaining > 0) {
      ok(`proposal pending — ${Math.ceil(remaining / 60)} min remaining`);
      info(`target: ${p.newKey.toBase58()}`);
      info("re-run this script after the ETA to execute it");
    } else {
      const sig = await program.methods
        .executeChange(KIND.setVaultAuthority.variant)
        .accountsPartial({
          pending: vaultPending,
          signer: authority.publicKey,
          rentRefund: authority.publicKey,
        })
        .rpc();
      const after = await program.account.config.fetch(configPda);
      if (!after.vaultAuthority.equals(p.newKey)) {
        throw new Error("vault authority did not take effect");
      }
      ok(`timelock elapsed and executed — vault authority = ${after.vaultAuthority.toBase58()}`);
      link(sig);
    }
  } else {
    // A throwaway stand-in. agent_vault does not exist yet, so this is a placeholder
    // whose only job is to prove the timelocked path works end to end.
    let vaultAuthKp: Keypair;
    if (state.vaultAuthority) {
      vaultAuthKp = Keypair.fromSecretKey(Uint8Array.from(state.vaultAuthority));
    } else {
      vaultAuthKp = Keypair.generate();
      state.vaultAuthority = Array.from(vaultAuthKp.secretKey);
      saveState(state);
    }

    const sig = await program.methods
      .queueSetVaultAuthority(KIND.setVaultAuthority.variant, vaultAuthKp.publicKey)
      .accountsPartial({
        pending: vaultPending,
        authority: authority.publicKey,
        payer: authority.publicKey,
      })
      .rpc();
    const p = await program.account.pendingChange.fetch(vaultPending);
    ok(`queued — executable in ${Math.ceil(DEVNET_TIMELOCK_DELAY / 60)} min`);
    info(`target: ${vaultAuthKp.publicKey.toBase58()}`);
    info(`eta:    ${new Date(p.eta.toNumber() * 1000).toISOString()}`);
    info("re-run this script after the ETA to complete it");
    link(sig);
  }

  // ─────────────────────────────────────────────────────────────
  const endBal = await connection.getBalance(authority.publicKey);
  console.log("\n\x1b[1m── Summary\x1b[0m");
  ok("Full builder journey and governance defences verified on devnet");
  info(`config:     ${configPda.toBase58()}`);
  info(`governance: ${governancePda.toBase58()}`);
  info(`guardian:   ${guardianKp.publicKey.toBase58()}`);
  info(`builder:    ${builderPda.toBase58()}  (tier ${b.tier})`);
  info(`listing:    ${listing.toBase58()}  (Live)`);
  info(`bond:       ${vaultBal / UNIT} tokens escrowed`);

  const finalCfg = await program.account.config.fetch(configPda);
  info(
    `vault authority: ${
      finalCfg.vaultAuthority.equals(PublicKey.default)
        ? "unset — a timelocked proposal may still be pending, see step 12"
        : finalCfg.vaultAuthority.toBase58()
    }`
  );
  info(`SOL spent: ${((startBal - endBal) / LAMPORTS_PER_SOL).toFixed(5)}`);
  console.log(
    `\n\x1b[2mView the program: https://explorer.solana.com/address/${PROGRAM_ID.toBase58()}?cluster=devnet\x1b[0m\n`
  );
}

main().catch((e) => {
  console.error("\n\x1b[31m✗ Walkthrough failed\x1b[0m");
  console.error(e);
  process.exit(1);
});
