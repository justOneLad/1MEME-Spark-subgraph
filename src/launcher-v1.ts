import { Address, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts";
import {
  TokenLaunched,
  DexAdded,
  DexDisabled,
  QuoteTokenAdded,
  QuoteTokenDisabled,
  LaunchFeeWalletSet,
  LaunchFeeSet,
  MarketCapRefSet,
  InstantBuySkipped,
  RoutesSet,
  RouteSucceeded,
  SparkLauncher,
} from "../generated/SparkLauncherV1/SparkLauncher";
import { SparkToken as SparkTokenContract } from "../generated/SparkLauncherV1/SparkToken";
import { UniswapV3Pool as UniswapV3PoolContract } from "../generated/SparkLauncherV1/UniswapV3Pool";
import {
  SparkTokenV1 as SparkTokenV1Template,
  SparkV1Pool as SparkV1PoolTemplate,
} from "../generated/templates";
import { LauncherV1, DexV1, QuoteToken, TokenV1, PoolV1, RouteSuccess } from "../generated/schema";
import { ZERO_BI, ZERO_ADDRESS, eventId, getOrCreateStats } from "./helpers";

function getOrCreateLauncher(address: Address, event: ethereum.Event): LauncherV1 {
  let launcher = LauncherV1.load(address);
  if (launcher == null) {
    launcher = new LauncherV1(address);
    let contract = SparkLauncher.bind(address);

    let owner = contract.try_owner();
    launcher.owner = owner.reverted ? ZERO_ADDRESS : owner.value;

    let weth = contract.try_weth();
    launcher.weth = weth.reverted ? ZERO_ADDRESS : weth.value;

    let tokenImpl = contract.try_tokenImpl();
    launcher.tokenImpl = tokenImpl.reverted ? ZERO_ADDRESS : tokenImpl.value;

    let locker = contract.try_locker();
    launcher.locker = locker.reverted ? ZERO_ADDRESS : locker.value;

    let launchFeeWallet = contract.try_launchFeeWallet();
    launcher.launchFeeWallet = launchFeeWallet.reverted
      ? ZERO_ADDRESS
      : launchFeeWallet.value;

    let launchFee = contract.try_launchFee();
    launcher.launchFee = launchFee.reverted ? ZERO_BI : launchFee.value;

    launcher.tokensLaunchedCount = ZERO_BI;
    launcher.createdAtBlock = event.block.number;
    launcher.createdAtTimestamp = event.block.timestamp;
  }
  launcher.updatedAtBlock = event.block.number;
  launcher.updatedAtTimestamp = event.block.timestamp;
  return launcher as LauncherV1;
}

export function handleDexAdded(event: DexAdded): void {
  let launcher = getOrCreateLauncher(event.address, event);

  let dex = DexV1.load(event.params.factory);
  let isNew = dex == null;
  if (dex == null) {
    dex = new DexV1(event.params.factory);
    dex.tokensLaunchedCount = ZERO_BI;
    dex.addedAtBlock = event.block.number;
    dex.addedAtTimestamp = event.block.timestamp;
  }
  dex.launcher = launcher.id;
  dex.positionManager = event.params.positionManager;
  dex.router = event.params.router;
  dex.routerNoDeadline = event.params.routerNoDeadline;
  dex.enabled = true;
  dex.updatedAtBlock = event.block.number;
  dex.updatedAtTimestamp = event.block.timestamp;
  dex.save();

  if (isNew) {
    let stats = getOrCreateStats();
    stats.dexCount = stats.dexCount.plus(BigInt.fromI32(1));
    stats.save();
  }

  launcher.save();
}

export function handleDexDisabled(event: DexDisabled): void {
  let dex = DexV1.load(event.params.factory);
  if (dex == null) return;
  dex.enabled = false;
  dex.updatedAtBlock = event.block.number;
  dex.updatedAtTimestamp = event.block.timestamp;
  dex.save();
}

export function handleQuoteTokenAdded(event: QuoteTokenAdded): void {
  let launcher = getOrCreateLauncher(event.address, event);

  let quoteToken = QuoteToken.load(event.params.token);
  if (quoteToken == null) {
    quoteToken = new QuoteToken(event.params.token);
    quoteToken.routeCount = ZERO_BI;
    quoteToken.addedAtBlock = event.block.number;
    quoteToken.addedAtTimestamp = event.block.timestamp;
  }
  quoteToken.launcher = launcher.id;
  quoteToken.marketCapRef = event.params.marketCapRef;
  quoteToken.wethPairFee = event.params.wethPairFee;
  quoteToken.enabled = true;
  quoteToken.updatedAtBlock = event.block.number;
  quoteToken.updatedAtTimestamp = event.block.timestamp;
  quoteToken.save();
}

export function handleQuoteTokenDisabled(event: QuoteTokenDisabled): void {
  let quoteToken = QuoteToken.load(event.params.token);
  if (quoteToken == null) return;
  quoteToken.enabled = false;
  quoteToken.updatedAtBlock = event.block.number;
  quoteToken.updatedAtTimestamp = event.block.timestamp;
  quoteToken.save();
}

export function handleLaunchFeeWalletSet(event: LaunchFeeWalletSet): void {
  let launcher = getOrCreateLauncher(event.address, event);
  launcher.launchFeeWallet = event.params.wallet;
  launcher.save();
}

export function handleLaunchFeeSet(event: LaunchFeeSet): void {
  let launcher = getOrCreateLauncher(event.address, event);
  launcher.launchFee = event.params.fee;
  launcher.save();
}

export function handleMarketCapRefSet(event: MarketCapRefSet): void {
  let launcher = getOrCreateLauncher(event.address, event);

  let quoteToken = QuoteToken.load(event.params.token);
  if (quoteToken == null) {
    // setMarketCapRef requires quoteTokens[token].enabled on-chain, so this quote token is
    // definitely registered even though we haven't seen a QuoteTokenAdded for it (e.g. native
    // BNB, whose registration never emits one — see getOrCreateQuoteToken above).
    quoteToken = new QuoteToken(event.params.token);
    quoteToken.launcher = launcher.id;
    quoteToken.wethPairFee = 0;
    quoteToken.enabled = true;
    quoteToken.routeCount = ZERO_BI;
    quoteToken.addedAtBlock = event.block.number;
    quoteToken.addedAtTimestamp = event.block.timestamp;
  }
  quoteToken.marketCapRef = event.params.marketCapRef;
  quoteToken.updatedAtBlock = event.block.number;
  quoteToken.updatedAtTimestamp = event.block.timestamp;
  quoteToken.save();

  launcher.save();
}

function getOrCreateQuoteToken(address: Address, launcherId: Bytes, event: ethereum.Event): QuoteToken {
  let quoteToken = QuoteToken.load(address);
  if (quoteToken == null) {
    // Covers native BNB specifically: SparkLauncher's initialize() sets quoteTokens[weth_]
    // directly without ever emitting QuoteTokenAdded, so handleQuoteTokenAdded never runs for
    // it — without this fallback, TokenV1.quoteToken (non-null) would dangle for every
    // native-BNB-quoted launch.
    quoteToken = new QuoteToken(address);
    quoteToken.launcher = launcherId;
    quoteToken.marketCapRef = BigInt.fromString("5000000000000000000");
    quoteToken.wethPairFee = 0;
    quoteToken.enabled = true;
    quoteToken.routeCount = ZERO_BI;
    quoteToken.addedAtBlock = event.block.number;
    quoteToken.addedAtTimestamp = event.block.timestamp;
    quoteToken.updatedAtBlock = event.block.number;
    quoteToken.updatedAtTimestamp = event.block.timestamp;
    quoteToken.save();
  }
  return quoteToken as QuoteToken;
}

export function handleTokenLaunched(event: TokenLaunched): void {
  let launcher = getOrCreateLauncher(event.address, event);
  launcher.tokensLaunchedCount = launcher.tokensLaunchedCount.plus(
    BigInt.fromI32(1)
  );
  launcher.save();

  let dex = DexV1.load(event.params.factory);
  if (dex != null) {
    dex.tokensLaunchedCount = dex.tokensLaunchedCount.plus(BigInt.fromI32(1));
    dex.save();
  }

  let token = new TokenV1(event.params.token);
  token.launcher = launcher.id;
  token.dex = event.params.factory;
  getOrCreateQuoteToken(event.params.quoteToken, launcher.id, event);
  token.quoteToken = event.params.quoteToken;
  token.creator = event.params.creator;
  token.feeWallet = event.params.feeWallet;
  token.positionManager = dex != null ? dex.positionManager : ZERO_ADDRESS;
  token.lockerTokenId = event.params.tokenId;
  token.launchBlock = event.block.number;
  token.launchTimestamp = event.block.timestamp;
  token.launchTx = event.transaction.hash;
  token.holderCount = ZERO_BI;
  token.transferCount = ZERO_BI;

  // launch() always ends by calling renounceOwnership() on the token, so it is
  // owner-less (owner == address(0)) by the time this event is observed.
  token.currentOwner = null;
  token.renounced = true;

  token.instantBuySkipped = false;
  token.instantBuySkippedRefundWei = null;

  let tokenContract = SparkTokenContract.bind(event.params.token);
  let name = tokenContract.try_name();
  token.name = name.reverted ? null : name.value;
  let symbol = tokenContract.try_symbol();
  token.symbol = symbol.reverted ? null : symbol.value;
  let decimals = tokenContract.try_decimals();
  if (!decimals.reverted) {
    token.decimals = decimals.value;
  }
  let totalSupply = tokenContract.try_totalSupply();
  token.totalSupply = totalSupply.reverted ? null : totalSupply.value;
  let metaURI = tokenContract.try_metaURI();
  token.metaURI = metaURI.reverted ? null : metaURI.value;

  token.save();

  let pool = new PoolV1(event.params.pool);
  pool.token = token.id;
  pool.quoteToken = event.params.quoteToken;

  let poolContract = UniswapV3PoolContract.bind(event.params.pool);
  let token0 = poolContract.try_token0();
  let token1 = poolContract.try_token1();
  pool.currency0 = token0.reverted ? ZERO_ADDRESS : token0.value;
  pool.currency1 = token1.reverted ? ZERO_ADDRESS : token1.value;
  pool.quoteIsToken0 = pool.currency0.equals(event.params.quoteToken);

  let fee = poolContract.try_fee();
  pool.fee = fee.reverted ? 10000 : fee.value; // SparkLauncher.FEE_TIER fallback

  pool.positionManager = token.positionManager;
  pool.creator = event.params.creator;
  pool.registeredAtBlock = event.block.number;
  pool.registeredAtTimestamp = event.block.timestamp;
  pool.registeredAtTx = event.transaction.hash;
  pool.swapCount = ZERO_BI;
  pool.buyCount = ZERO_BI;
  pool.sellCount = ZERO_BI;
  pool.totalVolumeQuote = ZERO_BI;
  pool.totalVolumeToken = ZERO_BI;
  pool.save();

  let stats = getOrCreateStats();
  stats.tokensLaunched = stats.tokensLaunched.plus(BigInt.fromI32(1));
  stats.save();

  SparkTokenV1Template.create(event.params.token);
  SparkV1PoolTemplate.create(event.params.pool);
}

export function handleInstantBuySkipped(event: InstantBuySkipped): void {
  let token = TokenV1.load(event.params.token);
  if (token == null) return;
  token.instantBuySkipped = true;
  token.instantBuySkippedRefundWei = event.params.refundedWei;
  token.save();
}

export function handleRoutesSet(event: RoutesSet): void {
  let launcher = getOrCreateLauncher(event.address, event);

  let quoteToken = QuoteToken.load(event.params.quoteToken);
  if (quoteToken == null) {
    // Unlike setMarketCapRef, setRoutes has no on-chain requirement that the quote token
    // already be registered via addQuoteToken, so create a placeholder if routes are
    // configured ahead of that. enabled defaults to false here (unlike handleMarketCapRefSet
    // above) since nothing confirms this token is actually enabled yet — a later
    // QuoteTokenAdded will correct it.
    quoteToken = new QuoteToken(event.params.quoteToken);
    quoteToken.launcher = launcher.id;
    quoteToken.marketCapRef = ZERO_BI;
    quoteToken.wethPairFee = 0;
    quoteToken.enabled = false;
    quoteToken.addedAtBlock = event.block.number;
    quoteToken.addedAtTimestamp = event.block.timestamp;
    quoteToken.updatedAtBlock = event.block.number;
    quoteToken.updatedAtTimestamp = event.block.timestamp;
  }
  quoteToken.routeCount = event.params.count;
  quoteToken.routesUpdatedAtBlock = event.block.number;
  quoteToken.routesUpdatedAtTimestamp = event.block.timestamp;
  quoteToken.save();

  launcher.save();
}

export function handleRouteSucceeded(event: RouteSucceeded): void {
  let routeSuccess = new RouteSuccess(eventId(event));
  routeSuccess.quoteToken = event.params.quoteToken;
  routeSuccess.routeIndex = event.params.routeIndex;
  routeSuccess.amountOut = event.params.amountOut;
  routeSuccess.blockNumber = event.block.number;
  routeSuccess.timestamp = event.block.timestamp;
  routeSuccess.txHash = event.transaction.hash;
  routeSuccess.save();
}
