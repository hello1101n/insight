export class AnalyticsApiError extends Error {
  status: number;
  body: unknown;

  constructor(status: number, body: unknown) {
    super(`Analytics API ${status}`);
    this.name = "AnalyticsApiError";
    this.status = status;
    this.body = body;
  }
}
