/** Byte-accounted LRU. Ownership never escapes through returned buffers. */
export class VerifiedBlockCache {
  private readonly blocks = new Map<string, Uint8Array>()
  private bytes = 0

  constructor(private readonly maxBytes: number) {}

  get(key: string): Uint8Array | undefined {
    const block = this.blocks.get(key)
    if (block === undefined) return undefined
    this.blocks.delete(key)
    this.blocks.set(key, block)
    return block.slice()
  }

  set(key: string, block: Uint8Array): void {
    const previous = this.blocks.get(key)
    if (previous !== undefined) {
      this.bytes -= previous.byteLength
      this.blocks.delete(key)
    }
    if (block.byteLength > this.maxBytes) return
    while (this.bytes + block.byteLength > this.maxBytes) {
      const oldest = this.blocks.entries().next().value
      if (oldest === undefined) break
      this.blocks.delete(oldest[0])
      this.bytes -= oldest[1].byteLength
    }
    this.blocks.set(key, block.slice())
    this.bytes += block.byteLength
  }

  clear(): void {
    this.blocks.clear()
    this.bytes = 0
  }
}
