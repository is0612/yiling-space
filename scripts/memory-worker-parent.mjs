/** Loaded only by managed Workers or desktop consumers. Exit when the manager disappears;
 * in-flight work is recovered through the persisted task lease and cursor. */
if (typeof process.send === "function") {
  process.once("disconnect", () => process.exit(1));
}
