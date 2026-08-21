import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { PublicKey, Keypair, LAMPORTS_PER_SOL, SystemProgram } from "@solana/web3.js";
import {
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { assert, expect } from "chai";
import { AgentRegistry } from "../target/types/agent_registry";

const CONFIG_SEED = Buffer.from("config");
const BUILDER_SEED = Buffer.from("builder");
const AGENT_SEED = Buffer.from("agent");
const BOND_SEED = Buffer.from("bond");
const GOVERNANCE_SEED = Buffer.from("governance");
const PENDING_SEED = Buffer.from("pending");

// $AGENT is assumed to have 6 decimals for these tests.
const UNIT = 1_000_000;
const TIER_BONDS: [BN, BN, BN] = [
  new BN(25_000 * UNIT),
  new BN(100_000 * UNIT),
  new BN(400_000 * UNIT),
];
// Quote-token base units (USDC, 6dp): $25k / $150k / $1M
const TIER_CEILINGS: [BN, BN, BN] = [
  new BN(25_000 * UNIT),
  new BN(150_000 * UNIT),
  new BN(1_000_000 * UNIT),
];

/// Short enough that the elapsed branch of `withdraw_bond` is reachable in a test.
const TEST_UNBOND_PERIOD = 2;

/// Matches MIN_TIMELOCK_DELAY under the `localnet` feature. A validator's clock cannot be
/// warped, so exercising a successful timelocked execution means really waiting.
const TEST_TIMELOCK_DELAY = 2;

/// Seed byte per ActionKind, mirroring `ActionKind::seed()` in state.rs.
const KIND = {
  transferAuthority: { variant: { transferAuthority: {} }, seed: 0 },
  setVaultAuthority: { variant: { setVaultAuthority: {} }, seed: 1 },
  updateTiers: { variant: { updateTiers: {} }, seed: 2 },
} as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Assert a transaction fails with a specific Anchor error code. */
async function expectError(promise: Promise<unknown>, code: string) {
  try {
    await promise;
    assert.fail(`expected to fail with ${code}, but it succeeded`);
  } catch (err: any) {
    const msg = err?.error?.errorCode?.code ?? err?.message ?? String(err);
    expect(msg).to.contain(code);
  }
}

describe("agent-registry", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.AgentRegistry as Program<AgentRegistry>;
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  // multisig stand-in
  const authority = Keypair.generate();
  const builderKp = Keypair.generate();
  const outsider = Keypair.generate();
  const vaultAuthority = Keypair.generate();
  const agentBot = Keypair.generate();
  const guardian = Keypair.generate();

  let agentMint: PublicKey;
  let configPda: PublicKey;
  let builderPda: PublicKey;
  let bondVaultPda: PublicKey;
  let builderAta: PublicKey;
  let traderCompensationAta: PublicKey;
  let buybackAta: PublicKey;
  let governancePda: PublicKey;

  /// Anchor cannot resolve this one itself: the seed is a byte computed from the action
  /// kind, which the IDL has no way to express. Passed explicitly at every call site.
  const pendingPda = (seedByte: number) =>
    PublicKey.findProgramAddressSync(
      [PENDING_SEED, Buffer.from([seedByte])],
      program.programId
    )[0];

  const listingPda = (builder: PublicKey, index: number) =>
    PublicKey.findProgramAddressSync(
      [AGENT_SEED, builder.toBuffer(), Buffer.from(new Uint16Array([index]).buffer)],
      program.programId
    )[0];

  before(async () => {
    for (const kp of [authority, builderKp, outsider, vaultAuthority, guardian]) {
      const sig = await connection.requestAirdrop(kp.publicKey, 5 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig);
    }

    agentMint = await createMint(connection, payer, payer.publicKey, null, 6);

    [configPda] = PublicKey.findProgramAddressSync([CONFIG_SEED], program.programId);
    [builderPda] = PublicKey.findProgramAddressSync(
      [BUILDER_SEED, builderKp.publicKey.toBuffer()],
      program.programId
    );
    [bondVaultPda] = PublicKey.findProgramAddressSync(
      [BOND_SEED, builderPda.toBuffer()],
      program.programId
    );
    [governancePda] = PublicKey.findProgramAddressSync([GOVERNANCE_SEED], program.programId);

    builderAta = await createAssociatedTokenAccount(
      connection, payer, agentMint, builderKp.publicKey
    );
    traderCompensationAta = await createAssociatedTokenAccount(
      connection, payer, agentMint, authority.publicKey
    );
    buybackAta = await createAssociatedTokenAccount(
      connection, payer, agentMint, outsider.publicKey
    );

    await mintTo(connection, payer, agentMint, builderAta, payer, 600_000 * UNIT);
  });

  // ─────────────────────────────── config ───────────────────────────────

  describe("config", () => {
    it("initialises with tiers and a governance authority", async () => {
      await program.methods
        .initializeConfig(authority.publicKey, TIER_BONDS, TIER_CEILINGS, new BN(TEST_UNBOND_PERIOD))
        .accounts({ agentMint, payer: payer.publicKey })
        .rpc();

      const cfg = await program.account.config.fetch(configPda);
      assert.equal(cfg.authority.toBase58(), authority.publicKey.toBase58());
      assert.equal(cfg.agentMint.toBase58(), agentMint.toBase58());
      assert.equal(cfg.vaultAuthority.toBase58(), PublicKey.default.toBase58());
      assert.equal(cfg.unbondPeriod.toNumber(), TEST_UNBOND_PERIOD);
      assert.equal(cfg.tierBonds[2].toString(), TIER_BONDS[2].toString());
    });

    it("initialises governance with a guardian", async () => {
      await program.methods
        .initializeGovernance(guardian.publicKey, new BN(TEST_TIMELOCK_DELAY))
        .accountsPartial({ authority: authority.publicKey, payer: payer.publicKey })
        .signers([authority, payer])
        .rpc();

      const g = await program.account.governance.fetch(governancePda);
      assert.equal(g.guardian.toBase58(), guardian.publicKey.toBase58());
      assert.equal(g.timelockDelay.toNumber(), TEST_TIMELOCK_DELAY);
    });

    it("refuses a guardian that is the authority itself", async () => {
      // The whole value of the veto key is that compromising the multisig does not also
      // compromise it. Governance is already initialised, so this also covers re-init.
      await expectError(
        program.methods
          .initializeGovernance(authority.publicKey, new BN(TEST_TIMELOCK_DELAY))
          .accountsPartial({ authority: authority.publicKey, payer: payer.publicKey })
          .signers([authority, payer])
          .rpc(),
        "already in use"
      );
    });

    it("rejects queued tier updates from a non-authority", async () => {
      await expectError(
        program.methods
          .queueUpdateTiers(KIND.updateTiers.variant, TIER_BONDS, TIER_CEILINGS)
          .accountsPartial({
            pending: pendingPda(KIND.updateTiers.seed),
            authority: outsider.publicKey,
            payer: outsider.publicKey,
          })
          .signers([outsider])
          .rpc(),
        "Unauthorized"
      );
    });

    it("rejects non-increasing tier bonds at queue time", async () => {
      const bad: [BN, BN, BN] = [new BN(100), new BN(50), new BN(200)];
      await expectError(
        program.methods
          .queueUpdateTiers(KIND.updateTiers.variant, bad, TIER_CEILINGS)
          .accountsPartial({
            pending: pendingPda(KIND.updateTiers.seed),
            authority: authority.publicKey,
            payer: payer.publicKey,
          })
          .signers([authority, payer])
          .rpc(),
        "TierBondsNotIncreasing"
      );
    });

    it("rejects an unbond period beyond the 90-day ceiling", async () => {
      await expectError(
        program.methods
          .setUnbondPeriod(new BN(91 * 24 * 60 * 60))
          .accounts({ authority: authority.publicKey })
          .signers([authority])
          .rpc(),
        "InvalidUnbondPeriod"
      );
    });
  });

  // ─────────────────────────────── bond ───────────────────────────────

  describe("builder and bond", () => {
    it("registers a builder at tier 0", async () => {
      await program.methods
        .registerBuilder()
        .accounts({ agentMint, authority: builderKp.publicKey })
        .signers([builderKp])
        .rpc();

      const b = await program.account.builder.fetch(builderPda);
      assert.equal(b.tier, 0);
      assert.equal(b.bondAmount.toNumber(), 0);
      assert.equal(b.totalAum.toNumber(), 0);
      assert.equal(b.agentCount, 0);
    });

    it("refuses to list without at least tier 1", async () => {
      await expectError(
        program.methods
          .submitListing(agentBot.publicKey, 0, Array(32).fill(1))
          .accounts({ authority: builderKp.publicKey })
          .signers([builderKp])
          .rpc(),
        "BondBelowTierOne"
      );
    });

    it("assigns tier 1 at exactly the tier-1 threshold", async () => {
      await program.methods
        .stakeBond(TIER_BONDS[0])
        .accounts({ authority: builderKp.publicKey, source: builderAta })
        .signers([builderKp])
        .rpc();

      const b = await program.account.builder.fetch(builderPda);
      assert.equal(b.tier, 1, "exact threshold should qualify");
      assert.equal(b.bondAmount.toString(), TIER_BONDS[0].toString());

      const vault = await getAccount(connection, bondVaultPda);
      assert.equal(vault.amount.toString(), TIER_BONDS[0].toString());
    });

    it("stays at tier 1 one base unit below tier 2", async () => {
      const topUp = TIER_BONDS[1].sub(TIER_BONDS[0]).sub(new BN(1));
      await program.methods
        .stakeBond(topUp)
        .accounts({ authority: builderKp.publicKey, source: builderAta })
        .signers([builderKp])
        .rpc();

      const b = await program.account.builder.fetch(builderPda);
      assert.equal(b.tier, 1, "one unit short must not promote");
    });

    it("promotes to tier 2 on the final base unit", async () => {
      await program.methods
        .stakeBond(new BN(1))
        .accounts({ authority: builderKp.publicKey, source: builderAta })
        .signers([builderKp])
        .rpc();

      const b = await program.account.builder.fetch(builderPda);
      assert.equal(b.tier, 2);
      assert.equal(b.bondAmount.toString(), TIER_BONDS[1].toString());
    });

    it("rejects a zero-amount stake", async () => {
      await expectError(
        program.methods
          .stakeBond(new BN(0))
          .accounts({ authority: builderKp.publicKey, source: builderAta })
          .signers([builderKp])
          .rpc(),
        "ZeroAmount"
      );
    });
  });

  // ─────────────────────────────── listings ───────────────────────────────

  describe("listings", () => {
    let listing0: PublicKey;

    it("submits a listing in the Vetting state with zeroed fees", async () => {
      listing0 = listingPda(builderPda, 0);
      await program.methods
        .submitListing(agentBot.publicKey, 0, Array(32).fill(7))
        .accounts({ authority: builderKp.publicKey })
        .signers([builderKp])
        .rpc();

      const l = await program.account.agentListing.fetch(listing0);
      assert.deepEqual(l.status, { vetting: {} });
      assert.equal(l.agentAuthority.toBase58(), agentBot.publicKey.toBase58());
      assert.equal(l.performanceFeeBps, 0, "fees must not exist before approval");
      assert.equal(l.aumCurrent.toNumber(), 0);

      const b = await program.account.builder.fetch(builderPda);
      assert.equal(b.agentCount, 1);
    });

    it("refuses approval from a non-authority", async () => {
      await expectError(
        program.methods
          .approveListing(null)
          .accountsPartial({ listing: listing0, authority: outsider.publicKey })
          .signers([outsider])
          .rpc(),
        "Unauthorized"
      );
    });

    it("rejects a fee config breaching the guardrails", async () => {
      await expectError(
        program.methods
          .approveListing({
            listingFeeBps: 0,
            performanceFeeBps: 5000, // 50% — above the 20% cap
            builderSplitBps: 8000,
            positionCapBps: 1200,
            maxDrawdownBps: 1500,
            autoPause: true,
          })
          .accountsPartial({ listing: listing0, authority: authority.publicKey })
          .signers([authority])
          .rpc(),
        "PerformanceFeeTooHigh"
      );
    });

    it("rejects a builder split below the 50% floor", async () => {
      await expectError(
        program.methods
          .approveListing({
            listingFeeBps: 0,
            performanceFeeBps: 1000,
            builderSplitBps: 3000,
            positionCapBps: 1200,
            maxDrawdownBps: 1500,
            autoPause: true,
          })
          .accountsPartial({ listing: listing0, authority: authority.publicKey })
          .signers([authority])
          .rpc(),
        "BuilderSplitTooLow"
      );
    });

    it("approves with the locked launch defaults when passed null", async () => {
      await program.methods
        .approveListing(null)
        .accountsPartial({ listing: listing0, authority: authority.publicKey })
        .signers([authority])
        .rpc();

      const l = await program.account.agentListing.fetch(listing0);
      assert.deepEqual(l.status, { live: {} });
      assert.equal(l.listingFeeBps, 0, "listing fee is 0 bps at launch");
      assert.equal(l.performanceFeeBps, 1000, "10% performance fee");
      assert.equal(l.builderSplitBps, 8000, "80/20 split");
      assert.equal(l.positionCapBps, 1200);
      assert.equal(l.maxDrawdownBps, 1500);
      assert.isTrue(l.autoPause);
      assert.isAbove(l.approvedAt.toNumber(), 0);
    });

    it("cannot approve twice", async () => {
      await expectError(
        program.methods
          .approveListing(null)
          .accountsPartial({ listing: listing0, authority: authority.publicKey })
          .signers([authority])
          .rpc(),
        "ListingNotVetting"
      );
    });

    it("lets the builder pause and resume", async () => {
      await program.methods
        .pauseListing()
        .accountsPartial({ builder: builderPda, listing: listing0, signer: builderKp.publicKey })
        .signers([builderKp])
        .rpc();
      assert.deepEqual((await program.account.agentListing.fetch(listing0)).status, { paused: {} });

      await program.methods
        .resumeListing()
        .accountsPartial({ builder: builderPda, listing: listing0, signer: builderKp.publicKey })
        .signers([builderKp])
        .rpc();
      assert.deepEqual((await program.account.agentListing.fetch(listing0)).status, { live: {} });
    });

    it("refuses lifecycle changes from an unrelated signer", async () => {
      await expectError(
        program.methods
          .pauseListing()
          .accountsPartial({ builder: builderPda, listing: listing0, signer: outsider.publicKey })
          .signers([outsider])
          .rpc(),
        "Unauthorized"
      );
    });

    it("rotates the agent authority after a key compromise", async () => {
      const newBot = Keypair.generate();
      await program.methods
        .rotateAgentAuthority(newBot.publicKey)
        .accountsPartial({ listing: listing0, authority: builderKp.publicKey })
        .signers([builderKp])
        .rpc();

      const l = await program.account.agentListing.fetch(listing0);
      assert.equal(l.agentAuthority.toBase58(), newBot.publicKey.toBase58());

      // restore for later tests
      await program.methods
        .rotateAgentAuthority(agentBot.publicKey)
        .accountsPartial({ listing: listing0, authority: builderKp.publicKey })
        .signers([builderKp])
        .rpc();
    });

    it("refuses rotation by anyone but the owning builder", async () => {
      await expectError(
        program.methods
          .rotateAgentAuthority(outsider.publicKey)
          .accountsPartial({ listing: listing0, authority: outsider.publicKey })
          .signers([outsider])
          .rpc(),
        "AccountNotInitialized"
      );
    });
  });

  // ─────────────────────────────── AUM ───────────────────────────────

  describe("AUM reporting", () => {
    let listing0: PublicKey;
    before(() => {
      listing0 = listingPda(builderPda, 0);
    });

    it("refuses AUM reports while no vault authority is configured", async () => {
      await expectError(
        program.methods
          .recordDeposit(new BN(1000 * UNIT), true)
          .accountsPartial({
            builder: builderPda,
            listing: listing0,
            vaultAuthority: vaultAuthority.publicKey,
          })
          .signers([vaultAuthority])
          .rpc(),
        "VaultAuthorityUnset"
      );
    });

    it("registers the vault authority, but only after the timelock", async () => {
      await program.methods
        .queueSetVaultAuthority(KIND.setVaultAuthority.variant, vaultAuthority.publicKey)
        .accountsPartial({
          pending: pendingPda(KIND.setVaultAuthority.seed),
          authority: authority.publicKey,
          payer: payer.publicKey,
        })
        .signers([authority, payer])
        .rpc();

      // Naming the program that reports AUM is the same shape of lever as the one that
      // drained Drift: point it at a hostile program and it mints ceiling headroom from
      // nothing. It must not take effect in the transaction that proposes it.
      let cfg = await program.account.config.fetch(configPda);
      assert.equal(cfg.vaultAuthority.toBase58(), PublicKey.default.toBase58());

      await expectError(
        program.methods
          .executeChange(KIND.setVaultAuthority.variant)
          .accountsPartial({
            pending: pendingPda(KIND.setVaultAuthority.seed),
            signer: authority.publicKey,
            rentRefund: payer.publicKey,
          })
          .signers([authority])
          .rpc(),
        "TimelockNotElapsed"
      );

      await sleep((TEST_TIMELOCK_DELAY + 1) * 1000);

      await program.methods
        .executeChange(KIND.setVaultAuthority.variant)
        .accountsPartial({
          pending: pendingPda(KIND.setVaultAuthority.seed),
          signer: authority.publicKey,
          rentRefund: payer.publicKey,
        })
        .signers([authority])
        .rpc();

      cfg = await program.account.config.fetch(configPda);
      assert.equal(cfg.vaultAuthority.toBase58(), vaultAuthority.publicKey.toBase58());
    });

    it("refuses AUM reports from an impostor", async () => {
      await expectError(
        program.methods
          .recordDeposit(new BN(1000 * UNIT), true)
          .accountsPartial({
            builder: builderPda,
            listing: listing0,
            vaultAuthority: outsider.publicKey,
          })
          .signers([outsider])
          .rpc(),
        "NotVaultAuthority"
      );
    });

    it("accepts a deposit within the tier ceiling", async () => {
      await program.methods
        .recordDeposit(new BN(100_000 * UNIT), true)
        .accountsPartial({
          builder: builderPda,
          listing: listing0,
          vaultAuthority: vaultAuthority.publicKey,
        })
        .signers([vaultAuthority])
        .rpc();

      const b = await program.account.builder.fetch(builderPda);
      const l = await program.account.agentListing.fetch(listing0);
      assert.equal(b.totalAum.toNumber(), 100_000 * UNIT);
      assert.equal(l.aumCurrent.toNumber(), 100_000 * UNIT);
      assert.equal(l.vaultCount, 1);
    });

    it("enforces the tier ceiling across the builder, not per listing", async () => {
      // Tier 2 ceiling is $150k; $100k is already deployed on listing 0.
      // A second listing must not be able to take another full ceiling.
      await program.methods
        .submitListing(agentBot.publicKey, 1, Array(32).fill(9))
        .accounts({ authority: builderKp.publicKey })
        .signers([builderKp])
        .rpc();

      const listing1 = listingPda(builderPda, 1);
      await program.methods
        .approveListing(null)
        .accountsPartial({ listing: listing1, authority: authority.publicKey })
        .signers([authority])
        .rpc();

      await expectError(
        program.methods
          .recordDeposit(new BN(60_000 * UNIT), true) // 100k + 60k > 150k
          .accountsPartial({
            builder: builderPda,
            listing: listing1,
            vaultAuthority: vaultAuthority.publicKey,
          })
          .signers([vaultAuthority])
          .rpc(),
        "AumCeilingExceeded"
      );
    });

    it("blocks deposits into a paused listing", async () => {
      await program.methods
        .pauseListing()
        .accountsPartial({ builder: builderPda, listing: listing0, signer: builderKp.publicKey })
        .signers([builderKp])
        .rpc();

      await expectError(
        program.methods
          .recordDeposit(new BN(1 * UNIT), false)
          .accountsPartial({
            builder: builderPda,
            listing: listing0,
            vaultAuthority: vaultAuthority.publicKey,
          })
          .signers([vaultAuthority])
          .rpc(),
        "ListingNotLive"
      );
    });

    it("still allows withdrawal from a paused listing", async () => {
      await program.methods
        .recordWithdrawal(new BN(40_000 * UNIT), false)
        .accountsPartial({
          builder: builderPda,
          listing: listing0,
          vaultAuthority: vaultAuthority.publicKey,
        })
        .signers([vaultAuthority])
        .rpc();

      const b = await program.account.builder.fetch(builderPda);
      assert.equal(b.totalAum.toNumber(), 60_000 * UNIT, "traders must always be able to exit");

      await program.methods
        .resumeListing()
        .accountsPartial({ builder: builderPda, listing: listing0, signer: builderKp.publicKey })
        .signers([builderKp])
        .rpc();
    });

    it("refuses to delist while capital is still deployed", async () => {
      await expectError(
        program.methods
          .delist()
          .accountsPartial({ builder: builderPda, listing: listing0, signer: builderKp.publicKey })
          .signers([builderKp])
          .rpc(),
        "ListingHasAum"
      );
    });
  });

  // ─────────────────────────────── unbonding ───────────────────────────────

  describe("unbonding", () => {
    it("refuses withdrawal with no request in flight", async () => {
      await expectError(
        program.methods
          .withdrawBond(new BN(1 * UNIT))
          .accountsPartial({ authority: builderKp.publicKey, destination: builderAta })
          .signers([builderKp])
          .rpc(),
        "UnbondNotRequested"
      );
    });

    it("starts the clock and blocks new listings while unbonding", async () => {
      await program.methods
        .requestUnbond()
        .accounts({ authority: builderKp.publicKey })
        .signers([builderKp])
        .rpc();

      const b = await program.account.builder.fetch(builderPda);
      assert.isAbove(b.unbondRequestedAt.toNumber(), 0);

      await expectError(
        program.methods
          .submitListing(agentBot.publicKey, 2, Array(32).fill(3))
          .accounts({ authority: builderKp.publicKey })
          .signers([builderKp])
          .rpc(),
        "BuilderUnbonding"
      );
    });

    it("blocks new trader capital while unbonding", async () => {
      await expectError(
        program.methods
          .recordDeposit(new BN(1 * UNIT), false)
          .accountsPartial({
            builder: builderPda,
            listing: listingPda(builderPda, 0),
            vaultAuthority: vaultAuthority.publicKey,
          })
          .signers([vaultAuthority])
          .rpc(),
        "BuilderUnbonding"
      );
    });

    it("refuses withdrawal before the period elapses", async () => {
      await expectError(
        program.methods
          .withdrawBond(new BN(1 * UNIT))
          .accountsPartial({ authority: builderKp.publicKey, destination: builderAta })
          .signers([builderKp])
          .rpc(),
        "UnbondPeriodNotElapsed"
      );
    });

    it("refuses a withdrawal that would stop covering deployed capital", async () => {
      await sleep((TEST_UNBOND_PERIOD + 1) * 1000);

      // $60k AUM still deployed needs tier 2 ($150k ceiling). Dropping to tier 1
      // ($25k ceiling) must be refused even though the clock has expired.
      const toTier1 = TIER_BONDS[1].sub(TIER_BONDS[0]);
      await expectError(
        program.methods
          .withdrawBond(toTier1)
          .accountsPartial({ authority: builderKp.publicKey, destination: builderAta })
          .signers([builderKp])
          .rpc(),
        "TierWouldNotCoverAum"
      );
    });

    it("allows the same withdrawal once traders have exited", async () => {
      // Traders exit down to $20k, which tier 1's $25k ceiling covers.
      await program.methods
        .recordWithdrawal(new BN(40_000 * UNIT), true)
        .accountsPartial({
          builder: builderPda,
          listing: listingPda(builderPda, 0),
          vaultAuthority: vaultAuthority.publicKey,
        })
        .signers([vaultAuthority])
        .rpc();

      const before = (await getAccount(connection, builderAta)).amount;
      const toTier1 = TIER_BONDS[1].sub(TIER_BONDS[0]);

      await program.methods
        .withdrawBond(toTier1)
        .accountsPartial({ authority: builderKp.publicKey, destination: builderAta })
        .signers([builderKp])
        .rpc();

      const b = await program.account.builder.fetch(builderPda);
      const after = (await getAccount(connection, builderAta)).amount;
      assert.equal((after - before).toString(), toTier1.toString());
      assert.equal(b.tier, 1);
      assert.equal(b.bondAmount.toString(), TIER_BONDS[0].toString());
      assert.equal(
        b.unbondRequestedAt.toNumber(),
        0,
        "withdrawal consumes the request — no permanently open window"
      );
    });

    it("can cancel an unbond request", async () => {
      await program.methods
        .requestUnbond()
        .accounts({ authority: builderKp.publicKey })
        .signers([builderKp])
        .rpc();
      await program.methods
        .cancelUnbond()
        .accounts({ authority: builderKp.publicKey })
        .signers([builderKp])
        .rpc();

      const b = await program.account.builder.fetch(builderPda);
      assert.equal(b.unbondRequestedAt.toNumber(), 0);
    });
  });

  // ─────────────────────────────── slashing ───────────────────────────────

  describe("slashing", () => {
    it("refuses a slash from a non-authority", async () => {
      await expectError(
        program.methods
          .slashBond(new BN(1000 * UNIT), Array(32).fill(0))
          .accountsPartial({
            builder: builderPda,
            traderCompensation: traderCompensationAta,
            buyback: buybackAta,
            authority: outsider.publicKey,
          })
          .signers([outsider])
          .rpc(),
        "Unauthorized"
      );
    });

    it("splits a slash 70/30 between harmed traders and the buyback pool", async () => {
      const amount = new BN(10_000 * UNIT);
      const bondBefore = (await program.account.builder.fetch(builderPda)).bondAmount;

      await program.methods
        .slashBond(amount, Array(32).fill(42))
        .accountsPartial({
          builder: builderPda,
          traderCompensation: traderCompensationAta,
          buyback: buybackAta,
          authority: authority.publicKey,
        })
        .signers([authority])
        .rpc();

      const traders = await getAccount(connection, traderCompensationAta);
      const buyback = await getAccount(connection, buybackAta);
      assert.equal(traders.amount.toString(), String(7_000 * UNIT), "70% to harmed traders");
      assert.equal(buyback.amount.toString(), String(3_000 * UNIT), "30% to buyback");

      const b = await program.account.builder.fetch(builderPda);
      assert.equal(b.bondAmount.toString(), bondBefore.sub(amount).toString());
      assert.equal(b.slashCount, 1);
    });

    it("refuses to slash more than the remaining bond", async () => {
      await expectError(
        program.methods
          .slashBond(new BN(10_000_000 * UNIT), Array(32).fill(0))
          .accountsPartial({
            builder: builderPda,
            traderCompensation: traderCompensationAta,
            buyback: buybackAta,
            authority: authority.publicKey,
          })
          .signers([authority])
          .rpc(),
        "InsufficientBond"
      );
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Governance: the Drift lesson, encoded.
  //
  // Drift lost $285M in April 2026 with no bug involved — months of social
  // engineering ended in admin control. These tests assert that holding the
  // multisig is not, on its own, enough to take the registry.
  // ────────────────────────────────────────────────────────────────────────
  describe("governance", () => {
    const queueTransfer = (to: PublicKey) =>
      program.methods
        .queueTransferAuthority(KIND.transferAuthority.variant, to)
        .accountsPartial({
          pending: pendingPda(KIND.transferAuthority.seed),
          authority: authority.publicKey,
          payer: payer.publicKey,
        })
        .signers([authority, payer])
        .rpc();

    // `listing0` is scoped to the listings suite; the same PDA, derived locally.
    const liveListing = () => listingPda(builderPda, 0);

    const resolve = (method: "executeChange" | "vetoChange", signer: Keypair) =>
      program.methods[method](KIND.transferAuthority.variant)
        .accountsPartial({
          pending: pendingPda(KIND.transferAuthority.seed),
          signer: signer.publicKey,
          rentRefund: payer.publicKey,
        })
        .signers([signer])
        .rpc();

    it("a compromised authority cannot seize the registry in one transaction", async () => {
      const attacker = Keypair.generate();
      await queueTransfer(attacker.publicKey);

      const cfg = await program.account.config.fetch(configPda);
      assert.equal(
        cfg.authority.toBase58(),
        authority.publicKey.toBase58(),
        "queuing must not transfer anything"
      );

      await expectError(resolve("executeChange", authority), "TimelockNotElapsed");
    });

    it("the guardian can veto during the delay", async () => {
      await resolve("vetoChange", guardian);

      // The pending account is closed by the veto, so nothing is left to execute.
      const info = await connection.getAccountInfo(
        PublicKey.findProgramAddressSync(
          [PENDING_SEED, Buffer.from([KIND.transferAuthority.seed])],
          program.programId
        )[0]
      );
      assert.isNull(info, "vetoed proposal must be gone");
    });

    it("the guardian can never propose anything", async () => {
      await expectError(
        program.methods
          .queueTransferAuthority(KIND.transferAuthority.variant, guardian.publicKey)
          .accountsPartial({
            pending: pendingPda(KIND.transferAuthority.seed),
            authority: guardian.publicKey,
            payer: guardian.publicKey,
          })
          .signers([guardian])
          .rpc(),
        "Unauthorized"
      );
    });

    it("the guardian can never execute, even after the delay", async () => {
      await queueTransfer(outsider.publicKey);
      await sleep((TEST_TIMELOCK_DELAY + 1) * 1000);

      await expectError(resolve("executeChange", guardian), "Unauthorized");
      await resolve("vetoChange", guardian); // clean up
    });

    it("an outsider can neither execute nor veto", async () => {
      await queueTransfer(outsider.publicKey);

      await expectError(resolve("executeChange", outsider), "Unauthorized");
      await expectError(resolve("vetoChange", outsider), "NotGuardianOrAuthority");
      await resolve("vetoChange", authority); // authority may cancel its own proposal
    });

    it("a second proposal of the same kind cannot silently displace the first", async () => {
      await queueTransfer(outsider.publicKey);
      await expectError(queueTransfer(agentBot.publicKey), "already in use");
      await resolve("vetoChange", guardian);
    });

    it("executes once the delay has genuinely elapsed", async () => {
      const successor = Keypair.generate();
      await queueTransfer(successor.publicKey);
      await sleep((TEST_TIMELOCK_DELAY + 1) * 1000);
      await resolve("executeChange", authority);

      const cfg = await program.account.config.fetch(configPda);
      assert.equal(cfg.authority.toBase58(), successor.publicKey.toBase58());

      // Hand it back so the remaining suites keep working.
      await program.methods
        .queueTransferAuthority(KIND.transferAuthority.variant, authority.publicKey)
        .accountsPartial({
          pending: pendingPda(KIND.transferAuthority.seed),
          authority: successor.publicKey,
          payer: payer.publicKey,
        })
        .signers([successor, payer])
        .rpc();
      await sleep((TEST_TIMELOCK_DELAY + 1) * 1000);
      await program.methods
        .executeChange(KIND.transferAuthority.variant)
        .accountsPartial({
          pending: pendingPda(KIND.transferAuthority.seed),
          signer: successor.publicKey,
          rentRefund: payer.publicKey,
        })
        .signers([successor])
        .rpc();

      const restored = await program.account.config.fetch(configPda);
      assert.equal(restored.authority.toBase58(), authority.publicKey.toBase58());
    });

    it("the timelock delay can be raised but never lowered", async () => {
      // Lowering would let a compromised authority shrink the guardian's window to
      // nothing and then help itself, which would defeat the entire mechanism.
      await expectError(
        program.methods
          .setTimelockDelay(new BN(TEST_TIMELOCK_DELAY))
          .accountsPartial({ authority: authority.publicKey })
          .signers([authority])
          .rpc(),
        "InvalidTimelockDelay"
      );

      await program.methods
        .setTimelockDelay(new BN(TEST_TIMELOCK_DELAY + 1))
        .accountsPartial({ authority: authority.publicKey })
        .signers([authority])
        .rpc();

      const g = await program.account.governance.fetch(governancePda);
      assert.equal(g.timelockDelay.toNumber(), TEST_TIMELOCK_DELAY + 1);
    });

    it("the guardian can stop a live agent instantly, with no delay", async () => {
      // Spec §11.3 item 4: emergency response must always be faster than emergency
      // damage. Waiting out a timelock to stop an agent that is actively losing other
      // people's money would be absurd, so pausing is immediate and unilateral.
      let l = await program.account.agentListing.fetch(liveListing());
      if (!("live" in l.status)) {
        await program.methods
          .resumeListing()
          .accountsPartial({ builder: builderPda, listing: liveListing(), signer: builderKp.publicKey })
          .signers([builderKp])
          .rpc();
      }

      await program.methods
        .guardianPauseListing()
        .accountsPartial({ listing: liveListing(), guardian: guardian.publicKey })
        .signers([guardian])
        .rpc();

      l = await program.account.agentListing.fetch(liveListing());
      assert.ok("paused" in l.status, "guardian pause takes effect in the same transaction");
    });

    it("the guardian cannot un-pause what it paused", async () => {
      // One-directional on purpose. An emergency key that could also restart an agent
      // would be a key that can put capital back at risk; this one may only reduce
      // exposure. Resuming stays with the builder or the authority.
      await expectError(
        program.methods
          .resumeListing()
          .accountsPartial({ builder: builderPda, listing: liveListing(), signer: guardian.publicKey })
          .signers([guardian])
          .rpc(),
        "Unauthorized"
      );

      await program.methods
        .resumeListing()
        .accountsPartial({ builder: builderPda, listing: liveListing(), signer: builderKp.publicKey })
        .signers([builderKp])
        .rpc();
    });

    it("an impostor cannot use the guardian's emergency stop", async () => {
      await expectError(
        program.methods
          .guardianPauseListing()
          .accountsPartial({ listing: liveListing(), guardian: outsider.publicKey })
          .signers([outsider])
          .rpc(),
        "NotGuardian"
      );
    });

    it("only the authority may rotate the guardian", async () => {
      await expectError(
        program.methods
          .setGuardian(outsider.publicKey)
          .accountsPartial({ authority: guardian.publicKey })
          .signers([guardian])
          .rpc(),
        "Unauthorized"
      );
    });
  });
});
