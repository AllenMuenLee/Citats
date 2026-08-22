export class BrowserServiceUnavailableError extends Error {
  override readonly name = "BrowserServiceUnavailableError";
}

export class BrowserServiceTimeoutError extends Error {
  override readonly name = "BrowserServiceTimeoutError";
}

export class BrowserServiceContractError extends Error {
  override readonly name = "BrowserServiceContractError";
}
