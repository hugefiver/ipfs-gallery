import { createElement, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'

function ContractPage() {
  const [result, setResult] = useState('waiting')
  useEffect(() => {
    const script = `fetch('https://audit-gateway.invalid/ipfs/test-block?format=raw', {
      headers: { Accept: 'application/vnd.ipld.raw' }
    }).then(response => response.text()).then(text => postMessage(text));`
    const workerUrl = URL.createObjectURL(new Blob([script], { type: 'application/javascript' }))
    const worker = new Worker(workerUrl)
    worker.onmessage = (event: MessageEvent<string>) => setResult(event.data)
    return () => {
      worker.terminate()
      URL.revokeObjectURL(workerUrl)
    }
  }, [])
  return createElement('main', null,
    createElement('h1', null, 'Owned browser contract'),
    createElement('p', { id: 'worker-result' }, result),
    createElement('button', { onClick: () => setResult('updated') }, 'Update'),
  )
}

createRoot(document.getElementById('root')!).render(createElement(ContractPage))
