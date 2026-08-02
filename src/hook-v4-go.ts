import { BigInt, Bytes, crypto, ethereum } from "@graphprotocol/graph-ts";
import {
  PoolRegistered,
  FeesClaimed,
  CTOApplied,
  CTOApproved,
  CTORejected,
  AfterSwapCall,
  SparkGoHookV4,
} from "../generated/SparkGoHookV4/SparkGoHookV4";
import { PoolGo, HookFeeClaimGo, CTOApplication } from "../generated/schema";
import {
  ZERO_BI,
  ZERO_ADDRESS,
  PROTOCOL_UNISWAP_V4,
  CTO_SOURCE_HOOK_V4_GO,
  eventId,
  getOrCreateStats,
} from "./helpers";
import { recordSwap } from "./swap-recorder-go";

export function handlePoolRegistered(event: PoolRegistered): void {
  let pool = new PoolGo(event.params.poolId);
  pool.token = event.params.token;
  pool.hook = event.address;
  pool.protocol = PROTOCOL_UNISWAP_V4;
  pool.creator = event.params.creator;
  pool.registeredAtBlock = event.block.number;
  pool.registeredAtTimestamp = event.block.timestamp;
  pool.registeredAtTx = event.transaction.hash;
  pool.totalFeesClaimed = ZERO_BI;
  pool.claimCount = ZERO_BI;
  pool.pendingCTOApplicationId = null;
  pool.swapCount = ZERO_BI;
  pool.buyCount = ZERO_BI;
  pool.sellCount = ZERO_BI;
  pool.totalVolumeQuote = ZERO_BI;
  pool.totalVolumeToken = ZERO_BI;
  pool.totalHookFeeTaken = ZERO_BI;

  let contract = SparkGoHookV4.bind(event.address);
  let info = contract.try_pools(event.params.poolId);
  if (!info.reverted) {
    pool.quoteToken = info.value.getQuoteCurrency();
    pool.tokenIsCurrency0 = info.value.getTokenIsCurrency0();
  } else {
    pool.quoteToken = ZERO_ADDRESS;
    pool.tokenIsCurrency0 = false;
  }

  pool.save();
}

export function handleFeesClaimed(event: FeesClaimed): void {
  let pool = PoolGo.load(event.params.poolId);
  if (pool == null) return;

  pool.totalFeesClaimed = pool.totalFeesClaimed.plus(event.params.amount);
  pool.claimCount = pool.claimCount.plus(BigInt.fromI32(1));
  pool.save();

  let claim = new HookFeeClaimGo(eventId(event));
  claim.pool = pool.id;
  claim.amount = event.params.amount;
  claim.blockNumber = event.block.number;
  claim.timestamp = event.block.timestamp;
  claim.txHash = event.transaction.hash;
  claim.save();

  let stats = getOrCreateStats();
  stats.hookFeeClaims = stats.hookFeeClaims.plus(BigInt.fromI32(1));
  stats.save();
}

export function handleCTOApplied(event: CTOApplied): void {
  let pool = PoolGo.load(event.params.poolId);

  let id = CTO_SOURCE_HOOK_V4_GO + "-" + eventId(event).toHexString();
  let application = new CTOApplication(id);
  application.source = CTO_SOURCE_HOOK_V4_GO;
  application.poolGo = event.params.poolId;
  application.tokenGo = pool != null ? pool.token : null;
  application.applicant = event.params.applicant;
  application.newRecipient = event.params.newCreator;
  application.paid = event.params.paid;
  application.status = "PENDING";
  application.appliedAtBlock = event.block.number;
  application.appliedAtTimestamp = event.block.timestamp;
  application.appliedAtTx = event.transaction.hash;
  application.save();

  if (pool != null) {
    pool.pendingCTOApplicationId = id;
    pool.save();
  }

  let stats = getOrCreateStats();
  stats.ctoApplications = stats.ctoApplications.plus(BigInt.fromI32(1));
  stats.save();
}

export function handleCTOApproved(event: CTOApproved): void {
  let pool = PoolGo.load(event.params.poolId);
  if (pool == null) return;

  pool.creator = event.params.newCreator;
  let pendingId = pool.pendingCTOApplicationId;
  if (pendingId != null) {
    let application = CTOApplication.load(pendingId as string);
    if (application != null) {
      application.status = "APPROVED";
      application.resolvedAtBlock = event.block.number;
      application.resolvedAtTimestamp = event.block.timestamp;
      application.resolvedAtTx = event.transaction.hash;
      application.save();
    }
  }
  pool.pendingCTOApplicationId = null;
  pool.save();

  let stats = getOrCreateStats();
  stats.ctoApprovals = stats.ctoApprovals.plus(BigInt.fromI32(1));
  stats.save();
}

export function handleCTORejected(event: CTORejected): void {
  let pool = PoolGo.load(event.params.poolId);
  if (pool == null) return;

  let pendingId = pool.pendingCTOApplicationId;
  if (pendingId != null) {
    let application = CTOApplication.load(pendingId as string);
    if (application != null) {
      application.status = "REJECTED";
      application.resolvedAtBlock = event.block.number;
      application.resolvedAtTimestamp = event.block.timestamp;
      application.resolvedAtTx = event.transaction.hash;
      application.save();
    }
  }
  pool.pendingCTOApplicationId = null;
  pool.save();

  let stats = getOrCreateStats();
  stats.ctoRejections = stats.ctoRejections.plus(BigInt.fromI32(1));
  stats.save();
}

export function handleAfterSwap(call: AfterSwapCall): void {
  let keyValue = call.inputValues[1].value;
  let encodedKey = ethereum.encode(keyValue);
  if (!encodedKey) return;
  let poolId = Bytes.fromByteArray(crypto.keccak256(encodedKey));

  recordSwap(
    call.block,
    call.transaction.hash,
    poolId,
    call.inputs.sender,
    call.transaction.from,
    call.inputs.delta,
    call.outputs.value1
  );
}
