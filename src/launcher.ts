import { Address, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts";
import {
  TokenLaunched,
  DexAdded,
  DexDisabled,
  LaunchFeeWalletSet,
  BurnerSet,
  LaunchFeeSet,
  MarketCapRefSet,
  SparkLauncherV2,
} from "../generated/SparkLauncherV2/SparkLauncherV2";
import { SparkToken as SparkTokenContract } from "../generated/SparkLauncherV2/SparkToken";
import { SparkToken as SparkTokenTemplate } from "../generated/templates";
import { Launcher, Dex, Token } from "../generated/schema";
import {
  ZERO_BI,
  ZERO_ADDRESS,
  protocolToString,
  getOrCreateStats,
} from "./helpers";

function getOrCreateLauncher(address: Address, event: ethereum.Event): Launcher {
  let launcher = Launcher.load(address);
  if (launcher == null) {
    launcher = new Launcher(address);
    let contract = SparkLauncherV2.bind(address);

    let owner = contract.try_owner();
    launcher.owner = owner.reverted ? ZERO_ADDRESS : owner.value;

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

    let marketCapRef = contract.try_marketCapRef();
    launcher.marketCapRef = marketCapRef.reverted ? ZERO_BI : marketCapRef.value;

    launcher.tokensLaunchedCount = ZERO_BI;
    launcher.createdAtBlock = event.block.number;
    launcher.createdAtTimestamp = event.block.timestamp;
  }
  launcher.updatedAtBlock = event.block.number;
  launcher.updatedAtTimestamp = event.block.timestamp;
  return launcher as Launcher;
}

export function handleDexAdded(event: DexAdded): void {
  let launcher = getOrCreateLauncher(event.address, event);

  let dex = Dex.load(event.params.positionManager);
  let isNew = dex == null;
  if (dex == null) {
    dex = new Dex(event.params.positionManager);
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
  let dex = Dex.load(event.params.positionManager);
  if (dex == null) return;
  dex.enabled = false;
  dex.updatedAtBlock = event.block.number;
  dex.updatedAtTimestamp = event.block.timestamp;
  dex.save();
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
  launcher.marketCapRef = event.params.marketCapRef;
  launcher.save();
}

/**
 * launch()'s original feeWallet_ argument isn't in the event (it only carries
 * the resolved feeWallet), so decode it from the transaction calldata to know
 * whether this launch explicitly routed to address(0) (the burner).
 */
function decodeOriginalFeeWalletWasZero(event: TokenLaunched): boolean {
  let input = event.transaction.input;
  if (input.length < 4) return false;
  let callData = Bytes.fromUint8Array(input.subarray(4));
  let decoded = ethereum.decode(
    "(string,string,string,address,address,bytes32)",
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

  let dex = Dex.load(event.params.positionManager);
  if (dex != null) {
    dex.tokensLaunchedCount = dex.tokensLaunchedCount.plus(BigInt.fromI32(1));
    dex.save();
  }

  let token = new Token(event.params.token);
  token.launcher = launcher.id;
  token.dex = event.params.positionManager;
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

  SparkTokenTemplate.create(event.params.token);
}
