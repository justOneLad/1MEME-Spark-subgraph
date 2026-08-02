import { Address, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts";
import {
  TokenLaunched,
  DexAdded,
  DexDisabled,
  QuoteTokenAdded,
  QuoteTokenDisabled,
  LaunchFeeWalletSet,
  BurnerSet,
  LaunchFeeSet,
  MarketCapRefSet,
  InstantBuySkipped,
  RoutesSet,
  RouteSucceeded,
  SparkGoLauncher,
} from "../generated/SparkGoLauncher/SparkGoLauncher";
import { SparkToken as SparkTokenContract } from "../generated/SparkGoLauncher/SparkToken";
import { SparkTokenGo as SparkTokenGoTemplate } from "../generated/templates";
import { LauncherGo, DexGo, QuoteTokenGo, TokenGo, RouteSuccessGo } from "../generated/schema";
import {
  ZERO_BI,
  ZERO_ADDRESS,
  protocolToString,
  eventId,
  getOrCreateStats,
} from "./helpers";

function getOrCreateLauncher(address: Address, event: ethereum.Event): LauncherGo {
  let launcher = LauncherGo.load(address);
  if (launcher == null) {
    launcher = new LauncherGo(address);
    let contract = SparkGoLauncher.bind(address);

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

    let burner = contract.try_burner();
    launcher.burner = burner.reverted ? null : burner.value;

    let launchFee = contract.try_launchFee();
    launcher.launchFee = launchFee.reverted ? ZERO_BI : launchFee.value;

    launcher.tokensLaunchedCount = ZERO_BI;
    launcher.createdAtBlock = event.block.number;
    launcher.createdAtTimestamp = event.block.timestamp;
  }
  launcher.updatedAtBlock = event.block.number;
  launcher.updatedAtTimestamp = event.block.timestamp;
  return launcher as LauncherGo;
}

export function handleDexAdded(event: DexAdded): void {
  let launcher = getOrCreateLauncher(event.address, event);

  let dex = DexGo.load(event.params.positionManager);
  let isNew = dex == null;
  if (dex == null) {
    dex = new DexGo(event.params.positionManager);
    dex.tokensLaunchedCount = ZERO_BI;
    dex.addedAtBlock = event.block.number;
    dex.addedAtTimestamp = event.block.timestamp;
  }
  dex.launcher = launcher.id;
  dex.protocol = protocolToString(event.params.protocol);
  dex.singleton = event.params.singleton;
  dex.poolLogic =
    event.params.poolLogic.equals(ZERO_ADDRESS) ? null : event.params.poolLogic;
  dex.permit2 = event.params.permit2;
  dex.hook = event.params.hook;
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
  let dex = DexGo.load(event.params.positionManager);
  if (dex == null) return;
  dex.enabled = false;
  dex.updatedAtBlock = event.block.number;
  dex.updatedAtTimestamp = event.block.timestamp;
  dex.save();
}

export function handleQuoteTokenAdded(event: QuoteTokenAdded): void {
  let launcher = getOrCreateLauncher(event.address, event);

  let quoteToken = QuoteTokenGo.load(event.params.token);
  if (quoteToken == null) {
    quoteToken = new QuoteTokenGo(event.params.token);
    quoteToken.routeCount = ZERO_BI;
    quoteToken.addedAtBlock = event.block.number;
    quoteToken.addedAtTimestamp = event.block.timestamp;
  }
  quoteToken.launcher = launcher.id;
  quoteToken.marketCapRef = event.params.marketCapRef;
  quoteToken.enabled = true;
  quoteToken.updatedAtBlock = event.block.number;
  quoteToken.updatedAtTimestamp = event.block.timestamp;
  quoteToken.save();
}

export function handleQuoteTokenDisabled(event: QuoteTokenDisabled): void {
  let quoteToken = QuoteTokenGo.load(event.params.token);
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

export function handleBurnerSet(event: BurnerSet): void {
  let launcher = getOrCreateLauncher(event.address, event);
  launcher.burner = event.params.burner.equals(ZERO_ADDRESS)
    ? null
    : event.params.burner;
  launcher.save();
}

export function handleLaunchFeeSet(event: LaunchFeeSet): void {
  let launcher = getOrCreateLauncher(event.address, event);
  launcher.launchFee = event.params.fee;
  launcher.save();
}

export function handleMarketCapRefSet(event: MarketCapRefSet): void {
  let launcher = getOrCreateLauncher(event.address, event);

  let quoteToken = QuoteTokenGo.load(event.params.token);
  if (quoteToken == null) {
    // setMarketCapRef requires quoteTokens[token].enabled on-chain, so this quote token is
    // definitely registered — this fallback only matters if handleQuoteTokenAdded somehow
    // hasn't run yet for it.
    quoteToken = new QuoteTokenGo(event.params.token);
    quoteToken.launcher = launcher.id;
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

/**
 * launch()'s LaunchParams.feeWallet isn't in the event (it only carries the resolved
 * feeWallet, post burner-substitution), so decode it from the transaction calldata to know
 * whether this launch explicitly routed to address(0) (the burner). Calldata is a single
 * LaunchParams struct; feeWallet is its 4th field.
 */
function decodeOriginalFeeWalletWasZero(event: TokenLaunched): boolean {
  let input = event.transaction.input;
  if (input.length < 4) return false;
  let callData = Bytes.fromUint8Array(input.subarray(4));
  let decoded = ethereum.decode(
    "(string,string,string,address,address,address,bytes32,uint256,uint256,bool)",
    callData
  );
  if (decoded == null) return false;
  let tuple = decoded.toTuple();
  let feeWallet = tuple[3].toAddress();
  return feeWallet.equals(ZERO_ADDRESS);
}

export function handleTokenLaunched(event: TokenLaunched): void {
  let launcher = getOrCreateLauncher(event.address, event);
  launcher.tokensLaunchedCount = launcher.tokensLaunchedCount.plus(
    BigInt.fromI32(1)
  );
  launcher.save();

  let dex = DexGo.load(event.params.positionManager);
  if (dex != null) {
    dex.tokensLaunchedCount = dex.tokensLaunchedCount.plus(BigInt.fromI32(1));
    dex.save();
  }

  let token = new TokenGo(event.params.token);
  token.launcher = launcher.id;
  token.dex = event.params.positionManager;
  token.quoteToken = event.params.quoteToken;
  token.creator = event.params.creator;
  token.feeWallet = event.params.feeWallet;
  token.routedToBurner = decodeOriginalFeeWalletWasZero(event);
  token.hook = event.params.hook;
  token.protocol = dex != null ? dex.protocol : protocolToString(0);
  token.poolId = event.params.poolId;
  token.positionManager = event.params.positionManager;
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

  let stats = getOrCreateStats();
  stats.tokensLaunched = stats.tokensLaunched.plus(BigInt.fromI32(1));
  stats.save();

  SparkTokenGoTemplate.create(event.params.token);
}

export function handleInstantBuySkipped(event: InstantBuySkipped): void {
  let token = TokenGo.load(event.params.token);
  if (token == null) return;
  token.instantBuySkipped = true;
  token.instantBuySkippedRefundWei = event.params.refundedWei;
  token.save();
}

export function handleRoutesSet(event: RoutesSet): void {
  let launcher = getOrCreateLauncher(event.address, event);

  let quoteToken = QuoteTokenGo.load(event.params.quoteToken);
  if (quoteToken == null) {
    // Unlike setMarketCapRef, setRoutes has no on-chain requirement that the quote token
    // already be registered via addQuoteToken, so create a placeholder if routes are
    // configured ahead of that. enabled defaults to false here (unlike handleMarketCapRefSet
    // above) since nothing confirms this token is actually enabled yet — a later
    // QuoteTokenAdded will correct it.
    quoteToken = new QuoteTokenGo(event.params.quoteToken);
    quoteToken.launcher = launcher.id;
    quoteToken.marketCapRef = ZERO_BI;
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
  let routeSuccess = new RouteSuccessGo(eventId(event));
  routeSuccess.quoteToken = event.params.quoteToken;
  routeSuccess.routeIndex = event.params.routeIndex;
  routeSuccess.amountOut = event.params.amountOut;
  routeSuccess.blockNumber = event.block.number;
  routeSuccess.timestamp = event.block.timestamp;
  routeSuccess.txHash = event.transaction.hash;
  routeSuccess.save();
}
