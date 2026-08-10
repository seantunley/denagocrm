-- Which flow node produced an outbound chatbot message.
--
-- BotFlowOutbox already carried `flowVersionId`, so when a message exhausted its
-- retries the `delivery_failed` analytics event could say WHICH PUBLISHED VERSION
-- had failed but not which node. The bot analytics dashboard reports both, and
-- the per-node column was therefore a row of zeroes while the version total was
-- non-zero — node attribution was not merely missing, it was actively misleading.
--
-- That matters because the failures are almost never uniform across a graph: one
-- image node whose URL the provider rejects, or one choice node whose option list
-- is too long for a channel, accounts for the whole count. Without the origin node
-- there is nothing to point at.
--
-- Additive and nullable. Rows enqueued before this column existed keep NULL, and
-- NULL must read as "origin unknown" — the analytics node query already excludes
-- NULL node ids rather than grouping them together as if they shared a node.
ALTER TABLE "BotFlowOutbox"
  ADD COLUMN "nodeId" TEXT;

-- Supports "which nodes in this published version are failing to deliver" without
-- scanning the whole queue. Deliberately not unique and not a foreign key: nodes
-- live inside the immutable BotFlowVersion definition JSON, not in a table, and a
-- queued row must survive the node being renamed in a later draft.
CREATE INDEX "BotFlowOutbox_tenant_flow_version_node_idx"
  ON "BotFlowOutbox"("tenantId", "flowVersionId", "nodeId");
