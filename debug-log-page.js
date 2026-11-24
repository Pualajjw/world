import React from 'react'
import { LOG_LIMIT, traceText } from './debug-log.js'
import { copyMobileAddress } from './mobile-clipboard.js'
const h = React.createElement, PAGE = 50, levels = { info:'信息', warn:'警告', error:'错误' }
const time = new Intl.DateTimeFormat('zh-CN', {hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false})
export function DebugLogPage({ log, visible }) {
  const [data, setData] = React.useState(() => ({ count:0, skipped:0, rows:[] })), [paused, pause] = React.useState(false)
  const [app, setApp] = React.useState(''), [level, setLevel] = React.useState(''), [query, setQuery] = React.useState('')
  const [page, setPage] = React.useState(0), [notice, setNotice] = React.useState('')
  React.useEffect(() => {
    if (!visible || paused) return
    let timer, controller, lastCount = -1, lastSkipped = -1
    function tick() {
      log.catchUp(controller.signal)
      if (lastCount === log.count && lastSkipped === log.skipped) return
      if (lastCount === log.count) setData(d => ({...d, skipped: log.skipped}))
      else setData(log.snapshot())
      lastCount = log.count; lastSkipped = log.skipped
    }
    function stop() { clearInterval(timer); controller?.abort() }
    function sync() { stop(); if (!document.hidden) { controller = new AbortController(); tick(); timer = setInterval(tick, 300) } }
    sync(); document.addEventListener('visibilitychange', sync)
    return () => { stop(); document.removeEventListener('visibilitychange', sync) }
  }, [log, visible, paused])
  const apps = React.useMemo(() => [...new Set(data.rows.flatMap(r=>[r.from,r.to]))].sort(), [data.rows])
  const filtered = React.useMemo(() => {
    const key = query.trim().toLowerCase()
    return data.rows.filter(r => (!level || level === r.level) && (!app || r.from === app || r.to === app)
      && (!key || `${r.from} ${r.to} ${r.event} #${r.id}`.toLowerCase().includes(key)))
  }, [data.rows, level, app, query])
  const pages = Math.max(1, Math.ceil(filtered.length/PAGE)), current = Math.min(page, pages-1)
  const select = (label, val, set, options) => h('select', {'aria-label':label,value:val,onChange:e=>{set(e.target.value);setPage(0)}},
    h('option',{value:''},label), ...options.map(([key,text])=>h('option',{key,value:key},text)))
  const copy = async id => setNotice(await copyMobileAddress(traceText(data.rows,id)) ? `已复制 #${id} 在缓冲区内的全部记录` : '复制失败，请检查剪贴板权限')
  return h('section',{className:'world-processes','aria-label':'调试日志'},
    h('div',{className:'world-processes-toolbar'},
      select('全部应用',app,setApp, [...new Set([...apps,...(app?[app]:[])])].map(s=>[s,s])),
      select('全部级别',level,setLevel,Object.entries(levels)),
      h('input',{'aria-label':'日志关键词',placeholder:'搜索操作、应用或 #调用号',value:query,onChange:e=>{setQuery(e.target.value);setPage(0)}}),
      h('button',{type:'button','aria-pressed':paused,title:paused?'自动刷新已暂停，点这里继续':'暂停刷新，方便逐一核对',onClick:()=>pause(!paused)},paused?'继续刷新':'暂停刷新')),
    h('p',{className:'world-processes-hint'},`${paused?'已暂停自动刷新 · ':''}当前桌面 · 保留 ${data.rows.length}/${LOG_LIMIT} 条 · 已覆盖 ${Math.max(0,data.count-LOG_LIMIT)} 条 · 已略过 ${data.skipped} 次成功轮询`),
    h('div',{className:'world-processes-table-wrap'},h('table',{className:'world-processes-table world-debug-log-table'},
      h('thead',null,h('tr',null,...['记录时间','级别','来源 → 目标','操作','耗时','调用链'].map(s=>h('th',{key:s},s)))),
      h('tbody',null,...filtered.slice(current*PAGE,(current+1)*PAGE).map(r=>h('tr',{key:r.n},
        h('td',null,time.format(r.time)),h('td',{className:r.level==='error'?'world-processes-error':undefined},levels[r.level]),
        h('td',null,`${r.from} → ${r.to}`),h('td',null,r.event),h('td',null,r.ms==null?'—':`${r.ms} ms`),
        h('td',null,h('button',{type:'button',title:'复制整次调用',onClick:()=>void copy(r.id)},`复制 #${r.id}`)))))),
      !filtered.length && h('p',{className:'world-processes-hint'},data.rows.length?'没有匹配的日志':'尚无日志，试试打开应用或运行工程。')),
    h('footer',{className:'world-processes-toolbar'},h('button',{disabled:current===0,onClick:()=>{const next=current-1;setPage(next);if(!next&&paused)pause(false)}},'上一页'),
      h('span',null,`${current+1} / ${pages}`),h('button',{disabled:current+1>=pages,title:'翻页会暂停自动刷新，回到第 1 页后自动恢复',onClick:()=>{pause(true);setPage(current+1)}},'下一页'),h('span',{role:'status'},notice)))
}
