import React from 'react'
import { worldConfirm } from './world-confirm.js'

// The catalog row and the keyboard-search result run the same confirmed action.
export function usePbnpmEntry(rpc, menuOpen, showNotice, showError) {
  const [info, setInfo] = React.useState(null), [busy, setBusy] = React.useState(false)
  const lock = React.useRef(false)
  const call = React.useCallback(async (op, payload = {}, signal) => {
    const result = await rpc.call('/api', `world-pbnpm/${op}`, payload, signal)
    if (!result?.ok) throw new Error(result?.error?.message || 'pbnpm 安装服务不可用')
    return result.value
  }, [rpc])
  React.useEffect(() => {
    if (!menuOpen || busy) return
    const controller = new AbortController()
    call('info', {}, controller.signal).then(value => { if (!controller.signal.aborted) setInfo(value) },
      e => { if (!controller.signal.aborted) setInfo({ error: e.message }) })
    return () => controller.abort()
  }, [call, menuOpen, busy])
  const open = async () => {
    if (lock.current) return
    lock.current = true; setBusy(true)
    try {
      const plan = await call('prepare'); setInfo(plan)
      const action = plan.installedVersion ? '重装' : '安装'
      if (!await worldConfirm({ title: `${action} pbnpm`, confirmLabel: `确认${action}`,
        message: `从${plan.source}安装 pbnpm v${plan.version}？`,
        detail: plan.installedVersion ? `已安装 v${plan.installedVersion}。${plan.enabled === false ? '重装后仍保持禁用。' : ''}${plan.version === plan.installedVersion ? '将重新安装同一版本。' : `将替换为 v${plan.version}。`}` : '安装到当前 DSH，按宿主提示重启生效。' })) return
      const result = await call('install', { token: plan.token, confirmed: true }); setInfo(result)
      showNotice(`pbnpm v${result.installedVersion} 已${action}${result.restartRequired ? '，请重启 DSH' : ''}`)
    } catch (e) { showError(e.message) } finally { lock.current = false; setBusy(false) }
  }
  const version = info?.installedVersion || info?.version
  const label = `pbnpm${version ? ` v${version}` : ''}`
  const action = busy || info?.installing ? '处理中…' : info?.installedVersion ? '重装' : '安装'
  const note = [info?.installedVersion && (info.enabled === false ? '已禁用' : '已安装'), info?.error || info?.source || '开发 pbpkg 优先 · Gitee 直连'].filter(Boolean).join(' · ')
  return { key: 'install:pbnpm', label, note, action, busy, open }
}
