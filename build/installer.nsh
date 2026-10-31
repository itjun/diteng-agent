# ============================================================================
# build/installer.nsh — diteng agent 安装器自定义皮肤（electron-builder 默认自动引入）
#
# 设计语言：米白底 #FAF8F1 + 帝擎绿 #1C803E（与应用图标/官网/登录页一致）
# 结构：原生标题栏（Win11 DWM 着米白、窗口图标即品牌绿 D 标）+
#       整页自绘底图 + 透明静态控件叠加 + 原生按钮重排
# 页面：欢迎(自绘) → 安装模式(重绘) → 目录(重绘) → 进度(重绘+清单) → 完成(自绘)
# 底图由 scripts/make-installer-art.ps1 生成于 build/installer/*.bmp
# 静默模式(/S) 不执行任何 UI 代码，自动更新链路不受影响。
# ============================================================================

# ---- 页面钩子接线（必须在本文件顶部、页面宏插入之前定义；MUI 用后即 undef）----
; GUIINIT：模板未占用，做全局窗体改肤
!define MUI_CUSTOMFUNCTION_GUIINIT dtGuiInit
!define MUI_CUSTOMFUNCTION_UNGUIINIT un.dtGuiInit

; 安装模式页 SHOW/LEAVE：PAGE_INSTALL_MODE 是首个 MUI 消费者
; （LEAVE 在离开模式页时执行，此时目录页即将显示，正好用于目录控件重排）
!ifndef DITENG_NO_MODE_HOOKS
  !ifdef BUILD_UNINSTALLER
    !define MUI_PAGE_CUSTOMFUNCTION_SHOW un.dtModeShow
  !else
    !define MUI_PAGE_CUSTOMFUNCTION_SHOW dtModeShow
    !define MUI_PAGE_CUSTOMFUNCTION_LEAVE dtModeLeave
  !endif
!endif

; MUI 全局底色/文字色（先于 MUI_INTERFACE 的 MUI_DEFAULT，天然接管头部区域）
!define MUI_BGCOLOR   0xF1F8FA   ; #FAF8F1 的 BGR
!define MUI_TEXTCOLOR 0x272E1F   ; #1F2E27 的 BGR

# ---- 设计令牌 ----
!define DITENG_CREAM     0xF1F8FA
!define DITENG_INK       0x272E1F
!define DITENG_SECONDARY 0x636B5C   ; #5C6B63 的 BGR
!define DITENG_MUTED     0x8A968F
!define DITENG_GREEN     0x3E801C   ; #1C803E 的 BGR
!define DITENG_TRACK     0xE7EFE4   ; 进度条轨道 #E4EFE7 的 BGR
!define DITENG_BORDER    0xD6E0D9
!define DITENG_W 620
!define DITENG_H 420

# ---- 资源目录 ----
!ifdef BUILD_RESOURCES_DIR
  !define DITENG_RES "${BUILD_RESOURCES_DIR}\installer"
!else
  !define DITENG_RES "build\installer"
!endif

# ---- 常量（自带数值，避免依赖头文件包含顺序）----
!define DITENG_WM_SETTEXT   0x0C
!define DITENG_WM_SETFONT   0x30
!define DITENG_WM_COMMAND   0x111
!define DITENG_SW_HIDE      0
!define DITENG_SW_SHOW      5
!define DITENG_SWP_NOMOVE   0x2
!define DITENG_SWP_NOZORDER 0x4
!define DITENG_SWP_NOACTIVATE 0x10
!define DITENG_WS_CHILD     0x40000000
!define DITENG_WS_VISIBLE   0x10000000
!define DITENG_SS_NOTIFY    0x80
!define DITENG_SS_CENTER    0x1
!define DITENG_SS_CENTERIMAGE 0x200
!define DITENG_BST_CHECKED  1
; 自绘热点按钮静态控件样式：WS_CHILD|WS_VISIBLE|SS_NOTIFY|SS_CENTER|SS_CENTERIMAGE
!define DITENG_STYLE_HOTBTN "0x50000281"
; 步骤文字标签：WS_CHILD|WS_VISIBLE|SS_LEFT
!define DITENG_STYLE_LABEL  "0x50000000"

# ---- 全局变量 ----
Var dtLogN           ; 诊断日志行号
Var dtBaseX          ; 对话框水平基准单位（像素→对话框单位换算）
Var dtBaseY
Var dtFontBtn        ; 按钮 15px≈11pt
Var dtFontLbl        ; 标签 13px≈10pt
Var dtFontSm         ; 弱文字 12px≈9pt
Var dtFontBold       ; 加粗标签 13px≈10pt
Var dtFormBg         ; 常驻整页底图（模式/目录/进度页共用，仅换图）

# 安装趟专用变量（卸载趟引用不到，须隔离避免 -WX 6001）
!ifndef BUILD_UNINSTALLER
  Var dtWelDlg         ; 欢迎页 nsDialogs 对话框
  Var dtWelBg
  Var dtWelImg
  Var dtWelBtn         ; “开始安装”位图真按钮（id 1 = 下一步语义）
  Var dtWelBtnImg
Var dtDirTitle       ; 目录页“安装位置”标题
Var dtStep1          ; 进度页步骤标签
  Var dtStep2
  Var dtStep3
  Var dtFinDlg         ; 完成页
  Var dtFinBg
  Var dtFinImg
  Var dtFinRun         ; 立即运行复选框
  Var dtFinBtn
  Var dtFinBtnImg
