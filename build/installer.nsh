; "Open in GaetanDev Git" on folders and folder backgrounds in Explorer.
; The app opens the folder it is given (see folderArg in src/main/index.ts).
; SHCTX is HKLM for an "all users" install and HKCU for "only me": electron-builder
; sets the shell context from that choice, so every user of an all-users install
; gets the entry, not only the account that ran the installer.

!macro customInstall
  WriteRegStr SHCTX "Software\Classes\Directory\shell\GaetanDevGit" "" "Open in GaetanDev Git"
  WriteRegStr SHCTX "Software\Classes\Directory\shell\GaetanDevGit" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr SHCTX "Software\Classes\Directory\shell\GaetanDevGit\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  WriteRegStr SHCTX "Software\Classes\Directory\Background\shell\GaetanDevGit" "" "Open in GaetanDev Git"
  WriteRegStr SHCTX "Software\Classes\Directory\Background\shell\GaetanDevGit" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr SHCTX "Software\Classes\Directory\Background\shell\GaetanDevGit\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%V"'
!macroend

!macro customUnInstall
  DeleteRegKey SHCTX "Software\Classes\Directory\shell\GaetanDevGit"
  DeleteRegKey SHCTX "Software\Classes\Directory\Background\shell\GaetanDevGit"
  ; Earlier versions always wrote the per-user keys.
  DeleteRegKey HKCU "Software\Classes\Directory\shell\GaetanDevGit"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\GaetanDevGit"
!macroend
