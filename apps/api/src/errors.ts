export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) { super(message); }
}

export const notFound = (entity: string): AppError => new AppError(404, "NOT_FOUND", `${entity} not found`);