!endif

# 卸载趟专用变量（避免安装器趟 6001 未引用警告）
!ifdef BUILD_UNINSTALLER
  Var dtUnDlg          ; 卸载欢迎页
  Var dtUnBg
  Var dtUnImg
  Var dtUnBtn
  Var dtUnBtnImg
!endif

# ============================================================================
# 底图提取（安装器与卸载器共用）
# ============================================================================
!macro DITENG_EXTRACT_ART
  InitPluginsDir
  File /oname=$PLUGINSDIR\dt-welcome.bmp   "${DITENG_RES}\welcome.bmp"
  File /oname=$PLUGINSDIR\dt-progress.bmp  "${DITENG_RES}\progress.bmp"
  File /oname=$PLUGINSDIR\dt-finish.bmp    "${DITENG_RES}\finish.bmp"
  File /oname=$PLUGINSDIR\dt-unwelcome.bmp "${DITENG_RES}\un-welcome.bmp"
  File /oname=$PLUGINSDIR\dt-form.bmp       "${DITENG_RES}\form.bmp"
  File /oname=$PLUGINSDIR\dt-btn-start.bmp  "${DITENG_RES}\btn-start.bmp"
  File /oname=$PLUGINSDIR\dt-btn-finish.bmp "${DITENG_RES}\btn-finish.bmp"
  File /oname=$PLUGINSDIR\dt-btn-un.bmp     "${DITENG_RES}\btn-un.bmp"
!macroend

!macro customInit
  ; 诊断模式：存在标记时预建日志文件（NSIS FileOpen a 首次写入会丢失）
  IfFileExists "$TEMP\dt-skin-debug" 0 +4
    FileOpen $9 "$TEMP\dt-skin.log" w
    FileWrite $9 "---- session start ----$\r$\n"
    FileClose $9
  !insertmacro DITENG_EXTRACT_ART
!macroend

!macro customUnInit
  !insertmacro DITENG_EXTRACT_ART
!macroend

# ---------- 通用小工具 ----------
; 像素 → 对话框单位字符串（nsDialogs 控件坐标用）
; 诊断日志：存在 %TEMP%\dt-skin-debug 标记时写入 %TEMP%\dt-skin.log
!macro dtLog MSG
  IfFileExists "$TEMP\dt-skin-debug" 0 +7
    IntOp $dtLogN $dtLogN + 1
    FileOpen $9 "$TEMP\dt-skin-$dtLogN.log" w
    FileWrite $9 "${MSG}"
    FileClose $9
!macroend

!macro dtDuX PX OUT
  IntOp ${OUT} ${PX} * 4
  IntOp ${OUT} ${OUT} / $dtBaseX
!macroend
!macro dtDuY PX OUT
  IntOp ${OUT} ${PX} * 8
  IntOp ${OUT} ${OUT} / $dtBaseY
!macroend

; 获取 outer 子控件句柄（失败返回 0）
!macro dtGetOuterCtl ID OUT
  System::Call 'user32::GetDlgItem(p $HWNDPARENT, i ${ID}) p.s'
  Pop ${OUT}
!macroend

!macro dtMoveWindow HWND X Y W H
  System::Call 'user32::MoveWindow(p ${HWND}, i ${X}, i ${Y}, i ${W}, i ${H}, i 1) i'
!macroend

!macro dtHideCtl ID
  !insertmacro dtGetOuterCtl ${ID} $1
  ${If} $1 != 0
    !insertmacro dtHide $1
  ${EndIf}
!macroend

!macro dtHide HWND
  System::Call 'user32::ShowWindow(p ${HWND}, i ${DITENG_SW_HIDE}) i'
!macroend
!macro dtShow HWND
  System::Call 'user32::ShowWindow(p ${HWND}, i ${DITENG_SW_SHOW}) i'
!macroend

!macro dtSetFont HWND FONT
  SendMessage ${HWND} ${DITENG_WM_SETFONT} ${FONT} 0
!macroend

; 在内层对话框上创建显示型静态标签（像素坐标）
!macro dtCreateLabel VAR X Y W H TEXT
  System::Call 'user32::CreateWindowExW(i 0, t "STATIC", t "${TEXT}", i ${DITENG_STYLE_LABEL}, i ${X}, i ${Y}, i ${W}, i ${H}, p $HWNDPARENT, i 0, p 0, p 0) p.s'
  Pop $${VAR}
!macroend


; （NSIS 3.0.4.1 无独立内层对话框：页面控件直接挂在外层，改色走窗口类刷子）

!macro dtCreamCtl ID
  !insertmacro dtGetOuterCtl ${ID} $0
  ${If} $0 != 0
    SetCtlColors $0 "" ${DITENG_CREAM}
  ${EndIf}
!macroend

; 目录页灰底喷涂：外层自身 + 全部已知模板静态/容器统一米白
!macro dtCreamDirPage
  SetCtlColors $HWNDPARENT "" ${DITENG_CREAM}
  !insertmacro dtCreamCtl 1006
  !insertmacro dtCreamCtl 1020
  !insertmacro dtCreamCtl 1023
  !insertmacro dtCreamCtl 1024
  !insertmacro dtCreamCtl 1018
  !insertmacro dtCreamCtl 1044
  !insertmacro dtCreamCtl 1036
  !insertmacro dtCreamCtl 1035
  !insertmacro dtCreamCtl 1045
  !insertmacro dtCreamCtl 1034
