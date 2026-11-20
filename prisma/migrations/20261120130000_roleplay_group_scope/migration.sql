ALTER TABLE "roleplay_sessions"
  ADD COLUMN "groupBindingId" UUID,
  ADD COLUMN "groupConversationId" VARCHAR(255);

CREATE INDEX "roleplay_sessions_groupBindingId_groupConversationId_idx"
  ON "roleplay_sessions"("groupBindingId", "groupConversationId");

ALTER TABLE "roleplay_sessions" ADD CONSTRAINT "roleplay_sessions_group_scope_check"
  CHECK (("groupBindingId" IS NULL AND "groupConversationId" IS NULL)
    OR ("groupBindingId" IS NOT NULL AND "groupConversationId" IS NOT NULL AND "groupConversationId" ~ '^g:[1-9][0-9]{0,19}$'));

-- A public story cannot later become private (or move to another group).
CREATE FUNCTION roleplay_session_immutable_group_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."groupBindingId" IS DISTINCT FROM NEW."groupBindingId"
    OR OLD."groupConversationId" IS DISTINCT FROM NEW."groupConversationId" THEN
    RAISE EXCEPTION 'roleplay session group scope is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "roleplay_sessions_immutable_group_scope"
  BEFORE UPDATE OF "groupBindingId", "groupConversationId" ON "roleplay_sessions"
  FOR EACH ROW EXECUTE FUNCTION roleplay_session_immutable_group_scope();
