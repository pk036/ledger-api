export class LedgerError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}