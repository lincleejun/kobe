export class InvalidTransitionError extends Error {
  constructor(from: string, to: string) {
    super(`invalid task transition: ${from} -> ${to}`)
    this.name = "InvalidTransitionError"
  }
}
export class CyclicDagError extends Error {
  constructor() {
    super("dag contains a cycle")
    this.name = "CyclicDagError"
  }
}
export class GuardError extends Error {
  constructor(msg: string) {
    super(msg)
    this.name = "GuardError"
  }
}
