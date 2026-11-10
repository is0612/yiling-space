/** Loaded only by managed Workers. Exit immediately when the launcher disappears;
 * in-flight work is recovered through the persisted task lease and cursor. */
if (typeof process.send === "function") {
  process.once("disconnect", () => process.exit(1));
}
