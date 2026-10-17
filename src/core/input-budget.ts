import type { ContentRef } from '../shared/contracts'
import { GalleryDomainError } from '../shared/errors'

export class InputBudgetExceededError extends GalleryDomainError {
  constructor(message: string, ref?: ContentRef) {
    super({ code: 'LIMIT', message, retryable: false, ...(ref === undefined ? {} : { ref }) })
  }
}

export function isInputBudgetExceeded(error: unknown): error is InputBudgetExceededError {
  return error instanceof InputBudgetExceededError
}
