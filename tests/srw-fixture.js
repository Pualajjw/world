const buttons = Array.from({length: 9}, (_, i) => `type cb_${i + 1} from commandbutton within w_dk
integer x = ${80 + (i % 3) * 740}
integer y = ${100 + Math.floor(i / 3) * 190}
integer width = 457
integer height = 92
string text = "none"
end type
${i === 0 ? 'event clicked;MessageBox("读卡", "卡 1")\nend event' : ''}`)
export const card = `$PBExportHeader$w_dk.srw
forward
global type w_dk from window
end type
type cb_1 from commandbutton within w_dk
end type
end forward
global type w_dk from window
integer width = 2140
integer height = 780
boolean titlebar = true
string title = "请选择读卡内容"
end type
type variables
commandbutton ibts[]
datastore ids
end variables
forward prototypes
public function integer wf_count ()
end prototypes
event open;for i = 1 to upperbound(ibts)
  ibts[i].visible = false
next
end event
public function integer wf_count ();return 9
end function
${buttons.join('\n')}`

// A background frame declared AFTER its foreground controls, as in PB9 exports.
export const layers = `global type w_layers from window
integer width = 1769
integer height = 864
end type
type st_5 from statictext within w_layers
integer width = 900
integer height = 96
string text = "窗口标题"
end type
type st_1 from statictext within w_layers
integer x = 229
integer y = 352
integer width = 279
integer height = 52
string text = "用户账号"
end type
type cb_exit from uo_xpbutton1 within w_layers
integer x = 1280
integer y = 332
integer width = 270
integer height = 92
string text = "确 定"
end type
type dw_logon from datawindow within w_layers
boolean visible = FALSE
integer width = 1381
integer height = 636
end type
type gb_1 from groupbox within w_layers
integer y = 288
integer width = 1755
integer height = 384
string text = "账户信息"
end type
type dw_shown from datawindow within w_layers
integer y = 700
integer width = 220
integer height = 80
end type`

export const sruFiles = {
  'sailjson.sru': `global type sailjson from uo_json_s
end type
global sailjson sailjson
on sailjson.create
end on
public function sailjson addarrayitem (string key);return this
end function`,
  'uo_json_s.sru': `global type uo_json_s from nonvisualobject
end type
type variables
ulong hJson
end variables`,
  'uo_panel.SRU': `global type uo_panel from userobject
integer width = 2140
integer height = 780
end type
type cb_apply from commandbutton within uo_panel
integer width = 457
integer height = 92
string text = "应用"
end type
event clicked;return
end event`,
}
