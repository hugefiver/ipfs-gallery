import type { Page } from '@playwright/test'
import type { BuildPolicy } from '../../src/shared/build-policy-defaults'
import { DEFAULT_LIMITS } from '../../src/shared/limits'
import { SW_GALLERY_BLOCK_PATH, SW_GALLERY_HEADERS } from '../support/sw-gallery-policy'

/** A real same-origin WindowClient exercises the actual SW's private protocol. */
export async function exerciseSwPrivateSession(page: Page, cid: string, gateways: string[], policy: BuildPolicy,
  observe: (stage: 'before-fetch' | 'after-read' | 'after-second-read') => void | Promise<void>) {
  await page.exposeFunction('swGalleryPrivatePhase', observe)
  return page.evaluate(async ({ cid, gateways, policy, limits, blockPath, headers }) => {
    await navigator.serviceWorker.register('ipfs-service-worker.js', { scope: './', type: 'module', updateViaCache: 'none' })
    await navigator.serviceWorker.ready
    if (!navigator.serviceWorker.controller) await new Promise<void>(resolve => {
      navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true })
    })
    const controller = navigator.serviceWorker.controller!
    type Reply = { v: number; sequence: number; ok: boolean; value?: Record<string, unknown>; error?: { code: string } }
    const exchange = (port: MessagePort, message: Record<string, unknown>) => new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => { port.close(); reject(new Error('Real SW protocol exchange timed out')) }, 10_000)
      port.onmessageerror = () => { clearTimeout(timer); reject(new Error('Real SW port decoding failed')) }
      port.onmessage = event => { clearTimeout(timer); resolve(event.data) }
      port.start()
      port.postMessage(message)
    })
    const management = async (message: Record<string, unknown>) => {
      const { port1, port2 } = new MessageChannel()
      try {
        const result = new Promise<Reply>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Real SW management exchange timed out')), 10_000)
          port1.onmessage = event => { clearTimeout(timer); resolve(event.data) }
          port1.start()
          controller.postMessage({ ...message, v: 1 }, [port2])
        })
        return await result
      } finally { port1.close(); port2.close() }
    }
    const identity = await management({ type: 'identify' })
    if (!identity.ok || !identity.value) throw new Error('Real SW identity was not returned')
    const open = { v: 1, type: 'open', sessionId: crypto.randomUUID(), ownerId: crypto.randomUUID(), secret: crypto.randomUUID(),
      attempt: 1, boot: identity.value.boot, policy, config: { gateways, limits } }
    const modeOpen = await management({ ...open, config: { ...open.config, trustless: !policy.trustless } })
    const mismatchOpen = await management({ ...open, policy: { ...policy, trustless: !policy.trustless } })
    const closeErrors: string[] = []
    const openBinding = async (request: typeof open) => {
      const { port1, port2 } = new MessageChannel()
      try {
        const admitted = await new Promise<Reply>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Real SW binding open timed out')), 10_000)
          port1.onmessage = event => { clearTimeout(timer); resolve(event.data) }
          port1.start()
          controller.postMessage(request, [port2])
        })
        if (!admitted.ok || !admitted.value) throw new Error('Real SW binding was not opened')
        const binding = admitted.value
        let sequence = 0
        const rpc = (type: string, fields: Record<string, unknown> = {}) => exchange(port1, {
          v: 1, type, sequence: ++sequence, sessionId: request.sessionId, bindingId: binding.bindingId, epoch: binding.epoch, ...fields,
        })
        return { binding, rpc, close: async () => {
          try { const closed = await rpc('close'); if (!closed.ok) closeErrors.push(closed.error?.code ?? 'Missing close acknowledgement') }
          finally { port1.close(); port2.close() }
        } }
      } catch (error) { port1.close(); port2.close(); throw error }
    }
    const fetchTicket = (binding: Record<string, unknown>, ticket: unknown) => fetch(new URL(`${blockPath}${cid}`, location.href), {
      method: 'GET', mode: 'same-origin', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store', headers: {
        [headers.version]: '1', [headers.bindingId]: String(binding.bindingId), [headers.epoch]: String(binding.epoch),
        [headers.capability]: String(binding.capability), [headers.blockRequestId]: '1', [headers.ticket]: String(ticket),
      },
    })
    const primary = await openBinding(open)
    let secondary: Awaited<ReturnType<typeof openBinding>> | undefined
    const { rpc, binding } = primary
    try {
      const prepared = await rpc('prepare-block', { blockRequestId: 1, cid })
      if (!prepared.ok || !prepared.value) throw new Error('Real SW ticket was not prepared')
      const beforeFetch = await rpc('read-block', { blockRequestId: 1 })
      await Reflect.get(window, 'swGalleryPrivatePhase')('before-fetch')
      const response = await fetchTicket(binding, prepared.value.ticket)
      const emptyHttp = (await response.arrayBuffer()).byteLength === 0
      const read = await rpc('read-block', { blockRequestId: 1 })
      const value = read.value
      if (!read.ok || !(value?.bytes instanceof ArrayBuffer)) throw new Error('Real SW private bytes were not delivered')
      const bytes = Array.from(new Uint8Array(value.bytes))
      await Reflect.get(window, 'swGalleryPrivatePhase')('after-read')
      const twice = await rpc('read-block', { blockRequestId: 1 })
      await Reflect.get(window, 'swGalleryPrivatePhase')('after-second-read')
      const replay = await fetchTicket(binding, prepared.value.ticket)
      const consumed = await rpc('consume', { blockRequestId: 1 })
      secondary = await openBinding({ ...open, sessionId: crypto.randomUUID(), ownerId: crypto.randomUUID(), secret: crypto.randomUUID() })
      const second = await secondary.rpc('prepare-block', { blockRequestId: 1, cid })
      if (!second.ok || !second.value) throw new Error('Mode probe ticket was not prepared')
      const secondAdmission = await fetchTicket(secondary.binding, second.value.ticket)
      if (secondAdmission.status !== 204 || (await secondAdmission.arrayBuffer()).byteLength !== 0) throw new Error('Mode probe was not genuinely admitted')
      const extraMode = await secondary.rpc('read-block', { blockRequestId: 1, trustless: !policy.trustless, verified: true })
      return { identity: identity.value, modeOpen, mismatchOpen, beforeFetch, extraMode, twice, consumed, closeErrors,
        status: response.status, emptyHttp, replayStatus: replay.status,
        delivery: { keys: Object.keys(value).sort(), cid: value.cid, byteLength: value.byteLength, policy: value.policy, bytes } }
    } finally {
      try { await secondary?.close() }
      finally { await primary.close() }
    }
  }, { cid, gateways, policy, limits: DEFAULT_LIMITS, blockPath: SW_GALLERY_BLOCK_PATH, headers: SW_GALLERY_HEADERS })
}
