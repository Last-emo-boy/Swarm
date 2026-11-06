/** Parsing the address a mesh server binds. */

/** Splits `host:port`, `[v6]:port` or a bare port into its parts. */
export function parseListen(listen: string): { host: string; port: number } {
  const at = listen.lastIndexOf(":");
  const host = at < 0 ? "127.0.0.1" : listen.slice(0, at).replace(/^\[|\]$/g, "") || "127.0.0.1";
  const port = Number(at < 0 ? listen : listen.slice(at + 1));
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`"${listen}" is not host:port`);
  return { host, port };
}
