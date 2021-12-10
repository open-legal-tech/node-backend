import { BaseError } from "../utils/ApiError";
import { HTTPStatusCodes, CustomErrorInterface } from "../types/types";

export class TreeNotFoundError extends BaseError {
  constructor({
    name = "TreeNotFound",
    message = "The tree was not found.",
    additionalErrorData,
    statusCode = HTTPStatusCodes.BAD_REQUEST,
    isOperational,
  }: CustomErrorInterface) {
    super({
      name,
      message,
      additionalErrorData,
      statusCode,
      isOperational,
    });
  }
}