!macroend

!macro dtCreateFormBg
  ; 常驻整页底图：一次创建，z 序插在 1044 灰色底板之上（NSIS 会重新显示 1044
  ; 且改色无效，只能用画面盖住它）、其余交互控件之下；此后仅 STM_SETIMAGE 换图
  ${If} $dtFormBg == 0
    System::Call 'user32::CreateWindowExW(i 0, t "STATIC", t "", i 0x5000000E, i 0, i 0, i ${DITENG_W}, i ${DITENG_H}, p $HWNDPARENT, i 0, p 0, p 0) p.s'
    Pop $dtFormBg
    !insertmacro dtGetOuterCtl 1044 $2
    ${If} $2 == 0
      StrCpy $2 1
    ${EndIf}
    System::Call 'user32::SetWindowPos(p $dtFormBg, p r2, i 0, i 0, i 0, i 0, i 0x13) i'
  ${EndIf}
!macroend

!macro dtSetPageImg BMP
  ; 切换常驻底图（旧句柄由 STM_SETIMAGE 返回后释放）
  !insertmacro dtCreateFormBg
  System::Call 'user32::LoadImageW(p 0, t "${BMP}", i 0, i 0, i 0, i 0x2010) p.s'
  Pop $2
  System::Call 'user32::SendMessageW(p $dtFormBg, i 0x172, i 0, p r2) p.s'
  Pop $3
  ${If} $3 != 0
    System::Call 'gdi32::DeleteObject(p $3) i'
  ${EndIf}
!macroend

!macro dtCreateBmpBtn VAR ID BMP X Y W H
  ; 外层真实按钮 + BS_BITMAP 显示药丸按钮图：原生点击/回车全通，
  ; id=1 即 NSIS 的“下一步”语义（点击 = 翻页）；VAR 传裸变量名
  System::Call 'user32::CreateWindowExW(i 0, t "BUTTON", t "", i 0x50000080, i ${X}, i ${Y}, i ${W}, i ${H}, p $HWNDPARENT, i ${ID}, p 0, p 0) p.s'
  Pop $${VAR}
  System::Call 'user32::LoadImageW(p 0, t "${BMP}", i 0, i 0, i 0, i 0x2010) p.s'
  Pop $${VAR}Img
  System::Call 'user32::SendMessageW(p $${VAR}, i 0xF7, i 0, p $${VAR}Img) p'   ; BM_SETIMAGE
  ; 页面显示时 NSIS 可能把页面区控件置顶，按钮显式压回最上，避免点击被整页位图吞掉
  System::Call 'user32::SetWindowPos(p $${VAR}, p 0, i 0, i 0, i 0, i 0, i 0x13) i'   ; HWND_TOP|NOSIZE|NOMOVE
!macroend

