import { BigInt } from "@graphprotocol/graph-ts";
import {
  PositionRegistered,
  FeesClaimed,
  CTOApplied,
  CTOApproved,
  CTORejected,
  SparkLocker,
} from "../generated/SparkLocker/SparkLocker";
import { LockerPosition, LockerFeeClaim, CTOApplication } from "../generated/schema";
import { ZERO_BI, ZERO_ADDRESS, CTO_SOURCE_LOCKER, eventId, getOrCreateStats } from "./helpers";

export function handlePositionRegistered(event: PositionRegistered): void {
  let position = new LockerPosition(event.params.token);
  position.token = event.params.token;
  position.tokenId = event.params.tokenId;
  position.feeWallet = event.params.feeWallet;
  position.singleton = event.params.pool;
  position.positionManager = event.params.positionManager;

  let contract = SparkLocker.bind(event.address);
  let pos = contract.try_positions(event.params.token);
  if (!pos.reverted) {
    position.currency0 = pos.value.getToken0();
    position.currency1 = pos.value.getToken1();
  } else {
    position.currency0 = ZERO_ADDRESS;
    position.currency1 = event.params.token;
  }

  position.registeredAtBlock = event.block.number;
  position.registeredAtTimestamp = event.block.timestamp;
  position.registeredAtTx = event.transaction.hash;
  position.totalCreator0 = ZERO_BI;
  position.totalCreator1 = ZERO_BI;
  position.totalPlatform0 = ZERO_BI;
  position.totalPlatform1 = ZERO_BI;
  position.claimCount = ZERO_BI;
  position.pendingCTOApplicationId = null;
  position.save();
}

export function handleFeesClaimed(event: FeesClaimed): void {
  let position = LockerPosition.load(event.params.token);
  if (position == null) return;

  position.totalCreator0 = position.totalCreator0.plus(event.params.creator0);
  position.totalCreator1 = position.totalCreator1.plus(event.params.creator1);
  position.totalPlatform0 = position.totalPlatform0.plus(event.params.platform0);
  position.totalPlatform1 = position.totalPlatform1.plus(event.params.platform1);
  position.claimCount = position.claimCount.plus(BigInt.fromI32(1));
  position.save();

  let claim = new LockerFeeClaim(eventId(event));
  claim.position = position.id;
  claim.feeWallet = event.params.feeWallet;
  claim.creator0 = event.params.creator0;
  claim.creator1 = event.params.creator1;
  claim.platform0 = event.params.platform0;
  claim.platform1 = event.params.platform1;
  claim.blockNumber = event.block.number;
  claim.timestamp = event.block.timestamp;
  claim.txHash = event.transaction.hash;
  claim.save();

  let stats = getOrCreateStats();
  stats.lockerFeeClaims = stats.lockerFeeClaims.plus(BigInt.fromI32(1));
  stats.save();
}

export function handleCTOApplied(event: CTOApplied): void {
  let position = LockerPosition.load(event.params.token);

  let id = CTO_SOURCE_LOCKER + "-" + eventId(event).toHexString();
  let application = new CTOApplication(id);
  application.source = CTO_SOURCE_LOCKER;
  application.token = event.params.token;
  application.position = event.params.token;
  application.applicant = event.params.applicant;
  application.newRecipient = event.params.newFeeWallet;
  application.paid = event.params.paid;
  application.status = "PENDING";
  application.appliedAtBlock = event.block.number;
  application.appliedAtTimestamp = event.block.timestamp;
  application.appliedAtTx = event.transaction.hash;
  application.save();

  if (position != null) {
    position.pendingCTOApplicationId = id;
    position.save();
  }

  let stats = getOrCreateStats();
  stats.ctoApplications = stats.ctoApplications.plus(BigInt.fromI32(1));
  stats.save();
}

export function handleCTOApproved(event: CTOApproved): void {
  let position = LockerPosition.load(event.params.token);
  if (position == null) return;

  position.feeWallet = event.params.newFeeWallet;
  let pendingId = position.pendingCTOApplicationId;
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
  position.pendingCTOApplicationId = null;
  position.save();

  let stats = getOrCreateStats();
  stats.ctoApprovals = stats.ctoApprovals.plus(BigInt.fromI32(1));
  stats.save();
}

export function handleCTORejected(event: CTORejected): void {
  let position = LockerPosition.load(event.params.token);
  if (position == null) return;

  let pendingId = position.pendingCTOApplicationId;
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
  position.pendingCTOApplicationId = null;
  position.save();

  let stats = getOrCreateStats();
  stats.ctoRejections = stats.ctoRejections.plus(BigInt.fromI32(1));
  stats.save();
}
