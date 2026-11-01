-- Existing rows cannot be safely fingerprinted because their original request payload was not stored.
-- Keep the column nullable so the API can reject ambiguous retries of legacy request keys.
ALTER TABLE "chat_requests"
  ADD COLUMN "requestHash" VARCHAR(64);