!macro DITENG_GUIINIT_BODY
  ; 对话框单位基准
  System::Call 'user32::GetDialogBaseUnits() i .r0'
  IntOp $dtBaseX $0 & 0xFFFF
  IntOp $dtBaseY $0 >> 16

  ; 字体（NSIS CreateFont 以磅为单位；96dpi 下 1pt ≈ 1.333px）
  CreateFont $dtFontBtn  "Microsoft YaHei UI" 11 400
  CreateFont $dtFontLbl  "Microsoft YaHei UI" 10 400
  CreateFont $dtFontSm   "Microsoft YaHei UI" 9  400
  CreateFont $dtFontBold "Microsoft YaHei UI" 10 700

  ; 窗口尺寸：客户区 DITENG_W x DITENG_H（按当前窗口样式计算外框）
  System::Call 'user32::GetWindowLongW(p $HWNDPARENT, i -16) i.r1'   ; GWL_STYLE
  System::Call 'user32::GetWindowLongW(p $HWNDPARENT, i -20) i.r2'   ; GWL_EXSTYLE
  System::Alloc 16
  Pop $3
  System::Call '*$3(i 0, i 0, i ${DITENG_W}, i ${DITENG_H})'
  System::Call 'user32::AdjustWindowRectEx(p $3, i r1, i 0, i r2) i'
  System::Call '*$3(i .r4, i .r5, i .r6, i .r7)'
  System::Free $3
  IntOp $8 $6 - $4    ; 宽
  IntOp $9 $7 - $5    ; 高
  System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i 0, i 0, i r8, i r9, i ${DITENG_SWP_NOMOVE}|${DITENG_SWP_NOZORDER}|${DITENG_SWP_NOACTIVATE}) i'

  ; 页面底色：外层对话框窗口类刷子改米白（页面控件直接挂在外层，一刷全白）
  System::Call 'gdi32::CreateSolidBrush(i ${DITENG_CREAM}) p.s'
  Pop $1
  System::Call 'user32::SetClassLongW(p $HWNDPARENT, i -10, p r1) i'   ; GCL_HBRBACKGROUND

  ; 一体化标题栏：去掉原生“最小化/最大化/关闭”三按钮（保留标题带可拖拽；
  ; 关闭由各页“取消安装”承担，Alt+F4 仍可用）
  System::Call 'user32::GetWindowLongW(p $HWNDPARENT, i -16) i.r1'
  IntOp $1 $1 & 0xFFF0FFFF   ; 清 WS_SYSMENU|WS_MINIMIZEBOX|WS_MAXIMIZEBOX
  System::Call 'user32::SetWindowLongW(p $HWNDPARENT, i -16, i r1) i'
  System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i 0, i 0, i 0, i 0, i 0x27) i'   ; FRAMECHANGED|NOMOVE|NOSIZE|NOZORDER

  ; Win11：DWM 标题栏/文字/边框着色（旧系统调用失败即维持原生外观）
  System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 35, *i ${DITENG_CREAM}, i 4) i'
  System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 36, *i ${DITENG_INK},   i 4) i'
  System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 34, *i ${DITENG_BORDER}, i 4) i'

  ; 内层 #32770 在首个页面显示前还不存在，页面函数里通过 dtEnsureInner 惰性解析
  ; （此处仅处理外层能做的事，内层铺满/1018/改色全部移入 dtEnsureInner）

  ; 隐藏 MUI 头部/品牌行/1018 占位等全部模板装饰（自绘页面自带标题体系）
  ; 会被 NSIS 页面显示重新 Show 的控件（1018/1036/1044/1006/1016）只改色不隐藏
  !insertmacro dtCreamCtl 1018
  !insertmacro dtCreamCtl 1036
  !insertmacro dtCreamCtl 1044
  !insertmacro dtHideCtl 1034
  !insertmacro dtHideCtl 1037
  !insertmacro dtHideCtl 1038
  !insertmacro dtHideCtl 1039
  !insertmacro dtHideCtl 1045
  !insertmacro dtHideCtl 1035
  !insertmacro dtHideCtl 1028
  !insertmacro dtHideCtl 1256

  ; 进度条(1004)提前挪到底图轨道位（避免页面时序导致双进度条观感）
  !insertmacro dtGetOuterCtl 1004 $1
  ${If} $1 != 0
    !insertmacro dtMoveWindow $1 40 312 540 10
  ${EndIf}

  ; 底部按钮重排：下一步(1) 右侧主位，取消(2) 左移成次按钮，后退(3) 隐藏
  !insertmacro dtGetOuterCtl 1 $1
  ${If} $1 != 0
    !insertmacro dtMoveWindow $1 448 356 132 44
    !insertmacro dtSetFont $1 $dtFontBtn
    SetCtlColors $1 ${DITENG_INK} transparent
  ${EndIf}
  !insertmacro dtGetOuterCtl 2 $1
  ${If} $1 != 0
    !insertmacro dtMoveWindow $1 300 356 132 44
    !insertmacro dtSetFont $1 $dtFontBtn
    SetCtlColors $1 ${DITENG_SECONDARY} transparent
    System::Call 'user32::SetWindowTextW(p $1, t "取消安装") i'
  ${EndIf}
  !insertmacro dtGetOuterCtl 3 $1
  ${If} $1 != 0
    !insertmacro dtMoveWindow $1 -600 -600 100 28
  ${EndIf}
!macroend


# ============================================================================
# 页面声明钩子（编译期插入到模板对应位置）
# ============================================================================
!macro customWelcomePage
  Page custom dtWelcomeCreate dtWelcomeLeave
!macroend

; 展开点位于目录页与 INSTFILES 之间：借此处为 INSTFILES 定义 SHOW 钩子
!macro customPageAfterChangeDir
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW dtInstFilesShow
!macroend

!macro customFinishPage
  Page custom dtFinishCreate dtFinishLeave
!macroend

!macro customUnWelcomePage
  UninstPage custom un.dtUnWelcomeCreate un.dtUnWelcomeLeave
!macroend

