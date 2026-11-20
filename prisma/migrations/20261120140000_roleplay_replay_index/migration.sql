-- Channel redelivery is resolved before selecting the currently active story.
CREATE INDEX "roleplay_messages_requestId_source_role_idx"
  ON "roleplay_messages"("requestId", "source", "role");
