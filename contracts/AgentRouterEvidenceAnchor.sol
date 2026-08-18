// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal Arc anchor for AgentRouter evidence.
/// @dev Full evidence stays offchain. This contract only emits hashes so calls
/// can be audited for timestamp, immutability, and hash consistency.
contract AgentRouterEvidenceAnchor {
    event EvidenceAnchored(
        string requestId,
        bytes32 indexed traceHash,
        bytes32 indexed resultHash,
        bytes32 verificationHash,
        bytes32 feedbackHash,
        bytes32 indexed serviceHash,
        bytes32 providerHash,
        bytes32 paymentTxHash,
        address anchor,
        uint256 createdAt
    );

    event FeedbackAnchored(
        string requestId,
        bytes32 indexed feedbackHash,
        bytes32 indexed serviceHash,
        bytes32 providerHash,
        address anchor,
        uint256 createdAt
    );

    function anchorEvidence(
        string calldata requestId,
        bytes32 traceHash,
        bytes32 resultHash,
        bytes32 verificationHash,
        bytes32 feedbackHash,
        bytes32 serviceHash,
        bytes32 providerHash,
        bytes32 paymentTxHash
    ) external {
        emit EvidenceAnchored(
            requestId,
            traceHash,
            resultHash,
            verificationHash,
            feedbackHash,
            serviceHash,
            providerHash,
            paymentTxHash,
            msg.sender,
            block.timestamp
        );
    }

    function anchorFeedback(
        string calldata requestId,
        bytes32 feedbackHash,
        bytes32 serviceHash,
        bytes32 providerHash
    ) external {
        emit FeedbackAnchored(
            requestId,
            feedbackHash,
            serviceHash,
            providerHash,
            msg.sender,
            block.timestamp
        );
    }
}
