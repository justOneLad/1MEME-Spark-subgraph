# 1MEME-Spark-subgraph

A subgraph indexing both active [1MEME Spark](https://github.com/justOneLad/1MEME-Spark)
deployments on BNB Smart Chain (chain ID `56`) — SparkV2 and SparkV1 — per
[Deployment.md](https://github.com/justOneLad/1MEME-Spark/blob/main/Deployment.md).

## What it indexes

### SparkV2

Fixed data sources (the active, non-deprecated contracts from `Deployment.md`):

| Contract | Address | Start block |
|---|---|---|
| `SparkLauncherV2` | `0xcD5B9F286cd5A2cE2fBe160bAfc018a1159d5c77` | 113277608 |
| `SparkLocker` | `0x01245e814bbc3A1DC3b24924FB0E4E3b6863105B` | 113277603 |
| `SparkHookV4` | `0x8baB0D3049B6d5D17B36d3263786Fe587A9D00C4` | 113278869 |
| `SparkHookInfinity` | `0xad220d84F318Ca4941D07af5AF244f081Cb849A8` | 113278027 |
| `SparkBurner` | `0x34480Bcd62D0bed99E2782cCAaF90c31A7fB475E` | 113278035 |

**Buy/sell activity** is captured via `callHandlers` on `SparkHookV4.afterSwap` /
`SparkHookInfinity.afterSwap`, not from an event — neither hook emits one per swap. This works
because the hook address is baked into the pool's identity (part of the poolId), so Uniswap v4 /
PancakeSwap Infinity invoke it on *every* swap against that pool with no way to bypass it — unlike
scraping the shared, chain-wide `PoolManager`/`CLPoolManager` `Swap` event (which fires for every
pool on the whole DEX, not just Spark's), this is naturally scoped to just these two contracts.
The `delta` argument passed into `afterSwap` is unpacked as a Uniswap v4 `BalanceDelta`
(`int128 amount0 << 128 | uint128 amount1`, verified against
[Uniswap/v4-core](https://github.com/Uniswap/v4-core/blob/main/src/types/BalanceDelta.sol) and
matching the hook's own decode logic) to get the signed BNB/token deltas, and poolId is recomputed
by re-encoding the call's raw `key` argument with `ethereum.encode` + `keccak256` — the same
`keccak256(abi.encode(poolKey))` scheme `SparkLauncherV2`/the hooks use on-chain (see
[Uniswap/v4-core](https://github.com/Uniswap/v4-core/blob/main/src/types/PoolId.sol) and
[pancakeswap/infinity-core](https://github.com/pancakeswap/infinity-core/blob/main/src/types/PoolId.sol)),
so it matches `Pool.id` exactly. **Call handlers need a trace-capable RPC** (Parity-style
`trace_filter`/`trace_block`) — supported by The Graph Studio and most archive nodes, but not by
every lightweight/public RPC endpoint; confirm your target indexer supports it before deploying.

Plus a `SparkToken` template: every `TokenLaunched` event dynamically spawns a new data source at
the launched token's clone address, so each meme token's own `Transfer`/ownership/metadata events
are indexed too.

The deprecated/abandoned contracts listed in `Deployment.md` (the first-attempt `SparkHookV4`,
`SparkToken` impl, `SparkLocker`, and `SparkLauncherV2`, plus the one-time `HookV4Factory` helper)
are intentionally **not** indexed.

### SparkV1

Deployed *after* SparkV2, specifically to fix a tradability gap: SparkV2's Uniswap v4 /
PancakeSwap Infinity pools use a custom hook and a `fee: 0` pool key that neither DEX's frontend
discovers or routes through by default, and most trading bots don't support hooked v4/Infinity
pools at all. SparkV1 (`spark/SparkLauncher.sol`) seeds liquidity into plain Uniswap V3 /
PancakeSwap V3 pools instead, using the standard fee-tier system, so pools are found and routable
everywhere V3 already works. It also supports multiple quote tokens (WBNB plus USDT/USDC/USD1),
each with its own `marketCapRef`, instead of SparkV2's single BNB-only `marketCapRef`.

| Contract | Address | Start block |
|---|---|---|
| `SparkLauncher` | `0x1Bfc2A7d68A115B29906537D9E836A1799ebd3C4` | 113379808 |
| `SparkLocker` (separate instance from SparkV2's) | `0xA69B4B4003483E7Ca27DDf1bE8cBC7e723afcF86` | 113379804 |

`SparkLocker` and the `SparkToken` implementation are the same, byte-identical contracts already
indexed for SparkV2 (verified via BscScan's bytecode-match auto-detection per `Deployment.md`) —
SparkV1 just deploys its own separate instances of each, since `SparkLocker.launcher` is a single
mutable address and a shared locker would have retired one launcher's ability to register new
positions. Because SparkV1's data model genuinely differs from SparkV2's (no hook, a plain V3 pool instead
of a hook-computed `poolId`, multiple quote tokens instead of one), it gets its own parallel set
of entities (`LauncherV1`, `DexV1`, `QuoteToken`, `TokenV1`, `TokenHolderV1`, `TokenTransferV1`,
`LockerPositionV1`, `LockerFeeClaimV1`, `PoolV1`, `SwapV1`) plus `SparkTokenV1` and `SparkV1Pool`
templates, rather than reusing the SparkV2 entities above — see the schema comments in
`schema.graphql` for the full reasoning. `CTOApplication` is shared across both versions (and
both SparkV2 hooks) since it was already built to be source-polymorphic.

**Swap tracking works differently for V1.** SparkV2 captures buy/sell activity via a call handler
on the hook's own `afterSwap` (see below), which works because the hook is baked into the pool's
identity. SparkV1 pools have no hook — they're plain Uniswap V3 / PancakeSwap V3 pools, whose
`Swap` event fires for every pool on the whole DEX, not just Spark's. Instead, a `SparkV1Pool`
template is instantiated at each token's specific pool address (emitted directly in
`TokenLaunched`), so it only ever indexes that one pool's `Swap` events — the same technique
Uniswap's own subgraph uses for per-pool tracking. Because SparkV1 supports multiple quote tokens
(WBNB/USDT/USDC/USD1), `PoolV1`/`SwapV1` use `quoteAmount`/`totalVolumeQuote` rather than
"native", and that volume is **not** folded into the global `SparkStats.totalVolumeNative` (which
would incorrectly sum BNB-wei amounts together with stablecoin amounts) — see the schema comment
on `SparkStats` for details. `SparkStats.totalSwaps`/`totalBuys`/`totalSells` (pure counts) do
include V1 activity.

Two earlier abandoned SparkV1 broadcast attempts (`0x35E7...`, `0xaBF5...`, plus their paired
lockers/token impls) are listed "Do not use" in `Deployment.md` and are **not** indexed, same as
SparkV2's deprecated set.

### OneCoinLocker (unrelated to Spark)

Also included, at the user's request: `OneCoinLocker` (`0x6C6e9740753d9F6C1E5D61C8bc0f34E37590f6C5`,
BSC, `startBlock: 100627321`) — a general-purpose token/LP locker that has nothing to do with
1MEME Spark. Its ABI, entities (`Locker`, `Lock`, `LockWithdrawal`, `LockTransfer`,
`LockActivity`) and mapping (`src/onecoin-locker.ts`) are ported from
[timedbase/OneMEMELaunchpad-Subgraph](https://github.com/timedbase/OneMEMELaunchpad-Subgraph),
which uses this same contract as a standalone locking utility outside its own launch flow. It's a
fully independent data source — no entity here links to any `Token`/`Pool`/`Launcher` above.

## Entities

### SparkV2

- `Launcher`, `Dex` — launcher config and registered DEXes (Uniswap v4 / PancakeSwap Infinity)
- `Token` — one per launched meme token, with name/symbol/decimals/totalSupply/metaURI resolved
  via `eth_call` at launch time (these aren't emitted as event data)
- `Pool` — the hook-side pool registration (anti-sandwich / max-buy / fee state) for each token,
  created unconditionally on every successful launch, plus running swap/volume aggregates
  (`swapCount`, `buyCount`, `sellCount`, `totalVolumeNative`, `totalVolumeToken`,
  `totalHookFeeTaken`)
- `Swap` — one row per buy or sell against a Spark pool, with signed BNB/token deltas, the
  hook's fee cut on that swap, the immediate caller (`sender`, often a router) and the
  originating wallet (`origin`, `tx.from`)
- `LockerPosition`, `LockerFeeClaim` — the permanent LP-NFT record in `SparkLocker` and its
  70/30 creator/platform fee claims
- `HookFeeClaim` — the hook's own 2% native-BNB sell fee claims (70/30 creator/platform split)
- `Burn` — `SparkBurner` calls that claim a token's fees, swap 95% into the token, burn it, and
  pay the caller 5%
- `TokenHolder`, `TokenTransfer` — per-token balances and transfer log (see caveat below)

### SparkV1

- `LauncherV1`, `DexV1` — launcher config and registered DEXes (Uniswap V3 / PancakeSwap V3)
- `QuoteToken` — a registered quote token (WBNB/USDT/USDC/USD1) with its own `marketCapRef` and
  `wethPairFee`
- `TokenV1` — one per launched meme token, same `eth_call`-resolved name/symbol/decimals/
  totalSupply/metaURI as `Token`
- `PoolV1` — the plain Uniswap V3 / PancakeSwap V3 pool seeded at launch, with running
  swap/volume aggregates (`swapCount`, `buyCount`, `sellCount`, `totalVolumeQuote`,
  `totalVolumeToken`), tracked via a per-pool `SparkV1Pool` template (see caveat below)
- `SwapV1` — one row per buy or sell against a `PoolV1`, captured from the pool's own `Swap` event
- `LockerPositionV1`, `LockerFeeClaimV1` — the permanent LP-NFT record in SparkV1's separate
  `SparkLocker` instance and its fee claims
- `TokenHolderV1`, `TokenTransferV1` — per-token balances and transfer log (see caveat below)

### Shared across both versions

- `CTOApplication` — community-takeover applications/approvals/rejections across both locker
  instances and both SparkV2 hooks
- `SparkStats` — a single global counters row (`id: "1"`), including `totalSwaps`/`totalBuys`/
  `totalSells`/`totalVolumeNative` across every Spark pool
- `Locker`, `Lock`, `LockWithdrawal`, `LockTransfer`, `LockActivity` — OneCoinLocker (see above;
  unrelated to the Spark entities)

### Known caveat: launch-time token transfers

The `SparkToken`/`SparkTokenV1` template data sources are only created while handling
`TokenLaunched`, which fires at the very end of the `launch()` transaction — after the initial 1B
mint, the LP-seeding transfer, and (SparkV1 only) any instant-buy transfer already happened
earlier in that same transaction. Dynamic data sources can't retroactively index events from
earlier in the same block, so those specific transfers won't appear in
`TokenHolder`/`TokenTransfer` (or their V1 counterparts). `Token(V1).totalSupply` is unaffected
since it's read directly from the contract via `eth_call`, not derived by summing transfers. This
is the same well-known limitation every factory+template subgraph (e.g. Uniswap) has to live with.

### Pool coverage

`SparkLauncherV2.launch()` unconditionally calls `registerPool` on the token's hook
(`_setupAndRegister` reverts the whole transaction otherwise), so every token that successfully
launches always gets exactly one `Pool` row, created in the same transaction as the launch —
before either hook's `startBlock` could possibly miss it, since both hooks were deployed (per
`Deployment.md`) before the first `addDex` call that could have made a launch succeed.

SparkV1 has no hook, so `PoolV1` is created directly in `handleTokenLaunched` (from
`launcher-v1.ts`) instead of from a separate registration event, and a `SparkV1Pool` template is
spawned at that exact pool address in the same handler to pick up its `Swap` events going
forward. One consequence of the template approach: any swap in the *same transaction* as the
launch (e.g. an instant-buy via `_doInstantBuy`) fires before the template exists yet, so — like
the launch-time token transfer caveat above — it won't produce a `SwapV1` row, even though
`PoolV1` itself is always created. `Mint`/`Burn` on the pool aren't tracked; SparkV1 liquidity is
seeded once at launch and permanently held by `SparkLocker`, so no ongoing LP position changes are
expected there (a third party could still mint a separate, unlocked position directly against the
pool, but that's not part of Spark's own liquidity and isn't tracked here).

## Usage

```bash
npm install
npm run codegen
npm run build
```

To deploy, point `graph deploy`/`graph create` at your target (The Graph Studio, a self-hosted
`graph-node`, or another indexer) with network `bsc`.
