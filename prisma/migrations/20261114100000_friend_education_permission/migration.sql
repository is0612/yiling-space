-- Friend education authorization is local to a character relationship, never a platform identity.
ALTER TABLE "memory_scopes" ADD COLUMN "educationEnabled" BOOLEAN NOT NULL DEFAULT false;
