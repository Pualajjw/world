import React from 'react'
import { worldConfirm } from './world-confirm.js'
const h = React.createElement
const changed = 'world-startup-change'
async function call(rpc,op,payload,signal) {
  const r = await rpc.call('/api',`world-startup/${op}`,payload,signal)
  if (!r?.ok) throw Error(r?.error?.message || '无法访问 World 启动项。')
  return r.value
}
// No sampling: fetch on open, on return to the page, or after a local settings change.
function useStartup(rpc,visible,id) {
  const [data,setData]=React.useState(null), [error,setError]=React.useState(''), [busy,setBusy]=React.useState(false)
  const [revision,refresh]=React.useReducer(n=>n+1,0), write=React.useRef(null), version=React.useRef(0)
  React.useEffect(()=>()=>write.current?.abort(),[])
  React.useEffect(()=>{
    if (!visible) return
    window.addEventListener(changed,refresh); window.addEventListener('focus',refresh)
    return ()=>{window.removeEventListener(changed,refresh); window.removeEventListener('focus',refresh)}
  },[visible])
  React.useEffect(()=>{
    if (!visible) return
    if (write.current) return
    const c=new AbortController(), generation=version.current
    const current=()=>!c.signal.aborted && generation===version.current
    call(rpc,id?'get':'list',id?{id}:{},c.signal).then(value=>{if (current()) {setData(value);setError('')}})
      .catch(e=>{if (current()) setError(e.message)})
    return ()=>c.abort()
  },[rpc,visible,id,revision])
  async function set(key,state) {
    if (write.current) return
    const previous=data, c=new AbortController(); version.current++;write.current=c;setBusy(true);setError('')
    if (id) setData({state}) // reflect checkbox input immediately; roll back on a failed save.
    try {
      const result=await call(rpc,'set',{id:key,state},c.signal)
      if (!c.signal.aborted) {
        if (id) setData(result); else setData(rows=>rows?.map(row=>row.id===key?{...row,state:result.state}:row))
        window.dispatchEvent(new Event(changed))
      }
    } catch(e) {if (!c.signal.aborted) {if (id) setData(previous);setError(e.message)}}
    finally {write.current=null;if (!c.signal.aborted) setBusy(false)}
  }
  return {data,error,busy,set,refresh}
}
export function MobileStartup({rpc,ready}) {
  const {data,error,busy,set,refresh}=useStartup(rpc,true,'mobile')
  const enabled=data?.state==='enabled'
  return h(React.Fragment,null,h('label',{className:'world-mobile-network'},
    h('input',{type:'checkbox',checked:enabled,'aria-busy':busy,disabled:!data || (!enabled && !ready),
      onChange:e=>void set('mobile',e.target.checked?'enabled':'disabled')}),'随 World 启动手机连接'),
    error && h('p',{role:'alert'},error,' ',h('button',{type:'button',onClick:refresh},'重试读取')))
}
export function StartupPage({rpc,visible}) {
  const {data,error,busy,set,refresh}=useStartup(rpc,visible)
  const listed=data?.filter(row=>row.state!=='removed'), other=data?.filter(row=>row.state==='removed')
  const remove=async row=>{if (await worldConfirm({title:'删除启动项',message:`从启动列表删除「${row.name}」？`,
    detail:'不会卸载应用、清除配置或停止当前连接。',confirmLabel:'删除启动项'})) await set(row.id,'removed')}
  const rowView=row=>h('div',{key:row.id,className:'world-processes-toolbar',role:'group','aria-label':row.name},
    h('strong',null,row.name), h('span',null,({enabled:'已启用',disabled:'已关闭',removed:'未加入',unavailable:'配置读取失败'})[row.state]),
    row.failed && h('span',null,'本次自动启动失败'),
    h('button',{type:'button',disabled:busy || row.state==='unavailable',onClick:()=>set(row.id,row.state==='enabled'?'disabled':'enabled')},
      row.state==='enabled'?'关闭':row.state==='removed'?'加入并启用':'启用'),
    row.state!=='removed' && h('button',{type:'button',disabled:busy || row.state==='unavailable',onClick:()=>void remove(row)},'删除'))
  return h('section',{className:'world-storage','aria-label':'随 World 启动'},
    h('div',{className:'world-storage-heading'},h('strong',null,'随 World 启动'),h('button',{type:'button',disabled:busy,onClick:refresh},'刷新')),
    h('p',{className:'world-processes-hint'},'更改在下次 World 后台启动时生效，不会立即启动或停止应用。上次桌面窗口的恢复不属于启动项。'),
    error && h('p',{role:'alert',className:'world-processes-error'},error),
    !data && !error && h('p',{role:'status'},'正在读取启动项…'),
    listed?.map(rowView),listed?.length===0 && h('p',null,'没有已登记的启动项。'),
    !!other?.length && h('details',null,h('summary',null,'可添加的应用'),other.map(rowView)))
}
