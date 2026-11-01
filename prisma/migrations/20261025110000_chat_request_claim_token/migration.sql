ALTER TABLE "chat_requests"
  ADD COLUMN "claimToken" UUID;

-- Existing requests are not active across deployments; initialize a unique token for each row.
UPDATE "chat_requests" SET "claimToken" = gen_random_uuid() WHERE "claimToken" IS NULL;

ALTER TABLE "chat_requests"
  ALTER COLUMN "claimToken" SET NOT NULL;
