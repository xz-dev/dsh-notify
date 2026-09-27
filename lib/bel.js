/** Emit one standard terminal BEL control character. */
export function createBelLauncher(options = {}) {
  const write = options.write ?? ((value) => process.stdout.write(value));
  return () => {
    write("\x07");
  };
}
