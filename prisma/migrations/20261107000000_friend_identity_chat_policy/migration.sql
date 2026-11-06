-- Separate platform identity classification from verification status and per-character chat policy.
CREATE TYPE "ExternalIdentityKind" AS ENUM ('UNKNOWN', 'HUMAN', 'AI');
CREATE TYPE "ExternalIdentityKindSource" AS ENUM ('AUTO', 'MANUAL');
CREATE TYPE "FriendChatPolicy" AS ENUM ('DEFAULT', 'ALLOW', 'BLOCK');

ALTER TABLE "external_identities"
  ADD COLUMN "kind" "ExternalIdentityKind" NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN "kindSource" "ExternalIdentityKindSource" NOT NULL DEFAULT 'AUTO';

ALTER TABLE "memory_scopes"
  ADD COLUMN "friendChatPolicy" "FriendChatPolicy" NOT NULL DEFAULT 'DEFAULT';

ALTER TABLE "conversations"
  ADD COLUMN "consecutiveAiRounds" INTEGER NOT NULL DEFAULT 0;
