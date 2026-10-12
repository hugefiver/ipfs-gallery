import { MemoryBlockstore } from 'blockstore-core/memory'
import { exporter } from 'ipfs-unixfs-exporter'
import type { UnixFSDirectoryEntry } from 'ipfs-unixfs-exporter'
import { importer } from 'ipfs-unixfs-importer'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import { expect, it } from 'vitest'

it('reads blockstore generators and lists an imported UnixFS directory via entries', async () => {
  const store = new MemoryBlockstore()
  const bytes = new Uint8Array([1, 2, 3, 4, 5])
  let directoryCid: CID | undefined
  for await (const entry of importer(
    [{ path: 'sample.bin', content: bytes }],
    store,
    { cidVersion: 1, wrapWithDirectory: true },
  )) {
    if (entry.path === '') directoryCid = entry.cid
  }
  if (directoryCid === undefined) throw new Error('Importer did not produce a directory')

  const directory = await exporter(directoryCid, store)
  if (directory.type !== 'directory') throw new Error('Expected an imported directory')
  const entries: UnixFSDirectoryEntry[] = []
  for await (const child of directory.entries()) entries.push(child)
  expect(entries).toHaveLength(1)
  expect(entries[0]?.name).toBe('sample.bin')

  const file = await exporter(`${directoryCid.toString()}/sample.bin`, store)
  if (file.type !== 'file' && file.type !== 'raw') throw new Error('Expected file bytes')
  const output: number[] = []
  for await (const chunk of file.content({ offset: 1, length: 3 })) output.push(...chunk)
  expect(output).toEqual([2, 3, 4])

  const rawCid = CID.createV1(0x55, await sha256.digest(bytes))
  await store.put(rawCid, bytes)
  const blocks = store.get(rawCid)
  expect('then' in blocks).toBe(false)
  const read: number[] = []
  for await (const chunk of blocks) read.push(...chunk)
  expect(read).toEqual([...bytes])
})