# ============================================================================
# 以下是函数定义（放在 customHeader：位于全部页面与变量声明之后，
# 才能引用 $MultiUser.* / $launchLink 等模板变量；函数可先调用后定义）
# ============================================================================
!macro customHeader

  Caption "欢迎使用 diteng agent"
  UninstallCaption "卸载 diteng agent"
  BrandingText ""
  ShowInstDetails nevershow
  InstProgressFlags smooth colored
  InstallColors ${DITENG_GREEN} ${DITENG_TRACK}

  # ---------- 全局窗体改肤（安装器与卸载器共用主体）----------
  ; 注意：MUI 在卸载器编译趟也会生成 .onGUIInit 引用本函数，必须两趟都编译
  Function dtGuiInit
    !insertmacro dtLog "guiinit enter"
    IfSilent dt_guiinit_done
    !insertmacro DITENG_GUIINIT_BODY
    dt_guiinit_done:
  FunctionEnd

  !ifndef BUILD_UNINSTALLER
  Function dtEnsureInner
    ; no-op：无内层概念，页面底色由 GUIINIT 的窗口类刷子统一处理
  FunctionEnd
  !endif

  !ifdef BUILD_UNINSTALLER
  Function un.dtGuiInit
    IfSilent un_guiinit_done
    !insertmacro DITENG_GUIINIT_BODY
    ; 卸载器完成按钮（MUI_UNPAGE_FINISH 的确定按钮即 id 1）沿用主位样式
    un_guiinit_done:
  FunctionEnd

  ; 卸载侧：INSTFILES 控件一次性重排（控件直接挂在外层）
  Function un.dtEnsureInner
    !insertmacro dtGetOuterCtl 1004 $1   ; 进度条
    ${If} $1 != 0
      !insertmacro dtMoveWindow $1 40 312 540 10
    ${EndIf}
    !insertmacro dtGetOuterCtl 1006 $1   ; 状态文字
    ${If} $1 != 0
      !insertmacro dtMoveWindow $1 40 334 420 18
      !insertmacro dtSetFont $1 $dtFontSm
      SetCtlColors $1 ${DITENG_MUTED} transparent
    ${EndIf}
    !insertmacro dtGetOuterCtl 1027 $1   ; 显示详情按钮
    ${If} $1 != 0
      !insertmacro dtHide $1
    ${EndIf}
    !insertmacro dtGetOuterCtl 1016 $1   ; 详情列表
    ${If} $1 != 0
      !insertmacro dtHide $1
    ${EndIf}
  FunctionEnd
  !endif

  !ifndef BUILD_UNINSTALLER
  # ---------- 欢迎页（自绘）----------
  Function dtWelcomeCreate
    nsDialogs::Create 1018
    Pop $dtWelDlg
    ; 内层宿主以 NSD 对话框的父窗口解析，随后两者都铺满整页
    Call dtEnsureInner
    !insertmacro dtMoveWindow $dtWelDlg 0 0 ${DITENG_W} ${DITENG_H}

    ; 校准 nsDialogs 的 du→px 换算（对话框字体基准 ≠ 系统基准，用 100u 探针实测）
    ${NSD_CreateLabel} "0u" "0u" "100u" "100u" ""
    Pop $9
    System::Alloc 16
    Pop $4
    System::Call 'user32::GetWindowRect(p $9, p $4) i'
    System::Call '*$4(i .r5, i .r6, i .r7, i .r8)'
    System::Free $4
    IntOp $7 $7 - $5
    IntOp $8 $8 - $6
    System::Call 'user32::DestroyWindow(p $9) i'
    ${If} $7 > 0
    ${AndIf} $8 > 0
      IntOp $dtBaseX $7 * 4
      IntOp $dtBaseX $dtBaseX / 100
      IntOp $dtBaseY $8 * 8
      IntOp $dtBaseY $dtBaseY / 100
    ${EndIf}
    !ifdef DITENG_DEBUG
      System::Call 'user32::SetWindowTextW(p $HWNDPARENT, t "CAL probe=$7,$8 base=$dtBaseX,$dtBaseY") i'
    !endif

    ; 整页底图（System 直建 SS_BITMAP 静态 + 手动挂图，最先创建即位于最底层）
    System::Call 'user32::CreateWindowExW(i 0, t "STATIC", t "", i 0x5000000E, i 0, i 0, i ${DITENG_W}, i ${DITENG_H}, p $dtWelDlg, i 0, p 0, p 0) p.s'
    Pop $dtWelBg
    System::Call 'user32::LoadImageW(p 0, t "$PLUGINSDIR\dt-welcome.bmp", i 0, i 0, i 0, i 0x2010) p.s'
    Pop $dtWelImg
    System::Call 'user32::SendMessageW(p $dtWelBg, i 0x172, i 0, p $dtWelImg) p'   ; STM_SETIMAGE

    ; “开始安装”= 真实位图按钮（id 1，点击/回车即翻页）
    !insertmacro dtCreateBmpBtn dtWelBtn 1 "$PLUGINSDIR\dt-btn-start.bmp" 448 356 132 44

    ; 真实“下一步”藏到屏幕外：NSIS 在页面显示后会重新 Show 它，但不会重新定位
    !insertmacro dtGetOuterCtl 1 $0
    ${If} $0 != 0
      !insertmacro dtMoveWindow $0 -600 -600 132 44
    ${EndIf}

    nsDialogs::Show
  FunctionEnd

  Function dtWelcomeLeave
    System::Call 'user32::DestroyWindow(p $dtWelBtn) i'
    StrCpy $dtWelBtn 0
    ${If} $dtWelBtnImg != 0
      System::Call 'gdi32::DeleteObject(p $dtWelBtnImg) i'
      StrCpy $dtWelBtnImg 0
    ${EndIf}
    ${If} $dtWelImg != 0
      System::Call 'gdi32::DeleteObject(p $dtWelImg) i'
      StrCpy $dtWelImg 0
    ${EndIf}
    !insertmacro dtGetOuterCtl 1 $0
    ${If} $0 != 0
      !insertmacro dtMoveWindow $0 448 356 132 44
      !insertmacro dtShow $0
    ${EndIf}
  FunctionEnd

  # ---------- 安装模式页（重绘 nsDialogs 控件）----------
  Function dtModeShow
    !insertmacro dtLog "modeShow enter mu=$MultiUser.InstallModePage"
    Call dtEnsureInner
    !insertmacro dtSetPageImg "$PLUGINSDIR\dt-form.bmp"
    ${If} $MultiUser.InstallModePage != 0
      !insertmacro dtMoveWindow $MultiUser.InstallModePage 0 0 ${DITENG_W} ${DITENG_H}
      SetCtlColors $MultiUser.InstallModePage "" ${DITENG_CREAM}
    ${EndIf}
    ${If} $MultiUser.InstallModePage.Text != 0
      !insertmacro dtMoveWindow $MultiUser.InstallModePage.Text 40 64 500 24
      !insertmacro dtSetFont $MultiUser.InstallModePage.Text $dtFontLbl
      SetCtlColors $MultiUser.InstallModePage.Text ${DITENG_INK} transparent
    ${EndIf}
    ${If} $MultiUser.InstallModePage.AllUsers != 0
      !insertmacro dtMoveWindow $MultiUser.InstallModePage.AllUsers 40 108 500 24
      !insertmacro dtSetFont $MultiUser.InstallModePage.AllUsers $dtFontLbl
      SetCtlColors $MultiUser.InstallModePage.AllUsers ${DITENG_INK} transparent
    ${EndIf}
    ${If} $MultiUser.InstallModePage.CurrentUser != 0
      !insertmacro dtMoveWindow $MultiUser.InstallModePage.CurrentUser 40 146 500 24
      !insertmacro dtSetFont $MultiUser.InstallModePage.CurrentUser $dtFontLbl
      SetCtlColors $MultiUser.InstallModePage.CurrentUser ${DITENG_INK} transparent
    ${EndIf}
    ${If} $RadioButtonLabel1 != 0
      !insertmacro dtMoveWindow $RadioButtonLabel1 40 190 500 60
      !insertmacro dtSetFont $RadioButtonLabel1 $dtFontSm
      SetCtlColors $RadioButtonLabel1 ${DITENG_SECONDARY} transparent
    ${EndIf}
    ; 下一步按钮文案
    !insertmacro dtGetOuterCtl 1 $0
    ${If} $0 != 0
      System::Call 'user32::SetWindowTextW(p $0, t "下一步") i'
    ${EndIf}
  FunctionEnd

  !endif ; 欢迎页~安装模式页（安装器趟）

  !ifdef BUILD_UNINSTALLER
  Function un.dtModeShow
    Call un.dtEnsureInner
    !insertmacro dtSetPageImg "$PLUGINSDIR\dt-form.bmp"
    ${If} $MultiUser.InstallModePage != 0
      !insertmacro dtMoveWindow $MultiUser.InstallModePage 0 0 ${DITENG_W} ${DITENG_H}
      SetCtlColors $MultiUser.InstallModePage "" ${DITENG_CREAM}
    ${EndIf}
    ${If} $MultiUser.InstallModePage.Text != 0
      !insertmacro dtMoveWindow $MultiUser.InstallModePage.Text 40 64 500 24
      !insertmacro dtSetFont $MultiUser.InstallModePage.Text $dtFontLbl
      SetCtlColors $MultiUser.InstallModePage.Text ${DITENG_INK} transparent
    ${EndIf}
    ${If} $MultiUser.InstallModePage.AllUsers != 0
      !insertmacro dtMoveWindow $MultiUser.InstallModePage.AllUsers 40 108 500 24
      !insertmacro dtSetFont $MultiUser.InstallModePage.AllUsers $dtFontLbl
      SetCtlColors $MultiUser.InstallModePage.AllUsers ${DITENG_INK} transparent
    ${EndIf}
    ${If} $MultiUser.InstallModePage.CurrentUser != 0
      !insertmacro dtMoveWindow $MultiUser.InstallModePage.CurrentUser 40 146 500 24
      !insertmacro dtSetFont $MultiUser.InstallModePage.CurrentUser $dtFontLbl
      SetCtlColors $MultiUser.InstallModePage.CurrentUser ${DITENG_INK} transparent
    ${EndIf}
    ${If} $RadioButtonLabel1 != 0
      !insertmacro dtMoveWindow $RadioButtonLabel1 40 190 500 60
      !insertmacro dtSetFont $RadioButtonLabel1 $dtFontSm
      SetCtlColors $RadioButtonLabel1 ${DITENG_SECONDARY} transparent
    ${EndIf}
  FunctionEnd
  !endif ; BUILD_UNINSTALLER（卸载器模式页）

  !ifndef BUILD_UNINSTALLER
  ; 离开模式页 = 目录页即将显示：重排目录页模板控件
  Function dtModeLeave
    !insertmacro dtLog "modeLeave enter"
    Call dtEnsureInner
    !insertmacro dtSetPageImg "$PLUGINSDIR\dt-form.bmp"
    ; NSIS 会在目录页创建时重设说明文字——直接隐藏 1006 长句与 1020 组框，用自己的标签
    !insertmacro dtGetOuterCtl 1006 $0
    ${If} $0 != 0
      !insertmacro dtHide $0
    ${EndIf}
    !insertmacro dtGetOuterCtl 1020 $0
    ${If} $0 != 0
      !insertmacro dtHide $0
    ${EndIf}
    !insertmacro dtCreateLabel dtDirTitle 40 64 300 24 "安装位置"
    !insertmacro dtSetFont $dtDirTitle $dtFontBold
    SetCtlColors $dtDirTitle ${DITENG_INK} transparent
    !insertmacro dtGetOuterCtl 1019 $0   ; 目录编辑框
    ${If} $0 != 0
      !insertmacro dtMoveWindow $0 40 104 428 26
      !insertmacro dtSetFont $0 $dtFontLbl
      SetCtlColors $0 ${DITENG_INK} 0xFFFFFF
    ${EndIf}
    !insertmacro dtGetOuterCtl 1001 $0   ; 浏览按钮
    ${If} $0 != 0
      !insertmacro dtMoveWindow $0 478 104 100 26
      !insertmacro dtSetFont $0 $dtFontLbl
      SetCtlColors $0 ${DITENG_INK} transparent
      System::Call 'user32::SetWindowTextW(p $0, t "浏览...") i'
    ${EndIf}
    !insertmacro dtGetOuterCtl 1023 $0   ; 所需空间
    ${If} $0 != 0
      !insertmacro dtMoveWindow $0 40 160 540 18
      !insertmacro dtSetFont $0 $dtFontSm
      SetCtlColors $0 ${DITENG_SECONDARY} transparent
    ${EndIf}
    !insertmacro dtGetOuterCtl 1024 $0   ; 可用空间
    ${If} $0 != 0
      !insertmacro dtMoveWindow $0 40 180 540 18
      !insertmacro dtSetFont $0 $dtFontSm
      SetCtlColors $0 ${DITENG_SECONDARY} transparent
    ${EndIf}
    ; 下一步按钮文案改为“安装”
    !insertmacro dtGetOuterCtl 1 $0
    ${If} $0 != 0
      System::Call 'user32::SetWindowTextW(p $0, t "安装") i'
    ${EndIf}
    !insertmacro dtCreamDirPage
  FunctionEnd

  # ---------- 进度页（INSTFILES 重排 + 步骤清单叠加）----------
  Function dtInstFilesShow
    !insertmacro dtLog "instShow enter"
    Call dtEnsureInner
    ${If} $dtDirTitle != 0
      System::Call 'user32::DestroyWindow(p $dtDirTitle) i'
      StrCpy $dtDirTitle 0
    ${EndIf}
    ; 常驻底图切换为进度页画面
    !insertmacro dtSetPageImg "$PLUGINSDIR\dt-progress.bmp"

    ; 本页 NSIS 会惰性创建内层 #32770（BTNFACE 灰底 450x210，盖住底图）——
    ; 整体流放屏幕外（进度条先改挂外层再绝对定位到底图轨道，双进度条同源修复）
    FindWindow $5 "#32770" "" $HWNDPARENT
    ${If} $5 != 0
      !insertmacro dtGetOuterCtl 1004 $6
      ${If} $6 != 0
        System::Call 'user32::SetParent(p $6, p $HWNDPARENT) p'
      ${EndIf}
      !insertmacro dtMoveWindow $5 -600 -600 450 210
    ${EndIf}
    !insertmacro dtGetOuterCtl 1004 $0
    ${If} $0 != 0
      !insertmacro dtMoveWindow $0 40 312 540 10
    ${EndIf}
    !insertmacro dtHideCtl 1006
    !insertmacro dtGetOuterCtl 1027 $0
    ${If} $0 != 0
      !insertmacro dtHide $0
    ${EndIf}
    !insertmacro dtGetOuterCtl 1016 $0
    ${If} $0 != 0
      !insertmacro dtHide $0
    ${EndIf}
    ; 安装完成时 NSIS 会重新显示“下一步”，进度页把它移出屏幕
    !insertmacro dtGetOuterCtl 1 $0
    ${If} $0 != 0
      !insertmacro dtMoveWindow $0 -600 -600 132 44
    ${EndIf}

    ; 步骤清单文字（图标已烘焙在底图；颜色区分状态）
    !insertmacro dtCreateLabel dtStep1 70 148 400 24 "安装前检查已完成"
    !insertmacro dtSetFont $dtStep1 $dtFontLbl
    SetCtlColors $dtStep1 ${DITENG_GREEN} transparent
    !insertmacro dtCreateLabel dtStep2 70 186 400 24 "正在写入程序文件"
    !insertmacro dtSetFont $dtStep2 $dtFontBold
    SetCtlColors $dtStep2 ${DITENG_INK} transparent
    !insertmacro dtCreateLabel dtStep3 70 224 400 24 "稍后创建快捷方式"
    !insertmacro dtSetFont $dtStep3 $dtFontLbl
    SetCtlColors $dtStep3 ${DITENG_MUTED} transparent
  FunctionEnd

  # ---------- 完成页（自绘）----------
  Function dtFinishCreate
    !insertmacro dtLog "finishCreate enter"
    nsDialogs::Create 1018
    Pop $dtFinDlg
    Call dtEnsureInner
    !insertmacro dtMoveWindow $dtFinDlg 0 0 ${DITENG_W} ${DITENG_H}

    System::Call 'user32::CreateWindowExW(i 0, t "STATIC", t "", i 0x5000000E, i 0, i 0, i ${DITENG_W}, i ${DITENG_H}, p $dtFinDlg, i 0, p 0, p 0) p.s'
    Pop $dtFinBg
    System::Call 'user32::LoadImageW(p 0, t "$PLUGINSDIR\dt-finish.bmp", i 0, i 0, i 0, i 0x2010) p.s'
    Pop $dtFinImg
    System::Call 'user32::SendMessageW(p $dtFinBg, i 0x172, i 0, p $dtFinImg) p'

    ; 立即运行复选框
    !insertmacro dtDuX 40 $0
    !insertmacro dtDuY 310 $1
    !insertmacro dtDuX 260 $2
    !insertmacro dtDuY 26 $3
    nsDialogs::CreateControl "Button" "0x50010003" 0 "$0u" "$1u" "$2u" "$3u" "立即运行 diteng agent"
    Pop $dtFinRun
    !insertmacro dtSetFont $dtFinRun $dtFontLbl
    SetCtlColors $dtFinRun ${DITENG_INK} transparent
    ${NSD_Check} $dtFinRun

    ; “完成”= 真实位图按钮（id 1，点击/回车即结束向导；启动逻辑在 leave 中）
    !insertmacro dtCreateBmpBtn dtFinBtn 1 "$PLUGINSDIR\dt-btn-finish.bmp" 448 356 132 44

    ; 真实“下一步”移出屏幕（NSIS 会重新显示但不重定位），取消隐藏即可
    !insertmacro dtGetOuterCtl 1 $0
    ${If} $0 != 0
      !insertmacro dtMoveWindow $0 -600 -600 132 44
    ${EndIf}
    !insertmacro dtGetOuterCtl 2 $0
    ${If} $0 != 0
      !insertmacro dtHide $0
    ${EndIf}

    nsDialogs::Show
  FunctionEnd

  Function dtFinishLeave
    System::Call 'user32::DestroyWindow(p $dtFinBtn) i'
    StrCpy $dtFinBtn 0
    ${If} $dtFinBtnImg != 0
      System::Call 'gdi32::DeleteObject(p $dtFinBtnImg) i'
      StrCpy $dtFinBtnImg 0
    ${EndIf}
    ${If} $dtFinImg != 0
      System::Call 'gdi32::DeleteObject(p $dtFinImg) i'
      StrCpy $dtFinImg 0
    ${EndIf}
    ${If} $dtFinRun != 0
      ${NSD_GetState} $dtFinRun $1
      ${If} $1 == ${DITENG_BST_CHECKED}
        ${If} ${isUpdated}
          StrCpy $2 "--updated"
        ${Else}
          StrCpy $2 ""
        ${EndIf}
        ${StdUtils.ExecShellAsUser} $3 "$launchLink" "open" "$2"
      ${EndIf}
    ${EndIf}
  FunctionEnd
  !endif ; 目录页~完成页（安装器趟）

  !ifdef BUILD_UNINSTALLER
  # ---------- 卸载欢迎页（自绘）----------
  Function un.dtUnWelcomeCreate
    nsDialogs::Create 1018
    Pop $dtUnDlg
    Call un.dtEnsureInner
    !insertmacro dtMoveWindow $dtUnDlg 0 0 ${DITENG_W} ${DITENG_H}

    System::Call 'user32::CreateWindowExW(i 0, t "STATIC", t "", i 0x5000000E, i 0, i 0, i ${DITENG_W}, i ${DITENG_H}, p $dtUnDlg, i 0, p 0, p 0) p.s'
    Pop $dtUnBg
    System::Call 'user32::LoadImageW(p 0, t "$PLUGINSDIR\dt-unwelcome.bmp", i 0, i 0, i 0, i 0x2010) p.s'
    Pop $dtUnImg
    System::Call 'user32::SendMessageW(p $dtUnBg, i 0x172, i 0, p $dtUnImg) p'

    ; “开始卸载”= 真实位图按钮（id 1 = 下一步语义）
    !insertmacro dtCreateBmpBtn dtUnBtn 1 "$PLUGINSDIR\dt-btn-un.bmp" 448 356 132 44

    ; 真实“下一步”移出屏幕（NSIS 会重新显示但不重定位）
    !insertmacro dtGetOuterCtl 1 $0
    ${If} $0 != 0
      !insertmacro dtMoveWindow $0 -600 -600 132 44
    ${EndIf}

    nsDialogs::Show
  FunctionEnd

  Function un.dtUnWelcomeLeave
    System::Call 'user32::DestroyWindow(p $dtUnBtn) i'
    StrCpy $dtUnBtn 0
    ${If} $dtUnBtnImg != 0
      System::Call 'gdi32::DeleteObject(p $dtUnBtnImg) i'
      StrCpy $dtUnBtnImg 0
    ${EndIf}
    ${If} $dtUnImg != 0
      System::Call 'gdi32::DeleteObject(p $dtUnImg) i'
      StrCpy $dtUnImg 0
    ${EndIf}
    !insertmacro dtGetOuterCtl 1 $0
    ${If} $0 != 0
      !insertmacro dtMoveWindow $0 448 356 132 44
      !insertmacro dtShow $0
    ${EndIf}
  FunctionEnd
  !endif ; BUILD_UNINSTALLER（卸载欢迎页）

!macroend

# ============================================================================
# 安装收尾：步骤清单状态翻转（customInstall 在文件/快捷方式/注册表完成后触发）
# ============================================================================
!macro customInstall
  IfSilent dt_custom_install_done
  ${If} $dtStep2 != 0
    SetCtlColors $dtStep2 ${DITENG_GREEN} transparent
    !insertmacro dtSetFont $dtStep2 $dtFontLbl
  ${EndIf}
  ${If} $dtStep3 != 0
    SetCtlColors $dtStep3 ${DITENG_GREEN} transparent
  ${EndIf}
  dt_custom_install_done:
!macroend
