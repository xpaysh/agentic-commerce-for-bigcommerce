/**
 * Public package entry. Exports the adapter + the request handler factory
 * for use as a library (e.g. embedded in another Node service or invoked
 * from a BC Connect-style entry point).
 */

export { BigCommerceAdapter, NotImplementedError } from "./adapter";
export type { BigCommerceAdapterOptions } from "./adapter";
export { BigCommerceClient, BigCommerceError } from "./bc-client";
export { loadConfig } from "./config";
export type { AppConfig, BigCommerceCredentials } from "./config";
export { buildHandler } from "./server";
export * as mappers from "./mappers";
